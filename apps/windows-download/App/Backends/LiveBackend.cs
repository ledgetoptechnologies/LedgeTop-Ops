using System.Text.Json;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

/// <summary>Trusted local setup for a real copy of the app. It names fixed origins and the reviewed
/// cloudflared binary; it never contains a token, bucket key or service credential.</summary>
public sealed record LiveSettings(Uri PortalApplicationUrl, Uri? StaffApplicationUrl, string CloudflaredPath, string CloudflaredSha256)
{
    public static string DefaultPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LedgeTop", "Files", "settings.json");

    /// <summary>Null when the app hasn't been set up on this PC.</summary>
    public static LiveSettings? Load(string path)
    {
        if (!File.Exists(path)) return null;
        var value = JsonSerializer.Deserialize<LiveSettings>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        return value is { PortalApplicationUrl: not null, CloudflaredPath.Length: > 0, CloudflaredSha256.Length: 64 } ? value : null;
    }
}

/// <summary>
/// The real sources: client deliveries through the portal and, when configured, company server folders.
/// Sign-in is the human Cloudflare Access login, started only from the Sign in button. Every listing and
/// download is authorized by the server for the signed-in person.
/// </summary>
public sealed class LiveBackend : IFilesBackend
{
    private readonly CloudflareAccessSession portalAccess;
    private readonly CloudflareAccessSession? staffAccess;
    private readonly PortalQueuedDownloadSource portalSource;
    private readonly EmployeeQueuedDownloadSource? staffSource;
    private readonly PortalClient portal;
    private readonly EmployeeClient? staff;

    public LiveBackend(LiveSettings settings, string stateDirectory)
    {
        StateDirectory = stateDirectory;
        portalAccess = new CloudflareAccessSession(settings.PortalApplicationUrl, settings.CloudflaredPath, settings.CloudflaredSha256);
        portalSource = new PortalQueuedDownloadSource("portal", portalAccess);
        portal = new PortalClient(portalAccess);
        var sources = new List<IQueuedDownloadSource> { portalSource };
        if (settings.StaffApplicationUrl is { } staffUrl) {
            staffAccess = new CloudflareAccessSession(staffUrl, settings.CloudflaredPath, settings.CloudflaredSha256);
            staffSource = new EmployeeQueuedDownloadSource("employee", staffAccess);
            staff = new EmployeeClient(staffAccess);
            sources.Add(staffSource);
        }
        Sources = sources;
        Session = new LiveSession(portalAccess, staffAccess, portalSource);
        Catalog = new LiveCatalog(portal, staff, portalSource, staffSource);
    }

    public ISessionGateway Session { get; }
    public IFileCatalog Catalog { get; }
    public IReadOnlyList<IQueuedDownloadSource> Sources { get; }
    public string StateDirectory { get; }

    public ValueTask DisposeAsync()
    {
        portal.Dispose(); staff?.Dispose(); portalSource.Dispose(); staffSource?.Dispose();
        return ValueTask.CompletedTask;
    }

    private sealed class LiveSession(CloudflareAccessSession portal, CloudflareAccessSession? staff, PortalQueuedDownloadSource probe) : ISessionGateway
    {
        public async Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default)
        {
            try { return new SessionInfo((await probe.GetSessionAsync(cancellationToken)).ExpiresAt); }
            catch (LoginRequiredException) { return null; }
        }

        public async Task SignInAsync(CancellationToken cancellationToken = default)
        {
            await portal.ExplicitLoginAsync(cancellationToken);
            if (staff is not null) await staff.ExplicitLoginAsync(cancellationToken);
        }
    }

    private sealed record PortalPlace(string Handle);
    private sealed record StaffPlace(string RootId, string Path);
    private sealed record PortalFilePlace(string Handle);
    private sealed record StaffFilePlace(string RootId, string Path);

    private sealed class LiveCatalog(PortalClient portal, EmployeeClient? staff, PortalQueuedDownloadSource portalSource,
        EmployeeQueuedDownloadSource? staffSource) : IFileCatalog
    {
        public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default)
        {
            var sections = new List<CatalogNode> { new("deliveries", "Client deliveries", NodeKind.Section, "portal") };
            if (staff is not null) sections.Add(new("server", "Company server", NodeKind.Section, "employee"));
            return Task.FromResult<IReadOnlyList<CatalogNode>>(sections);
        }

        public async Task<IReadOnlyList<CatalogNode>> GetChildrenAsync(CatalogNode node, CancellationToken cancellationToken = default)
        {
            var result = new List<CatalogNode>();
            if (node.Kind == NodeKind.Section && node.SourceAlias == "portal") {
                string? cursor = null;
                do {
                    var page = await portal.GetDeliveriesAsync(cursor, cancellationToken);
                    result.AddRange(page.Items.Select(item => new CatalogNode("p:" + item.Handle, item.DisplayName, NodeKind.Root, "portal", new PortalPlace(item.Handle))));
                    cursor = page.NextCursor;
                } while (cursor is not null && result.Count < 500);
                return result;
            }
            if (node.Kind == NodeKind.Section && staff is not null) {
                foreach (var root in await staff.GetRootsAsync(cancellationToken))
                    result.Add(new CatalogNode("s:" + root.RootId, root.DisplayName, NodeKind.Root, "employee", new StaffPlace(root.RootId, "")));
                return result;
            }
            return (await ListAsync(node, cancellationToken)).Folders;
        }

        public async Task<CatalogListing> ListAsync(CatalogNode folder, CancellationToken cancellationToken = default)
        {
            var folders = new List<CatalogNode>(); var files = new List<CatalogFile>();
            switch (folder.Payload) {
                case PortalPlace place: {
                    string? cursor = null;
                    do {
                        var page = await portal.GetFolderAsync(place.Handle, cursor, cancellationToken);
                        folders.AddRange(page.Folders.Select(item => new CatalogNode("p:" + item.Handle, item.Name, NodeKind.Folder, "portal", new PortalPlace(item.Handle))));
                        files.AddRange(page.Files.Select(item => new CatalogFile("p:" + item.Handle, item.Name, item.Size, item.DownloadAvailable, "portal", new PortalFilePlace(item.Handle))));
                        cursor = page.NextCursor;
                    } while (cursor is not null && folders.Count + files.Count < 5000);
                    break;
                }
                case StaffPlace place when staff is not null: {
                    string? cursor = null;
                    do {
                        var page = await staff.GetEntriesAsync(place.RootId, place.Path, cursor, cancellationToken);
                        foreach (var entry in page.Entries) {
                            var path = place.Path.Length == 0 ? entry.Name : place.Path + "/" + entry.Name;
                            if (entry.Kind == "folder") folders.Add(new CatalogNode("s:" + place.RootId + ":" + path, entry.Name, NodeKind.Folder, "employee", new StaffPlace(place.RootId, path)));
                            else files.Add(new CatalogFile("s:" + place.RootId + ":" + path, entry.Name, -1, true, "employee", new StaffFilePlace(place.RootId, path)));
                        }
                        cursor = page.NextCursor;
                    } while (cursor is not null && folders.Count + files.Count < 5000);
                    break;
                }
            }
            return new CatalogListing(folders, files);
        }

        public async Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) => file.Payload switch {
            PortalFilePlace place => (await portalSource.GetReferenceAsync(place.Handle, cancellationToken)).ResourceReference,
            StaffFilePlace place when staffSource is not null => (await staffSource.GetReferenceAsync(place.RootId, place.Path, cancellationToken)).ResourceReference,
            _ => throw new ResourceUnavailableException(),
        };
    }
}
