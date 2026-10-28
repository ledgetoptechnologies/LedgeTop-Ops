using LedgeTop.Files;
using System.Text;

internal static class WindowsStartupAdapterTests
{
    private const string Executable = @"C:\Users\Synthetic\AppData\Local\Programs\LedgeTop Files Pilot\versions\0.5.3.0\LedgeTop.Files.exe";
    internal static async Task Run()
    {
        Require(WindowsStartupPolicy.RunValueName == "LedgeTopFilesPilot" && WindowsStartupPolicy.StartupSavedSourceArgument == "--startup-saved-source-v1", "fixed installer contract");
        Require(WindowsStartupPolicy.PreferenceKey == @"Software\LedgeTop\Files\Pilot" && WindowsStartupPolicy.PreferenceValueName == "StartupEnabled", "fixed explicit preference contract shared with installer");
        Require(WindowsStartupPolicy.DecodePreference(4, [0, 0, 0, 0]) == WindowsStartupPreference.Disabled &&
            WindowsStartupPolicy.DecodePreference(4, [1, 0, 0, 0]) == WindowsStartupPreference.Enabled &&
            WindowsStartupPolicy.DecodePreference(4, [2, 0, 0, 0]) == WindowsStartupPreference.Invalid &&
            WindowsStartupPolicy.DecodePreference(1, [1, 0, 0, 0]) == WindowsStartupPreference.Invalid &&
            WindowsStartupPolicy.DecodePreference(4, [1]) == WindowsStartupPreference.Invalid, "preference accepts exact DWORD0/1 only");
        foreach (var alias in new[] { "employee", "portal" }) {
            var fresh = new Fixture(); var enabled = await fresh.Adapter.ApplyDefaultAsync(alias, default);
            Require(enabled.Enabled && enabled.SourceAlias == alias && fresh.Store.Writes == 1 && fresh.Store.Preference == true,
                "unset installed launch defaults on only for its selected source coordinate");
            await fresh.Adapter.ApplyDefaultAsync(alias, default); Require(fresh.Store.Writes == 1, "default is idempotent");
        }
        foreach (var preference in new[] { false, true }) {
            var stored = new Fixture(); stored.Store.Preference = preference;
            Require(!(await stored.Adapter.ApplyDefaultAsync("employee", default)).Enabled && stored.Store.Writes == 0 && stored.Store.Preference == preference,
                "recorded preference preserves absent Run without silently overriding user or external choice");
        }
        var ownedExisting = new Fixture(); ownedExisting.Store.Value = new(WindowsStartupValueKind.String, WindowsStartupPolicy.Command(Executable, "portal"));
        Require((await ownedExisting.Adapter.ApplyDefaultAsync("employee", default)).SourceAlias == "portal" && ownedExisting.Store.Writes == 0 && ownedExisting.Store.Preference is null,
            "existing owned Run alias is preserved without relabeling or preference write");
        var malformed = new Fixture(); malformed.Store.PreferenceOverride = WindowsStartupPreference.Invalid;
        Require((await malformed.Adapter.ApplyDefaultAsync("employee", default)).Availability == WindowsStartupAvailability.Conflict &&
            (await malformed.Adapter.SetEnabledAsync(true, "employee", default)).Availability == WindowsStartupAvailability.Conflict && malformed.Store.Writes == 0 && malformed.Store.Preference is null,
            "malformed stored preference is retained for review even on explicit toggle");
        var defaultRace = new Fixture(); defaultRace.Store.BeforeReplace = () => defaultRace.Store.Preference = false;
        Require((await defaultRace.Adapter.ApplyDefaultAsync("employee", default)).Availability == WindowsStartupAvailability.Conflict && defaultRace.Store.Writes == 0 && defaultRace.Store.Preference == false,
            "default CAS rechecks preference so cooperating opt-out cannot be overwritten");
        foreach (var alias in new[] { "portal", "employee" }) {
            var text = WindowsStartupPolicy.Command(Executable, alias);
            Require(text == '"' + Executable + "\" --startup-saved-source-v1 " + alias && text.Length <= 260, "exact quoted command contains only source coordinates");
            Require(WindowsStartupPolicy.RecognizedCommandShape(new(WindowsStartupValueKind.String, text)), "owned shape recognized");
            var raw = Encoding.Unicode.GetBytes(text + '\0');
            Require(WindowsStartupPolicy.DecodeRunValue(1, raw) == new WindowsStartupRunValue(WindowsStartupValueKind.String, text), "exact raw REG_SZ retained");
            foreach (var invalid in new[] { raw[..^2], raw[..^1], Encoding.Unicode.GetBytes(text + "\0\0"), new byte[] { 0, 0xD8, 0, 0 }, new byte[524] })
                Require(WindowsStartupPolicy.DecodeRunValue(1, invalid).Kind == WindowsStartupValueKind.Other, "missing/extra NUL, odd/oversize/invalid UTF16 stays foreign");
            Require(WindowsStartupPolicy.DecodeRunValue(2, raw).Kind == WindowsStartupValueKind.Other, "REG_EXPAND_SZ is never literal owned text");
        }
        foreach (var path in new[] { @"C:\other\LedgeTop.Files.exe", @"\\server\share\LedgeTop.Files.exe", Executable.Replace("0.5.3.0", "0.5.3", StringComparison.Ordinal),
            Executable.Replace("0.5.3.0", "0.5.65536.0", StringComparison.Ordinal), Executable.Replace("0.5.3.0", "00.5.3.0", StringComparison.Ordinal),
            Executable.Replace("Synthetic", "..", StringComparison.Ordinal), Executable.Replace("Synthetic", "user%other", StringComparison.Ordinal),
            Executable.Replace("Synthetic", "invalid\ud800", StringComparison.Ordinal),
            Executable.Replace("Synthetic", new string('x', 220), StringComparison.Ordinal) }) {
            try { WindowsStartupPolicy.Command(path, "portal"); throw new Exception("Invalid startup executable accepted."); }
            catch (WindowsStartupOwnershipUnavailableException) { }
        }
        var f = new Fixture();
        Require(await f.Adapter.ValidateRunningInstallationAsync(default) && f.Store.Reads == 0 && f.Owner.Disposals == 1,
            "startup admission validates installed ownership/fences without reading/mutating Run");
        Require(await f.Adapter.GetStateAsync(default) == new WindowsStartupState(WindowsStartupAvailability.Available), "absent startup is opt-out");
        Require(await f.Adapter.SetEnabledAsync(true, "portal", default) == new WindowsStartupState(WindowsStartupAvailability.Available, true, "portal") && f.Store.Writes == 1,
            "enable only after fresh ownership proof");
        Require(f.Log.LastIndexOf("verify") < f.Log.LastIndexOf("readback") && f.Owner.Disposals == 3, "readback and ownership are confirmed and every proof disposed");
        await f.Adapter.SetEnabledAsync(true, "portal", default); Require(f.Store.Writes == 1 && f.Store.Preference == true, "idempotent enable records explicit preference without Run write");
        Require((await f.Adapter.SetEnabledAsync(true, "employee", default)).SourceAlias == "employee" && f.Store.Writes == 2, "explicit source change replaces other recognized owned alias");
        Require(await f.Adapter.SetEnabledAsync(false, "portal", default) == new WindowsStartupState(WindowsStartupAvailability.Available) && f.Store.Writes == 3,
            "explicit disable removes exact owned shape even when it names the other alias");
        await f.Adapter.SetEnabledAsync(false, "employee", default); Require(f.Store.Writes == 3 && f.Store.Preference == false, "absent explicit opt-out is persisted without Run mutation");

        foreach (var foreign in new[] {
            new WindowsStartupRunValue(WindowsStartupValueKind.Other, null), new(WindowsStartupValueKind.String, "\"C:\\other.exe\""),
            new(WindowsStartupValueKind.String, WindowsStartupPolicy.Command(Executable, "portal") + " --extra"),
            new(WindowsStartupValueKind.String, WindowsStartupPolicy.Command(Executable, "portal").Replace("0.5.3.0", "0.5.2.0", StringComparison.Ordinal)),
            new(WindowsStartupValueKind.String, WindowsStartupPolicy.Command(Executable, "portal").Replace("portal", "Portal", StringComparison.Ordinal))
        }) {
            var conflict = new Fixture(); conflict.Store.Value = foreign;
            Require((await conflict.Adapter.GetStateAsync(default)).Availability == WindowsStartupAvailability.Conflict, "foreign type/text/stale-version is not owned by current proof");
            Require((await conflict.Adapter.ApplyDefaultAsync("employee", default)).Availability == WindowsStartupAvailability.Conflict && conflict.Store.Writes == 0,
                "default never adopts or replaces foreign Run data");
            foreach (var enable in new[] { true, false })
                Require((await conflict.Adapter.SetEnabledAsync(enable, "portal", default)).Availability == WindowsStartupAvailability.Conflict && conflict.Store.Value == foreign && conflict.Store.Writes == 0,
                    "foreign Run value preserved for both enable and disable");
            Require(conflict.Store.Preference is null, "foreign Run value never publishes an explicit startup preference");
        }
        var raced = new Fixture { }; var replacement = new WindowsStartupRunValue(WindowsStartupValueKind.String, "foreign command never echo");
        raced.Store.BeforeReplace = () => raced.Store.Value = replacement;
        Require((await raced.Adapter.SetEnabledAsync(true, "portal", default)).Availability == WindowsStartupAvailability.Conflict && raced.Store.Value == replacement && raced.Store.Writes == 0,
            "value changed between observation and mutation is preserved");
        var unavailable = new Fixture(); unavailable.Owner.Unavailable = true;
        Require(!await unavailable.Adapter.ValidateRunningInstallationAsync(default) &&
            (await unavailable.Adapter.SetEnabledAsync(true, "portal", default)).Availability == WindowsStartupAvailability.Unavailable && unavailable.Store.Reads == 0 && unavailable.Store.Writes == 0,
            "unknown installed ownership never touches Run");
        var changedOwner = new Fixture(); changedOwner.Owner.VerifyFault = true;
        Require((await changedOwner.Adapter.SetEnabledAsync(true, "portal", default)).Availability == WindowsStartupAvailability.Unavailable && changedOwner.Store.Writes == 0 && changedOwner.Owner.Disposals == 1,
            "changed ownership before mutation fails closed and releases fences");
        var invalidAlias = new Fixture();
        Require((await invalidAlias.Adapter.SetEnabledAsync(true, "unsupported", default)).Availability == WindowsStartupAvailability.Unavailable && invalidAlias.Store.Reads == 0,
            "arbitrary aliases cannot become launch arguments");
        using (var cancel = new CancellationTokenSource()) {
            var cancelled = new Fixture(); cancelled.Owner.OnVerify = cancel.Cancel;
            try { await cancelled.Adapter.SetEnabledAsync(true, "portal", cancel.Token); throw new Exception("Cancellation did not stop write."); }
            catch (OperationCanceledException) { }
            Require(cancelled.Store.Writes == 0 && cancelled.Owner.Disposals == 1, "cancellation before mutation keeps preference and disposes proof");
        }
        using (var cancel = new CancellationTokenSource()) {
            var committed = new Fixture(); committed.Store.AfterReplace = cancel.Cancel;
            Require((await committed.Adapter.SetEnabledAsync(true, "portal", cancel.Token)).Enabled && committed.Store.Writes == 1,
                "cancellation after committed mutation is not falsely reported as rollback");
        }
        var error = new Fixture(); error.Store.WriteFault = true;
        Require((await error.Adapter.SetEnabledAsync(true, "portal", default)).Availability == WindowsStartupAvailability.Error && error.Owner.Disposals == 1,
            "store errors are typed and release read fences");
        var lateOwner = new Fixture(); lateOwner.Store.AfterReplace = () => lateOwner.Owner.VerifyFault = true;
        Require((await lateOwner.Adapter.SetEnabledAsync(true, "portal", default)).Availability == WindowsStartupAvailability.Unavailable && lateOwner.Store.Writes == 1,
            "post-mutation ownership change is explicit, never a false confirmed success or blind rollback");
        var readbackRace = new Fixture(); readbackRace.Store.AfterReplace = () => readbackRace.Store.Value = replacement;
        Require((await readbackRace.Adapter.SetEnabledAsync(true, "portal", default)).Availability == WindowsStartupAvailability.Conflict && readbackRace.Store.Value == replacement && readbackRace.Store.Writes == 1,
            "foreign value appearing at readback is preserved, never rolled back or deleted");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var concurrent = new Fixture(); concurrent.Owner.HoldRead = async () => { entered.SetResult(); await release.Task; };
        var first = concurrent.Adapter.GetStateAsync(default); await entered.Task;
        using (var cancel = new CancellationTokenSource()) {
            var queued = concurrent.Adapter.SetEnabledAsync(true, "portal", cancel.Token); cancel.Cancel();
            try { await queued; throw new Exception("Queued cancellation not observed."); } catch (OperationCanceledException) { }
            Require(concurrent.Store.Writes == 0 && concurrent.Owner.Reads == 1, "queued request cannot enter ownership or mutate");
        }
        concurrent.Owner.HoldRead = null; release.SetResult(); await first;
        Console.WriteLine("Windows startup policy/adapter pure tests passed; no real registry, installation, auth or native operation executed.");
    }
    private static void Require(bool value, string reason) { if (!value) throw new Exception(reason); }
    private sealed class Fixture
    {
        internal readonly List<string> Log = [];
        internal Owner Owner { get; }
        internal Store Store { get; }
        internal WindowsStartupAdapter Adapter { get; }
        internal Fixture() { Owner = new(Log); Store = new(Log); Adapter = new(Owner, Store); }
    }
    private sealed class Owner(List<string> log) : IWindowsStartupOwnershipReader
    {
        internal bool Unavailable, VerifyFault;
        internal int Reads, Disposals;
        internal Action? OnVerify;
        internal Func<Task>? HoldRead;
        public async Task<IWindowsStartupOwnership> ReadAsync(CancellationToken token)
        { Reads++; log.Add("owner"); if (Unavailable) throw new WindowsStartupOwnershipUnavailableException(); if (HoldRead is not null) await HoldRead(); return new Proof(this, log); }
        private sealed class Proof(Owner owner, List<string> log) : IWindowsStartupOwnership
        {
            public string ExecutablePath => Executable;
            public Task VerifyStillCurrentAsync(CancellationToken token)
            { log.Add("verify"); owner.OnVerify?.Invoke(); token.ThrowIfCancellationRequested(); if (owner.VerifyFault) throw new WindowsStartupOwnershipUnavailableException(); return Task.CompletedTask; }
            public ValueTask DisposeAsync() { owner.Disposals++; log.Add("dispose"); return ValueTask.CompletedTask; }
        }
    }
    private sealed class Store(List<string> log) : IWindowsStartupRunStore
    {
        internal WindowsStartupRunValue? Value;
        internal int Reads, Writes;
        internal Action? BeforeReplace, AfterReplace;
        internal bool WriteFault;
        internal bool? Preference;
        internal WindowsStartupPreference? PreferenceOverride;
        public WindowsStartupPreference ReadPreference() => PreferenceOverride ?? (Preference switch { false => WindowsStartupPreference.Disabled, true => WindowsStartupPreference.Enabled, _ => WindowsStartupPreference.Unset });
        public void SavePreference(bool enabled) { Preference = enabled; }
        public WindowsStartupRunValue? Read() { Reads++; log.Add(Writes == 0 ? "read" : "readback"); return Value; }
        public bool TryReplace(WindowsStartupRunValue? expected, WindowsStartupRunValue? replacement, bool requireUnsetPreference = false)
        { BeforeReplace?.Invoke(); if (WriteFault) throw new IOException("private registry error"); if (Value != expected || requireUnsetPreference && ReadPreference() != WindowsStartupPreference.Unset) return false; Writes++; Value = replacement; log.Add("write"); AfterReplace?.Invoke(); return true; }
    }
}
