#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;

// Observation only. A matching current identity does not prove the identity
// originally created by the probe or exclude a concurrent provider connection.
internal static class SyntheticMemoryInspection {
    private static (string Root, byte[] Context) Scope(string basePath, string idText) {
        if (string.IsNullOrWhiteSpace(basePath) || !Path.IsPathFullyQualified(basePath) ||
            basePath.StartsWith("\\\\", StringComparison.Ordinal) ||
            !Guid.TryParseExact(idText, "N", out var id) || idText != id.ToString("N"))
            throw new ArgumentException("A local artifact base and exact lowercase probe GUID are required.");
        return (Path.Combine(Path.GetFullPath(basePath), "memory-native-fixtures", idText, "Files"),
            Encoding.UTF8.GetBytes("LedgeTop.Files.MemoryNativeTest.v1:" + id));
    }

    internal static int Run(string idText) {
        if (Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") != "1") return 2;
        try {
            var (root, context) = Scope(Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? "", idText);
            // Inspect validates the fixed NTFS root and rejects reparse ancestors.
            var observation = NativeRootRegistration.Inspect(root, context);
            Console.WriteLine(JsonSerializer.Serialize(new { root, observation, observationOnly = true,
                originalPhysicalIdentityProven = false, noLiveProviderProven = false, mutationsPerformed = false }));
            return 0;
        } catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException or PlatformNotSupportedException) {
            Console.Error.WriteLine("Read-only synthetic root inspection unavailable: " + error.Message);
            return 1;
        }
    }

    internal static int Tests() {
        var id = Guid.Parse("12345678-1234-1234-1234-123456789abc");
        var basePath = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "synthetic-inspect-base"));
        var (root, context) = Scope(basePath, id.ToString("N"));
        if (root != Path.Combine(basePath, "memory-native-fixtures", id.ToString("N"), "Files") ||
            Encoding.UTF8.GetString(context) != "LedgeTop.Files.MemoryNativeTest.v1:" + id)
            throw new IOException("Synthetic scope was derived incorrectly.");
        foreach (var bad in new[] { "../outside", id.ToString(), id.ToString("N").ToUpperInvariant(), "" }) {
            try { Scope(basePath, bad); throw new IOException("Invalid probe GUID accepted."); }
            catch (ArgumentException) { }
        }
        foreach (var bad in new[] { "relative", "\\\\server\\share", "" }) {
            try { Scope(bad, id.ToString("N")); throw new IOException("Invalid artifact base accepted."); }
            catch (ArgumentException) { }
        }
        Console.WriteLine("PASS synthetic read-only inspection scope and identity refusals; no filesystem or native calls.");
        return 0;
    }
}
#endif
