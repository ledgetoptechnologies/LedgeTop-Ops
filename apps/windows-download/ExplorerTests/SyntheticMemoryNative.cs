#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Diagnostic only: distinct external readers against a fresh synthetic native
// root. Never selects production sources or uses cache I/O in FETCH_DATA.
internal static class SyntheticMemoryNative {
    internal static readonly byte[] Bytes = Encoding.UTF8.GetBytes(new string('x', 100_000));
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private static readonly string Principal = "odqp1_" + new string('f', 64);
    internal static int Reader(string path, string startName, string readyName) {
        using var start = EventWaitHandle.OpenExisting(startName); using var ready = EventWaitHandle.OpenExisting(readyName);
        ready.Set(); if (!start.WaitOne(TimeSpan.FromSeconds(15))) return 1;
        var bytes = File.ReadAllBytes(path);
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), SHA256.HashData(Bytes)) ? 0 : 1;
    }
    private static void RequireLocalDirectory(string path) {
        var full = Path.GetFullPath(path);
        if (full.StartsWith("\\\\", StringComparison.Ordinal) || !Directory.Exists(full)) throw new IOException("Existing local test directory required.");
        for (string? current = full; current is not null; current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Test directory may not traverse aliases.");
    }
    internal static async Task<int> RunAsync(int count) {
        if (!OperatingSystem.IsWindows() || count is < 1 or > 4 ||
            Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") != "1") return 2;
        var basePath = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        if (string.IsNullOrEmpty(basePath) || !Path.IsPathFullyQualified(basePath) || basePath.StartsWith("\\\\", StringComparison.Ordinal)) return 2;
        RequireLocalDirectory(basePath);
        var fixtureBase = Path.Combine(basePath, "memory-native-fixtures");
        if (!Directory.Exists(fixtureBase)) Directory.CreateDirectory(fixtureBase);
        RequireLocalDirectory(fixtureBase);
        var id = Guid.NewGuid(); var owned = Path.Combine(fixtureBase, id.ToString("N"));
        if (Directory.Exists(owned) || File.Exists(owned)) throw new IOException("Test fixture already exists.");
        var root = Path.Combine(owned, "Files"); var cache = Path.Combine(owned, "Cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        RequireLocalDirectory(root); RequireLocalDirectory(cache);
        var manifest = Enumerable.Range(0, count).ToDictionary(i => $"sample-{i}.bin", i => new PlaceholderIdentity(
            "pilot", "synthetic", "https://source.example.invalid", Principal, "odqr1_" + i,
            "oef1_" + new string((char)('a' + i), 64), Sha, $"sample-{i}.bin", Bytes.Length, "\"" + Sha + "\"", Sha), StringComparer.OrdinalIgnoreCase);
        NativeRootRegistration? registration = null; NativePlaceholderProvider? provider = null;
        var readers = new List<Process>(); var readyHandles = new List<EventWaitHandle>(); var safe = true; var success = false;
        var startName = "Local\\LedgeTopMemoryProbe-" + id.ToString("N");
        using var start = new EventWaitHandle(false, EventResetMode.ManualReset, startName);
        try {
            registration = NativeRootRegistration.Register(root, Encoding.UTF8.GetBytes("LedgeTop.Files.MemoryNativeTest.v1:" + id));
            provider = new NativePlaceholderProvider(registration, cache, new Source(), "pilot", Principal, manifest, []);
            await provider.ConnectAndPopulateAsync();
            var executable = Environment.ProcessPath ?? throw new IOException("Self-contained test apphost required.");
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Use the self-contained test apphost.");
            foreach (var name in manifest.Keys) {
                var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
                var readyName = startName + "-" + readyHandles.Count;
                readyHandles.Add(new EventWaitHandle(false, EventResetMode.ManualReset, readyName));
                info.ArgumentList.Add("--synthetic-memory-native-reader"); info.ArgumentList.Add(Path.Combine(root, name));
                info.ArgumentList.Add(startName); info.ArgumentList.Add(readyName);
                readers.Add(Process.Start(info) ?? throw new IOException("Synthetic reader failed to start."));
            }
            if (!WaitHandle.WaitAll(readyHandles.ToArray(), TimeSpan.FromSeconds(10))) throw new TimeoutException("Synthetic readers did not reach the start gate.");
            start.Set();
            await Task.WhenAll(readers.Select(p => p.WaitForExitAsync())).WaitAsync(TimeSpan.FromSeconds(25));
            success = readers.All(p => p.ExitCode == 0);
        } catch (Exception error) { Console.Error.WriteLine($"Synthetic memory native: {error.GetType().Name}: {error.Message}"); }
        finally {
            foreach (var reader in readers) {
                try { if (!reader.HasExited) { reader.Kill(); await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); } }
                catch { safe = false; }
                reader.Dispose();
            }
            foreach (var ready in readyHandles) ready.Dispose();
            if (provider is not null) try { await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20)); } catch { safe = false; }
            if (registration is not null && safe) try { registration.Unregister(); } catch { safe = false; }
            Console.WriteLine($"Synthetic memory native: count={count}; success={success}; cleanupVerified={safe}; root={root}");
        }
        return success && safe ? 0 : 1;
    }
    private sealed class Source : IQueuedDownloadSource {
        public string Alias => "synthetic";
        public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
    }
}
#endif
