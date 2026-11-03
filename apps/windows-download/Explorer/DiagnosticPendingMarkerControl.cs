#if LEDGETOP_NATIVE_DIAGNOSTICS
using LedgeTop.WindowsDownload;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace LedgeTop.Files.Explorer;

// Isolated synthetic control only. This is not a reservation/quota test.
internal static class DiagnosticPendingMarkerControl
{
    internal static readonly byte[] Expected = "LedgeTop.PendingMarkerSynthetic/1\n"u8.ToArray();
    internal static readonly byte[] Mutated = "LedgeTop.PendingMarkerSynthetic/2\n"u8.ToArray();
    private static readonly object Gate = new();
    private static Scope? current;
    internal static Scope Begin(string cache, string mode, TimeSpan? timeout = null, Func<byte[]>? testRead = null)
    {
        lock (Gate) {
            if (current is not null) throw new IOException("Synthetic pending control already active.");
            var scope = new Scope(cache, mode, timeout ?? TimeSpan.FromSeconds(12), testRead);
            current = scope;
            return scope;
        }
    }
    internal static Task RunAsync(string cache, string name, Func<Task> transfer, CancellationToken token)
    {
        Scope scope; lock (Gate) scope = current ?? throw new IOException("Synthetic pending control is not active.");
        return scope.RunAsync(cache, name, transfer, token);
    }
    internal sealed class Scope : IDisposable
    {
        private readonly object sync = new();
        private readonly string cache, mode;
        private readonly TimeSpan timeout;
        private readonly Func<byte[]>? testRead;
        private readonly FileStream? retained;
        private readonly (uint Volume, ulong Id) initialIdentity;
        private readonly TaskCompletionSource aWaiting = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> bFinished = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private bool aSeen, bSeen, aTransferred, bTransferred, verified, invalid, disposed;
        private int active;
        internal string MarkerPath { get; }
        internal byte[] CleanupExpected => mode == "mutated" ? Mutated : Expected;
        internal bool EvidenceValid { get { lock (sync) return !invalid && aSeen && bSeen && aTransferred && bTransferred && verified && active == 0; } }
        internal Scope(string cache, string mode, TimeSpan timeout, Func<byte[]>? testRead)
        {
            if (mode is not ("reopen" or "retained" or "mutated") || timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(30) ||
                Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") != "1") throw new IOException("Synthetic pending control mode invalid.");
            var artifact = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
            if (string.IsNullOrEmpty(artifact) || !Path.IsPathFullyQualified(artifact) || artifact.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Synthetic artifact root invalid.");
            this.cache = Path.GetFullPath(cache); this.mode = mode; this.timeout = timeout; this.testRead = testRead;
            var owned = Path.GetDirectoryName(this.cache) ?? throw new IOException("Synthetic fixture invalid.");
            var id = Path.GetFileName(owned);
            if (!Guid.TryParseExact(id, "N", out var parsed) || id != parsed.ToString("N") ||
                !string.Equals(this.cache, Path.Combine(Path.GetFullPath(artifact), "memory-native-fixtures", id, "Cache"), StringComparison.OrdinalIgnoreCase))
                throw new IOException("Synthetic cache is outside its fixture.");
            RequireLocalDirectory(this.cache);
            var directory = Path.Combine(this.cache, "pending-marker");
            if (Directory.Exists(directory) || File.Exists(directory)) throw new IOException("Synthetic pending marker directory exists.");
            Directory.CreateDirectory(directory); RequireLocalDirectory(directory);
            MarkerPath = Path.Combine(directory, "fixture.marker");
            using (var output = new FileStream(MarkerPath, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { output.Write(Expected); output.Flush(true); }
            if (mode == "mutated") { using var identityFile = new FileStream(MarkerPath, FileMode.Open, FileAccess.Read, FileShare.Read); initialIdentity = Identify(identityFile.SafeFileHandle); }
            if (mode == "retained") retained = new FileStream(MarkerPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        }
        private static void RequireLocalDirectory(string path) {
            for (string? current = path; current is not null; current = Path.GetDirectoryName(current)) {
                var attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw new IOException("Synthetic fixture may not traverse aliases.");
            }
        }
        [StructLayout(LayoutKind.Sequential)] private struct FileInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
        private static (uint Volume, ulong Id) Identify(SafeFileHandle handle) {
            if (!OperatingSystem.IsWindows() || !GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x410) != 0 || info.Links != 1)
                throw new IOException("Synthetic marker identity unavailable.");
            var id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
            if (info.Volume == 0 || id == 0) throw new IOException("Synthetic marker identity unavailable.");
            return (info.Volume, id);
        }
        private void MutateMarker() {
            NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerMutateOpenEnter);
            using (var output = new FileStream(MarkerPath, FileMode.Open, FileAccess.Write, FileShare.None)) {
                if (Identify(output.SafeFileHandle) != initialIdentity) throw new IOException("Synthetic marker identity changed before mutation.");
                NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerMutateOpenVerified);
                output.Write(Mutated); NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerMutateWriteComplete);
                output.Flush(true); NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerMutateFlushComplete);
            }
            NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerMutateCloseComplete);
        }
        private byte[] ReadMarker() {
            if (testRead is not null) return testRead();
            using var opened = mode is "reopen" or "mutated" ? new FileStream(MarkerPath, FileMode.Open, FileAccess.Read, FileShare.Read) : null;
            var stream = opened ?? retained ?? throw new IOException("Synthetic retained marker unavailable.");
            if (mode == "mutated" && Identify(stream.SafeFileHandle) != initialIdentity) throw new IOException("Synthetic marker identity changed during comparison.");
            if (stream.Length != Expected.Length) return [];
            var bytes = new byte[Expected.Length]; var count = RandomAccess.Read(stream.SafeFileHandle, bytes, 0);
            return count == bytes.Length ? bytes : [];
        }
        internal async Task RunAsync(string path, string name, Func<Task> transfer, CancellationToken token)
        {
            bool a;
            lock (sync) {
                if (disposed || !string.Equals(Path.GetFullPath(path), cache, StringComparison.OrdinalIgnoreCase) || name is not ("sample-0.bin" or "sample-1.bin") ||
                    (name == "sample-0.bin" ? aSeen : bSeen)) {
                    invalid = true; bFinished.TrySetResult(false); NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerInvalid);
                    throw new IOException("Synthetic pending callback identity was invalid or repeated.");
                }
                a = name == "sample-0.bin"; if (a) aSeen = true; else bSeen = true; active++;
            }
            try {
                if (a) {
                    if (mode == "mutated") MutateMarker();
                    NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerAWaiting); aWaiting.TrySetResult();
                    if (!await bFinished.Task.WaitAsync(timeout, token).ConfigureAwait(false)) throw new IOException("Synthetic marker read did not verify.");
                    NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerAReleased);
                    await transfer().ConfigureAwait(false); lock (sync) aTransferred = true;
                } else {
                    var entered = false; var matched = false;
                    try {
                        await aWaiting.Task.WaitAsync(timeout, token).ConfigureAwait(false);
                        if (bFinished.Task.IsCompleted) throw new IOException("Synthetic pending comparison already failed.");
                        NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerBReadEnter); entered = true;
                        if (!ReadMarker().AsSpan().SequenceEqual(mode == "mutated" ? Mutated : Expected)) throw new IOException("Synthetic marker bytes differed.");
                        NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerBReadVerified); matched = true;
                        lock (sync) verified = true;
                    } finally {
                        if (entered) NativeStallTrace.Record(NativeStallTrace.Stage.PendingMarkerBReadExit);
                        if (!matched) lock (sync) invalid = true;
                        bFinished.TrySetResult(matched);
                    }
                    await transfer().ConfigureAwait(false); lock (sync) bTransferred = true;
                }
            } catch { lock (sync) invalid = true; bFinished.TrySetResult(false); throw; }
            finally { lock (sync) active--; }
        }
        public void Dispose()
        {
            lock (Gate) lock (sync) {
                if (active != 0) throw new IOException("Synthetic pending callbacks have not drained.");
                if (ReferenceEquals(current, this)) current = null;
                if (!disposed) { retained?.Dispose(); disposed = true; }
            }
        }
    }
}
#endif
