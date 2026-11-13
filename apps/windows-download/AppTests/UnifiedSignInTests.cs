using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using LedgeTop.Files;
using LedgeTop.Files.Backends;

internal static class UnifiedSignInTests
{
    internal static async Task Run()
    {
        var attempt = Guid.NewGuid(); var account = new UnifiedAccountBinding();
        foreach (var (client, employee, expected, mode) in new[] {
            (true, false, UnifiedSignInStatus.Selected, (AccessMode?)AccessMode.Client),
            (false, true, UnifiedSignInStatus.Selected, (AccessMode?)AccessMode.Employee),
            (true, true, UnifiedSignInStatus.Ambiguous, (AccessMode?)null),
            (false, false, UnifiedSignInStatus.NoAccess, (AccessMode?)null)
        }) {
            var result = UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, UnifiedDiscoveryStatus.Complete, client, employee, mode));
            Need(result.Status == expected && result.Mode == mode, "only complete authoritative eligibility selects a sole source");
        }
        Need(UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, UnifiedDiscoveryStatus.Complete, true, true, AccessMode.Employee)).Mode == AccessMode.Employee,
            "both eligible uses only the server's explicit selected source");
        Need(UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, UnifiedDiscoveryStatus.Complete, true, false, AccessMode.Employee)).Status == UnifiedSignInStatus.Invalid &&
            UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, UnifiedDiscoveryStatus.Complete, true, false)).Status == UnifiedSignInStatus.Invalid,
            "Windows never guesses or accepts an ineligible selected source");
        foreach (var status in Enum.GetValues<UnifiedDiscoveryStatus>().Where(value => value != UnifiedDiscoveryStatus.Complete)) {
            var result = UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, status));
            Need(result.Status is not (UnifiedSignInStatus.Selected or UnifiedSignInStatus.NoAccess) && result.Mode is null,
                "unavailable/login/denied/disabled never become definitive ineligibility or a different-source fallback");
            Need(UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, status, false, true)).Status == UnifiedSignInStatus.Invalid,
                "partial eligibility cannot select a source");
        }
        Need(UnifiedSignInPolicy.Decide(attempt, account, new(attempt, account, UnifiedDiscoveryStatus.Complete, true)).Status == UnifiedSignInStatus.Invalid,
            "incomplete source checks cannot select");
        Need(UnifiedSignInPolicy.Decide(attempt, account, new(Guid.NewGuid(), account, UnifiedDiscoveryStatus.Complete, true, false)).Status == UnifiedSignInStatus.Stale &&
            UnifiedSignInPolicy.Decide(attempt, account, new(attempt, new UnifiedAccountBinding(), UnifiedDiscoveryStatus.Complete, true, false)).Status == UnifiedSignInStatus.Stale,
            "account and operation must match the authenticated attempt exactly");

        var session = new FakeSession(); var auths = 0;
        var coordinator = new UnifiedSignInCoordinator(_ => { auths++; return Task.FromResult<IUnifiedAuthenticatedDiscoverySession>(session); });
        Need(auths == 0, "construction never signs in");
        var selected = await coordinator.SignInAsync(default);
        Need(selected.Decision.Mode == AccessMode.Employee && selected.Selection is not null && session.Disposals == 0 && session.Verifications == 1,
            "sole employee selects even without any file roots and retains authenticated lease for admission");
        await selected.Selection!.VerifyCurrentAsync(default);
        coordinator.Invalidate();
        var refused = false;
        try { await selected.Selection.VerifyCurrentAsync(default); } catch (InvalidOperationException) { refused = true; }
        Need(refused, "an accepted but retired generation cannot admit a source");
        await selected.Selection.DisposeAsync(); await selected.Selection.DisposeAsync();
        Need(session.Disposals == 1, "authenticated lease is released exactly once");

        foreach (var failure in new[] { "account", "generation", "cancel", "verify" }) {
            var fake = new FakeSession { Hold = true };
            var flow = new UnifiedSignInCoordinator(_ => Task.FromResult<IUnifiedAuthenticatedDiscoverySession>(fake));
            using var cancel = new CancellationTokenSource();
            var running = flow.SignInAsync(cancel.Token);
            Need(!running.IsCompleted, "synthetic discovery stays pending");
            if (failure == "generation") flow.Invalidate();
            if (failure == "cancel") cancel.Cancel();
            if (failure == "verify") fake.FailVerification = true;
            if (failure == "account") fake.ReplaceAccount = true;
            fake.Gate.SetResult();
            try {
                var result = await running;
                Need(result.Selection is null && result.Decision.Status == UnifiedSignInStatus.Stale,
                    "changed account/generation never selects or replaces a source");
            } catch (OperationCanceledException) when (failure == "cancel") { }
            catch (IOException) when (failure == "verify") { }
            Need(fake.Disposals == 1 && fake.Discoveries == 1, "every failed/late attempt drains exactly its own session without probing another source");
        }
        await SelectionHandoffRaces();
        SavedProfileRouting();
        await WindowLifecycle();
        Console.WriteLine("Unified sign-in source-only policy/coordinator: fake discovery and account/session generation checks passed; no production adapter or startup wiring.");
    }
    private static async Task SelectionHandoffRaces()
    {
        var changing = new ChangingGetterSession();
        var flow = new UnifiedSignInCoordinator(_ => Task.FromResult<IUnifiedAuthenticatedDiscoverySession>(changing));
        var result = await flow.SignInAsync(default);
        Need(result.Selection is not null && ReferenceEquals(result.Selection.Account, changing.Original),
            "handoff retains the exact account verified for the routing decision; constructor never adopts a later getter value");
        var rejected = false;
        try { await result.Selection!.VerifyCurrentAsync(default); } catch (InvalidOperationException) { rejected = true; }
        Need(rejected && !ReferenceEquals(result.Selection!.Account, changing.Replacement),
            "a changed getter cannot turn the decision for A into a binding for B");
        await result.Selection!.DisposeAsync();
        Need(changing.Disposals == 1, "rejected changing-account selection releases its original session");

        var held = new HeldVerificationSession();
        flow = new UnifiedSignInCoordinator(_ => Task.FromResult<IUnifiedAuthenticatedDiscoverySession>(held));
        result = await flow.SignInAsync(default);
        var verifying = result.Selection!.VerifyCurrentAsync(default);
        await held.Entered.Task;
        Need(!verifying.IsCompleted, "consumer verification remains held in the synthetic adapter");
        await result.Selection!.DisposeAsync();
        held.Release.SetResult();
        rejected = false;
        try { await verifying; } catch (InvalidOperationException) { rejected = true; }
        Need(rejected && held.Disposals == 1,
            "disposal during verification invalidates the retained owner even when adapter returns unchanged account and ignores disposal");
    }
    private static void SavedProfileRouting()
    {
        var modes = new[] { AccessMode.Client, AccessMode.Employee };
        foreach (var mode in modes) {
            var other = mode == AccessMode.Client ? AccessMode.Employee : AccessMode.Client;
            foreach (var state in new[] { SavedProfileState.Absent, SavedProfileState.Removed })
                Need(SavedConnectionResumePolicy.Decide(modes, [new(mode, SavedProfileState.OwnedReady), new(other, state)]) == new SavedResumeDecision(SavedResumeStatus.ResumeOwned, mode),
                    "exactly one owned cached profile routes directly; its reconnect must verify its pinned principal");
        }
        Need(SavedConnectionResumePolicy.Decide(modes, [new(AccessMode.Client, SavedProfileState.OwnedReady), new(AccessMode.Employee, SavedProfileState.OwnedReady)]).Status == SavedResumeStatus.DiscoverAccount,
            "multiple owned profiles wait for authenticated authoritative routing without a source chooser or root removal");
        Need(SavedConnectionResumePolicy.Decide(modes, [new(AccessMode.Client, SavedProfileState.Absent), new(AccessMode.Employee, SavedProfileState.Removed)]).Status == SavedResumeStatus.DiscoverAccount,
            "no owned ready connection requires real new-account discovery");
        foreach (var profiles in new SavedProfileObservation[][] {
            [new(AccessMode.Client, SavedProfileState.OwnedReady)],
            [new(AccessMode.Client, SavedProfileState.OwnedReady), new(AccessMode.Client, SavedProfileState.Absent)],
            [new(AccessMode.Client, SavedProfileState.OwnedReady), new(AccessMode.Employee, (SavedProfileState)99)],
            [new(AccessMode.Client, SavedProfileState.OwnedReady), new((AccessMode)99, SavedProfileState.Absent)]
        }) Need(SavedConnectionResumePolicy.Decide(modes, profiles).Status == SavedResumeStatus.NeedsReview,
            "missing, duplicate and malformed local observations preserve data and block setup");
        foreach (var selected in modes)
            foreach (var otherState in Enum.GetValues<SavedProfileState>()) {
                var other = selected == AccessMode.Client ? AccessMode.Employee : AccessMode.Client;
                Need(SavedConnectionResumePolicy.Decide(modes, [new(selected, SavedProfileState.NeedsReview), new(other, otherState)]) == new SavedResumeDecision(SavedResumeStatus.DiscoverAccount),
                    "well-formed per-source review prevents automatic resume but allows authoritative account discovery without changing any root");
            }
        Need(SavedConnectionResumePolicy.Decide([AccessMode.Client], [new(AccessMode.Client, SavedProfileState.NeedsReview)]).Status == SavedResumeStatus.DiscoverAccount,
            "even the sole well-formed damaged profile awaits account discovery; selected-root admission still must refuse its ownership conflict");
    }
    private static async Task WindowLifecycle()
    {
        var auths = 0; var fake = new FakeSession { Hold = true };
        var window = Hidden(new(_ => { auths++; return Task.FromResult<IUnifiedAuthenticatedDiscoverySession>(fake); }));
        Need(auths == 0 && window.SignInButton.IsEnabled && !Labels(window).Contains("Client deliveries") && !Labels(window).Contains("Company files"),
            "one first-window Sign in action replaces source guessing and never authenticates on open");
        window.SignInButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        try { await Until(() => fake.Discoveries == 1); }
        catch { throw new InvalidOperationException("Synthetic first-window state: auths=" + auths + ", status=" + window.StatusText); }
        Need(auths == 1 && !window.SignInButton.IsEnabled, "click starts only one explicit authenticated discovery");
        window.Close();
        Need(!window.Selection.IsCompleted && window.IsVisible, "close waits for a cancellation-ignoring discovery to drain safely");
        fake.Gate.SetResult();
        Need(await window.Selection is null && fake.Disposals == 1, "late cancelled result admits no source and releases its authenticated session");

        var accepted = new FakeSession(); window = Hidden(new(_ => Task.FromResult<IUnifiedAuthenticatedDiscoverySession>(accepted)));
        window.SignInButton.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        var selection = await window.Selection;
        Need(selection?.Mode == AccessMode.Employee && accepted.Disposals == 0, "selected account lease survives window close until source admission consumer releases it");
        await selection!.DisposeAsync(); Need(accepted.Disposals == 1, "consumer owns successful lease cleanup");
    }
    private static UnifiedSignInWindow Hidden(UnifiedSignInCoordinator coordinator)
    {
        var window = new UnifiedSignInWindow(coordinator, "Test") { ShowInTaskbar = false, Left = -20000, Top = -20000,
            WindowStartupLocation = WindowStartupLocation.Manual };
        window.Show(); return window;
    }
    private static string Labels(DependencyObject value)
    {
        var text = value is TextBlock block ? block.Text : "";
        for (var i = 0; i < System.Windows.Media.VisualTreeHelper.GetChildrenCount(value); i++) text += Labels(System.Windows.Media.VisualTreeHelper.GetChild(value, i));
        return text;
    }
    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition()) { if (DateTime.UtcNow > deadline) throw new TimeoutException("Synthetic unified sign-in did not settle."); await Task.Delay(10); var frame = new DispatcherFrame(); _ = Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, () => frame.Continue = false); Dispatcher.PushFrame(frame); }
    }
    private static void Need(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private sealed class ChangingGetterSession : IUnifiedAuthenticatedDiscoverySession
    {
        internal readonly UnifiedAccountBinding Original = new(), Replacement = new();
        private int reads;
        internal int Disposals;
        // Initial capture and final coordinator check see A; an old constructor's third
        // getter read would silently adopt B after the decision for A was verified.
        public UnifiedAccountBinding Account => ++reads <= 2 ? Original : Replacement;
        public Task<UnifiedDiscoveryObservation> DiscoverAsync(Guid attempt, CancellationToken token) =>
            Task.FromResult(new UnifiedDiscoveryObservation(attempt, Original, UnifiedDiscoveryStatus.Complete, false, true, AccessMode.Employee));
        public Task VerifyCurrentAsync(CancellationToken token) => Task.CompletedTask;
        public ValueTask DisposeAsync() { Disposals++; return ValueTask.CompletedTask; }
    }
    private sealed class HeldVerificationSession : IUnifiedAuthenticatedDiscoverySession
    {
        public UnifiedAccountBinding Account { get; } = new();
        private int verifications;
        internal int Disposals;
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<UnifiedDiscoveryObservation> DiscoverAsync(Guid attempt, CancellationToken token) =>
            Task.FromResult(new UnifiedDiscoveryObservation(attempt, Account, UnifiedDiscoveryStatus.Complete, false, true, AccessMode.Employee));
        public async Task VerifyCurrentAsync(CancellationToken token)
        {
            if (++verifications == 1) return;
            Entered.SetResult(); await Release.Task; // Deliberately ignores disposal/cancellation.
        }
        public ValueTask DisposeAsync() { Disposals++; return ValueTask.CompletedTask; }
    }
    private sealed class FakeSession : IUnifiedAuthenticatedDiscoverySession
    {
        public UnifiedAccountBinding Account { get; private set; } = new();
        internal int Disposals, Discoveries, Verifications;
        internal bool Hold, ReplaceAccount, FailVerification;
        internal readonly TaskCompletionSource Gate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<UnifiedDiscoveryObservation> DiscoverAsync(Guid attempt, CancellationToken token)
        {
            Discoveries++; var original = Account;
            if (Hold) await Gate.Task; // Deliberately ignores cancellation to exercise the caller fence.
            if (ReplaceAccount) Account = new();
            return new(attempt, original, UnifiedDiscoveryStatus.Complete, false, true, AccessMode.Employee);
        }
        public Task VerifyCurrentAsync(CancellationToken token) { Verifications++; if (FailVerification) throw new IOException("Synthetic identity changed."); return Task.CompletedTask; }
        public ValueTask DisposeAsync() { Disposals++; return ValueTask.CompletedTask; }
    }
}
