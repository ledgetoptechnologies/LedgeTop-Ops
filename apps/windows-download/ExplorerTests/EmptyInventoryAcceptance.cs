using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class EmptyInventoryAcceptance
{
    public static async Task<int> RunAsync()
    {
        var id = Guid.NewGuid();
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LedgeTopFilesExplorerEmptyInventoryTests", id.ToString("N"));
        Directory.CreateDirectory(directory);
        var phases = new List<string>();
        var failures = new List<string>();
        var results = new List<object>();
        var receipt = Path.Combine(directory, "receipt.json");
        void Save() => File.WriteAllText(receipt, JsonSerializer.Serialize(new {
            id, directory, phases, failures, results, utc = DateTimeOffset.UtcNow
        }, new JsonSerializerOptions { WriteIndented = true }));
        Save();
        using var source = new ExplorerDemoSource(signedIn: false);
        try
        {
            await InvalidManifests(directory, source);
            phases.Add("invalid manifests rejected before connection/native writes"); Save();
            await Scenario("empty", []);
            await Scenario("directories-only", ["Empty", "Empty\\Nested", "Second"]);
        }
        catch (Exception error) { failures.Add(error.ToString()); Save(); }
        Console.WriteLine(receipt);
        Console.WriteLine(JsonSerializer.Serialize(new { passed = failures.Count == 0, phases, failures }));
        return failures.Count == 0 ? 0 : 1;

        async Task Scenario(string name, string[] directories)
        {
            var generation = Guid.NewGuid();
            var root = Path.Combine(directory, name, "Files");
            var cache = Path.Combine(directory, name, "Cache");
            Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
            var shellId = ShellRegistration.CreateId(generation);
            var context = Encoding.UTF8.GetBytes("LedgeTop.EmptyInventoryAcceptance.v1:" + generation.ToString("N"));
            var icon = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3";
            ShellRegistration? registration = null;
            NativePlaceholderProvider? provider = null;
            var disconnected = true;
            var removalAttempted = false;
            SaveOwner("register-intent");
            try
            {
                registration = await ShellRegistration.RegisterAsync(root, shellId, icon, context);
                SaveOwner("registered");
                provider = Create();
                disconnected = false;
                await provider.ConnectAndPopulateAsync();
                ValidateTree();
                if (directories.Length != 0)
                {
                    provider.SetFolderAvailabilityIntent("Empty", true);
                    Require((Attributes(Path.Combine(root, "Empty")) & 0x80000) != 0, "Directory keep intent missing.");
                    provider.SetFolderAvailabilityIntent("Empty", false);
                    Require((Attributes(Path.Combine(root, "Empty")) & 0x100000) != 0, "Directory free intent missing.");
                }
                provider.ValidateForRemoval();
                await provider.DisposeAsync(); provider = null; disconnected = true;
                phases.Add(name + ": connected/populated exact inventory and disconnected"); SaveOwner("disconnected"); Save();
                registration = ShellRegistration.OpenOwned(root, shellId, context, icon,
                    registration.NamespaceClsid, registration.RootFileId);
                provider = Create(); disconnected = false;
                await provider.ConnectExistingAsync();
                ValidateTree(); provider.ValidateForRemoval();
                await provider.DisposeAsync(); provider = null; disconnected = true;
                phases.Add(name + ": reconnected unchanged inventory and drained"); SaveOwner("reconnected-and-drained"); Save();
            }
            catch (ShellRegistrationException error)
            {
                registration = error.OwnedPartial;
                throw;
            }
            finally
            {
                try
                {
                    if (provider is not null) { await provider.DisposeAsync(); provider = null; disconnected = true; }
                    if (registration is not null && disconnected)
                    {
                        registration.VerifyOwned();
                        await using (var verifier = Create()) verifier.ValidateForRemoval();
                        SaveOwner("unregister-intent"); removalAttempted = true;
                        registration.Unregister();
                        var observation = ShellRegistration.Inspect(root, shellId, context, registration.NamespaceClsid, icon);
                        Require(observation.CompleteAbsenceVerified, "Native, shell, or linked namespace cleanup incomplete.");
                        results.Add(new { name, generation, root, registration.RootFileId, registration.NamespaceClsid, observation });
                        phases.Add(name + ": one unregister, native/HKLM/linked-HKCU absence verified");
                        SaveOwner("removed"); Save();
                    }
                }
                catch (Exception cleanup)
                {
                    failures.Add(name + " cleanup: " + cleanup); SaveOwner("cleanup-held"); Save();
                }
            }
            NativePlaceholderProvider Create() => new(registration!, cache, source, source.Channel,
                source.PrincipalId, new Dictionary<string, PlaceholderIdentity>(), directories);
            void ValidateTree()
            {
                var actual = Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories)
                    .Select(path => Path.GetRelativePath(root, path)).Order(StringComparer.Ordinal).ToArray();
                Require(actual.SequenceEqual(directories.Order(StringComparer.Ordinal)), "Inventory differs or an unexpected child was created.");
                Require(!Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Any(), "Empty inventory generated a file.");
            }
            void SaveOwner(string phase) => File.WriteAllText(Path.Combine(directory, name + "-owner.json"),
                JsonSerializer.Serialize(new { generation, root, shellId, context = Convert.ToBase64String(context), icon,
                    rootFileId = registration?.RootFileId ?? 0, namespaceClsid = registration?.NamespaceClsid ?? Guid.Empty,
                    phase, disconnected, removalAttempted }, new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    private static async Task InvalidManifests(string directory, ExplorerDemoSource source)
    {
        var cache = Path.Combine(directory, "PureCache"); Directory.CreateDirectory(cache);
        var fake = new NoNativeRegistration(Path.Combine(directory, "NeverRegistered"));
        var identity = source.Entries[0].Identity;
        await Reject(new Dictionary<string, PlaceholderIdentity> { ["README.txt"] = identity }, ["README.txt"], "file/directory collision");
        await Reject(new Dictionary<string, PlaceholderIdentity> { ["README.txt"] = identity },
            Enumerable.Range(0, 1000).Select(n => "D" + n), "combined inventory limit");
        await Reject(new Dictionary<string, PlaceholderIdentity>(), [string.Join('\\', Enumerable.Repeat("d", 33))], "depth limit");
        await Reject(new Dictionary<string, PlaceholderIdentity>(), [new string('a', 181)], "path length limit");
        var oversized = identity with { ResourceReference = "odqr1_" + new string('a', 5000) };
        oversized.Validate();
        await Reject(new Dictionary<string, PlaceholderIdentity> { ["README.txt"] = oversized }, [], "native identity encoding limit");
        await Reject(new Dictionary<string, PlaceholderIdentity> { ["README.txt"] = identity with { Length = (64L << 30) + 1 } }, [],
            "native hydration file capacity");
        Require(!Directory.Exists(fake.Root), "Constructor validation wrote an unexpected root.");

        async Task Reject(IReadOnlyDictionary<string, PlaceholderIdentity> manifest, IEnumerable<string> dirs, string label)
        {
            try
            {
                await using var invalid = new NativePlaceholderProvider(fake, cache, source, source.Channel, source.PrincipalId, manifest, dirs);
            }
            catch (Exception error) when (error is IOException or TransferException or ArgumentException) { return; }
            throw new IOException("Invalid manifest accepted: " + label);
        }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new IOException(message); }
    private static uint Attributes(string path)
    {
        var previous = RtlSetThreadPlaceholderCompatibilityMode(2);
        if (previous < 0) throw new IOException("Placeholder inspection compatibility scope failed.");
        try { return (uint)File.GetAttributes(path); }
        finally { if (RtlSetThreadPlaceholderCompatibilityMode(previous) < 0) throw new IOException("Placeholder inspection compatibility scope restore failed."); }
    }
    [DllImport("ntdll.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern sbyte RtlSetThreadPlaceholderCompatibilityMode(sbyte mode);
    private sealed class NoNativeRegistration(string root) : IPreviewRootRegistration
    {
        public string Root => root;
        public void VerifyOwned() { }
        public void Unregister() => throw new InvalidOperationException("Pure validation must not unregister.");
    }
}
