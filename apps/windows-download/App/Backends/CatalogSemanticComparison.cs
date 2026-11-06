using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

/// <summary>Differences observed between two validated inventories, not an atomic server history or deletion authority.</summary>
internal sealed record CatalogObservedDifferences(int NewFiles, int MissingFiles, int ChangedFiles, int NewDirectories, int MissingDirectories)
{
    internal bool HasDifferences => NewFiles + MissingFiles + ChangedFiles + NewDirectories + MissingDirectories != 0;
}

internal static class CatalogSemanticComparison
{
    // Manifests validate scope, identities and path collisions on construction. Callers must independently
    // establish that the current account and generation still match before using the result. Selector rotation
    // requires separate rebind handling; no semantic differences does not authorize reusing stale placeholders.
    internal static CatalogObservedDifferences Compare(ExplorerRootManifest previous, ExplorerRootManifest observed)
    {
        ArgumentNullException.ThrowIfNull(previous);
        ArgumentNullException.ThrowIfNull(observed);
        if (previous.Scope != observed.Scope) throw new TransferException("Explorer inventories have different bound sources or accounts.");
        var added = 0; var missing = 0; var changed = 0;
        foreach (var (path, identity) in observed.Files) {
            if (!previous.Files.TryGetValue(path, out var old)) added++;
            else if (!SameContent(old, identity)) changed++;
        }
        foreach (var path in previous.Files.Keys) if (!observed.Files.ContainsKey(path)) missing++;
        var oldDirectories = new HashSet<string>(previous.Directories, StringComparer.OrdinalIgnoreCase);
        var newDirectories = new HashSet<string>(observed.Directories, StringComparer.OrdinalIgnoreCase);
        return new(added, missing, changed, newDirectories.Count(path => !oldDirectories.Contains(path)),
            oldDirectories.Count(path => !newDirectories.Contains(path)));
    }

    private static bool SameContent(PlaceholderIdentity a, PlaceholderIdentity b) =>
        a.LogicalFileId == b.LogicalFileId && a.RemoteVersion == b.RemoteVersion &&
        string.Equals(a.FileName, b.FileName, StringComparison.OrdinalIgnoreCase) && a.Length == b.Length &&
        a.ETag == b.ETag && a.Sha256 == b.Sha256;
}
