namespace LedgeTop.Files.Explorer;

internal enum AvailabilityIntent { None, Keep, Free, Unknown }

/// <summary>Connection-local, manifest-bounded failed intent suppression. Does not gate native read callbacks.</summary>
internal sealed class FailedAvailabilityIntents
{
    private readonly HashSet<string> known;
    private readonly Dictionary<string, AvailabilityIntent> failed = new(StringComparer.OrdinalIgnoreCase);
    internal FailedAvailabilityIntents(IEnumerable<string> manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        // Limit input items, not just unique names, to bound duplicate-only sources too.
        var paths = manifest.Take(1001).ToArray();
        if (paths.Length > 1000) throw new ArgumentException("Availability manifest is too large.");
        known = paths.ToHashSet(StringComparer.OrdinalIgnoreCase);
    }
    internal static AvailabilityIntent ObserveAttributes(uint attributes) => (attributes & (0x80000u | 0x100000u)) switch {
        0x80000u => AvailabilityIntent.Keep,
        0x100000u => AvailabilityIntent.Free,
        0 => AvailabilityIntent.None,
        _ => AvailabilityIntent.Unknown
    };
    internal bool ShouldAttempt(string file, AvailabilityIntent intent)
    {
        Validate(file, intent);
        if (intent == AvailabilityIntent.Unknown) return false;
        if (failed.TryGetValue(file, out var previous)) {
            if (previous == intent) return false;
            failed.Remove(file); // Only an observed intent change or a new connection releases suppression.
        }
        return intent != AvailabilityIntent.None;
    }
    internal void MarkFailed(string file, AvailabilityIntent intent)
    {
        Validate(file, intent);
        if (intent is AvailabilityIntent.None or AvailabilityIntent.Unknown) throw new ArgumentException("A concrete failed availability intent is required.");
        failed[file] = intent;
    }
    internal void Clear() => failed.Clear();
    // Called under the owning worker's synchronization lock after admission validation.
    internal void AddKnown(IEnumerable<string> paths)
    {
        foreach (var path in paths) known.Add(path);
    }
    private void Validate(string file, AvailabilityIntent intent)
    {
        if (!known.Contains(file) || !Enum.IsDefined(intent)) throw new ArgumentException("Availability intent is outside the manifest.");
    }
}
