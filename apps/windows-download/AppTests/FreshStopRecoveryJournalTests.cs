using LedgeTop.Files;

internal static class FreshStopRecoveryJournalTests
{
    internal static Task Run()
    {
        var root = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Generated root required.");
        var dir = Path.Combine(root, "stop-journal-" + Guid.NewGuid().ToString("N"), "connected-explorer-pilot-employee");
        Directory.CreateDirectory(dir);
        var op = Guid.NewGuid(); var selector = new string('a', 64); bool owner = true, drained = false;
        bool Owned() => owner;
        if (FreshStopRecoveryJournal.Discover(dir, selector, Owned) is not null) throw new Exception("Unexpected discovery.");
        if (FreshStopRecoveryJournal.Observe(dir, op, selector, Owned) != FreshStopRecoveryJournal.Observation.Missing) throw new Exception("Unexpected journal.");
        FreshStopRecoveryJournal.RecordIntent(dir, op, selector, Owned);
        // Simulate loss of the original owner before drain: an unowned reader cannot reconcile.
        owner = false;
        Refuse(() => FreshStopRecoveryJournal.Observe(dir, op, selector, Owned));
        owner = true; // models a new, separately verified owner
        if (FreshStopRecoveryJournal.Observe(dir, op, selector, Owned) != FreshStopRecoveryJournal.Observation.IntentRecordPresent) throw new Exception("Intent was lost.");
        if (FreshStopRecoveryJournal.Discover(dir, selector, Owned) != (op, FreshStopRecoveryJournal.Observation.IntentRecordPresent)) throw new Exception("Intent discovery failed.");
        Refuse(() => FreshStopRecoveryJournal.RecordIntent(dir, op, selector, Owned));
        Refuse(() => FreshStopRecoveryJournal.RecordDrained(dir, op, selector, Owned, () => drained));
        drained = true;
        FreshStopRecoveryJournal.RecordDrained(dir, op, selector, Owned, () => drained);
        if (FreshStopRecoveryJournal.Observe(dir, op, selector, Owned) != FreshStopRecoveryJournal.Observation.DrainRecordPresent) throw new Exception("Drain receipt was lost.");
        if (FreshStopRecoveryJournal.Discover(dir, selector, Owned) != (op, FreshStopRecoveryJournal.Observation.DrainRecordPresent)) throw new Exception("Drain discovery failed.");
        Refuse(() => FreshStopRecoveryJournal.Observe(dir, op, new string('b', 64), Owned));
        Refuse(() => FreshStopRecoveryJournal.RecordDrained(dir, op, selector, Owned, () => drained));
        // Loss of authority immediately after file publication is explicitly uncertain;
        // a fresh owner sees the retained intent, never an implied completed release.
        var second = Guid.NewGuid(); int calls = 0;
        Refuse(() => FreshStopRecoveryJournal.RecordIntent(dir, second, selector, () => ++calls == 1));
        if (FreshStopRecoveryJournal.Observe(dir, second, selector, Owned) != FreshStopRecoveryJournal.Observation.IntentRecordPresent) throw new Exception("Uncertain intent was not retained.");
        Refuse(() => FreshStopRecoveryJournal.Discover(dir, selector, Owned));
        // Partial record and orphan receipt fail closed, never rewritten or deleted.
        var partial = Guid.NewGuid(); var partialPath = Path.Combine(dir, $"fresh-stop-{partial:N}.intent.json"); File.WriteAllText(partialPath, "{");
        Refuse(() => FreshStopRecoveryJournal.Observe(dir, partial, selector, Owned));
        if (File.ReadAllText(partialPath) != "{") throw new Exception("Partial record changed.");
        var orphan = Guid.NewGuid(); File.WriteAllText(Path.Combine(dir, $"fresh-stop-{orphan:N}.drained.json"), "{}");
        Refuse(() => FreshStopRecoveryJournal.Observe(dir, orphan, selector, Owned));
        return Task.CompletedTask;
    }
    private static void Refuse(Action action) { try { action(); } catch (IOException) { return; } throw new Exception("Expected refusal."); }
}
