namespace LedgeTop.Files.Explorer;

/// <summary>Process-local ordering for diagnostic display only; not a durable audit log.</summary>
public sealed record ActivityEntry(long Sequence, string Text);

public interface IOrderedActivitySource
{
    IReadOnlyList<ActivityEntry> ActivityEntries { get; }
}

public sealed class OrderedActivity
{
    private const int Capacity = 100;
    private static long sequence;
    private readonly object gate = new();
    private readonly Queue<ActivityEntry> items = new();

    public void Add(string text)
    {
        lock (gate) {
            items.Enqueue(new(Interlocked.Increment(ref sequence), text));
            if (items.Count > Capacity) items.Dequeue();
        }
    }

    public IReadOnlyList<ActivityEntry> Snapshot()
    {
        lock (gate) return items.ToArray();
    }

    public static IReadOnlyList<ActivityEntry> From(IExplorerPreviewSession? session) => session switch {
        null => [],
        IOrderedActivitySource ordered => ordered.ActivityEntries,
        // Legacy/test-only implementations have no ordering evidence. Keep their snapshot
        // ahead of process-stamped entries rather than fabricating timestamps on each read.
        _ => session.Activity.Select((text, index) => new ActivityEntry(long.MinValue + index, text)).ToArray()
    };

    public static IReadOnlyList<ActivityEntry> Merge(params IReadOnlyList<ActivityEntry>[] sources) =>
        sources.SelectMany(source => source).OrderBy(entry => entry.Sequence).TakeLast(Capacity).ToArray();
}
