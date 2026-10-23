using System.Text.Json;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

/// <summary>The settings file exists but can't be trusted; <see cref="Exception.Message"/> is safe to show.</summary>
public sealed class SettingsException(string message) : Exception(message);

/// <summary>Local setup for a real copy of the app: fixed origins and the reviewed cloudflared binary.
/// It never contains a token, bucket key or service credential. This file is user-writable, so it is not
/// proof of where the binary came from: the installer must supply trusted origins and the cloudflared identity.</summary>
public sealed record LiveSettings(Uri PortalApplicationUrl, Uri? StaffApplicationUrl, string CloudflaredPath, string CloudflaredSha256)
{
    private const int MaximumBytes = 16 * 1024;
    private const string Broken = "The setup file on this PC is damaged or incomplete. Reinstall Ledge Top Files or ask your Ledge Top contact to check it.";
    private const string Unreadable = "The setup file on this PC couldn't be read. Restart the PC and try again.";

    /// <summary>The developer-build settings file. Packaged releases never read it.</summary>
    public static string PathUnder(string localAppData) => Path.Combine(localAppData, "LedgeTop", "Files", "settings.json");

    /// <summary>Null when the app hasn't been set up on this PC; <see cref="SettingsException"/> when the file is unusable.</summary>
    public static LiveSettings? Load(string path)
    {
        if (!File.Exists(path)) return null;
        byte[] bytes;
        try {
            using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (input.Length > MaximumBytes) throw new SettingsException(Broken);
            bytes = new byte[input.Length];
            input.ReadExactly(bytes);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { throw new SettingsException(Unreadable); }
        try { return Parse(bytes); }
        catch (Exception error) when (error is JsonException or FormatException or ArgumentException or InvalidOperationException) { throw new SettingsException(Broken); }
    }

    /// <summary>Strict: one object, only the four known keys, each at most once, with well-formed values.</summary>
    internal static LiveSettings Parse(ReadOnlySpan<byte> json)
    {
        var reader = new Utf8JsonReader(json, new JsonReaderOptions { CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 2 });
        var values = new Dictionary<string, string?>(StringComparer.Ordinal);
        if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) throw new FormatException();
        while (reader.Read() && reader.TokenType != JsonTokenType.EndObject) {
            if (reader.TokenType != JsonTokenType.PropertyName) throw new FormatException();
            var name = reader.GetString()!;
            if (name is not ("portalApplicationUrl" or "staffApplicationUrl" or "cloudflaredPath" or "cloudflaredSha256") || values.ContainsKey(name))
                throw new FormatException();
            reader.Read();
            values[name] = reader.TokenType switch {
                JsonTokenType.String => reader.GetString(),
                JsonTokenType.Null when name == "staffApplicationUrl" => null,
                _ => throw new FormatException(),
            };
        }
        if (reader.TokenType != JsonTokenType.EndObject || reader.Read()) throw new FormatException();
        static Uri Origin(string? value) =>
            Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.UserInfo.Length == 0
                && uri.Query.Length == 0 && uri.Fragment.Length == 0 && uri.AbsolutePath != "/" ? uri : throw new FormatException();
        var portal = Origin(values.GetValueOrDefault("portalApplicationUrl"));
        var staff = values.GetValueOrDefault("staffApplicationUrl") is { } staffValue ? Origin(staffValue) : null;
        var binary = values.GetValueOrDefault("cloudflaredPath");
        if (binary is null || !Path.IsPathFullyQualified(binary) || binary.StartsWith(@"\\", StringComparison.Ordinal)
            || !binary.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new FormatException();
        var hash = values.GetValueOrDefault("cloudflaredSha256");
        if (hash is not { Length: 64 } || !hash.All(Uri.IsHexDigit)) throw new FormatException();
        return new LiveSettings(portal, staff, binary, hash.ToLowerInvariant());
    }
}

/// <summary>
/// The real sources: client deliveries through the portal and, when configured, company server folders.
/// Sign-in is the human Cloudflare Access login, started only from the Sign in button. Every listing and
/// download is authorized by the server for the signed-in person.
/// </summary>
public sealed class LiveBackend : IFilesBackend
{
    // Only the chosen source is constructed, authenticated and disposed. The test seam cannot
    // replace the production factory exposed by the public constructors.
    internal sealed record SelectedBackend(ISessionGateway Session, IFileCatalog Catalog,
        IQueuedDownloadSource Source, Action Dispose);
    private readonly SelectedBackend selected;
    private int disposed;

    /// <summary>
    /// Reads the setup and builds the real sources. Returns no backend and no problem when the PC isn't set up,
    /// and a plain problem (never an exception) when the setup or the pinned cloudflared can't be used.
    /// </summary>
    public static (LiveBackend? Backend, string? Problem) Open(string settingsPath, string stateDirectory)
    {
        LiveSettings? settings;
        try { settings = LiveSettings.Load(settingsPath); }
        catch (SettingsException error) { return (null, error.Message); }
        if (settings is null) return (null, null);
        try { return (new LiveBackend(settings, stateDirectory), null); }
        catch (Exception) {
            return (null, Startup.HelperProblem);
        }
    }

    /// <summary>Compatibility overload: client delivery only; never signs into the employee application.</summary>
    public LiveBackend(LiveSettings settings, string stateDirectory) : this(settings, stateDirectory, AccessMode.Client) { }

    public LiveBackend(LiveSettings settings, string stateDirectory, AccessMode mode)
        : this(settings, stateDirectory, mode, CreateSelected) { }

    internal LiveBackend(LiveSettings settings, string stateDirectory, AccessMode mode,
        Func<LiveSettings, AccessMode, SelectedBackend> factory)
    {
        AccessModes.Validate(mode);
        ArgumentNullException.ThrowIfNull(settings);
        if (mode == AccessMode.Employee && settings.StaffApplicationUrl is null)
            throw new SettingsException("Employee access is not configured on this PC. Ask your Ledge Top contact to check the setup.");
        Settings = settings;
        StateDirectory = stateDirectory;
        selected = factory(settings, mode);
        var alias = AccessModes.Alias(mode);
        if (selected.Source.Alias != alias) {
            selected.Dispose();
            throw new InvalidOperationException("The selected file source is unavailable.");
        }
        Sources = Array.AsReadOnly(new[] { selected.Source });
        Session = selected.Session;
        Catalog = new SelectedCatalog(mode, selected.Catalog);
    }

    private static SelectedBackend CreateSelected(LiveSettings settings, AccessMode mode)
    {
        var access = new CloudflareAccessSession(mode == AccessMode.Client
            ? settings.PortalApplicationUrl : settings.StaffApplicationUrl!, settings.CloudflaredPath, settings.CloudflaredSha256);
        if (mode == AccessMode.Client) {
            var source = new PortalQueuedDownloadSource("portal", access);
            var client = new PortalClient(access);
            return new(new LiveSession(access, source), new LiveCatalog(client, null, source, null), source,
                () => { client.Dispose(); source.Dispose(); });
        }
        else {
            var source = new EmployeeQueuedDownloadSource("employee", access);
            var client = new EmployeeClient(access);
            return new(new LiveSession(access, source), new LiveCatalog(null, client, null, source), source,
                () => { client.Dispose(); source.Dispose(); });
        }
    }

    /// <summary>The origins and helper this backend was built with (for diagnostics and tests).</summary>
    public LiveSettings Settings { get; }
    public ISessionGateway Session { get; }
    public IFileCatalog Catalog { get; }
    public IReadOnlyList<IQueuedDownloadSource> Sources { get; }
    public string StateDirectory { get; }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) selected.Dispose();
        return ValueTask.CompletedTask;
    }

    private sealed class LiveSession(CloudflareAccessSession access, IQueuedDownloadSource probe) : ISessionGateway
    {
        public async Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default)
        {
            try {
                var session = await probe.GetSessionAsync(cancellationToken);
                return new SessionInfo(session.PrincipalId, session.ExpiresAt);
            }
            catch (LoginRequiredException) { return null; }
        }

        public async Task SignInAsync(CancellationToken cancellationToken = default)
        {
            await access.ExplicitLoginAsync(cancellationToken);
        }
    }

    private sealed class SelectedCatalog(AccessMode mode, IFileCatalog inner) : IFileCatalog
    {
        private readonly string alias = AccessModes.Alias(mode);
        private void Check(string source) { if (source != alias) throw new ResourceUnavailableException(); }
        private void Check(CatalogNode node) {
            Check(node.SourceAlias);
            if (node.Kind == NodeKind.Section && node.Key != (mode == AccessMode.Client ? "deliveries" : "server"))
                throw new ResourceUnavailableException();
        }
        public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<CatalogNode>>([mode == AccessMode.Client
                ? new("deliveries", "Client deliveries", NodeKind.Section, alias)
                : new("server", "Company server", NodeKind.Section, alias)]);
        public Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default) {
            Check(node); return inner.GetChildrenAsync(node, more, cancellationToken);
        }
        public Task<CatalogListing> ListAsync(CatalogNode folder, object? more = null, CancellationToken cancellationToken = default) {
            Check(folder); return inner.ListAsync(folder, more, cancellationToken);
        }
        public Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) {
            Check(file.SourceAlias); return inner.GetReferenceAsync(file, cancellationToken);
        }
    }

    private sealed record PortalPlace(string Handle);
    private sealed record StaffPlace(string RootId, string Path);
    private sealed record PortalFilePlace(string Handle);
    private sealed record StaffFilePlace(string RootId, string Path);

    private sealed class LiveCatalog(PortalClient? portal, EmployeeClient? staff, PortalQueuedDownloadSource? portalSource,
        EmployeeQueuedDownloadSource? staffSource) : IFileCatalog
    {
        public Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default)
        {
            var sections = new List<CatalogNode>();
            if (portal is not null) sections.Add(new("deliveries", "Client deliveries", NodeKind.Section, "portal"));
            if (staff is not null) sections.Add(new("server", "Company server", NodeKind.Section, "employee"));
            return Task.FromResult<IReadOnlyList<CatalogNode>>(sections);
        }

        // One server page per call: the window offers "Show more" for the rest, so nothing authorized is unreachable.
        public async Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default)
        {
            if (node.Kind == NodeKind.Section && node.SourceAlias == "portal" && portal is not null) {
                var page = await portal.GetDeliveriesAsync(more as string, cancellationToken);
                return new NodePage(page.Items.Select(item => new CatalogNode("p:" + item.Handle, item.DisplayName, NodeKind.Root, "portal", new PortalPlace(item.Handle))).ToList(),
                    page.NextCursor);
            }
            if (node.Kind == NodeKind.Section && node.SourceAlias == "employee" && staff is not null)
                return new NodePage((await staff.GetRootsAsync(cancellationToken))
                    .Select(root => new CatalogNode("s:" + root.RootId, root.DisplayName, NodeKind.Root, "employee", new StaffPlace(root.RootId, ""))).ToList());
            var listing = await ListAsync(node, more, cancellationToken);
            return new NodePage(listing.Folders, listing.More);
        }

        public async Task<CatalogListing> ListAsync(CatalogNode folder, object? more = null, CancellationToken cancellationToken = default)
        {
            switch (folder.Payload) {
                case PortalPlace place when portal is not null: {
                    var page = await portal.GetFolderAsync(place.Handle, more as string, cancellationToken);
                    return new CatalogListing(
                        page.Folders.Select(item => new CatalogNode("p:" + item.Handle, item.Name, NodeKind.Folder, "portal", new PortalPlace(item.Handle))).ToList(),
                        page.Files.Select(item => new CatalogFile("p:" + item.Handle, item.Name, item.Size, item.DownloadAvailable, "portal", new PortalFilePlace(item.Handle))).ToList(),
                        page.NextCursor);
                }
                case StaffPlace place when staff is not null: {
                    var page = await staff.GetEntriesAsync(place.RootId, place.Path, more as string, cancellationToken);
                    var folders = new List<CatalogNode>(); var files = new List<CatalogFile>();
                    foreach (var entry in page.Entries) {
                        var path = place.Path.Length == 0 ? entry.Name : place.Path + "/" + entry.Name;
                        if (entry.Kind == "folder") folders.Add(new CatalogNode("s:" + place.RootId + ":" + path, entry.Name, NodeKind.Folder, "employee", new StaffPlace(place.RootId, path)));
                        else files.Add(new CatalogFile("s:" + place.RootId + ":" + path, entry.Name, -1, true, "employee", new StaffFilePlace(place.RootId, path)));
                    }
                    return new CatalogListing(folders, files, page.NextCursor);
                }
                default: return new CatalogListing([], []);
            }
        }

        public async Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default) => file.Payload switch {
            PortalFilePlace place when portalSource is not null => (await portalSource.GetReferenceAsync(place.Handle, cancellationToken)).ResourceReference,
            StaffFilePlace place when staffSource is not null => (await staffSource.GetReferenceAsync(place.RootId, place.Path, cancellationToken)).ResourceReference,
            _ => throw new ResourceUnavailableException(),
        };
    }
}
