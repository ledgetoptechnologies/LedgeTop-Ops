using LedgeTop.WindowsDownload;
namespace LedgeTop.Files.Explorer;

/// <summary>Process-local ordering for diagnostic display only; not a durable audit log.</summary>
public sealed record ActivityEntry(long Sequence, string Text)
{
    internal bool RecentDownloadFailure { get; init; }
}

public interface IOrderedActivitySource
{
    IReadOnlyList<ActivityEntry> ActivityEntries { get; }
}

public sealed class OrderedActivity
{
    private const int Capacity = 100, FailureCapacity = 20;
    private static long sequence;
    private readonly object gate = new();
    private readonly Queue<ActivityEntry> items = new();
    private readonly Dictionary<string, ActivityEntry> downloadFailures = new(StringComparer.Ordinal);

    public void Add(string text)
    {
        lock (gate) {
            items.Enqueue(new(Interlocked.Increment(ref sequence), text));
            if (items.Count > Capacity) items.Dequeue();
        }
    }
    // Only a validated, typed hydration diagnostic may enter this separate in-memory list.
    // ActivityText is generated solely from its closed enum and numeric fields, not file names,
    // paths, selectors, exception messages, or arbitrary provider activity strings.
    internal void AddDownloadFailure(HydrationFailureDiagnostic diagnostic)
    {
        ArgumentNullException.ThrowIfNull(diagnostic);
        const string marker = "Support code: ";
        var generated = diagnostic.ActivityText;
        var at = generated.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) throw new InvalidOperationException("Typed hydration support code missing.");
        var label = "Recent file-download support code: " + generated[(at + marker.Length)..];
        lock (gate) {
            var id = Interlocked.Increment(ref sequence);
            items.Enqueue(new(id, generated)); if (items.Count > Capacity) items.Dequeue();
            downloadFailures[label] = new(id, label) { RecentDownloadFailure = true };
            if (downloadFailures.Count > FailureCapacity) downloadFailures.Remove(downloadFailures.MinBy(pair => pair.Value.Sequence).Key);
        }
    }
    public IReadOnlyList<ActivityEntry> Snapshot()
    {
        lock (gate) return Combine(items.Concat(downloadFailures.Values));
    }
    private static IReadOnlyList<ActivityEntry> Combine(IEnumerable<ActivityEntry> entries)
    {
        var all = entries.ToArray();
        var recent = all.Where(entry => !entry.RecentDownloadFailure).OrderBy(entry => entry.Sequence).TakeLast(Capacity);
        var recentArray = recent.ToArray();
        var recentIds = recentArray.Select(entry => entry.Sequence).ToHashSet();
        var failures = all.Where(entry => entry.RecentDownloadFailure).GroupBy(entry => entry.Text, StringComparer.Ordinal)
            .Select(group => group.MaxBy(entry => entry.Sequence)!).OrderBy(entry => entry.Sequence).TakeLast(FailureCapacity)
            .Where(entry => !recentIds.Contains(entry.Sequence));
        return recentArray.Concat(failures).OrderBy(entry => entry.Sequence).ToArray();
    }
    public static IReadOnlyList<ActivityEntry> From(IExplorerPreviewSession? session) => session switch {
        null => [],
        IOrderedActivitySource ordered => ordered.ActivityEntries,
        // Legacy/test-only implementations have no ordering evidence. Keep their snapshot
        // ahead of process-stamped entries rather than fabricating timestamps on each read.
        _ => session.Activity.Select((text, index) => new ActivityEntry(long.MinValue + index, text)).ToArray()
    };
    public static IReadOnlyList<ActivityEntry> Merge(params IReadOnlyList<ActivityEntry>[] sources) => Combine(sources.SelectMany(source => source));
}
