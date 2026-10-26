using System.Collections.ObjectModel;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

/// <summary>
/// One bounded, fully enumerated inventory for one selected person/source/channel. Durable references
/// select resources but grant no access. No tokens, content URLs, cursors or adapter payloads are retained.
/// </summary>
public sealed record ExplorerCatalogSnapshot(string PrincipalId, string Channel, string Alias, string Origin,
    IReadOnlyDictionary<string, PlaceholderIdentity> Files, IReadOnlyList<string> Directories);

/// <summary>
/// Captures the existing read-only catalog without browser sign-in, file downloads or filesystem changes.
/// Catalog APIs currently have no revision/snapshot token: this is a fenced inventory, not an atomic
/// server snapshot or a basis for deleting/renaming existing local content during an incremental refresh.
/// </summary>
public static class ExplorerCatalogSnapshotBuilder
{
    private const int MaximumEntries = 1000, MaximumDepth = 32, MaximumPathLength = 180, MaximumPages = 2048;
    private const long MaximumHydrationFileBytes = 64L << 30;

    public static async Task<ExplorerCatalogSnapshot> CaptureAsync(IFilesBackend backend, string channel,
        string expectedPrincipal, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(backend);
        if (channel is not ("pilot" or "stable") || expectedPrincipal is null ||
            !Regex.IsMatch(expectedPrincipal, "\\Aodqp1_[a-f0-9]{64}\\z")) throw Invalid("The Explorer catalog scope is invalid.");
        if (backend.Sources.Count != 1) throw Invalid("Choose exactly one file source before preparing Explorer files.");
        var source = backend.Sources[0] ?? throw Invalid("The selected file source is unavailable.");
        var catalog = backend.Catalog ?? throw Invalid("The selected catalog is unavailable.");
        var gateway = backend.Session ?? throw Invalid("The selected session is unavailable.");
        var alias = source.Alias;
        if (alias is null || !Regex.IsMatch(alias, "\\A[a-z0-9][a-z0-9_-]{0,63}\\z")) throw Invalid("The selected source alias is invalid.");
        var origin = CanonicalOrigin(source.Origin);
        var files = new Dictionary<string, PlaceholderIdentity>(StringComparer.OrdinalIgnoreCase);
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Queue<(CatalogNode Node, string Path)>();
        var pages = 0;

        void Configuration()
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (backend.Sources.Count != 1 || !ReferenceEquals(backend.Sources[0], source) ||
                !ReferenceEquals(backend.Catalog, catalog) || !ReferenceEquals(backend.Session, gateway) ||
                source.Alias != alias || CanonicalOrigin(source.Origin) != origin)
                throw Invalid("The selected file source changed while preparing Explorer files.");
        }

        void Session(string principal, DateTimeOffset expiry)
        {
            if (principal != expectedPrincipal) throw new AccessDeniedException();
            if (expiry <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new LoginRequiredException();
        }

        async Task GatewayFence()
        {
            Configuration();
            var current = await gateway.TryCurrentAsync(cancellationToken);
            Configuration();
            if (current is null) throw new LoginRequiredException();
            Session(current.PrincipalId, current.ExpiresAt);
        }

        async Task Fence()
        {
            // LiveSession.TryCurrentAsync already probes this same selected source. Probe the
            // gateway only at capture boundaries, then use authoritative source-session checks
            // around each metadata request instead of doubling every network/helper operation.
            Configuration();
            var selected = await source.GetSessionAsync(cancellationToken);
            Configuration();
            Session(selected.PrincipalId, selected.ExpiresAt);
        }

        async Task<T> Request<T>(Func<Task<T>> action)
        {
            await Fence();
            var result = await action();
            Configuration();
            await Fence();
            return result;
        }

        void Page()
        {
            if (++pages > MaximumPages) throw Invalid("The Explorer catalog exceeds the supported page limit.");
        }

        void Node(CatalogNode node, NodeKind expected)
        {
            if (node is null || node.Kind != expected || node.SourceAlias != alias || string.IsNullOrWhiteSpace(node.Key) ||
                node.Key.Length > 16384 || !visited.Add(node.Key))
                throw Invalid("The Explorer catalog contains an invalid, repeated or cyclic folder.");
        }

        void PathLimit(string path)
        {
            if (path.Length > MaximumPathLength || path.Split('\\').Length > MaximumDepth)
                throw Invalid("The Explorer catalog exceeds the supported local path or folder-depth limit.");
        }

        void Count()
        {
            if (files.Count + directories.Count > MaximumEntries)
                throw Invalid("The Explorer catalog exceeds the supported file and folder limit.");
        }

        void DirectoryEntry(string path)
        {
            PathLimit(path);
            if (files.ContainsKey(path) || !directories.Add(path))
                throw Invalid("Two catalog entries would use the same Windows path.");
            Count();
        }

        async Task FileEntry(CatalogFile file, string parent)
        {
            if (file is null || file.SourceAlias != alias || !file.Verifiable || file.Size < -1 ||
                file.Size > (1L << 40) || string.IsNullOrWhiteSpace(file.Key) || file.Key.Length > 16384)
                throw Invalid("A catalog file lacks supported, verifiable download metadata.");
            if (file.Size > MaximumHydrationFileBytes)
                throw Invalid("The Explorer preview supports files up to 64 GiB; no oversized file was omitted silently.");
            WindowsName(file.Name);
            var path = parent + "\\" + file.Name;
            PathLimit(path);
            if (directories.Contains(path) || files.ContainsKey(path)) throw Invalid("Two catalog entries would use the same Windows path.");
            // Stop before resolving the next file when its addition would exceed the inventory bound.
            if (files.Count + directories.Count >= MaximumEntries)
                throw Invalid("The Explorer catalog exceeds the supported file and folder limit.");
            var reference = await Request(() => catalog.GetReferenceAsync(file, cancellationToken));
            if (reference is null || reference.Length > 16384 || !Regex.IsMatch(reference, "\\Aodqr1_[A-Za-z0-9_-]+\\z"))
                throw Invalid("The catalog returned an invalid durable file reference.");
            var resolved = await Request(() => source.ResolveAsync(reference, cancellationToken));
            if (resolved is null || resolved.Spec is null || string.IsNullOrEmpty(resolved.LogicalFileId) || string.IsNullOrEmpty(resolved.RemoteVersion))
                throw Invalid("The catalog returned an invalid resolved file.");
            var spec = resolved.Spec;
            if (spec.Length > MaximumHydrationFileBytes)
                throw Invalid("The Explorer preview supports files up to 64 GiB; no oversized file was omitted silently.");
            if (resolved.PrincipalId != expectedPrincipal || spec.FileName != file.Name ||
                (file.Size >= 0 && file.Size != spec.Length) || spec.OpaqueIdentity != resolved.LogicalFileId + ":" + resolved.RemoteVersion ||
                CanonicalContentOrigin(spec.ContentUri) != origin || spec.ContentUri.Query.Length != 0 ||
                (alias == "portal" && !resolved.LogicalFileId.StartsWith("ondf1_", StringComparison.Ordinal)) ||
                (alias == "employee" && !resolved.LogicalFileId.StartsWith("oef1_", StringComparison.Ordinal)))
                throw Invalid("A file changed or resolved outside the selected Explorer catalog scope.");
            var identity = new PlaceholderIdentity(channel, alias, origin, expectedPrincipal, reference,
                resolved.LogicalFileId, resolved.RemoteVersion, spec.FileName, spec.Length, spec.ETag, spec.Sha256);
            // The native identity ceiling is smaller than the source reference ceiling. Never truncate
            // a valid long reference, omit its file silently or register a root before this check succeeds.
            identity.Encode();
            files.Add(path, identity); Count();
        }

        // The production backend pins its cached Access credential for the entire capture.
        // Metadata fetched under an intervening account's credential must never become a
        // snapshot for the expected person, even if that account changes back before a fence.
        using var captureScope = backend is LiveBackend live ? await live.PinCatalogSessionAsync(cancellationToken) : null;
        Configuration();
        await GatewayFence();
        var sections = await Request(() => catalog.GetSectionsAsync(cancellationToken));
        if (sections is null) throw Invalid("The catalog returned no supported section list.");
        foreach (var section in sections) {
            Node(section, NodeKind.Section);
            object? more = null;
            var continuations = new HashSet<object>();
            do {
                Page();
                var roots = await Request(() => catalog.GetChildrenAsync(section, more, cancellationToken));
                if (roots is null || roots.Nodes is null) throw Invalid("The catalog returned an invalid root page.");
                foreach (var root in roots.Nodes) {
                    Node(root, NodeKind.Root); WindowsName(root.Name); DirectoryEntry(root.Name);
                    pending.Enqueue((root, root.Name));
                }
                more = roots.More;
                if (more is not null && !continuations.Add(more)) throw Invalid("The catalog repeated a root continuation.");
            } while (more is not null);
        }

        while (pending.TryDequeue(out var item)) {
            object? more = null;
            var continuations = new HashSet<object>();
            do {
                Page();
                var listing = await Request(() => catalog.ListAsync(item.Node, more, cancellationToken));
                if (listing is null || listing.Folders is null || listing.Files is null)
                    throw Invalid("The catalog returned an invalid folder page.");
                foreach (var folder in listing.Folders) {
                    Node(folder, NodeKind.Folder); WindowsName(folder.Name);
                    var path = item.Path + "\\" + folder.Name;
                    DirectoryEntry(path); pending.Enqueue((folder, path));
                }
                foreach (var file in listing.Files) await FileEntry(file, item.Path);
                more = listing.More;
                if (more is not null && !continuations.Add(more)) throw Invalid("The catalog repeated a folder continuation.");
            } while (more is not null);
        }
        await GatewayFence();
        // The gateway await can itself be delayed while its source changes; never return a
        // completed inventory without a subsequent authoritative selected-source readback.
        await Fence();
        return new(expectedPrincipal, channel, alias, origin,
            new ReadOnlyDictionary<string, PlaceholderIdentity>(files),
            Array.AsReadOnly(directories.Order(StringComparer.OrdinalIgnoreCase).ToArray()));
    }

    private static string CanonicalOrigin(Uri uri)
    {
        if (uri is null || !uri.IsAbsoluteUri || uri.Scheme != "https" || uri.UserInfo.Length != 0 || uri.Query.Length != 0 ||
            uri.Fragment.Length != 0 || uri.AbsolutePath != "/") throw Invalid("The selected Explorer origin is invalid.");
        return uri.GetLeftPart(UriPartial.Authority);
    }

    private static string CanonicalContentOrigin(Uri uri)
    {
        if (uri is null || !uri.IsAbsoluteUri || uri.Scheme != "https" || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
            throw Invalid("The resolved file origin is invalid.");
        return uri.GetLeftPart(UriPartial.Authority);
    }

    private static void WindowsName(string name)
    {
        // Keep folder mappings as strict as the downloader's basenames. Do not silently sanitize a
        // remote name into a different local name or select one of two case-colliding remote files.
        if (string.IsNullOrWhiteSpace(name) || name.Length > 150 || name is "." or ".." || string.Equals(name, ".ltds-downloads-v1", StringComparison.OrdinalIgnoreCase) ||
            name.EndsWith('.') || name.EndsWith(' ') || name.Any(c => "<>:\"/\\|?*".Contains(c)))
            throw Invalid("A catalog name cannot be represented safely in Windows.");
        for (var index = 0; index < name.Length;) {
            if (!Rune.TryGetRuneAt(name, index, out var rune) || Rune.GetUnicodeCategory(rune) is
                UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.Surrogate)
                throw Invalid("A catalog name cannot be represented safely in Windows.");
            index += rune.Utf16SequenceLength;
        }
        var stem = name.Split('.')[0].ToUpperInvariant();
        if (stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" ||
            Regex.IsMatch(stem, "\\A(?:COM|LPT)[1-9¹²³]\\z")) throw Invalid("A catalog name uses a Windows reserved device name.");
    }

    private static TransferException Invalid(string message) => new(message);
}
