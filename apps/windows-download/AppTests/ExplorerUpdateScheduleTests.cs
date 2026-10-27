using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files.Tests;

internal static class ExplorerUpdateScheduleTests
{
    internal static async Task Run()
    {
        var artifacts = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Explicit test artifact root required.");
        if (!Path.IsPathFullyQualified(artifacts)) throw new IOException("Test artifact root refused.");
        var root = Path.Combine(artifacts, "update-schedule-fixtures", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var clock = new DateTimeOffset(2026, 10, 26, 12, 0, 0, TimeSpan.Zero);
        True(ExplorerUpdateSchedulePolicy.Initial(clock, TimeSpan.FromMinutes(1)) == clock.AddMinutes(3), "initial delay+jitter");
        Throws(() => ExplorerUpdateSchedulePolicy.Initial(clock, TimeSpan.FromMinutes(-1)), "negative jitter");
        Throws(() => ExplorerUpdateSchedulePolicy.Initial(clock, TimeSpan.FromMinutes(3)), "unbounded jitter");
        Throws(() => ExplorerUpdateScheduleSettingsStore.CreatePilot(root), "arbitrary production location");

        var fresh = Store("fresh/not-yet-created");
        var initial = fresh.Load(); True(initial.Issue is null && initial.Settings.AutoUpdatesEnabled && initial.Settings.NextDueUtc is null, "truly missing settings defaults on without creating directories");
        True(!Directory.Exists(Path.Combine(root, "fresh/not-yet-created")), "load does not create state");
        fresh.Save(new(false, clock));
        True(fresh.Load().Settings == new ExplorerUpdateScheduleSettings(false, clock), "atomic round trip and bounded parent creation");
        var ownedLock = Path.Combine(root, "fresh/not-yet-created", ExplorerUpdateScheduleSettingsStore.Leaf + ".lock");
        True(new FileInfo(ownedLock).Length == 0, "first save leaves an owned empty writer lock");
        AssertCurrentOwnerAndAcl(ownedLock);
        AssertCurrentOwnerAndAcl(Path.Combine(root, "fresh/not-yet-created", ExplorerUpdateScheduleSettingsStore.Leaf));
        var ownedLockSecurity = new FileInfo(ownedLock).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access).GetSecurityDescriptorBinaryForm();
        fresh.Save(new(true, clock.AddHours(6))); True(fresh.Load().Settings.AutoUpdatesEnabled, "replacement round trip");
        True(new FileInfo(ownedLock).Length == 0, "existing owned empty lock reused without mutation");
        True(new FileInfo(ownedLock).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access).GetSecurityDescriptorBinaryForm().AsSpan().SequenceEqual(ownedLockSecurity),
            "OPEN_ALWAYS preserves the existing owned lock's exact security descriptor");
        AssertCurrentOwnerAndAcl(Path.Combine(root, "fresh/not-yet-created", ExplorerUpdateScheduleSettingsStore.Leaf));
        var data = File.ReadAllText(Path.Combine(root, "fresh/not-yet-created", ExplorerUpdateScheduleSettingsStore.Leaf));
        True(!data.Contains("source") && !data.Contains("principal") && !data.Contains("token"), "only schedule preference is saved");

        foreach (var malformed in new[] { "{}", "[]", "{", data.Replace("\"schemaVersion\":1", "\"schemaVersion\":2"), data.Replace("LedgeTop.Files.UpdateSchedule/1", "foreign"),
            data.Replace("\"autoUpdatesEnabled\":true", "\"autoUpdatesEnabled\":true,\"autoUpdatesEnabled\":false"),
            data.Replace("\"autoUpdatesEnabled\":true", "\"AutoUpdatesEnabled\":true"), data.Replace("\"autoUpdatesEnabled\":true", "\"autoUpdatesEnabled\":\"true\""),
            data.Replace("\"owner\":", "\"extra\":0,\"owner\":"), new string(' ', 1025), data.Replace("2026-10-26", "not-a-date") }) {
            var directory = Path.Combine(root, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, ExplorerUpdateScheduleSettingsStore.Leaf); CreateFixtureFile(path, malformed);
            var invalid = ExplorerUpdateScheduleSettingsStore.CreateForTests(directory);
            True(invalid.Load() is { Settings.AutoUpdatesEnabled: false, Issue: not null }, "unknown/corrupt/foreign settings pause automatically");
            Throws(() => invalid.Save(new(true, clock)), "invalid settings cannot be silently overwritten");
            True(File.ReadAllText(path) == malformed, "invalid original remains exact");
        }

        var linkedDirectory = Path.Combine(root, "hardlink"); Directory.CreateDirectory(linkedDirectory);
        var original = Path.Combine(root, "original.json"); CreateFixtureFile(original, data);
        True(CreateHardLinkW(Path.Combine(linkedDirectory, ExplorerUpdateScheduleSettingsStore.Leaf), original, IntPtr.Zero), "owned hardlink fixture created");
        True(ExplorerUpdateScheduleSettingsStore.CreateForTests(linkedDirectory).Load().Issue is not null, "hardlink rejected");
        var aliasDirectory = Path.Combine(root, "alias-leaf"); Directory.CreateDirectory(aliasDirectory);
        Junction(Path.Combine(aliasDirectory, ExplorerUpdateScheduleSettingsStore.Leaf), linkedDirectory);
        True(ExplorerUpdateScheduleSettingsStore.CreateForTests(aliasDirectory).Load().Issue is not null, "reparse leaf rejected");
        var aliasParent = Path.Combine(root, "alias-parent"); Junction(aliasParent, linkedDirectory);
        True(ExplorerUpdateScheduleSettingsStore.CreateForTests(aliasParent).Load().Issue is not null, "reparse ancestor rejected");
        var foreignLock = Store("foreign-lock"); Directory.CreateDirectory(Path.Combine(root, "foreign-lock"));
        CreateFixtureFile(Path.Combine(root, "foreign-lock", ExplorerUpdateScheduleSettingsStore.Leaf + ".lock"), "foreign");
        Throws(() => foreignLock.Save(new(true, clock)), "unrecognized lock bytes are never overwritten");
        // On an elevated Windows runner the default owner can be Administrators. When that owner
        // is assignable without changing privileges, prove OPEN_ALWAYS never adopts it. Normal
        // tokens still run every strict owner assertion above; this extra adversarial fixture is
        // unavailable when Windows refuses assigning the foreign SID in the first place.
        var foreignOwnersExercised = 0;
        foreach (var lockOnly in new[] { false, true }) {
            var directory = Path.Combine(root, "foreign-owner-" + lockOnly); Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, ExplorerUpdateScheduleSettingsStore.Leaf + (lockOnly ? ".lock" : ""));
            var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            if (TryCreateForeignOwnerFixture(path, lockOnly ? "" : data, administrators)) {
                foreignOwnersExercised++;
                var bytesBefore = File.ReadAllBytes(path); var descriptorBefore = new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access).GetSecurityDescriptorBinaryForm();
                var refused = ExplorerUpdateScheduleSettingsStore.CreateForTests(directory);
                if (!lockOnly) True(refused.Load().Issue is not null, "foreign owner settings stay visibly disabled");
                Throws(() => refused.Save(new(true, clock)), "foreign owner cannot be adopted by save/open-always");
                True(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytesBefore) && new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access)
                    .GetSecurityDescriptorBinaryForm().AsSpan().SequenceEqual(descriptorBefore), "foreign owner data and security descriptor remain exact");
            }
        }
        Console.WriteLine("Schedule ACL checks: current-user owner/protected ACL verified for new lock and two publications; assignable foreign-owner fixtures=" + foreignOwnersExercised + "/2 (no token or privilege changes).");

        var eligible = new ExplorerUpdateScheduleEligibility(true, false, false, false); var checks = 0; var installs = 0;
        var disableEarlyStore = Store("disable-before-first-tick");
        var disableEarly = new ExplorerUpdateScheduleController(disableEarlyStore, () => clock, TimeSpan.Zero, () => eligible,
            _ => throw new InvalidOperationException(), _ => throw new InvalidOperationException());
        await disableEarly.SetEnabledAsync(false);
        var disableReloaded = new ExplorerUpdateScheduleController(disableEarlyStore, () => clock, TimeSpan.Zero, () => eligible,
            _ => throw new InvalidOperationException(), _ => throw new InvalidOperationException());
        True(disableReloaded.Status is { State: ExplorerUpdateScheduleState.Disabled, NextDueUtc: not null, Issue: null }, "ordinary early disable never persists uncertainty sentinel");
        var scheduled = new ExplorerUpdateScheduleController(Store("normal"), () => clock, TimeSpan.FromSeconds(30), () => eligible,
            _ => { checks++; return Task.FromResult(true); }, _ => { installs++; return Task.FromResult(new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.Postponed, false)); });
        await scheduled.TickAsync(); True(checks == 0, "not before initial delay");
        clock = clock.AddMinutes(3);
        foreach (var skip in new[] { new ExplorerUpdateScheduleEligibility(false, false, false, false), new(true, true, false, false), new(true, false, true, false), new(true, false, false, true) }) {
            eligible = skip; await scheduled.TickAsync(); True(checks == 0, "disconnected/busy/maintenance/quitting skips");
        }
        eligible = new(true, false, false, false); await scheduled.TickAsync();
        True(checks == 1 && installs == 1 && scheduled.Status.NextDueUtc == clock.AddHours(6), "one safe scheduled attempt then6h");
        clock = clock.AddHours(6); await scheduled.SetEnabledAsync(false); await scheduled.TickAsync(); True(checks == 1, "disabled persists and skips");
        True(!Store("normal").Load().Settings.AutoUpdatesEnabled, "preference survives new store");
        await scheduled.SetEnabledAsync(true); await scheduled.TickAsync(); True(checks == 1, "reenable waits initial delay");
        await scheduled.StopAsync(); clock = clock.AddDays(1); await scheduled.TickAsync(); True(checks == 1 && scheduled.Status.State == ExplorerUpdateScheduleState.Stopped, "stopped never restarts");

        var changed = new ExplorerUpdateScheduleController(Store("eligibility-changes"), () => clock, TimeSpan.Zero, () => eligible,
            _ => { eligible = eligible with { Maintenance = true }; return Task.FromResult(true); }, _ => throw new InvalidOperationException("must not install"));
        clock = clock.AddMinutes(3); await changed.TickAsync(); True(changed.Status.State == ExplorerUpdateScheduleState.Waiting, "eligibility rechecked after metadata and before install");
        eligible = new(true, false, false, false);
        var safeFailure = new ExplorerUpdateScheduleController(Store("check-failure"), () => clock, TimeSpan.Zero, () => eligible,
            _ => throw new IOException("private-header-principal"), _ => throw new InvalidOperationException());
        clock = clock.AddMinutes(3); await safeFailure.TickAsync(); True(safeFailure.Status.NextDueUtc == clock.AddHours(1) && safeFailure.Status.Issue is null, "check failure retries no sooner than1h without raw error");

        var exitCalls = 0; var exitStore = Store("accepted-parent-exit");
        var exiting = new ExplorerUpdateScheduleController(exitStore, () => clock, TimeSpan.Zero, () => eligible,
            _ => Task.FromResult(true), _ => { exitCalls++; return Task.FromResult(new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.ParentExitRequested, true)); });
        clock = clock.AddMinutes(3); await exiting.TickAsync(); clock = clock.AddDays(1); await exiting.TickAsync();
        var afterExit = new ExplorerUpdateScheduleController(exitStore, () => clock, TimeSpan.Zero, () => eligible,
            _ => Task.FromResult(false), _ => throw new InvalidOperationException());
        True(exitCalls == 1 && exiting.Status.State == ExplorerUpdateScheduleState.Stopped && afterExit.Status is { AutoUpdatesEnabled: true, NextDueUtc: not null, Issue: null },
            "successful parent exit stops old controller but preserves next-version automatic schedule");

        foreach (var outcome in new[] { ExeUpdateHandoffStatus.ExitUncertain, ExeUpdateHandoffStatus.RecoveryBlocked, (ExeUpdateHandoffStatus)999 }) {
            var calls = 0;
            var uncertainStore = Store(Guid.NewGuid().ToString("N"));
            var unsafeFlow = new ExplorerUpdateScheduleController(uncertainStore, () => clock, TimeSpan.Zero, () => eligible,
                _ => Task.FromResult(true), _ => { calls++; return Task.FromResult(new ExeUpdateHandoffResult(outcome, true)); });
            clock = clock.AddMinutes(3); await unsafeFlow.TickAsync(); clock = clock.AddDays(1); await unsafeFlow.TickAsync();
            await unsafeFlow.SetEnabledAsync(false); await unsafeFlow.StopAsync();
            True(calls == 1 && unsafeFlow.Status is { State: ExplorerUpdateScheduleState.NeedsReview, Issue: not null }, "uncertain helper outcome remains sticky after cancellation/settings/stop");
            var restarted = new ExplorerUpdateScheduleController(uncertainStore, () => clock, TimeSpan.Zero, () => eligible,
                _ => throw new InvalidOperationException(), _ => throw new InvalidOperationException());
            await restarted.SetEnabledAsync(true); await restarted.TickAsync();
            True(restarted.Status is { State: ExplorerUpdateScheduleState.NeedsReview, AutoUpdatesEnabled: false }, "diagnostic uncertainty pause survives restart and cannot silently reenable");
        }
        await CancellationJoins(installing: false); await CancellationJoins(installing: true); await CancellationJoins(installing: true, confirmsStopped: true);
        var readOnlyBad = Store("bad-controller"); Directory.CreateDirectory(Path.Combine(root, "bad-controller"));
        CreateFixtureFile(Path.Combine(root, "bad-controller", ExplorerUpdateScheduleSettingsStore.Leaf), "{}");
        var badController = new ExplorerUpdateScheduleController(readOnlyBad, () => clock, TimeSpan.Zero, () => eligible, _ => throw new InvalidOperationException(), _ => throw new InvalidOperationException());
        await badController.TickAsync(); True(badController.Status is { AutoUpdatesEnabled: false, Issue: not null }, "corrupt config remains visibly off without callbacks");

        ExplorerUpdateScheduleSettingsStore Store(string relative) => ExplorerUpdateScheduleSettingsStore.CreateForTests(Path.Combine(root, relative));
        async Task CancellationJoins(bool installing, bool confirmsStopped = false)
        {
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var calls = 0;
            async Task Wait(CancellationToken token) { calls++; entered.SetResult(); using var registration = token.Register(() => cancelled.TrySetResult()); await release.Task; token.ThrowIfCancellationRequested(); }
            var controller = new ExplorerUpdateScheduleController(Store(Guid.NewGuid().ToString("N")), () => clock, TimeSpan.Zero, () => eligible,
                async token => { if (!installing) await Wait(token); return true; }, async token => {
                    try { await Wait(token); } catch (OperationCanceledException) when (confirmsStopped) { }
                    return new(ExeUpdateHandoffStatus.Postponed, false);
                });
            clock = clock.AddMinutes(3); var running = controller.TickAsync(); await entered.Task;
            await controller.TickAsync(); True(calls == 1, "single flight even during reentrant tick");
            var stop = controller.StopAsync(); await cancelled.Task; True(!stop.IsCompleted && !running.IsCompleted, "stop cancels then joins callback");
            release.SetResult(); await Task.WhenAll(stop, running);
            True(controller.Status.State == (installing && !confirmsStopped ? ExplorerUpdateScheduleState.NeedsReview : ExplorerUpdateScheduleState.Stopped), "cancelled install requires positive typed safe result; check-only stop is safe");
        }
    }
    private static void Throws(Action action, string description) { try { action(); } catch { return; } throw new InvalidOperationException(description); }
    private static void True(bool value, string description) { if (!value) throw new InvalidOperationException(description); }
    private static void AssertCurrentOwnerAndAcl(string path)
    {
        using var current = WindowsIdentity.GetCurrent();
        var security = new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        True(Equals(security.GetOwner(typeof(SecurityIdentifier)), current.User), "new lock/published file owner is actual user SID regardless of token default owner");
        var expected = new HashSet<string> { current.User!.Value, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null).Value };
        var rules = security.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
        True(security.AreAccessRulesProtected && rules.Length == expected.Count && rules.All(rule => !rule.IsInherited && rule.AccessControlType == AccessControlType.Allow &&
            rule.FileSystemRights == FileSystemRights.FullControl && expected.Contains(rule.IdentityReference.Value)), "new files have only protected current-user+SYSTEM full control");
    }
    private static void CreateFixtureFile(string path, string text, SecurityIdentifier? owner = null)
    {
        using var current = WindowsIdentity.GetCurrent();
        var security = new FileSecurity(); security.SetOwner(owner ?? current.User!);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(current.User!, FileSystemRights.FullControl, AccessControlType.Allow));
        using var file = FileSystemAclExtensions.Create(new FileInfo(path), FileMode.CreateNew, FileSystemRights.Read | FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, security);
        var bytes = new UTF8Encoding(false).GetBytes(text); file.Write(bytes); file.Flush(flushToDisk: true);
    }
    private static bool TryCreateForeignOwnerFixture(string path, string text, SecurityIdentifier foreign)
    {
        try { CreateFixtureFile(path, text, foreign); return true; }
        catch (UnauthorizedAccessException) { True(!File.Exists(path), "unassignable owner fails at creation without leaving a file"); return false; }
        catch (IOException error) when ((error.HResult & 0xffff) is 1307 or 1314) {
            True(!File.Exists(path), "Windows invalid-owner/privilege refusal leaves no test file"); return false;
        }
    }
    private static void Junction(string alias, string target)
    {
        if (alias.Concat(target).Any(ch => "&|<>^\"%!\r\n".Contains(ch))) throw new IOException("Test junction argument refused.");
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe") {
            Arguments = "/d /c mklink /J \"" + alias + "\" \"" + target + "\"", UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        }) ?? throw new IOException("Test junction unavailable.");
        if (!process.WaitForExit(10000) || process.ExitCode != 0) throw new IOException("Test junction unavailable.");
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateHardLinkW(string link, string existing, IntPtr security);
}
