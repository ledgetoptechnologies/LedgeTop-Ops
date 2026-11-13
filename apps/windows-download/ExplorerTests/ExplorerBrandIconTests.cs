using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class ExplorerBrandIconTests
{
    internal static async Task<int> RunAsync()
    {
        var testRoot = Path.Combine(Path.GetTempPath(), "LedgeTopExplorerBrandTests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(testRoot);
        try
        {
            var icons = Path.Combine(testRoot, "Icons");
            var resource = ExplorerBrandIcon.EnsureInDirectory(icons);
            var file = resource[..^2];
            Require(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(file))) == ExplorerBrandIcon.Digest, "Approved favicon hash differs.");
            var stamp = File.GetLastWriteTimeUtc(file);
            Require(ExplorerBrandIcon.EnsureInDirectory(icons) == resource && File.GetLastWriteTimeUtc(file) == stamp, "Valid durable icon was replaced.");
            await File.WriteAllBytesAsync(file, new byte[1889]);
            Reject(() => ExplorerBrandIcon.EnsureInDirectory(icons));
            Require((await File.ReadAllBytesAsync(file)).All(b => b == 0), "Unexpected bytes were overwritten.");
            File.Delete(file); Directory.CreateDirectory(file);
            Reject(() => ExplorerBrandIcon.EnsureInDirectory(icons));
            Reject(() => ExplorerBrandIcon.EnsureInDirectory("relative"));
            Require(ExplorerBrandIcon.IsKnownResource(ExplorerBrandIcon.Resource) && ExplorerBrandIcon.IsKnownResource(ExplorerBrandIcon.LegacyResource), "Known icon compatibility failed.");
            Require(!ExplorerBrandIcon.IsKnownResource(resource) && !ExplorerBrandIcon.IsKnownResource(ExplorerBrandIcon.Resource + " "), "Arbitrary profile icon accepted.");
            ShellRegistration.ValidateIcon(ExplorerBrandIcon.Resource, requireExistingResource: false);
            var absentIcon = Path.Combine(testRoot, "absent.ico") + ",0";
            try { ShellRegistration.ValidateIcon(absentIcon, requireExistingResource: false); throw new IOException("Unknown missing recovery icon accepted."); }
            catch (ArgumentException) { }

            // Exercise real schema-2 profile deserialization/ownership checks without any native registration.
            using var user = WindowsIdentity.GetCurrent();
            var id = Guid.NewGuid(); var profile = Path.Combine(testRoot, "Profile"); var files = Path.Combine(testRoot, "Files");
            Directory.CreateDirectory(profile);
            foreach (var icon in new[] { ExplorerBrandIcon.LegacyResource, ExplorerBrandIcon.Resource })
            {
                await File.WriteAllTextAsync(Path.Combine(profile, "profile.json"), JsonSerializer.Serialize(new {
                    Schema = 2, Owner = "LedgeTop.Files.ExplorerPreview/1", Sid = user.User!.Value, Identity = id,
                    Root = files, Context = "LedgeTop.Files.ExplorerPreview/1:" + id.ToString("N"), Icon = icon,
                    RootFileId = 0, Phase = "Prepared", Paused = false, Revision = 1, NamespaceClsid = Guid.Empty
                }));
                await using var session = OwnedExplorerRootSession.Generated(profile, files);
                Require(session.HasOwnershipReceipt, "Existing profile schema/icon compatibility failed.");
            }
            using var source = new ExplorerDemoSource(signedIn: false);
            var scope = new ExplorerRootScope(source.Channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), source.PrincipalId);
            var profile3 = Path.Combine(testRoot, "ConnectedProfile"); Directory.CreateDirectory(profile3);
            foreach (var icon in new[] { ExplorerBrandIcon.LegacyResource, ExplorerBrandIcon.Resource })
            {
                await File.WriteAllTextAsync(Path.Combine(profile3, "profile.json"), JsonSerializer.Serialize(new {
                    Schema = 3, Owner = "LedgeTop.Files.ConnectedExplorer/1", Sid = user.User!.Value, Identity = id,
                    Root = files, Context = "LedgeTop.Files.ConnectedExplorer/1:" + id.ToString("N"), Icon = icon,
                    RootFileId = 0, Phase = "Prepared", Paused = false, Revision = 1, NamespaceClsid = Guid.Empty,
                    Binding = new { Scope = scope, File = "manifest-" + id.ToString("N") + ".json", Digest = new string('a', 64) }
                }));
                var before = await File.ReadAllBytesAsync(Path.Combine(profile3, "profile.json"));
                await using var session = new OwnedExplorerRootSession(profile3, files, source, scope);
                Require(session.HasOwnershipReceipt, "Connected schema-3 exact icon compatibility failed.");
                var after = await File.ReadAllBytesAsync(Path.Combine(profile3, "profile.json"));
                Require(before.AsSpan().SequenceEqual(after), "Legacy profile read rewrote migration data.");
            }
            // Real ownership JSON parser, without Start, source calls, root creation or native registration.
            foreach (var alias in new[] { "employee", "portal", "explorer-demo" }) {
                var profile4 = Path.Combine(testRoot, "Profile4-" + alias); Directory.CreateDirectory(profile4);
                var aliasScope = scope with { Alias = alias };
                var unused = new NeverCalledSource(alias, source.Origin);
                var node = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(profile3, "profile.json")))!.AsObject();
                node["Schema"] = 4;
                node["DisplayName"] = ExplorerRootDisplayName.ForConnectedAlias(alias);
                node["Binding"]!["Scope"]!["Alias"] = alias;
                var path = Path.Combine(profile4, "profile.json");
                await File.WriteAllTextAsync(path, node.ToJsonString());
                var expectedBytes = await File.ReadAllBytesAsync(path);
                await using (var accepted = new OwnedExplorerRootSession(profile4, files, unused, aliasScope))
                    Require(accepted.HasOwnershipReceipt, "Source-specific schema4 profile was refused.");
                var actualBytes = await File.ReadAllBytesAsync(path);
                Require(expectedBytes.AsSpan().SequenceEqual(actualBytes), "Schema4 read changed the profile.");
                foreach (var invalid in new string?[] { null, "unknown", alias == "portal" ? ExplorerRootDisplayName.Company : ExplorerRootDisplayName.Client }) {
                    node["DisplayName"] = invalid;
                    await File.WriteAllTextAsync(path, node.ToJsonString());
                    await using var rejected = new OwnedExplorerRootSession(profile4, files, unused, aliasScope);
                    Reject(() => { _ = rejected.HasOwnershipReceipt; });
                }
                Require(unused.Calls == 0, "Profile compatibility inspection contacted its source.");
            }
            // Ownership checks must still refuse another executable/icon path.
            var profileText = await File.ReadAllTextAsync(Path.Combine(profile, "profile.json"));
            await File.WriteAllTextAsync(Path.Combine(profile, "profile.json"), profileText.Replace(ExplorerBrandIcon.Resource.Replace("\\", "\\\\"), resource.Replace("\\", "\\\\"), StringComparison.Ordinal));
            await using (var session = OwnedExplorerRootSession.Generated(profile, files)) Reject(() => { _ = session.HasOwnershipReceipt; });
            Require(!Directory.Exists(files), "Brand-policy tests created a native files root.");
            Console.WriteLine("PASS approved embedded icon, durable reuse, tamper/type refusal, exact legacy/new schema-2/3 profiles, known-path-only recovery policy; no native registrations.");
            return 0;
        }
        finally { Directory.Delete(testRoot, recursive: true); }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new IOException(message); }
    private static void Reject(Action action) { try { action(); } catch (IOException) { return; } throw new IOException("Unsafe icon/profile was accepted."); }
    private sealed class NeverCalledSource(string alias, Uri origin) : IQueuedDownloadSource
    {
        public string Alias => alias;
        public Uri Origin => origin;
        public int Calls { get; private set; }
        private Exception Refuse() { Calls++; return new IOException("Profile inspection must not contact a source."); }
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw Refuse();
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw Refuse();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
            CancellationToken cancellationToken = default) => throw Refuse();
    }
}
