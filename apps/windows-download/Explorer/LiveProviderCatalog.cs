using System.Collections.Frozen;

namespace LedgeTop.Files.Explorer;

// Copy-on-write membership for an already-owned provider. This is not an authority,
// filesystem, placeholder creation or recovery mechanism. A future caller must first
// complete those checks and publish only entries already safe for the scanner to inspect.
internal sealed class LiveProviderCatalog<T> where T : notnull
{
    internal sealed record Snapshot(long Revision, FrozenDictionary<string, T> Files,
        FrozenSet<string> Directories, IReadOnlyList<string> ScanPaths);
    private readonly object sync = new();
    private Snapshot current;
    internal Snapshot Current => Volatile.Read(ref current);

    internal LiveProviderCatalog(IReadOnlyDictionary<string, T> files, IEnumerable<string> directories)
    {
        current = Build(0, files, directories);
    }

    // Caller serializes against provider shutdown. prepareWorker must either admit the
    // entire batch or throw without admission. No network/native work under this lock.
    internal Snapshot Add(long expectedRevision, IReadOnlyDictionary<string, T> files,
        IReadOnlyCollection<string> directories, Action<IReadOnlyList<string>> prepareWorker)
    {
        lock (sync) {
            var previous = current;
            if (previous.Revision != expectedRevision) throw new IOException("Provider catalog changed.");
            var nextFiles = previous.Files.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
            var nextDirectories = previous.Directories.ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var directory in directories)
                if (!nextDirectories.Add(directory) || nextFiles.ContainsKey(directory)) throw new IOException("Provider catalog directory conflicts.");
            foreach (var (path, identity) in files)
                if (nextDirectories.Contains(path) || !nextFiles.TryAdd(path, identity)) throw new IOException("Provider catalog file conflicts.");
            if (nextFiles.Count + nextDirectories.Count > 1000) throw new IOException("Provider catalog exceeds its limit.");
            var candidate = Build(checked(previous.Revision + 1), nextFiles, nextDirectories);
            var added = Array.AsReadOnly(files.Keys.ToArray());
            prepareWorker(added); // Worker membership is visible before the scanner snapshot.
            Volatile.Write(ref current, candidate);
            return candidate;
        }
    }

    private static Snapshot Build(long revision, IReadOnlyDictionary<string, T> files, IEnumerable<string> directories)
    {
        var snapshotFiles = files.ToFrozenDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        var snapshotDirectories = directories.ToFrozenSet(StringComparer.OrdinalIgnoreCase);
        return new(revision, snapshotFiles, snapshotDirectories, Array.AsReadOnly(snapshotFiles.Keys.ToArray()));
    }
}
