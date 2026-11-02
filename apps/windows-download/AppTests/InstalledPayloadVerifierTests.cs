using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using LedgeTop.Files.Updates;

internal static class InstalledPayloadVerifierTests
{
    private static readonly string Commit = new('a', 40);
    private const string Version = "1.2.3.4";
    internal static async Task Run()
    {
        ParserRefusals();
        MarkerRefusals();
        await EmptyDirectoryFenceLifecycle();
        await DirectoryListAccessDenied();
        using (var fixture = new Fixture(includeOrdinaryInstallerIni: true)) {
            await using (var verified = await fixture.Verify()) {
                Require(verified.AppHostSha256 == Hash(fixture.Payload["LedgeTop.Files.exe"]) && verified.ManagedAssemblySha256 == Hash(fixture.Payload["LedgeTop.Files.dll"]) &&
                    verified.HelperSha256 == fixture.HelperHash && verified.Version == Version && verified.SourceCommit == Commit && verified.PayloadManifestSha256 == fixture.ManifestHash,
                    "trusted anchor, marker and all payload hashes are bound in the retained result");
                Require(fixture.Payload.ContainsKey("installer.ini"), "ordinary inventoried installer.ini is permitted without becoming protocol metadata");
                await Refuses(() => { using var stream = File.Open(fixture.PathOf("LedgeTop.Files.exe"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); }, "retained payload handle denies write");
                await Refuses(() => File.Delete(fixture.PathOf("LedgeTop.Files.dll")), "retained payload handle denies deletion");
                await Refuses(() => Directory.Move(fixture.Root, fixture.Root + "-moved"), "retained directory handle denies root rename");
                fixture.Write("unexpected.dll", [1]);
                await Refuses(() => verified.RevalidateAsync(default), "pre-handoff recheck refuses newly created extras");
                File.Delete(fixture.PathOf("unexpected.dll"));
                await verified.RevalidateAsync(default);
            }
            // Disposal releases the boundary; the fixture remains caller-owned and writable.
            File.WriteAllBytes(fixture.PathOf("LedgeTop.Files.exe"), fixture.Payload["LedgeTop.Files.exe"]);
        }
        foreach (var fault in new[] { "manifest-hash", "helper-pin", "source-commit", "version", "owner", "payload-hash", "missing", "extra", "empty-extra-directory", "marker-duplicate", "sidecar-whitespace" }) {
            using var fixture = new Fixture();
            var manifest = fixture.ManifestHash; var helper = fixture.HelperHash; var source = Commit; var version = Version;
            switch (fault) {
                case "manifest-hash": manifest = new string('0', 64); break;
                case "helper-pin": helper = new string('0', 64); break;
                case "source-commit": source = new string('b', 40); break;
                case "version": version = "1.2.3.5"; break;
                case "owner": fixture.WriteMarker("other-owner"); break;
                case "payload-hash": fixture.Write("LedgeTop.Files.exe", [9, 9, 9]); break;
                case "missing": File.Delete(fixture.PathOf("LedgeTop.Files.dll")); break;
                case "extra": fixture.Write("unexpected.ini", [1]); break;
                case "empty-extra-directory": fixture.MakeDirectory("extra"); break;
                case "marker-duplicate": File.AppendAllText(fixture.PathOf(InstalledPayloadVerifier.MarkerName), "Owner=" + InstalledPayloadVerifier.Owner + "\r\n"); break;
                case "sidecar-whitespace": File.AppendAllText(fixture.PathOf(InstalledPayloadVerifier.InventoryName), " "); break;
            }
            await Refuses(() => InstalledPayloadVerifier.VerifyAsync(fixture.Root, version, source, manifest, helper, default), "installed fixture refuses " + fault);
            // Failed verification must release every acquired handle.
            using var writable = File.Open(fixture.PathOf(InstalledPayloadVerifier.MarkerName), FileMode.Open, FileAccess.Write, FileShare.None);
        }
        using (var fixture = new Fixture(bomAndWhitespace: true, utf16Marker: true)) {
            await using var verified = await fixture.Verify();
            Require(verified.PayloadManifestSha256 == fixture.ManifestHash, "raw BOM/whitespace hash and strict UTF16LE NSIS marker accepted");
        }
        using (var fixture = new Fixture()) {
            using var cancel = new CancellationTokenSource(); cancel.Cancel();
            await Refuses(() => InstalledPayloadVerifier.VerifyAsync(fixture.Root, Version, Commit, fixture.ManifestHash, fixture.HelperHash, cancel.Token), "cancellation refuses and releases owned handles");
        }
        using (var fixture = new Fixture()) {
            File.Delete(fixture.PathOf("LedgeTop.Files.dll"));
            Require(CreateHardLinkW(fixture.PathOf("LedgeTop.Files.dll"), fixture.PathOf("LedgeTop.Files.exe"), IntPtr.Zero), "owned NTFS hardlink fixture created");
            await Refuses(() => fixture.Verify(), "multiple-link payload alias refused before hash acceptance");
        }
        using (var fixture = new Fixture()) {
            File.Delete(fixture.PathOf("LedgeTop.Files.dll"));
            var created = false;
            try {
                File.CreateSymbolicLink(fixture.PathOf("LedgeTop.Files.dll"), fixture.PathOf("LedgeTop.Files.exe"));
                created = true;
            } catch (Exception error) when (error is UnauthorizedAccessException || error is IOException && error.HResult == unchecked((int)0x80070522)) {
                Console.WriteLine("Installed payload verifier: file-symlink fixture unavailable without local symlink privilege; reparse acceptance remains pending this optional fixture.");
            }
            if (created) await Refuses(() => fixture.Verify(), "owned payload reparse alias refused");
        }
        Console.WriteLine("Installed payload verifier: strict anchored parser, owned local fixtures, tamper/extra/missing refusal and retained-handle boundary passed. No installed profiles, registry, installer/app/provider execution or authentication.");
    }

    private static async Task EmptyDirectoryFenceLifecycle()
    {
        // Isolated generated path with no held child files: the earlier payload-root
        // rename test could also be blocked by files rather than the directory handle.
        using var fixture = new Fixture(); fixture.MakeDirectory("empty-fenced");
        var directory = fixture.PathOf("empty-fenced"); var renamed = fixture.PathOf("empty-fenced-moved");
        await using (var fence = new VerifiedInstalledPayload(directory)) {
            fence.HoldDirectory(directory);
            await Refuses(() => Directory.Move(directory, renamed), "directory handle alone must refuse rename while held");
            Require(Directory.Exists(directory) && !Directory.Exists(renamed), "failed rename leaves fixture at its original path");
            var child = Path.Combine(directory, "temporary.txt"); File.WriteAllText(child, "synthetic"); File.Delete(child);
            await fence.RevalidateAsync(default); // rechecks held directory handle + empty tree
        }
        Directory.Move(directory, renamed); Directory.Move(renamed, directory);
        Require(Directory.Exists(directory) && !Directory.Exists(renamed), "disposing the fence releases the generated directory");
    }

    private static async Task DirectoryListAccessDenied()
    {
        using var fixture = new Fixture(); fixture.MakeDirectory("no-list");
        var directory = fixture.PathOf("no-list"); var info = new DirectoryInfo(directory);
        var original = info.GetAccessControl(AccessControlSections.Access); var descriptor = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        using var identity = WindowsIdentity.GetCurrent(); var sid = identity.User ?? throw new IOException("Current SID unavailable.");
        try {
            var denied = info.GetAccessControl(AccessControlSections.Access); denied.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.ListDirectory, AccessControlType.Deny));
            info.SetAccessControl(denied);
            Require((File.GetAttributes(directory) & FileAttributes.Directory) != 0, "metadata remains visible when listing is denied");
            await using var fence = new VerifiedInstalledPayload(directory);
            await Refuses(() => fence.HoldDirectory(directory), "list-denied directory must fail closed");
        } finally {
            var restored = new DirectorySecurity(); restored.SetSecurityDescriptorSddlForm(descriptor, AccessControlSections.Access); info.SetAccessControl(restored);
        }
    }

    private static void ParserRefusals()
    {
        var hash = new string('a', 64);
        string Row(string path, string bytes = "1") => "{\"path\":" + JsonSerializer.Serialize(path) + ",\"bytes\":" + bytes + ",\"sha256\":\"" + hash + "\"}";
        var bad = new List<string> {
            "{}", "[]", "[null]", "[" + Row("a") + "," + Row("A") + "]", "[" + Row("a") + "," + Row("a/b") + "]",
            "[" + Row("Dir/a") + "," + Row("dir/b") + "]", "[" + Row("a", "-1") + "]", "[" + Row("a", "1.5") + "]",
            "[" + Row("a", "2147483649") + "]", "[" + Row("a", "1073741825") + "]", "[" + Row("a", "true") + "]",
            "[{\"path\":\"a\",\"path\":\"b\",\"bytes\":1,\"sha256\":\"" + hash + "\"}]",
            "[{\"Path\":\"a\",\"bytes\":1,\"sha256\":\"" + hash + "\"}]",
            "[{\"path\":\"a\",\"bytes\":1,\"sha256\":\"" + hash.ToUpperInvariant() + "\",\"extra\":0}]",
            "[" + Row("a") + ",]", "/*comment*/[" + Row("a") + "]",
            "[" + string.Join(',', Enumerable.Range(0, 4097).Select(i => Row("p" + i))) + "]"
        };
        foreach (var path in new[] { "../escape", "/root", "C:/drive", "a\\b", "a//b", "a/./b", "a/../b", "a.", "a ", "a:b", "CON.txt", "com¹", "NUL", "a\u202Eb", "a!b", "a$b", "a`b", "installer-owned.ini", "uninstall.exe", "installed-payload-inventory.json", "INSTALLED-PAYLOAD-INVENTORY.JSON/child", new string('a', 151), "a/" + new string('b', 150) + "/" + new string('c', 100) }) bad.Add("[" + Row(path) + "]");
        foreach (var json in bad) RefusesSync(() => InstalledPayloadVerifier.ParseInventory(Encoding.UTF8.GetBytes(json)), "strict inventory refuses invalid form");
        RefusesSync(() => InstalledPayloadVerifier.ParseInventory(new byte[8 * 1024 * 1024 + 1]), "manifest byte cap precedes parsing");
        RefusesSync(() => InstalledPayloadVerifier.ParseInventory(new byte[] { 0xff }), "invalid UTF8 refused");
        var valid = InstalledPayloadVerifier.ParseInventory(Encoding.UTF8.GetBytes("[" + Row("a", "0") + "]")); Require(valid.Count == 1 && valid[0].Bytes == 0, "empty regular payload file supported");
    }
    private static void MarkerRefusals()
    {
        var valid = "[Installer]\r\nOwner=" + InstalledPayloadVerifier.Owner + "\r\nVersion=" + Version + "\r\nPayloadManifestSha256=" + new string('a', 64) + "\r\nSourceCommit=" + Commit + "\r\n";
        Require(InstalledPayloadVerifier.ParseMarker(Encoding.UTF8.GetBytes(valid)).Version == Version, "exact bounded INI accepted");
        foreach (var text in new[] { valid + "Version=" + Version, valid + "[Other]\r\n", valid.Replace("Owner=", "owner=", StringComparison.Ordinal), valid.Replace("Version=1", "Version=01", StringComparison.Ordinal), valid.Replace("[Installer]", ";comment\r\n[Installer]", StringComparison.Ordinal), valid.Replace("SourceCommit=", "Other=", StringComparison.Ordinal), valid + "\0" })
            RefusesSync(() => InstalledPayloadVerifier.ParseMarker(Encoding.UTF8.GetBytes(text)), "strict INI rejects aliases and duplicate/unknown fields");
    }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(string newName, string existingName, IntPtr security);
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static void RefusesSync(Action action, string message)
    {
        try { action(); } catch (Exception e) when (e is InvalidDataException or IOException or UnauthorizedAccessException or JsonException or DecoderFallbackException or OverflowException or OperationCanceledException) { return; }
        throw new InvalidOperationException(message);
    }
    private static Task Refuses(Action action, string message) { RefusesSync(action, message); return Task.CompletedTask; }
    private static async Task Refuses(Func<Task> action, string message)
    {
        try { await action(); } catch (Exception e) when (e is InvalidDataException or IOException or UnauthorizedAccessException or JsonException or DecoderFallbackException or OverflowException or OperationCanceledException) { return; }
        throw new InvalidOperationException(message);
    }
    private sealed class Fixture : IDisposable
    {
        private readonly HashSet<string> files = new(StringComparer.OrdinalIgnoreCase), directories = new(StringComparer.OrdinalIgnoreCase);
        internal string Root { get; }
        internal Dictionary<string, byte[]> Payload { get; } = new(StringComparer.Ordinal) { ["LedgeTop.Files.exe"] = [1, 2, 3], ["LedgeTop.Files.dll"] = [4, 5], [InstalledPayloadVerifier.HelperName] = [6, 7, 8, 9] };
        internal string ManifestHash { get; }
        internal string HelperHash => Hash(Payload[InstalledPayloadVerifier.HelperName]);
        internal Fixture(bool bomAndWhitespace = false, bool utf16Marker = false, bool includeOrdinaryInstallerIni = false)
        {
            // This test binary is built in the owned task workspace; never use user install/profile roots.
            var parent = Path.Combine(AppContext.BaseDirectory, ".pv"); Directory.CreateDirectory(parent);
            Root = Path.Combine(parent, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Root);
            if (includeOrdinaryInstallerIni) Payload.Add("installer.ini", Encoding.UTF8.GetBytes("ordinary inventoried payload bytes"));
            foreach (var file in Payload) Write(file.Key, file.Value);
            var json = JsonSerializer.Serialize(Payload.Select(item => new { path = item.Key, bytes = item.Value.Length, sha256 = Hash(item.Value) }));
            var raw = Encoding.UTF8.GetBytes(bomAndWhitespace ? " \r\n" + json + " \r\n" : json);
            if (bomAndWhitespace) raw = new byte[] { 239, 187, 191 }.Concat(raw).ToArray();
            ManifestHash = Hash(raw); Write(InstalledPayloadVerifier.InventoryName, raw);
            WriteMarker(InstalledPayloadVerifier.Owner, utf16Marker); Write("uninstall.exe", [0]);
        }
        internal string PathOf(string relative) => Path.Combine(Root, relative.Replace('/', '\\'));
        internal void MakeDirectory(string relative) { Directory.CreateDirectory(PathOf(relative)); directories.Add(relative); }
        internal void Write(string relative, byte[] bytes)
        {
            var parent = Path.GetDirectoryName(relative.Replace('/', '\\'));
            if (!string.IsNullOrEmpty(parent)) MakeDirectory(parent);
            File.WriteAllBytes(PathOf(relative), bytes); files.Add(relative);
        }
        internal void WriteMarker(string owner, bool utf16 = false)
        {
            var text = "[Installer]\r\nOwner=" + owner + "\r\nVersion=" + Version + "\r\nPayloadManifestSha256=" + ManifestHash + "\r\nSourceCommit=" + Commit + "\r\n";
            var raw = utf16 ? Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes(text)).ToArray() : Encoding.UTF8.GetBytes(text);
            Write(InstalledPayloadVerifier.MarkerName, raw);
        }
        internal Task<VerifiedInstalledPayload> Verify() => InstalledPayloadVerifier.VerifyAsync(Root, Version, Commit, ManifestHash, HelperHash, default);
        public void Dispose()
        {
            // Only explicitly recorded paths under this fresh GUID fixture; no recursive deletion.
            foreach (var file in files) File.Delete(PathOf(file));
            foreach (var directory in directories.OrderByDescending(path => path.Length)) Directory.Delete(PathOf(directory));
            Directory.Delete(Root);
        }
    }
}
