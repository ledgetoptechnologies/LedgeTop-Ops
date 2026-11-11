#if LEDGETOP_NATIVE_DIAGNOSTICS
using LedgeTop.WindowsDownload;
namespace LedgeTop.Files.Explorer;

// Synthetic-only opt-in comparison. Paths and bytes are supplied by the
// isolated test fixture, never by a source account or remote response.
internal static class DiagnosticMemoryMarkerIo {
    internal const string Marker = "LedgeTop.SyntheticMemoryMarker/1\n";
    internal static string Mode(string? value) => value switch {
        null or "none" => "none", "shared-marker" => "shared-marker", "distinct-marker" => "distinct-marker", "preopened-distinct" => "preopened-distinct", "create-flush-distinct" => "create-flush-distinct", _ => "invalid"
    };
    // The probe binds one previously opened handle per synthetic name before it
    // registers the provider. Read uses offset-based I/O and performs no open.
    private static readonly object Gate = new();
    private static Preopened? active;
    private static CreateScope? activeCreate;
    internal sealed class CreateScope : IDisposable {
        internal readonly string Cache;
        internal CreateScope(string cache) {
            Cache = Path.GetFullPath(cache);
            if (!Path.IsPathFullyQualified(cache) || Cache.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Local synthetic cache required.");
            var markerDirectory = Path.Combine(Cache, "synthetic-memory-markers");
            if (!Directory.Exists(markerDirectory)) throw new IOException("Synthetic marker directory missing.");
            for (string? current = markerDirectory; current is not null; current = Path.GetDirectoryName(current))
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Synthetic fixture may not traverse aliases.");
            lock (Gate) { if (activeCreate is not null) throw new IOException("Synthetic create fixture already bound."); activeCreate = this; }
        }
        public void Dispose() { lock (Gate) { if (ReferenceEquals(activeCreate, this)) activeCreate = null; } }
    }
    internal sealed class Preopened : IDisposable {
        private readonly string cacheDirectory;
        private readonly Dictionary<string, FileStream> streams;
        internal Preopened(string cacheDirectory, IEnumerable<string> names) {
            this.cacheDirectory = Path.GetFullPath(cacheDirectory);
            streams = new(StringComparer.Ordinal);
            try {
                foreach (var name in names) {
                    if (!System.Text.RegularExpressions.Regex.IsMatch(name, "\\Asample-[0-3]\\.bin\\z")) throw new IOException("Invalid synthetic marker name.");
                    if (streams.ContainsKey(name)) throw new IOException("Duplicate synthetic marker name.");
                    streams.Add(name, new FileStream(Path.Combine(this.cacheDirectory, "synthetic-memory-markers", name + ".marker"), FileMode.Open, FileAccess.Read, FileShare.Read));
                }
                if (streams.Count == 0) throw new IOException("Synthetic markers are required.");
                lock (Gate) { if (active is not null) throw new IOException("Synthetic markers already bound."); active = this; }
            } catch { foreach (var stream in streams.Values) stream.Dispose(); throw; }
        }
        internal string Read(string directory, string name) {
            if (!string.Equals(Path.GetFullPath(directory), cacheDirectory, StringComparison.OrdinalIgnoreCase) || !streams.TryGetValue(name, out var stream))
                throw new IOException("Synthetic preopened marker scope mismatch.");
            var bytes = new byte[128];
            var length = RandomAccess.Read(stream.SafeFileHandle, bytes, 0);
            return System.Text.Encoding.UTF8.GetString(bytes, 0, length);
        }
        public void Dispose() {
            lock (Gate) { if (ReferenceEquals(active, this)) active = null; }
            foreach (var stream in streams.Values) stream.Dispose();
        }
    }
    internal static void Read(string mode, string cacheDirectory, string fileName, Func<string, string>? read = null) {
        if (mode == "none") return;
        if (mode is not ("shared-marker" or "distinct-marker" or "preopened-distinct" or "create-flush-distinct") || !System.Text.RegularExpressions.Regex.IsMatch(fileName, "\\Asample-[0-3]\\.bin\\z"))
            throw new IOException("Synthetic marker mode or name is invalid.");
        if (mode == "create-flush-distinct") { CreateAndFlush(cacheDirectory, fileName); return; }
        var marker = mode == "shared-marker" ? "shared.marker" : fileName + ".marker";
        var path = Path.Combine(cacheDirectory, "synthetic-memory-markers", marker);
        NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerReadEnter);
        try {
            string value;
            if (mode == "preopened-distinct") {
                Preopened bound; lock (Gate) bound = active ?? throw new IOException("Synthetic markers are not bound.");
                value = bound.Read(cacheDirectory, fileName);
            } else value = (read ?? File.ReadAllText)(path);
            if (value != Marker) throw new IOException("Synthetic marker differs.");
        }
        finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerReadExit); }
    }
    // Synthetic-only fixture, created exclusively once per sample. Repeated
    // callbacks for the same sample fail visibly rather than replacing data.
    private static void CreateAndFlush(string cacheDirectory, string fileName) {
        CreateScope scope; lock (Gate) scope = activeCreate ?? throw new IOException("Synthetic create fixture is not bound.");
        if (!string.Equals(Path.GetFullPath(cacheDirectory), scope.Cache, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Synthetic create fixture scope mismatch.");
        var path = Path.Combine(cacheDirectory, "synthetic-memory-markers", fileName + ".created");
        FileStream stream;
        NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerCreateEnter);
        try { stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); }
        finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerCreateExit); }
        try {
            var bytes = System.Text.Encoding.UTF8.GetBytes(Marker);
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerWriteEnter);
            try { stream.Write(bytes); }
            finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerWriteExit); }
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerFlushEnter);
            try { stream.Flush(true); }
            finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerFlushExit); }
        } finally {
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerCloseEnter);
            try { stream.Dispose(); }
            finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerCloseExit); }
        }
    }
}
#endif
