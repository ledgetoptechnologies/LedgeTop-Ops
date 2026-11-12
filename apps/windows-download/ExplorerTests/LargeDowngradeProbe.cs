using System.Security.Cryptography;
using System.Text.Json.Nodes;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class LargeDowngradeProbe
{
    private static void Check(bool value, string message) { if (!value) throw new IOException(message); }
    private static string Hash(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
    private static string Root(string input)
    {
        var full = Path.GetFullPath(input);
        var temp = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        if (!string.Equals(Path.GetDirectoryName(full), temp, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(full).StartsWith("LedgeTopDowngradeSynthetic-", StringComparison.Ordinal))
            throw new IOException("Fixture must be a direct owned temp directory.");
        return full;
    }
    internal static async Task<int> Produce(string input)
    {
        Check(CatalogCapacity.MaximumEntries == 5000, "Producer must be the 5000 prototype build.");
        var baseDir = Root(input);
        Check(!Directory.Exists(baseDir) && !File.Exists(baseDir), "Fixture already exists.");
        Directory.CreateDirectory(baseDir);
        foreach (var count in new[] { 999, 1000 }) {
            var scenario = Path.Combine(baseDir, count.ToString()); Directory.CreateDirectory(scenario);
            var profileDir = Path.Combine(scenario, "profile"); var root = Path.Combine(scenario, "files");
            using var source = new ExplorerDemoSource(signedIn: false, chunkDelay: TimeSpan.Zero);
            var scope = new ExplorerRootScope(source.Channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), source.PrincipalId);
            var sample = source.Entries.First().Identity;
            var files = Enumerable.Range(0, count).ToDictionary(i => "Photos\\p" + i + ".jpg", i => sample with { FileName = "p" + i + ".jpg" });
            var manifest = new ExplorerRootManifest(scope, files);
            await using (var session = OwnedExplorerRootSession.CandidateForTest(profileDir, root, source, scope, manifest))
                await session.PrepareFreshConnectedCandidateAsync();
            var profilePath = Path.Combine(profileDir, "profile.json");
            var profile = JsonNode.Parse(File.ReadAllBytes(profilePath))!.AsObject();
            profile["Phase"] = "Ready"; profile["RootFileId"] = 1; profile["NamespaceClsid"] = Guid.NewGuid().ToString();
            File.WriteAllText(profilePath, profile.ToJsonString());
            Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "sentinel.txt"), "generated sentinel");
            await using var reopened = new OwnedExplorerRootSession(profileDir, root, source, scope);
            Check(reopened.State != ExplorerPreviewState.Failed && reopened.FrozenManifest?.Files.Count == count && reopened.FrozenManifest.Digest == manifest.Digest,
                "Producer could not reopen its own synthetic Ready profile.");
        }
        Console.WriteLine("Produced generated-only 1000 and 1001 entry synthetic Ready profiles; no native registration.");
        return 0;
    }
    internal static async Task<int> Consume(string input)
    {
        Check(CatalogCapacity.MaximumEntries == 1000, "Consumer must be the baseline 1000 build.");
        var baseDir = Root(input);
        foreach (var count in new[] { 999, 1000 }) {
            var scenario = Path.Combine(baseDir, count.ToString());
            var profileDir = Path.Combine(scenario, "profile"); var root = Path.Combine(scenario, "files");
            var profilePath = Path.Combine(profileDir, "profile.json");
            var originalProfile = File.ReadAllBytes(profilePath); var profile = JsonNode.Parse(originalProfile)!.AsObject();
            var file = profile["Binding"]!["File"]!.GetValue<string>(); var manifestPath = Path.Combine(profileDir, file);
            var originalManifest = File.ReadAllBytes(manifestPath); var sentinelPath = Path.Combine(root, "sentinel.txt");
            var sentinel = File.ReadAllBytes(sentinelPath); var id = CandidateDirectoryFence.ObserveFile(sentinelPath);
            using var source = new ExplorerDemoSource(signedIn: false, chunkDelay: TimeSpan.Zero);
            var scope = new ExplorerRootScope(source.Channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), source.PrincipalId);
            await using (var session = new OwnedExplorerRootSession(profileDir, root, source, scope)) {
                if (count == 999) Check(session.State != ExplorerPreviewState.Failed && session.FrozenManifest?.Files.Count == 999, "Baseline boundary control failed.");
                else {
                    Check(session.State == ExplorerPreviewState.Failed && session.Activity.Any(s => s.Contains("No files or Windows registrations were changed")), "Oversized saved inventory did not fail closed.");
                    var refused = false; try { await session.StartAsync(); } catch (IOException) { refused = true; }
                    Check(refused, "Start unexpectedly accepted oversized inventory.");
                }
            }
            Check(File.ReadAllBytes(profilePath).AsSpan().SequenceEqual(originalProfile), "Profile changed.");
            Check(File.ReadAllBytes(manifestPath).AsSpan().SequenceEqual(originalManifest) && Hash(originalManifest) == profile["Binding"]!["Digest"]!.GetValue<string>(), "Sidecar or binding changed.");
            Check(File.ReadAllBytes(sentinelPath).AsSpan().SequenceEqual(sentinel) && CandidateDirectoryFence.ObserveFile(sentinelPath) == id, "Sentinel changed.");
        }
        Console.WriteLine("PASS baseline 1000 entry control and 1001 entry fail-closed: profile, manifest, binding, sentinel unchanged; synthetic receipt only.");
        return 0;
    }
}
