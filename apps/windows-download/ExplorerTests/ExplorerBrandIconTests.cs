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
                await using var session = new OwnedExplorerRootSession(profile3, files, source, scope);
                Require(session.HasOwnershipReceipt, "Connected schema-3 exact icon compatibility failed.");
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
}
