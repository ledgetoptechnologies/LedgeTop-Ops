using LedgeTop.Files;

internal static class FreshStopRecoveryJournalTests
{
    internal static Task Run()
    {
        var root = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Generated root required.");
        var dir = NewDirectory(root); var lockPath = Path.Combine(dir, "index.lock");
        using var original = SelectorIndexOwnership.Acquire(lockPath, FileMode.CreateNew);
        var op = Guid.NewGuid(); var selector = new string('a', 64); bool selectorCurrent = true, drained = false;
        bool Exact() => selectorCurrent;
        if (FreshStopRecoveryJournal.Discover(dir, selector, original, Exact) is not null) throw new Exception("Unexpected discovery.");
        FreshStopRecoveryJournal.RecordIntent(dir, op, selector, original, Exact);
        // An unresolved operation blocks every other operation, including another ID.
        Refuse(() => FreshStopRecoveryJournal.RecordIntent(dir, Guid.NewGuid(), selector, original, Exact));
        Refuse(() => FreshStopRecoveryJournal.RecordIntent(dir, op, selector, original, Exact));
        // Transfer retains the same lock and invalidates the prior epoch.
        using var next = original.Transfer();
        Refuse(() => FreshStopRecoveryJournal.Observe(dir, op, selector, original, Exact));
        if (FreshStopRecoveryJournal.Discover(dir, selector, next, Exact) != (op, FreshStopRecoveryJournal.Observation.IntentRecordPresent)) throw new Exception("Intent discovery failed.");
        Refuse(() => FreshStopRecoveryJournal.RecordDrained(dir, op, selector, next, Exact, () => drained));
        drained = true; FreshStopRecoveryJournal.RecordDrained(dir, op, selector, next, Exact, () => drained);
        if (FreshStopRecoveryJournal.Discover(dir, selector, next, Exact) != (op, FreshStopRecoveryJournal.Observation.DrainRecordPresent)) throw new Exception("Drain discovery failed.");
        Refuse(() => FreshStopRecoveryJournal.Observe(dir, op, new string('b', 64), next, Exact));
        Refuse(() => FreshStopRecoveryJournal.RecordDrained(dir, op, selector, next, Exact, () => drained));
        // Real exclusive handle blocks a second owner while discovery/write owns it.
        Refuse(() => { using var competing = SelectorIndexOwnership.Acquire(lockPath); });
        selectorCurrent = false; Refuse(() => FreshStopRecoveryJournal.Discover(dir, selector, next, Exact)); selectorCurrent = true;

        var secondDir = NewDirectory(root); using var secondOwner = SelectorIndexOwnership.Acquire(Path.Combine(secondDir, "index.lock"), FileMode.CreateNew);
        var second = Guid.NewGuid(); int calls = 0;
        // The fourth selector check occurs after publication; uncertain bytes remain.
        Refuse(() => FreshStopRecoveryJournal.RecordIntent(secondDir, second, selector, secondOwner, () => ++calls < 4));
        if (FreshStopRecoveryJournal.Discover(secondDir, selector, secondOwner, () => true) != (second, FreshStopRecoveryJournal.Observation.IntentRecordPresent)) throw new Exception("Uncertain intent was not retained.");

        var partialDir = NewDirectory(root); using var partialOwner = SelectorIndexOwnership.Acquire(Path.Combine(partialDir, "index.lock"), FileMode.CreateNew);
        var partial = Guid.NewGuid(); var partialPath = Path.Combine(partialDir, $"fresh-stop-{partial:N}.intent.json"); File.WriteAllText(partialPath, "{");
        Refuse(() => FreshStopRecoveryJournal.Discover(partialDir, selector, partialOwner, () => true));
        if (File.ReadAllText(partialPath) != "{") throw new Exception("Partial record changed.");
        var orphanDir = NewDirectory(root); using var orphanOwner = SelectorIndexOwnership.Acquire(Path.Combine(orphanDir, "index.lock"), FileMode.CreateNew);
        var orphan = Guid.NewGuid(); File.WriteAllText(Path.Combine(orphanDir, $"fresh-stop-{orphan:N}.drained.json"), "{}");
        Refuse(() => FreshStopRecoveryJournal.Discover(orphanDir, selector, orphanOwner, () => true));
        return Task.CompletedTask;
    }
    private static string NewDirectory(string root) {
        var dir = Path.Combine(root, "stop-journal-" + Guid.NewGuid().ToString("N"), "connected-explorer-pilot-employee"); Directory.CreateDirectory(dir); return dir;
    }
    private static void Refuse(Action action) { try { action(); } catch (IOException) { return; } catch (ObjectDisposedException) { return; } throw new Exception("Expected refusal."); }
}
