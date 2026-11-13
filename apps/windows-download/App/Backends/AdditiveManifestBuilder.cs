using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Backends;

/// <summary>
/// An in-memory input to a future durable generation transition, never permission to alter a root.
/// Missing and changed old entries remain intact; conflict, authority and filesystem checks remain mandatory.
/// Retaining an old selector or identity does not authorize its use or guarantee it remains valid.
/// </summary>
internal sealed record AdditiveManifestCandidate(string PreviousDigest, string ObservedDigest,
    ExplorerRootManifest Manifest, IReadOnlyList<string> NewDirectories, IReadOnlyList<string> NewFiles)
{
    internal int AddedFiles => NewFiles.Count;
    internal int AddedDirectories => NewDirectories.Count;
}

internal static class AdditiveManifestBuilder
{
    internal static AdditiveManifestCandidate Build(ExplorerRootManifest previous, ExplorerRootManifest observed)
    {
        ArgumentNullException.ThrowIfNull(previous);
        ArgumentNullException.ThrowIfNull(observed);
        if (previous.Scope != observed.Scope) throw new TransferException("Explorer inventories have different bound sources or accounts.");
        var files = new Dictionary<string, PlaceholderIdentity>(previous.Files, StringComparer.OrdinalIgnoreCase);
        var directories = new HashSet<string>(previous.Directories, StringComparer.OrdinalIgnoreCase);
        foreach (var pair in observed.Files) files.TryAdd(pair.Key, pair.Value);
        foreach (var directory in observed.Directories) directories.Add(directory);
        // Construction rejects any old/new file-directory collision, unsafe paths, and bound violations.
        // In particular a remote removal is never used to make room for a new entry.
        var candidate = new ExplorerRootManifest(previous.Scope, files, directories);
        var previousDirectories = new HashSet<string>(previous.Directories, StringComparer.OrdinalIgnoreCase);
        // Ordering is for a future consumer's dependency planning, not a filesystem check or admission.
        // Every path still requires fresh authority and a guarded local collision check before creation.
        var addedDirectories = candidate.Directories.Where(path => !previousDirectories.Contains(path))
            .OrderBy(path => path.Count(c => c == '\\')).ThenBy(path => path, StringComparer.Ordinal).ToArray();
        var addedFiles = candidate.Files.Keys.Where(path => !previous.Files.ContainsKey(path))
            .OrderBy(path => path, StringComparer.Ordinal).ToArray();
        return new(previous.Digest, observed.Digest, candidate, Array.AsReadOnly(addedDirectories), Array.AsReadOnly(addedFiles));
    }
}
