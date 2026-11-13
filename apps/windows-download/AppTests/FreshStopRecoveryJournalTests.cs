using LedgeTop.Files;
using System.Diagnostics;

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
        // A second intent or malformed/orphan extra prevents a drain record.
        foreach (var extra in new[] { "intent", "drained", "bad" }) {
            var conflictDir = NewDirectory(root); using var conflict = SelectorIndexOwnership.Acquire(Path.Combine(conflictDir, "index.lock"), FileMode.CreateNew);
            var first = Guid.NewGuid(); FreshStopRecoveryJournal.RecordIntent(conflictDir, first, selector, conflict, () => true);
            var name = extra == "bad" ? "fresh-stop-not-a-guid.intent.json" : $"fresh-stop-{Guid.NewGuid():N}.{extra}.json";
            File.WriteAllText(Path.Combine(conflictDir, name), "{}");
            Refuse(() => FreshStopRecoveryJournal.RecordDrained(conflictDir, first, selector, conflict, () => true, () => true));
            if (File.Exists(Path.Combine(conflictDir, $"fresh-stop-{first:N}.drained.json"))) throw new Exception("Conflicting drain record was written.");
        }
        // Each caller-supplied callback is adversarial: a swallowed reentrant
        // Dispose/Transfer must poison the operation and preserve the lock.
        foreach (var method in new[] { "intent", "discover", "observe", "drain-selector", "drain-proof" })
            foreach (var mutation in new[] { "dispose", "transfer" }) {
                int maximum = method switch { "intent" => 4, "discover" => 4, "observe" => 2, "drain-selector" => 6, _ => 2 };
                for (int checkpoint = 1; checkpoint <= maximum; checkpoint++) Reentrant(root, selector, method, mutation, checkpoint);
            }
#if DEBUG
        var crossDir = NewDirectory(root); var crossOp = Guid.NewGuid();
        using (var crossOwner = SelectorIndexOwnership.Acquire(Path.Combine(crossDir, "index.lock"), FileMode.CreateNew)) {
            FreshStopRecoveryJournal.RecordIntent(crossDir, crossOp, selector, crossOwner, () => true);
            bool launched = false;
            FreshStopRecoveryJournal.Discover(crossDir, selector, crossOwner, () => {
                if (!launched) { launched = true; CheckChild(crossDir, "locked"); }
                return true;
            });
            if (!launched) throw new Exception("Cross-process contention was not tested.");
        }
        // After the first owner releases, the second process obtains the lock but
        // must still refuse a new ID because the prior journal is unresolved.
        CheckChild(crossDir, "unresolved");
#endif
        return Task.CompletedTask;
    }
#if DEBUG
    private static void CheckChild(string dir, string expected) {
        var exe = Environment.ProcessPath ?? throw new IOException("Test executable is unavailable.");
        var info = new ProcessStartInfo(exe) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) info.ArgumentList.Add(typeof(FreshStopRecoveryJournalTests).Assembly.Location);
        info.ArgumentList.Add("--fresh-stop-journal-child"); info.ArgumentList.Add(dir);
        using var child = Process.Start(info) ?? throw new IOException("Test child did not start.");
        if (!child.WaitForExit(10000)) { child.Kill(true); if (!child.WaitForExit(5000)) throw new IOException("Test child termination is unconfirmed."); throw new IOException("Test child timed out."); }
        var output = child.StandardOutput.ReadToEnd().Trim(); var error = child.StandardError.ReadToEnd().Trim();
        if (child.ExitCode != 0 || output != expected) throw new IOException($"Test child returned {child.ExitCode}: {output}; {error}");
    }
    internal static int Child(string directory) {
        var root = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Generated root required.");
        var resolved = Path.GetFullPath(directory); var allowed = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
        if (!resolved.StartsWith(allowed, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(resolved) != "connected-explorer-pilot-employee" || !Path.GetFileName(Path.GetDirectoryName(resolved)!).StartsWith("stop-journal-", StringComparison.Ordinal)) throw new IOException("Generated directory required.");
        SelectorIndexOwnership owner;
        try { owner = SelectorIndexOwnership.Acquire(Path.Combine(resolved, "index.lock")); }
        catch (IOException) { Console.WriteLine("locked"); return 0; }
        using (owner) {
            try { FreshStopRecoveryJournal.RecordIntent(resolved, Guid.NewGuid(), new string('a', 64), owner, () => true); }
            catch (IOException) { Console.WriteLine("unresolved"); return 0; }
        }
        throw new IOException("A second intent unexpectedly succeeded.");
    }
#endif
    private static void Reentrant(string root, string selector, string method, string mutation, int checkpoint) {
        var dir = NewDirectory(root); using var owner = SelectorIndexOwnership.Acquire(Path.Combine(dir, "index.lock"), FileMode.CreateNew);
        var id = Guid.NewGuid();
        if (method != "intent") FreshStopRecoveryJournal.RecordIntent(dir, id, selector, owner, () => true);
        int n = 0; bool Probe() {
            if (++n == checkpoint) { try { if (mutation == "dispose") owner.Dispose(); else owner.Transfer(); } catch (IOException) { } }
            return true;
        }
        Refuse(() => {
            switch (method) {
                case "intent": FreshStopRecoveryJournal.RecordIntent(dir, id, selector, owner, Probe); break;
                case "discover": FreshStopRecoveryJournal.Discover(dir, selector, owner, Probe); break;
                case "observe": FreshStopRecoveryJournal.Observe(dir, id, selector, owner, Probe); break;
                case "drain-selector": FreshStopRecoveryJournal.RecordDrained(dir, id, selector, owner, Probe, () => true); break;
                default: FreshStopRecoveryJournal.RecordDrained(dir, id, selector, owner, () => true, Probe); break;
            }
        });
        if (n != checkpoint || !owner.IsHeld) throw new Exception("Reentrant mutation did not preserve lock and fail closed.");
    }
    private static string NewDirectory(string root) {
        var dir = Path.Combine(root, "stop-journal-" + Guid.NewGuid().ToString("N"), "connected-explorer-pilot-employee"); Directory.CreateDirectory(dir); return dir;
    }
    private static void Refuse(Action action) { try { action(); } catch (IOException) { return; } catch (ObjectDisposedException) { return; } throw new Exception("Expected refusal."); }
}
