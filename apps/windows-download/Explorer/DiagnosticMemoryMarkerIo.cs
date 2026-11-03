#if LEDGETOP_NATIVE_DIAGNOSTICS
using LedgeTop.WindowsDownload;
namespace LedgeTop.Files.Explorer;

// Synthetic-only opt-in comparison. Paths and bytes are supplied by the
// isolated test fixture, never by a source account or remote response.
internal static class DiagnosticMemoryMarkerIo {
    internal const string Marker = "LedgeTop.SyntheticMemoryMarker/1\n";
    internal static string Mode(string? value) => value switch {
        null or "none" => "none", "shared-marker" => "shared-marker", "distinct-marker" => "distinct-marker", "preopened-distinct" => "preopened-distinct", _ => "invalid"
    };
    // The probe binds one previously opened handle per synthetic name before it
    // registers the provider. Read uses offset-based I/O and performs no open.
    private static readonly object Gate = new();
    private static Preopened? active;
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
        if (mode is not ("shared-marker" or "distinct-marker" or "preopened-distinct") || !System.Text.RegularExpressions.Regex.IsMatch(fileName, "\\Asample-[0-3]\\.bin\\z"))
            throw new IOException("Synthetic marker mode or name is invalid.");
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
}
#endif
