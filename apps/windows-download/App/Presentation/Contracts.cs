using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Presentation;

/// <summary>
/// The signed-in human session, as far as the app needs it. <see cref="PrincipalId"/> is the source's
/// verified opaque person ID (never an email or token), so a different sign-in is recognised.
/// </summary>
public sealed record SessionInfo(string PrincipalId, DateTimeOffset ExpiresAt);

/// <summary>Sign-in is always an explicit user action; nothing here may open a browser on its own.</summary>
public interface ISessionGateway
{
    /// <summary>Reads the current cached session without any browser interaction; null means sign-in is needed.</summary>
    Task<SessionInfo?> TryCurrentAsync(CancellationToken cancellationToken = default);
    /// <summary>Starts the browser sign-in. Only called from the Sign in button.</summary>
    Task SignInAsync(CancellationToken cancellationToken = default);
}

public enum NodeKind { Section, Root, Folder }

/// <summary>A browsable place in the file tree. <see cref="Payload"/> is adapter-private and never shown.</summary>
public sealed record CatalogNode(string Key, string Name, NodeKind Kind, string SourceAlias, object? Payload = null);

/// <summary>A file the signed-in person may download. Size is -1 when the source doesn't report it.</summary>
public sealed record CatalogFile(string Key, string Name, long Size, bool Verifiable, string SourceAlias, object? Payload = null);

/// <summary>One page of a folder. <see cref="More"/> is an adapter-private continuation; null means this was the last page.</summary>
public sealed record CatalogListing(IReadOnlyList<CatalogNode> Folders, IReadOnlyList<CatalogFile> Files, object? More = null);

/// <summary>One page of places under a node, continued the same way.</summary>
public sealed record NodePage(IReadOnlyList<CatalogNode> Nodes, object? More = null);

/// <summary>Read-only browsing over every source the person can use, presented as one tree.</summary>
public interface IFileCatalog
{
    Task<IReadOnlyList<CatalogNode>> GetSectionsAsync(CancellationToken cancellationToken = default);
    /// <summary>Reads one page; pass the previous page's <c>More</c> to continue. Nothing is silently dropped.</summary>
    Task<NodePage> GetChildrenAsync(CatalogNode node, object? more = null, CancellationToken cancellationToken = default);
    Task<CatalogListing> ListAsync(CatalogNode folder, object? more = null, CancellationToken cancellationToken = default);
    /// <summary>A durable, non-authorizing queue reference for one file.</summary>
    Task<string> GetReferenceAsync(CatalogFile file, CancellationToken cancellationToken = default);
}

/// <summary>Everything one running copy of the app needs: sign-in, browsing and the download sources.</summary>
public interface IFilesBackend : IAsyncDisposable
{
    ISessionGateway Session { get; }
    IFileCatalog Catalog { get; }
    IReadOnlyList<IQueuedDownloadSource> Sources { get; }
    /// <summary>An app-owned folder for queue state (one subfolder per source).</summary>
    string StateDirectory { get; }
}
