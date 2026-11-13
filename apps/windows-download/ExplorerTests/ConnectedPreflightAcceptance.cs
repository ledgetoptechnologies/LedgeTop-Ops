using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class ConnectedPreflightAcceptance
{
    internal static async Task<int> RunAsync()
    {
        var id = Guid.NewGuid();
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LedgeTopFilesConnectedPreflightTests", id.ToString("N"));
        Directory.CreateDirectory(directory);
        var profileDirectory = Path.Combine(directory, "Profile"); var root = Path.Combine(directory, "Files");
        var phases = new List<string>(); var failures = new List<string>();
        OwnedExplorerRootSession? session = null;
        using var fixture = new ExplorerDemoSource(signedIn: false, chunkDelay: TimeSpan.Zero);
        var source = new CountingSource(fixture);
        var scope = new ExplorerRootScope(fixture.Channel, fixture.Alias, fixture.Origin.GetLeftPart(UriPartial.Authority), fixture.PrincipalId);
        var manifest = new ExplorerRootManifest(scope, fixture.Entries.ToDictionary(
            entry => entry.RelativePath.Replace('/', '\\'), entry => entry.Identity));
        Save();
        try {
            session = new(profileDirectory, root, source, scope, manifest);
            var refused = false;
            try { await session.StartAsync(); } catch (LoginRequiredException) { refused = true; }
            Require(refused && source.Sessions == 1 && source.Resolutions == 0 && source.Downloads == 0,
                "Signed-out preflight did not refuse before file metadata or content calls.");
            var prepared = Profile();
            Require(session.HasOwnershipReceipt && prepared["Schema"]!.GetValue<int>() == 4 &&
                prepared["Phase"]!.GetValue<string>() == "Prepared", "Signed-out preflight did not retain valid Prepared ownership.");
            Require(!Directory.Exists(root) && !File.Exists(root), "Signed-out preflight created a local root.");
            var bytes = File.ReadAllBytes(Path.Combine(profileDirectory, prepared["Binding"]!["File"]!.GetValue<string>()));
            Require(Hash(bytes) == manifest.Digest && prepared["Binding"]!["Digest"]!.GetValue<string>() == manifest.Digest,
                "Prepared profile does not bind the canonical frozen inventory.");
            var unusedShellId = ShellRegistration.CreateId(Guid.Parse(prepared["Identity"]!.GetValue<string>()));
            Require(ShellMetadataAbsent(unusedShellId), "Signed-out preflight established shell metadata.");
            File.WriteAllText(Path.Combine(directory, "prepared-before-cleanup.json"), prepared.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            phases.Add("signed-out Start saved schema4 Prepared + canonical inventory before auth refusal; no local root or exact HKLM metadata"); Save();
            await session.DisposeAsync(); session = null;

            var calls = source.Counts;
            session = new(profileDirectory, root, source, scope);
            Require(session.State == ExplorerPreviewState.Failed && session.HasOwnershipReceipt,
                "Reopened Prepared generation did not retain positive ownership evidence.");
            await session.RemoveAsync();
            Require(session.State == ExplorerPreviewState.Removed && Profile()["Phase"]!.GetValue<string>() == "Removed" &&
                source.Counts == calls && !Directory.Exists(root) && ShellMetadataAbsent(unusedShellId),
                "Prepared removal needed authentication or changed the absent root/registration state.");
            phases.Add("reopened Prepared receipt removed offline with zero new session/reference/byte calls"); Save();
            await session.DisposeAsync(); session = null;

            fixture.SignIn(); // Explicit synthetic fixture action only; no browser, helper or network.
            session = new(profileDirectory, root, source, scope, manifest);
            await session.StartAsync(); Require(session.State == ExplorerPreviewState.Running, "New signed-in generation did not run.");
            var registered = Profile();
            Require(registered["Identity"]!.GetValue<string>() != prepared["Identity"]!.GetValue<string>(), "Removed generation identity was reused.");
            var readmePath = Path.Combine(root, "README.txt");
            var readme = await File.ReadAllBytesAsync(readmePath).WaitAsync(TimeSpan.FromSeconds(35));
            Require(Hash(readme) == manifest.Files["README.txt"].Sha256, "Real native README hydration differs from frozen SHA.");
            await File.WriteAllTextAsync(Path.Combine(root, "local-notes.txt"), "Preflight acceptance local notes must survive.\r\n");
            phases.Add("explicit synthetic sign-in started a distinct full Shell generation and hydrated exact README SHA"); Save();
            fixture.Revoke(); calls = source.Counts;
            await session.RemoveAsync();
            Require(source.Counts == calls && session.State == ExplorerPreviewState.Removed && Profile()["Phase"]!.GetValue<string>() == "Removed",
                "Offline native removal contacted the revoked source or did not save Removed.");
            Require(Hash(File.ReadAllBytes(readmePath)) == manifest.Files["README.txt"].Sha256 &&
                File.ReadAllText(Path.Combine(root, "local-notes.txt")) == "Preflight acceptance local notes must survive.\r\n",
                "Offline native removal changed hydrated or ordinary local files.");
            var observation = ShellRegistration.Inspect(root,
                ShellRegistration.CreateId(Guid.Parse(registered["Identity"]!.GetValue<string>())),
                Encoding.UTF8.GetBytes(registered["Context"]!.GetValue<string>()),
                Guid.Parse(registered["NamespaceClsid"]!.GetValue<string>()), registered["Icon"]!.GetValue<string>(), ExplorerRootDisplayName.ResolveProfile(false,
                    registered["Schema"]!.GetValue<int>(), scope.Alias, registered.AsObject().ContainsKey("DisplayName"), registered["DisplayName"]?.GetValue<string>()));
            Require(observation.CompleteAbsenceVerified, "Supported unregister left native/HKLM/linked HKCU integration.");
            File.WriteAllText(Path.Combine(directory, "cleanup-observation.json"), JsonSerializer.Serialize(observation, new JsonSerializerOptions { WriteIndented = true }));
            phases.Add("revoked-source offline removal made zero new source calls; one unregister proved native/HKLM/linked-HKCU absence and preserved local files"); Save();
        }
        catch (Exception error) { failures.Add(error.ToString()); }
        finally {
            if (session is not null) {
                if (failures.Count != 0 && session.State != ExplorerPreviewState.Removed) {
                    try { await session.RemoveAsync(); phases.Add("failure cleanup: exact owned session removal completed"); }
                    catch (Exception error) { failures.Add("Exact cleanup held for ownership review: " + error); }
                }
                try { await session.DisposeAsync(); }
                catch (Exception error) { failures.Add("Drain could not be confirmed: " + error); }
            }
            Save();
        }
        Console.WriteLine(JsonSerializer.Serialize(new { passed = failures.Count == 0, phases, failures }));
        Console.WriteLine(Path.Combine(directory, "receipt.json"));
        return failures.Count == 0 ? 0 : 1;
        JsonObject Profile() => JsonNode.Parse(File.ReadAllText(Path.Combine(profileDirectory, "profile.json")))!.AsObject();
        void Save() => File.WriteAllText(Path.Combine(directory, "receipt.json"), JsonSerializer.Serialize(new {
            id, directory, root, profileDirectory, phases, failures,
            calls = new { source.Sessions, source.Resolutions, source.Downloads }, utc = DateTimeOffset.UtcNow
        }, new JsonSerializerOptions { WriteIndented = true }));
    }
    private static bool ShellMetadataAbsent(string id)
    {
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var exact = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager\" + id, false);
        return exact is null;
    }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static void Require(bool condition, string message) { if (!condition) throw new IOException(message); }
    private sealed class CountingSource(ExplorerDemoSource inner) : IQueuedDownloadSource
    {
        internal int Sessions, Resolutions, Downloads;
        internal (int Sessions, int Resolutions, int Downloads) Counts => (Volatile.Read(ref Sessions), Volatile.Read(ref Resolutions), Volatile.Read(ref Downloads));
        public string Alias => inner.Alias;
        public Uri Origin => inner.Origin;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        { Interlocked.Increment(ref Sessions); return inner.GetSessionAsync(cancellationToken); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default)
        { Interlocked.Increment(ref Resolutions); return inner.ResolveAsync(reference, cancellationToken); }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        { Interlocked.Increment(ref Downloads); return inner.DownloadAsync(spec, destination, progress, cancellationToken); }
    }
}
