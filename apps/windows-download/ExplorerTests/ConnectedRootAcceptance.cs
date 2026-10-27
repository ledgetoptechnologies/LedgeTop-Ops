using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class ConnectedRootAcceptance
{
    internal static async Task<int> RunAsync(string[] arguments)
    {
        if (arguments.Length == 2) return await Child(arguments[0], Guid.ParseExact(arguments[1], "N"));
        if (arguments.Length != 0) return 64;
        var id = Guid.NewGuid(); var directory = Base(id); Directory.CreateDirectory(directory);
        var phases = new List<string>(); var failures = new List<string>();
        var activeChild = false;
        try {
            foreach (var mode in new[] { "seed", "principal", "origin", "alias", "tamper", "version", "resume", "remove" }) {
                var start = new ProcessStartInfo(Environment.ProcessPath!) {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                };
                if (string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath), "dotnet", StringComparison.OrdinalIgnoreCase))
                    start.ArgumentList.Add(typeof(ConnectedRootAcceptance).Assembly.Location);
                start.ArgumentList.Add("--connected-root-acceptance"); start.ArgumentList.Add(mode); start.ArgumentList.Add(id.ToString("N"));
                using var child = Process.Start(start) ?? throw new IOException("Acceptance child did not start.");
                activeChild = true;
                var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(120)); activeChild = false;
                var stdout = await output; var stderr = await errors;
                File.WriteAllText(Path.Combine(directory, mode + "-output.txt"), stdout + stderr);
                Require(child.ExitCode == 0, mode + " acceptance failed: " + stderr);
                phases.Add(mode); Console.WriteLine("PASS connected root: " + mode);
                Save();
            }
        } catch (Exception error) { failures.Add(error.ToString()); }
        finally {
            if (failures.Count != 0 && !activeChild) {
                try { await OfflineRemove(id); phases.Add("failure cleanup: exact owned integration removed"); }
                catch (Exception error) { failures.Add("Cleanup held: " + error); }
            }
            Save();
        }
        Console.WriteLine(Path.Combine(directory, "receipt.json"));
        return failures.Count == 0 ? 0 : 1;
        void Save() => File.WriteAllText(Path.Combine(directory, "receipt.json"), JsonSerializer.Serialize(new {
            id, directory, phases, failures, activeChild, utc = DateTimeOffset.UtcNow
        }, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static async Task<int> Child(string mode, Guid id)
    {
        try {
            var directory = Base(id); var profile = Path.Combine(directory, "Profile"); var root = Path.Combine(directory, "Files");
            using var fixture = new ExplorerDemoSource(signedIn: true, chunkDelay: TimeSpan.Zero);
            var source = new MutatingSource(fixture);
            var scope = Scope(fixture);
            if (mode == "seed") {
                var manifest = new ExplorerRootManifest(scope, fixture.Entries.ToDictionary(e => e.RelativePath.Replace('/', '\\'), e => e.Identity), ["Explicit empty\\Nested"]);
                await using var session = new OwnedExplorerRootSession(profile, root, source, scope, manifest);
                await session.StartAsync(); Require(session.State == ExplorerPreviewState.Running, "Connected engine did not run.");
                var saved = ReadProfile(profile);
                Require(saved["Schema"]!.GetValue<int>() == 4 && saved["Owner"]!.GetValue<string>() == "LedgeTop.Files.ConnectedExplorer/1", "Generated facade was used instead of connected schema4.");
                var sidecar = Path.Combine(profile, saved["Binding"]!["File"]!.GetValue<string>());
                var bytes = File.ReadAllBytes(sidecar);
                Require(Hash(bytes) == manifest.Digest && saved["Binding"]!["Digest"]!.GetValue<string>() == manifest.Digest, "Frozen manifest digest was not persisted.");
                var text = Encoding.UTF8.GetString(bytes);
                Require(!text.Contains("/content/", StringComparison.Ordinal) && !text.Contains("ContentUri", StringComparison.Ordinal), "Sidecar retained a byte URL.");
                var csv = await File.ReadAllBytesAsync(Path.Combine(root, "Samples", "sample.csv")).WaitAsync(TimeSpan.FromSeconds(35));
                Require(Hash(csv) == manifest.Files["Samples\\sample.csv"].Sha256, "Seed hydration differs from frozen identity.");
                await File.WriteAllTextAsync(Path.Combine(root, "local-notes.txt"), "Owned connected acceptance local notes.\r\n");
                await session.PauseAsync(); await session.DisposeAsync();
                File.WriteAllText(Path.Combine(directory, "seed-owner.json"), saved.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine("Frozen schema3 manifest saved before root effects; generated fixture explicitly signed in; paused root retained.");
                return 0;
            }
            if (mode == "remove") { await OfflineRemove(id); return 0; }
            if (mode == "tamper") { await Tamper(id, fixture); return 0; }
            var before = File.ReadAllBytes(Path.Combine(profile, "profile.json"));
            if (mode is "principal" or "origin" or "alias") {
                source.Mode = mode;
                await using var refused = new OwnedExplorerRootSession(profile, root, source, scope);
                await Refuse(refused.StartAsync);
                Require(File.ReadAllBytes(Path.Combine(profile, "profile.json")).AsSpan().SequenceEqual(before), "Scope drift changed the durable profile.");
                Require(source.Downloads == 0 && source.Resolutions == 0, "Scope drift reached file content metadata.");
                VerifyPresent(profile, root);
                Console.WriteLine("Source " + mode + " drift refused without replacing or unregistering root."); return 0;
            }
            await using var reopened = new OwnedExplorerRootSession(profile, root, source, scope);
            Require(reopened.FrozenManifest is not null, "A separate process could not load frozen inventory without initial capture.");
            await reopened.StartAsync(); Require(reopened.State == ExplorerPreviewState.Paused, "Persisted pause was lost.");
            Require(Hash(await File.ReadAllBytesAsync(Path.Combine(root, "Samples", "sample.csv"))) == reopened.FrozenManifest!.Files["Samples\\sample.csv"].Sha256,
                "Cached paused file changed on reconnect.");
            if (mode == "version") {
                source.Mode = "version"; await reopened.ResumeAsync();
                var denied = false;
                try { await File.ReadAllBytesAsync(Path.Combine(root, "README.txt")).WaitAsync(TimeSpan.FromSeconds(35)); }
                catch (IOException) { denied = true; }
                Require(denied && source.Resolutions > 0 && source.Downloads == 0, "Changed version reached bytes or was not refused.");
                await reopened.PauseAsync();
                Console.WriteLine("Frozen file version drift refused at hydration before source bytes."); return 0;
            }
            Require(mode == "resume", "Unknown child mode.");
            fixture.Revoke(); await Refuse(reopened.ResumeAsync);
            Require(reopened.State == ExplorerPreviewState.Failed, "Expired cached auth did not stop provider.");
            await reopened.DisposeAsync(); fixture.SignIn();
            await using var signedIn = new OwnedExplorerRootSession(profile, root, source, scope);
            await signedIn.StartAsync(); await signedIn.ResumeAsync();
            var readme = await File.ReadAllBytesAsync(Path.Combine(root, "README.txt")).WaitAsync(TimeSpan.FromSeconds(35));
            Require(Hash(readme) == signedIn.FrozenManifest!.Files["README.txt"].Sha256, "Current cached auth did not restore exact frozen file hydration.");
            await signedIn.PauseAsync();
            Console.WriteLine("Resume uses cached source authentication; revoked source refused; explicit fixture sign-in restored exact hydration.");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static async Task OfflineRemove(Guid id)
    {
        var directory = Base(id); var profile = Path.Combine(directory, "Profile"); var root = Path.Combine(directory, "Files");
        if (!File.Exists(Path.Combine(profile, "profile.json"))) return;
        var saved = ReadProfile(profile);
        using var fixture = new ExplorerDemoSource(signedIn: false); var source = new MutatingSource(fixture) { DenySession = true };
        await using var session = new OwnedExplorerRootSession(profile, root, source, Scope(fixture));
        await session.RemoveAsync(); Require(session.State == ExplorerPreviewState.Removed, "Offline removal did not complete.");
        Require(source.Sessions == 0 && source.Resolutions == 0 && source.Downloads == 0, "Offline removal called authentication or source metadata.");
        var identity = Guid.Parse(saved["Identity"]!.GetValue<string>());
        var context = Encoding.UTF8.GetBytes(saved["Context"]!.GetValue<string>());
        var observation = ShellRegistration.Inspect(root, ShellRegistration.CreateId(identity), context,
            Guid.Parse(saved["NamespaceClsid"]!.GetValue<string>()), saved["Icon"]!.GetValue<string>(), DisplayName(saved));
        Require(observation.CompleteAbsenceVerified, "Offline removal left native/shell/linked namespace integration.");
        Require(File.ReadAllText(Path.Combine(root, "local-notes.txt")) == "Owned connected acceptance local notes.\r\n", "Removal changed local notes.");
        var expected = fixture.Entries.Single(e => e.RelativePath == "Samples/sample.csv").Identity.Sha256;
        Require(Hash(File.ReadAllBytes(Path.Combine(root, "Samples", "sample.csv"))) == expected, "Removal changed retained hydrated bytes.");
        File.WriteAllText(Path.Combine(directory, "cleanup-observation.json"), JsonSerializer.Serialize(observation, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine("Offline removal made no session/reference/byte requests; local notes and hydrated CSV preserved; all integration absence verified.");
    }

    private static async Task Tamper(Guid id, ExplorerDemoSource fixture)
    {
        var directory = Base(id); var original = Path.Combine(directory, "Profile"); var root = Path.Combine(directory, "Files");
        var originalProfile = ReadProfile(original); var file = originalProfile["Binding"]!["File"]!.GetValue<string>();
        var manifest = File.ReadAllBytes(Path.Combine(original, file));
        foreach (var mode in new[] { "malformed", "digest", "foreign-profile" }) {
            var clone = Path.Combine(directory, "Invalid", mode); Directory.CreateDirectory(clone);
            var profile = originalProfile.DeepClone(); var bytes = manifest;
            if (mode == "malformed") { bytes = "{}"u8.ToArray(); profile["Binding"]!["Digest"] = Hash(bytes); }
            if (mode == "digest") bytes = manifest.Concat(new byte[] { 32 }).ToArray();
            if (mode == "foreign-profile") profile["Owner"] = "Foreign.Owner";
            File.WriteAllText(Path.Combine(clone, "profile.json"), profile.ToJsonString()); File.WriteAllBytes(Path.Combine(clone, file), bytes);
            var source = new MutatingSource(fixture);
            await using var refused = new OwnedExplorerRootSession(clone, root, source, Scope(fixture));
            await Refuse(refused.StartAsync);
            Require(source.Resolutions == 0 && source.Downloads == 0, "Invalid persisted ownership reached source file metadata.");
            VerifyPresent(original, root);
        }
        Console.WriteLine("Malformed canonical sidecar, digest mismatch and foreign profile refused before integration changes.");
    }

    private static void VerifyPresent(string directory, string root)
    {
        var profile = ReadProfile(directory);
        var observation = ShellRegistration.Inspect(root, ShellRegistration.CreateId(Guid.Parse(profile["Identity"]!.GetValue<string>())),
            Encoding.UTF8.GetBytes(profile["Context"]!.GetValue<string>()), Guid.Parse(profile["NamespaceClsid"]!.GetValue<string>()), profile["Icon"]!.GetValue<string>(), DisplayName(profile));
        Require(observation.ExpectedNativeIdentityMatches && observation.ExactShellMetadataPresent &&
            observation.RootFileId == profile["RootFileId"]!.GetValue<long>(), "Failed startup changed actual root ownership.");
    }
    private static JsonObject ReadProfile(string directory) => JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "profile.json")))!.AsObject();
    private static string Base(Guid id) => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFilesConnectedRootTests", id.ToString("N"));
    private static string DisplayName(System.Text.Json.Nodes.JsonNode profile) => ExplorerRootDisplayName.ResolveProfile(false,
        profile["Schema"]!.GetValue<int>(), "explorer-demo", profile.AsObject().ContainsKey("DisplayName"), profile["DisplayName"]?.GetValue<string>());
    private static ExplorerRootScope Scope(ExplorerDemoSource source) => new(source.Channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), source.PrincipalId);
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static void Require(bool condition, string message) { if (!condition) throw new IOException(message); }
    private static async Task Refuse(Func<Task> action)
    {
        try { await action(); } catch (Exception error) when (error is IOException or AccessDeniedException or LoginRequiredException or TransferException) { return; }
        throw new IOException("An invalid source/profile was accepted.");
    }
    private sealed class MutatingSource(ExplorerDemoSource inner) : IQueuedDownloadSource
    {
        internal string Mode = "";
        internal bool DenySession;
        internal int Sessions, Resolutions, Downloads;
        public string Alias => Mode == "alias" ? "other-source" : inner.Alias;
        public Uri Origin => Mode == "origin" ? new("https://other.invalid/") : inner.Origin;
        public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref Sessions); if (DenySession) throw new IOException("Offline removal attempted a session request.");
            var current = await inner.GetSessionAsync(cancellationToken);
            return Mode == "principal" ? current with { PrincipalId = "odqp1_" + new string('f', 64) } : current;
        }
        public async Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref Resolutions); var result = await inner.ResolveAsync(reference, cancellationToken);
            return Mode == "version" ? result with { RemoteVersion = "new-version", Spec = result.Spec with { OpaqueIdentity = result.LogicalFileId + ":new-version" } } : result;
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        { Interlocked.Increment(ref Downloads); return inner.DownloadAsync(spec, destination, progress, cancellationToken); }
    }
}
