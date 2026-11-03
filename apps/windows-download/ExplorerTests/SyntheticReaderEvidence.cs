#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

// Current-user pipes avoid writing extra cache files during this comparison.
// A missing, late, duplicate or malformed observation is never success proof.
internal static class SyntheticReaderEvidence {
    internal sealed record Receipt(int Version, int ProcessId, string FileName, string Nonce, string Outcome, int HResult);
    internal enum Classification { Invalid, Matched, CloudUnavailable }
    internal static string PipeName(string nonce) => "LedgeTopFilesSynthetic-" + nonce;
    internal static NamedPipeServerStream CreateServer(string nonce) {
        if (!ValidNonce(nonce)) throw new ArgumentException("Invalid synthetic nonce.");
        return new NamedPipeServerStream(PipeName(nonce), PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    }
    private static bool ValidNonce(string nonce) => Guid.TryParseExact(nonce, "N", out var parsed) && nonce == parsed.ToString("N");
    internal static async Task<bool> SendAsync(string pipeName, string nonce, string fileName, string outcome, int hresult) {
        if (!ValidNonce(nonce) || pipeName != PipeName(nonce) || !ValidFile(fileName)) return false;
        try {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await pipe.ConnectAsync(timeout.Token).ConfigureAwait(false);
            var data = JsonSerializer.SerializeToUtf8Bytes(new Receipt(1, Environment.ProcessId, fileName, nonce, outcome, hresult));
            if (data.Length > 1024) return false;
            var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, data.Length);
            await pipe.WriteAsync(header, timeout.Token).ConfigureAwait(false);
            await pipe.WriteAsync(data, timeout.Token).ConfigureAwait(false);
            await pipe.FlushAsync(timeout.Token).ConfigureAwait(false);
            var acknowledgement = new byte[1]; await pipe.ReadExactlyAsync(acknowledgement, timeout.Token).ConfigureAwait(false);
            if (acknowledgement[0] != 0xA5) return false;
            return true;
        } catch (Exception error) when (error is IOException or OperationCanceledException or UnauthorizedAccessException or ArgumentException) { return false; }
    }
    internal static async Task<byte[]?> ReceiveAsync(NamedPipeServerStream pipe, int expectedPid, CancellationToken token) {
        using (pipe) {
            try {
                await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var actualPid) || actualPid != (uint)expectedPid) return null;
                var header = new byte[4]; await pipe.ReadExactlyAsync(header, token).ConfigureAwait(false);
                var length = BinaryPrimitives.ReadInt32LittleEndian(header); if (length is <= 0 or > 1024) return null;
                var data = new byte[length]; await pipe.ReadExactlyAsync(data, token).ConfigureAwait(false);
                await pipe.WriteAsync(new byte[] { 0xA5 }, token).ConfigureAwait(false);
                await pipe.FlushAsync(token).ConfigureAwait(false);
                var extra = new byte[1]; if (await pipe.ReadAsync(extra, token).ConfigureAwait(false) != 0) return null;
                return data;
            } catch (Exception error) when (error is IOException or OperationCanceledException or UnauthorizedAccessException or ObjectDisposedException or ArgumentException) { return null; }
        }
    }
    internal static Classification Classify(byte[] data, int expectedPid, string expectedFile, string expectedNonce, int exitCode) {
        try {
            if (data.Length is <= 0 or > 1024 || !ValidNonce(expectedNonce) || !ValidFile(expectedFile)) return Classification.Invalid;
            using var json = JsonDocument.Parse(data);
            var names = json.RootElement.EnumerateObject().Select(p => p.Name).ToArray();
            if (!names.Order().SequenceEqual(new[] { "Version", "ProcessId", "FileName", "Nonce", "Outcome", "HResult" }.Order())) return Classification.Invalid;
            var receipt = JsonSerializer.Deserialize<Receipt>(data);
            if (receipt is null || receipt.Version != 1 || receipt.ProcessId != expectedPid || receipt.FileName != expectedFile || receipt.Nonce != expectedNonce) return Classification.Invalid;
            if (receipt.Outcome == "matched" && receipt.HResult == 0 && exitCode == 0) return Classification.Matched;
            if (receipt.Outcome == "IOException" && receipt.HResult == unchecked((int)0x80070185) && exitCode == 1) return Classification.CloudUnavailable;
            return Classification.Invalid;
        } catch (Exception error) when (error is JsonException or InvalidOperationException or ArgumentException) { return Classification.Invalid; }
    }
    private static bool ValidFile(string name) => System.Text.RegularExpressions.Regex.IsMatch(name, "\\Asample-[01]\\.bin\\z");
    internal static async Task<int> SelfTestsAsync() {
        if (!OperatingSystem.IsWindows()) return 2;
        foreach (var correctPid in new[] { true, false }) {
            var nonce = Guid.NewGuid().ToString("N");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            var server = CreateServer(nonce);
            var received = ReceiveAsync(server, Environment.ProcessId + (correctPid ? 0 : 1), timeout.Token);
            var sent = SendAsync(PipeName(nonce), nonce, "sample-1.bin", "IOException", unchecked((int)0x80070185));
            var data = await received.ConfigureAwait(false); var sentOk = await sent.ConfigureAwait(false);
            if (correctPid) {
                if (!sentOk || data is null || Classify(data, Environment.ProcessId, "sample-1.bin", nonce, 1) != Classification.CloudUnavailable)
                    throw new IOException("Synthetic pipe could not verify the current process.");
            } else if (data is not null || sentOk) throw new IOException("Synthetic pipe accepted a different process identity.");
        }
        var executable = Environment.ProcessPath ?? throw new IOException("Synthetic test apphost is unavailable.");
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Synthetic evidence test requires the apphost.");
        var childNonce = Guid.NewGuid().ToString("N");
        using var childTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var childServer = CreateServer(childNonce);
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("--synthetic-reader-evidence-child"); info.ArgumentList.Add(PipeName(childNonce)); info.ArgumentList.Add(childNonce);
        Process child;
        try { child = Process.Start(info) ?? throw new IOException("Synthetic pipe child did not start."); }
        catch { childServer.Dispose(); throw; }
        using (child) {
            var received = ReceiveAsync(childServer, child.Id, childTimeout.Token);
            try {
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                var data = await received.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                if (data is null || Classify(data, child.Id, "sample-1.bin", childNonce, child.ExitCode) != Classification.CloudUnavailable)
                    throw new IOException("Synthetic child process evidence did not match its OS PID and exit.");
            } finally {
                if (!child.HasExited) { child.Kill(); await child.WaitForExitAsync().ConfigureAwait(false); }
                childTimeout.Cancel(); childServer.Dispose();
                await received.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
            }
        }
        Console.WriteLine("PASS synthetic current-user pipe bounds and OS peer process identity.");
        return 0;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);
}
#endif
