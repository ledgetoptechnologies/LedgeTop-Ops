using System.Text.Json;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Tests;

internal static class ConnectionDiagnosticStoreTests
{
    internal static void Run()
    {
        var artifacts = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Explicit artifact root required.");
        if (!Path.IsPathFullyQualified(artifacts)) throw new IOException("Absolute fixture path required.");
        var root = Path.Combine(Path.GetFullPath(artifacts), "connection-diagnostic-store", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var now = new DateTimeOffset(2026, 10, 28, 23, 0, 0, TimeSpan.Zero); var version = new Version(0, 5, 13, 0);
        var first = ConnectionFailureTrace.Format(ConnectionAction.CachedReconnect, ConnectionPhase.CurrentSession,
            new LoginRequiredException(LoginFailureReason.HttpUnauthorized, LoginFailureOperation.QueueSession));
        var secret = "secret-token https://private.invalid/path principal-private ref-private";
        var error = new TransferException(secret, TransferFailureReason.UnexpectedHttpStatus, 503); error.Data["token"] = secret;
        var second = ConnectionFailureTrace.Format(ConnectionAction.Recheck, ConnectionPhase.SourceSession, error);
        string Existing(string label) { var path = Path.Combine(root, label, "connected-explorer-pilot-employee"); Directory.CreateDirectory(path); return path; }
        void Save(string path, string code, DateTimeOffset? time = null, Func<bool>? own = null) =>
            ConnectionDiagnosticStore.TrySaveLatest(path, own ?? (() => true), code, version, time ?? now);
        var good = Existing("latest"); Save(good, first); Save(good, second, now.AddMinutes(1));
        var leaf = Path.Combine(good, ConnectionDiagnosticStore.Leaf); var data = File.ReadAllText(leaf);
        using (var doc = JsonDocument.Parse(data)) {
            True(doc.RootElement.GetProperty("supportCode").GetString() == second, "latest record atomically replaces owned record");
            True(doc.RootElement.GetProperty("owner").GetString() == ConnectionDiagnosticStore.Owner && doc.RootElement.GetProperty("schemaVersion").GetInt32() == 1, "fixed ownership/schema");
            True(doc.RootElement.EnumerateObject().Count() == 5 && doc.RootElement.GetProperty("appVersion").GetString() == "0.5.13.0", "five closed fields only");
        }
        True(new FileInfo(leaf).Length <= 1024 && Directory.GetFiles(good).Length == 1, "one bounded JSON, no accumulated temporary logs");
        True(!data.Contains("secret", StringComparison.Ordinal) && !data.Contains("private", StringComparison.Ordinal) && !data.Contains("https://", StringComparison.Ordinal), "exception message/Data never serialized");
        Save(good, first, now); True(File.ReadAllText(leaf) == data, "older timestamp cannot replace latest evidence");
        foreach (var invalid in new[] { secret, first + "\n" + secret, first + "; token=" + secret, first.Replace("CachedReconnect", "999"), first.Replace("QueueSession", "secret"), new string('x', 2000) }) {
            True(!ConnectionDiagnosticStore.IsSafeSupportCode(invalid), "arbitrary or numeric support coordinates rejected");
            Save(good, invalid, now.AddMinutes(2)); True(File.ReadAllText(leaf) == data, "invalid input leaves latest untouched");
        }
        var unknowns = new[] { "{}", "{", data.Replace(ConnectionDiagnosticStore.Owner, "foreign"), data.Replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            data.Replace("\"owner\":", "\"extra\":0,\"owner\":"), data.Replace("\"owner\":", "\"owner\":\"duplicate\",\"owner\":"),
            data.Replace("0.5.13.0", "not-version"), data.Replace("2026-10-28", "not-date"), data.Replace(second, secret), new string(' ', 1025) };
        foreach (var unknown in unknowns) {
            var dir = Existing(Guid.NewGuid().ToString("N")); var path = Path.Combine(dir, ConnectionDiagnosticStore.Leaf); File.WriteAllText(path, unknown);
            Save(dir, first); True(File.ReadAllText(path) == unknown && Directory.GetFiles(dir).Length == 1, "unknown/foreign/duplicate/oversized original preserved without temp creation");
        }
        var missing = Path.Combine(root, "missing", "connected-explorer-pilot-employee"); Save(missing, first);
        True(!Directory.Exists(missing), "store never creates an index directory");
        var wrong = Path.Combine(root, "wrong"); Directory.CreateDirectory(wrong); Save(wrong, first); True(Directory.GetFiles(wrong).Length == 0, "wrong index kind refused");
        var refused = Existing("ownership"); Save(refused, first, own: () => false); Save(refused, first, own: () => throw new IOException("synthetic owner check failure"));
        True(Directory.GetFiles(refused).Length == 0, "absent/uncertain lease proof is harmless skip");
        var checks = 0; Save(refused, first, own: () => ++checks == 1); True(Directory.GetFiles(refused).Length == 0, "ownership loss before publication cleans own temporary and skips");
        var longBase = Path.Combine(root, new string('a', 90), new string('b', 90));
        var longDir = Path.Combine(longBase, "connected-explorer-pilot-employee"); Directory.CreateDirectory(longDir);
        var longOriginal = Path.Combine(longDir, ConnectionDiagnosticStore.Leaf);
        File.WriteAllText(longOriginal, "foreign-long-path-data");
        Save(longDir, first, own: () => true);
        True(File.ReadAllText(longOriginal) == "foreign-long-path-data" && Directory.GetFiles(longDir).Length == 1,
            "long path is refused before a temporary file is created or existing data changed");
        // The final record can fit while the longer temporary leaf exceeds the guard.
        var padding = 208 - root.Length - 2 - "connected-explorer-pilot-employee".Length;
        if (padding < 1 || padding > 200) throw new IOException("A short synthetic artifact root is required for the boundary fixture.");
        var boundary = Path.Combine(root, new string('c', padding), "connected-explorer-pilot-employee");
        Directory.CreateDirectory(boundary); checks = 0;
        True(Path.Combine(boundary, ConnectionDiagnosticStore.Leaf).Length <= 240 && Path.Combine(boundary, ".latest-connection-failure.write.tmp").Length > 240, "fixture exercises temporary-only boundary");
        Save(boundary, first, own: () => ++checks == 1);
        True(Directory.GetFiles(boundary).Length == 0, "temporary-only long path refused before creation");
        var race = Existing("foreign-race"); var raceLeaf = Path.Combine(race, ConnectionDiagnosticStore.Leaf); Save(race, first); checks = 0;
        Save(race, second, own: () => { if (++checks == 2) File.WriteAllText(raceLeaf, "foreign-after-preflight"); return true; });
        True(File.ReadAllText(raceLeaf) == "foreign-after-preflight" && Directory.GetFiles(race).Length == 1, "raced unknown record preserved before atomic publish");
        var blocked = Existing("io-error"); var blockedLeaf = Path.Combine(blocked, ConnectionDiagnosticStore.Leaf); File.WriteAllText(blockedLeaf, "locked-original");
        using (var locked = new FileStream(blockedLeaf, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) Save(blocked, first);
        True(File.ReadAllText(blockedLeaf) == "locked-original", "IO denial never escapes or changes target");
        var nonplain = Existing("nonplain"); Directory.CreateDirectory(Path.Combine(nonplain, ConnectionDiagnosticStore.Leaf)); Save(nonplain, first);
        True(Directory.GetDirectories(nonplain).Length == 1 && Directory.GetFiles(nonplain).Length == 0, "directory at record path refused");
        var target = Existing("reparse-target"); var aliasParent = Path.Combine(root, "reparse-alias");
        Junction(root, aliasParent, Path.GetDirectoryName(target)!);
        Save(Path.Combine(aliasParent, "connected-explorer-pilot-employee"), first);
        True(Directory.GetFiles(target).Length == 0, "reparse ancestor cannot redirect diagnostic writes");
        var reparseLeafDir = Existing("reparse-leaf"); Junction(root, Path.Combine(reparseLeafDir, ConnectionDiagnosticStore.Leaf), target); Save(reparseLeafDir, first);
        True(Directory.GetFiles(target).Length == 0, "reparse target refused without external effect");
        Console.WriteLine("PASS local latest connection diagnostic fixtures: bounded/strict/latest/redacted/ownership/race/IO/nonplain/reparse; no auth/network/provider calls.");
    }
    private static void Junction(string ownedRoot, string alias, string target)
    {
        var prefix = Path.GetFullPath(ownedRoot) + Path.DirectorySeparatorChar;
        if (!Path.IsPathFullyQualified(alias) || !Path.IsPathFullyQualified(target) ||
            !Path.GetFullPath(alias).StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !Path.GetFullPath(target).StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
            alias.Concat(target).Any(ch => "&|<>^\"%!\r\n".Contains(ch))) throw new IOException("Fixture paths refused.");
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe")) {
            Arguments = "/d /c mklink /J \"" + alias + "\" \"" + target + "\"", UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        }) ?? throw new IOException("Fixture junction unavailable.");
        if (!process.WaitForExit(10000) || process.ExitCode != 0) throw new IOException("Fixture junction unavailable.");
    }
    private static void True(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
}
