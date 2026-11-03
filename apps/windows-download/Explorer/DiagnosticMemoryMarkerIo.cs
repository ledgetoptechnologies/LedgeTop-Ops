#if LEDGETOP_NATIVE_DIAGNOSTICS
using LedgeTop.WindowsDownload;
namespace LedgeTop.Files.Explorer;

// Synthetic-only opt-in comparison. Paths and bytes are supplied by the
// isolated test fixture, never by a source account or remote response.
internal static class DiagnosticMemoryMarkerIo {
    internal const string Marker = "LedgeTop.SyntheticMemoryMarker/1\n";
    internal static string Mode(string? value) => value switch {
        null or "none" => "none", "shared-marker" => "shared-marker", "distinct-marker" => "distinct-marker", _ => "invalid"
    };
    internal static void Read(string mode, string cacheDirectory, string fileName, Func<string, string>? read = null) {
        if (mode == "none") return;
        if (mode is not ("shared-marker" or "distinct-marker") || !System.Text.RegularExpressions.Regex.IsMatch(fileName, "\\Asample-[0-3]\\.bin\\z"))
            throw new IOException("Synthetic marker mode or name is invalid.");
        var marker = mode == "shared-marker" ? "shared.marker" : fileName + ".marker";
        var path = Path.Combine(cacheDirectory, "synthetic-memory-markers", marker);
        NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerReadEnter);
        try { if ((read ?? File.ReadAllText)(path) != Marker) throw new IOException("Synthetic marker differs."); }
        finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticMarkerReadExit); }
    }
}
#endif
