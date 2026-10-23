using System.Security.Cryptography;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

internal static class BackendModeTests
{
    public static async Task Run()
    {
        var folder = Path.Combine(Path.GetTempPath(), "ltfiles-backend-mode-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        var binary = Path.Combine(folder, "owned-not-executable.exe");
        // These inert owned bytes are hashed for constructor validation only. Never execute this file.
        await File.WriteAllBytesAsync(binary, "synthetic constructor fixture, not executable"u8.ToArray());
        var pin = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(binary)));
        var settings = new LiveSettings(new Uri("https://portal.example.invalid/portal"),
            new Uri("https://ops.example.invalid/operations"), binary, pin);
        var bad = new Uri("http://unselected.example.invalid/");
        await using (var client = new LiveBackend(settings with { StaffApplicationUrl = bad }, folder)) {
            Equal("portal", client.Sources.Single().Alias);
            Equal("portal.example.invalid", client.Sources.Single().Origin.Host);
            Equal("deliveries", (await client.Catalog.GetSectionsAsync()).Single().Key);
            await Refuses<ResourceUnavailableException>(() => client.Catalog.GetChildrenAsync(new("server", "server", NodeKind.Section, "employee")));
            await Refuses<ResourceUnavailableException>(() => client.Catalog.ListAsync(new("foreign", "foreign", NodeKind.Folder, "employee")));
            await Refuses<ResourceUnavailableException>(() => client.Catalog.GetReferenceAsync(new("foreign", "foreign", 1, true, "employee")));
        }
        await using (var employee = new LiveBackend(settings with { PortalApplicationUrl = bad }, folder, AccessMode.Employee)) {
            Equal("employee", employee.Sources.Single().Alias);
            Equal("ops.example.invalid", employee.Sources.Single().Origin.Host);
            Equal("server", (await employee.Catalog.GetSectionsAsync()).Single().Key);
            await Refuses<ResourceUnavailableException>(() => employee.Catalog.GetChildrenAsync(new("deliveries", "deliveries", NodeKind.Section, "portal")));
            await Refuses<ResourceUnavailableException>(() => employee.Catalog.ListAsync(new("foreign", "foreign", NodeKind.Folder, "portal")));
            await Refuses<ResourceUnavailableException>(() => employee.Catalog.GetReferenceAsync(new("foreign", "foreign", 1, true, "portal")));
        }
        // The selected URL still passes through Core's origin restrictions, not just the test seam.
        Throws<ArgumentException>(() => new LiveBackend(settings with { PortalApplicationUrl = bad }, folder, AccessMode.Client));
        Throws<ArgumentException>(() => new LiveBackend(settings with { StaffApplicationUrl = bad }, folder, AccessMode.Employee));
        Throws<ArgumentOutOfRangeException>(() => new LiveBackend(settings with { CloudflaredPath = "not-a-helper" }, folder, (AccessMode)999));
        Throws<SettingsException>(() => new LiveBackend(settings with { StaffApplicationUrl = null, CloudflaredPath = "not-a-helper" }, folder, AccessMode.Employee));
        var calls = 0;
        LiveBackend.SelectedBackend Factory(LiveSettings _, AccessMode mode) {
            calls++;
            throw new Exception("factory must not run");
        }
        Throws<ArgumentOutOfRangeException>(() => new LiveBackend(settings, folder, (AccessMode)999, Factory));
        Throws<SettingsException>(() => new LiveBackend(settings with { StaffApplicationUrl = null }, folder, AccessMode.Employee, Factory));
        Equal(0, calls);
        // Missing staff is valid in client mode even through the actual constructor.
        await using (var client = new LiveBackend(settings with { StaffApplicationUrl = null }, folder, AccessMode.Client))
            Equal("portal", client.Sources.Single().Alias);

        foreach (var mode in Enum.GetValues<AccessMode>()) {
            var alias = mode == AccessMode.Client ? "portal" : "employee";
            var other = mode == AccessMode.Client ? "employee" : "portal";
            var session = new Session(); var catalog = new Catalog(); var source = new Source(alias);
            var factories = 0; var disposals = 0;
            var backend = new LiveBackend(settings, folder, mode, (actualSettings, actualMode) => {
                Equal(settings, actualSettings); Equal(mode, actualMode); factories++;
                return new(session, catalog, source, () => disposals++);
            });
            Equal(1, factories); Equal(1, backend.Sources.Count); Equal(source, backend.Sources.Single());
            await backend.Session.SignInAsync(); Equal(1, session.Logins);
            Equal("synthetic", (await backend.Session.TryCurrentAsync())!.PrincipalId); Equal(1, session.Probes);
            var section = (await backend.Catalog.GetSectionsAsync()).Single(); Equal(alias, section.SourceAlias);
            await backend.Catalog.GetChildrenAsync(section); Equal(1, catalog.Children);
            await backend.Catalog.ListAsync(new("folder", "folder", NodeKind.Folder, alias)); Equal(1, catalog.Lists);
            Equal("reference", await backend.Catalog.GetReferenceAsync(new("file", "file", 1, true, alias))); Equal(1, catalog.References);
            await Refuses<ResourceUnavailableException>(() => backend.Catalog.GetChildrenAsync(section with { SourceAlias = other }));
            await Refuses<ResourceUnavailableException>(() => backend.Catalog.GetChildrenAsync(section with { Key = "foreign" }));
            await Refuses<ResourceUnavailableException>(() => backend.Catalog.ListAsync(new("x", "x", NodeKind.Folder, other)));
            await Refuses<ResourceUnavailableException>(() => backend.Catalog.GetReferenceAsync(new("x", "x", 1, true, other)));
            Equal(1, catalog.Children); Equal(1, catalog.Lists); Equal(1, catalog.References);
            session.Denied = true;
            await Refuses<AccessDeniedException>(() => backend.Session.SignInAsync());
            await Refuses<AccessDeniedException>(() => backend.Session.TryCurrentAsync());
            catalog.Denied = true;
            await Refuses<AccessDeniedException>(() => backend.Catalog.GetChildrenAsync(section));
            Equal(1, factories); Equal(2, session.Logins); Equal(2, session.Probes);
            await backend.DisposeAsync(); await backend.DisposeAsync(); Equal(1, disposals);
        }
        await using var full = new DemoBackend(folder, signedIn: true);
        Equal(2, full.Sources.Count); Equal(2, (await full.Catalog.GetSectionsAsync()).Count);
        foreach (var mode in Enum.GetValues<AccessMode>()) {
            await using var demo = new DemoBackend(folder, signedIn: true, mode: mode);
            var alias = mode == AccessMode.Client ? "portal" : "employee";
            Equal(alias, demo.Sources.Single().Alias);
            var section = (await demo.Catalog.GetSectionsAsync()).Single(); Equal(alias, section.SourceAlias);
            var root = (await demo.Catalog.GetChildrenAsync(section)).Nodes.First();
            var listing = await demo.Catalog.ListAsync(root);
            await demo.Catalog.GetReferenceAsync(listing.Files.First());
            var foreign = (await full.Catalog.GetSectionsAsync()).Single(value => value.SourceAlias != alias);
            await Refuses<ResourceUnavailableException>(() => demo.Catalog.GetChildrenAsync(foreign));
            var foreignRoot = (await full.Catalog.GetChildrenAsync(foreign)).Nodes.First();
            var foreignFile = (await full.Catalog.ListAsync(foreignRoot)).Files.First();
            await Refuses<ResourceUnavailableException>(() => demo.Catalog.ListAsync(foreignRoot));
            await Refuses<ResourceUnavailableException>(() => demo.Catalog.GetReferenceAsync(foreignFile));
        }
        Throws<ArgumentOutOfRangeException>(() => new DemoBackend(folder, mode: (AccessMode)999));
        Console.WriteLine("Backend modes: real constructor isolation and synthetic routing/session/disposal checks passed; no helper execution or HTTP.");
    }

    private static void Equal<T>(T expected, T actual) { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception("Backend mode assertion failed."); }
    private static void Throws<T>(Action action) where T : Exception {
        try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name);
    }
    private static async Task Refuses<T>(Func<Task> action) where T : Exception {
        try { await action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name);
    }
    private sealed class Session : ISessionGateway {
        public int Logins, Probes; public bool Denied;
        public Task SignInAsync(CancellationToken cancellationToken = default) {
            Logins++; if (Denied) throw new AccessDeniedException(); return Task.CompletedTask;
        }
        public Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default) {
            Probes++; if (Denied) throw new AccessDeniedException(); return Task.FromResult<SessionInfo?>(new("synthetic", DateTimeOffset.UtcNow.AddHours(1)));
        }
    }
    private sealed class Catalog : IFileCatalog {
        public int Children, Lists, References; public bool Denied;
        public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default) => throw new Exception("Selected sections must not query adapters.");
        public Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default) {
            Children++; if (Denied) throw new AccessDeniedException(); return Task.FromResult(new NodePage([]));
        }
        public Task<CatalogListing> ListAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default) {
            Lists++; return Task.FromResult(new CatalogListing([], []));
        }
        public Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) {
            References++; return Task.FromResult("reference");
        }
    }
    private sealed class Source(string alias) : IQueuedDownloadSource {
        public string Alias => alias;
        public Uri Origin => new("https://synthetic.example.invalid/");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw new Exception("No source network in backend routing tests.");
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
