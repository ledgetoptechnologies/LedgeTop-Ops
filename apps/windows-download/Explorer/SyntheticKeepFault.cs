#if LEDGETOP_NATIVE_DIAGNOSTICS
namespace LedgeTop.Files.Explorer;

// One explicit synthetic fixture may arm this exactly once. This is not a
// simulation of a Windows or network failure.
internal sealed class SyntheticKeepFault {
    internal static bool IsScope(string root, string? artifact, bool enabled, string alias, string origin, string channel, string principal, int count, bool hasSample) {
        var fixture = Path.GetFileName(Path.GetDirectoryName(root));
        return enabled && !string.IsNullOrEmpty(artifact) && Path.IsPathFullyQualified(artifact) && !artifact.StartsWith("\\\\", StringComparison.Ordinal) &&
            Guid.TryParseExact(fixture, "N", out var id) && fixture == id.ToString("N") &&
            string.Equals(Path.GetFullPath(root), Path.Combine(Path.GetFullPath(artifact), "memory-native-fixtures", fixture, "Files"), StringComparison.OrdinalIgnoreCase) &&
            alias == "synthetic" && origin == "https://source.example.invalid/" && channel == "pilot" &&
            principal == "odqp1_" + new string('f', 64) && count == 1 && hasSample;
    }
    private int armed;
    private int remaining;
    private int attempts;
    internal int Attempts => Volatile.Read(ref attempts);
    internal void Arm(bool authorizedScope) {
        if (!authorizedScope || Interlocked.CompareExchange(ref armed, 1, 0) != 0)
            throw new InvalidOperationException("Synthetic Keep fault scope is unavailable.");
        Volatile.Write(ref remaining, 1);
    }
    internal bool ShouldFail() {
        Interlocked.Increment(ref attempts);
        return Interlocked.Exchange(ref remaining, 0) == 1;
    }
}
#endif
