using System.Reflection;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

internal static class ExplorerPreviewWindowTests
{
    internal static async Task Run(string screenshots)
    {
        var uiThread = Environment.CurrentManagedThreadId;
        var developer = new AssemblyMetadataAttribute(ReleaseProfiles.BuildModeKey, "developer");
        var pilot = new AssemblyMetadataAttribute(ReleaseProfiles.ChannelKey, "pilot");
        True(App.ExplorerDemoRequested([developer], ["--explorer-demo"]), "explicit developer preview allowed");
        True(!App.ExplorerDemoRequested([], ["--explorer-demo"]), "plain build refuses native preview");
        True(!App.ExplorerDemoRequested([pilot], ["--explorer-demo"]), "packaged pilot refuses native preview flag");
        True(!App.ExplorerDemoRequested([pilot, developer], ["--explorer-demo"]), "mixed metadata refuses preview");
        True(!App.ExplorerDemoRequested([developer, developer], ["--explorer-demo"]), "duplicate developer metadata refuses preview");
        True(!App.ExplorerDemoRequested([developer], ["--Explorer-Demo"]), "preview flag is exact");

        var root = Path.Combine(Path.GetTempPath(), "ltfiles-settings-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root); var retained = Path.Combine(root, "retained.txt"); await File.WriteAllTextAsync(retained, "keep local bytes");
        try {
            var created = new List<FakeSession>();
            var tray = new FakeTrayIcon();
            var window = Window(() => { var service = new FakeSession(root); created.Add(service); return Task.FromResult<IExplorerPreviewSession>(service); }, tray);
            var closed = 0; window.Closed += (_, _) => closed++;
            try {
                True(created.Count == 0 && window.StartButton.IsEnabled, "opening Settings doesn't construct a provider");
                True(window.ReconnectButton.Visibility == Visibility.Collapsed, "generated preview never offers cached connected authorization");
                Snap(window, Path.Combine(screenshots, "explorer-settings-before-start.png"));
                await window.StartPreviewAsync();
                True(created.Count == 1 && created[0].Starts == 1 && window.OpenFolderButton.IsEnabled, "explicit simulated start opens preview controls");
                True(window.PauseButton.IsEnabled && !window.ResumeButton.IsEnabled, "running state offers pause");
                await window.PausePreviewAsync();
                True(created[0].Pauses == 1 && window.ResumeButton.IsEnabled, "pause routes to preview source");
                await window.ResumePreviewAsync();
                True(created[0].Resumes == 1 && window.PauseButton.IsEnabled, "resume routes to preview source");
                Snap(window, Path.Combine(screenshots, "explorer-settings-running.png"));
                window.Pages.SelectedIndex = 1; Pump();
                Snap(window, Path.Combine(screenshots, "explorer-activity.png"));
                await window.RemovePreviewAsync();
                True(created[0].Removals == 1 && File.Exists(retained) && window.StartButton.IsEnabled, "remove keeps local files and offers restart");
                await window.StartPreviewAsync();
                True(created.Count == 2 && created[0].Disposals == 1, "removed preview is disposed before a new session opens");
                True(created[0].DisposeThread != uiThread, "old session replacement drains off the dispatcher");
                window.Close(); Pump();
                True(!window.IsVisible && closed == 0 && created[1].Disposals == 0, "ordinary close keeps session running in tray");
                tray.Activate(); Pump(); True(window.IsVisible, "tray restores settings");
                window.Quit(); await Until(() => closed == 1);
                True(created[1].Disposals == 1 && tray.Disposals == 1 && File.Exists(retained), "quit disconnects once and preserves local files");
            } finally { window.Quit(); }

            // Closing during asynchronous preparation must dispose the late session without starting OS registration.
            var factory = new TaskCompletionSource<IExplorerPreviewSession>(TaskCreationOptions.RunContinuationsAsynchronously);
            var late = new FakeSession(root); var lateTray = new FakeTrayIcon();
            var lateWindow = Window(() => factory.Task, lateTray); var lateClosed = false; lateWindow.Closed += (_, _) => lateClosed = true;
            var starting = lateWindow.StartPreviewAsync(); lateWindow.Quit();
            True(!lateClosed, "quit waits for the pending factory");
            factory.SetResult(late); await starting; await Until(() => lateClosed);
            True(late.Starts == 0 && late.Disposals == 1, "late prepared service was disposed without starting");
            True(late.DisposeThread != uiThread, "late prepared service drains off the dispatcher");

            // A failed disconnect must keep a visible, retryable owner instead of silently closing around a live provider.
            var refusing = new FakeSession(root) { RefuseFirstDispose = true };
            var refusal = Window(() => Task.FromResult<IExplorerPreviewSession>(refusing), new FakeTrayIcon());
            var refusalClosed = false; refusal.Closed += (_, _) => refusalClosed = true;
            await refusal.StartPreviewAsync(); refusal.Quit();
            await Until(() => refusal.StatusText == "Preview needs attention");
            True(refusal.IsVisible && !refusalClosed, "failed disconnect leaves visible app");
            refusal.Quit(); await Until(() => refusalClosed);
            True(refusing.Disposals == 2, "disconnect can be retried");

            // A synchronous native-style stop must not capture the WPF dispatcher. Keep the gate bounded
            // even in the counterfactual implementation so a regression fails instead of hanging this harness.
            using var stopGate = new ManualResetEventSlim(false);
            var stopping = new FakeSession(root) { DisposeGate = stopGate };
            var responsive = Window(() => Task.FromResult<IExplorerPreviewSession>(stopping), new FakeTrayIcon());
            var responsiveClosed = false; responsive.Closed += (_, _) => responsiveClosed = true;
            await responsive.StartPreviewAsync(); responsive.Quit();
            try {
                await stopping.DisposeEntered.Task.WaitAsync(TimeSpan.FromSeconds(8));
                True(stopping.DisposeThread != uiThread, "blocking disconnect executes on a worker");
                var heartbeat = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                _ = Dispatcher.CurrentDispatcher.BeginInvoke(() => heartbeat.TrySetResult());
                await heartbeat.Task.WaitAsync(TimeSpan.FromSeconds(2));
                True(!responsiveClosed && responsive.IsVisible, "responsive stopping window retains ownership until real drain");
            } finally {
                stopGate.Set(); responsive.Quit(); await Until(() => responsiveClosed);
            }
            var prepared = new FakeSession(root);
            var connectedFactoryCalls = 0;
            var connected = Window(() => { connectedFactoryCalls++; throw new InvalidOperationException("Offline removal must not prepare a sign-in."); },
                new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", LedgeTop.Files.Backends.AccessMode.Employee), prepared);
            var connectedClosed = false; connected.Closed += (_, _) => connectedClosed = true;
            try {
                True(connected.RemoveButton.IsEnabled && prepared.Starts == 0 && connectedFactoryCalls == 0,
                    "prepared connection offers offline removal without sign-in or factory execution");
                True(connected.ReconnectButton.Visibility == Visibility.Collapsed, "absent saved inventory does not offer reconnect");
                True((string)connected.StartButton.Content == "Sign in and connect files", "real connection has explicit sign-in action");
                var labels = Labels((DependencyObject)connected.Content);
                True(!labels.Contains("simulated sign-in") && !labels.Contains("DEMO DATA") && !labels.Contains("Demo account"),
                    "connected settings do not claim generated data or simulated sign-in");
                Snap(connected, Path.Combine(screenshots, "connected-settings-before-sign-in.png"));
                await connected.RemovePreviewAsync();
                True(prepared.Removals == 1 && prepared.Starts == 0 && connectedFactoryCalls == 0 && File.Exists(retained),
                    "offline removal routes directly to the owned connection and preserves files");
            } finally { connected.Quit(); await Until(() => connectedClosed); }
            var pendingLogin = new FakeSession(root) { StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously) };
            var cancellable = Window(() => Task.FromResult<IExplorerPreviewSession>(pendingLogin), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", LedgeTop.Files.Backends.AccessMode.Client), pendingLogin);
            var cancelledClosed = false; cancellable.Closed += (_, _) => cancelledClosed = true;
            var connecting = cancellable.StartPreviewAsync();
            True(!connecting.IsCompleted && pendingLogin.Starts == 1, "synthetic sign-in is pending");
            cancellable.Quit();
            await Until(() => cancelledClosed); await connecting;
            True(pendingLogin.Disposals == 1 && pendingLogin.State != ExplorerPreviewState.Running,
                "Quit cancels the pending connection before waiting for its operation and closes after drain");
            var saved = new FakeSession(root) { SavedReady = true, ReconnectPaused = true };
            var savedWindow = Window(() => throw new InvalidOperationException("Cached reconnect must use the prepared owner."), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", LedgeTop.Files.Backends.AccessMode.Client), saved);
            var savedClosed = false; savedWindow.Closed += (_, _) => savedClosed = true;
            try {
                True(savedWindow.ReconnectButton.IsVisible && savedWindow.ReconnectButton.IsEnabled && saved.Reconnects == 0 && saved.Starts == 0,
                    "owned saved connection offers explicit reconnect without running it on window load");
                Snap(savedWindow, Path.Combine(screenshots, "connected-settings-saved-files.png"));
                savedWindow.ReconnectButton.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
                await Until(() => saved.Reconnects == 1 && savedWindow.ResumeButton.IsEnabled);
                True(saved.Starts == 0 && saved.State == ExplorerPreviewState.Paused && savedWindow.ReconnectButton.Visibility == Visibility.Collapsed,
                    "button routes cached-only action, preserves pause and disappears once connected");
                await savedWindow.RemovePreviewAsync();
                True(savedWindow.ReconnectButton.Visibility == Visibility.Collapsed, "removed saved connection cannot reconnect");
            } finally { savedWindow.Quit(); await Until(() => savedClosed); }
            var cachedPending = new FakeSession(root) { SavedReady = true, StartGate = new(TaskCreationOptions.RunContinuationsAsynchronously) };
            var cachedWindow = Window(() => throw new InvalidOperationException("No replacement session during cached reconnect."), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", LedgeTop.Files.Backends.AccessMode.Client), cachedPending);
            var cachedClosed = false; cachedWindow.Closed += (_, _) => cachedClosed = true;
            var pendingReconnect = cachedWindow.ReconnectPreviewAsync();
            True(cachedPending.Reconnects == 1 && !cachedWindow.ReconnectButton.IsEnabled && !pendingReconnect.IsCompleted,
                "cached action serializes controls while awaiting metadata");
            cachedWindow.Quit(); await Until(() => cachedClosed); await pendingReconnect;
            True(cachedPending.Disposals == 1 && cachedPending.Starts == 0 && cachedPending.State != ExplorerPreviewState.Running,
                "Quit cancels and drains cached reconnect before closing without explicit sign-in");
            await UpdateLifecycle(root, screenshots);
            await ScheduledUpdates(root);
            await WindowsStartupSettings(root);
            var choice = new ExplorerSourceChoiceWindow([LedgeTop.Files.Backends.AccessMode.Client, LedgeTop.Files.Backends.AccessMode.Employee], "Pilot") {
                ShowInTaskbar = false, Left = -20000, Top = -20000, WindowStartupLocation = WindowStartupLocation.Manual
            };
            choice.Show(); Pump(); Snap(choice, Path.Combine(screenshots, "connected-source-choice.png"));
            choice.Choices[LedgeTop.Files.Backends.AccessMode.Client].RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(await choice.Selection == LedgeTop.Files.Backends.AccessMode.Client, "explicit source selection returns only the chosen kind");
            var cancelledChoice = new ExplorerSourceChoiceWindow([LedgeTop.Files.Backends.AccessMode.Employee], "Pilot") {
                ShowInTaskbar = false, Left = -20000, Top = -20000, WindowStartupLocation = WindowStartupLocation.Manual
            };
            cancelledChoice.Show(); cancelledChoice.Close();
            True(await cancelledChoice.Selection is null, "closing source selection does not silently select or authenticate a source");
        } finally {
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()) + "ltfiles-settings-", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Refusing unexpected test cleanup path.");
            Directory.Delete(full, true);
        }
    }

    private static WindowsAppReleaseCheck AvailableUpdate() => new(WindowsAppReleaseStatus.Available, "0.5.2.0",
        new("pilot", "0.5.3.0", 100, new string('a', 64), "\"synthetic\"", new string('b', 40), "exe"));
    private static Task<ConnectedExplorerUpdateBinding> FakeBinding(IExplorerPreviewSession source, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        return source is FakeSession fake && fake.State is ExplorerPreviewState.Running or ExplorerPreviewState.Paused
            ? Task.FromResult(fake.Binding) : throw new LoginRequiredException();
    }

    private static async Task UpdateLifecycle(string root, string screenshots)
    {
        var demo = Window(() => Task.FromResult<IExplorerPreviewSession>(new FakeSession(root)), new FakeTrayIcon());
        True(demo.CheckUpdatesButton.Visibility == Visibility.Collapsed && demo.InstallUpdateButton.Visibility == Visibility.Collapsed, "generated preview hides updates");
        demo.Quit(); await Until(() => !demo.IsVisible);

        var content = ExplorerWindowContent.Connected("Pilot", AccessMode.Employee);
        var check = new WindowsAppReleaseCheck(WindowsAppReleaseStatus.NoRelease, "0.5.2.0");
        var failCheck = false; var initial = new FakeSession(root);
        var checks = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, initial,
            new("0.5.2.0", _ => failCheck ? throw new IOException("private-principal/header/path") : Task.FromResult(check),
                _ => Task.FromResult(new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.PreparationFailed, false))), FakeBinding);
        try {
            await checks.StartPreviewAsync(); await checks.CheckForUpdatesAsync();
            True(!checks.InstallUpdateButton.IsEnabled && checks.UpdateStatusText.Contains("No approved"), "no eligible offer is not an installed-success claim");
            check = new(WindowsAppReleaseStatus.Current, "0.5.2.0"); await checks.CheckForUpdatesAsync();
            True(!checks.InstallUpdateButton.IsEnabled && checks.UpdateStatusText == "This version is current.", "current release disables install");
            check = AvailableUpdate(); await checks.CheckForUpdatesAsync();
            True(checks.InstallUpdateButton.IsEnabled && checks.UpdateStatusText.Contains("0.5.3.0"), "available version offers explicit install and restart");
            if (((System.Windows.Controls.TabItem)checks.Pages.Items[0]).Content is System.Windows.Controls.ScrollViewer scroll) scroll.ScrollToVerticalOffset(400);
            Snap(checks, Path.Combine(screenshots, "connected-settings-update-available.png"));
            await checks.InstallUpdateAsync();
            True(!checks.UpdateMaintenanceOwned && initial.Pauses == 0 && checks.PauseButton.IsEnabled, "safe preparation refusal restores ordinary controls without touching provider");
            failCheck = true; await checks.CheckForUpdatesAsync();
            True(!checks.UpdateStatusText.Contains("private") && !checks.InstallUpdateButton.IsEnabled, "check exceptions are sanitized");
        } finally { checks.Quit(); await Until(() => !checks.IsVisible); }

        var checkEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var checkCancelled = false;
        var checking = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root),
            new("0.5.2.0", async token => { checkEntered.SetResult(); try { await Task.Delay(Timeout.Infinite, token); } catch (OperationCanceledException) { checkCancelled = true; throw; } return AvailableUpdate(); },
                _ => throw new InvalidOperationException()), FakeBinding);
        var checkWork = checking.CheckForUpdatesAsync(); await checkEntered.Task; checking.Quit(); await checkWork;
        await Until(() => !checking.IsVisible); True(checkCancelled, "Quit cancels a pending check and stays responsive");

        var old = new FakeSession(root); var bad = new FakeSession(root) { SavedReady = true };
        bad.Binding = bad.Binding with { PrincipalId = "odqp1_" + new string('2', 64) };
        var good = new FakeSession(root) { SavedReady = true, ReconnectPaused = true };
        var replacements = new Queue<IExplorerPreviewSession>([bad, good]);
        ExplorerPreviewWindow recovery = null!;
        recovery = Window(() => Task.FromResult(replacements.Dequeue()), new FakeTrayIcon(), content, old,
            new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                var binding = await recovery.GetVerifiedUpdateBindingAsync(); await recovery.DrainForUpdateAsync();
                True(!await recovery.RecoverForUpdateAsync(binding), "changed cached identity is not recovery");
                return new(ExeUpdateHandoffStatus.NeedsReconnect, true);
            }), FakeBinding);
        try {
            await recovery.StartPreviewAsync(); await recovery.CheckForUpdatesAsync(); await recovery.InstallUpdateAsync();
            True(old.Disposals == 1 && old.Removals == 0 && bad.Reconnects == 1 && bad.Starts == 0 && bad.Disposals == 1,
                "update drain disposes off-thread without remove; mismatched cached recovery is drained, never adopted");
            True(recovery.ReconnectButton.IsEnabled && recovery.StartButton.Visibility == Visibility.Collapsed, "failed recovery offers saved reconnect, not interactive fallback");
            await recovery.StartPreviewAsync(); True(old.Starts == 1 && good.Starts == 0, "direct start cannot bypass saved recovery identity");
            await recovery.ReconnectPreviewAsync();
            True(good.Reconnects == 1 && good.Starts == 0 && recovery.ResumeButton.IsEnabled, "fresh same-source cached recovery preserves pause without a browser");
        } finally { recovery.Quit(); await Until(() => !recovery.IsVisible); }

        foreach (var outcome in new[] { ExeUpdateHandoffStatus.RecoveryBlocked, ExeUpdateHandoffStatus.ExitUncertain }) {
            var owned = new FakeSession(root); ExplorerPreviewWindow uncertain = null!;
            uncertain = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, owned,
                new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => { await uncertain.DrainForUpdateAsync(); return new(outcome, true); }), FakeBinding);
            try {
                await uncertain.StartPreviewAsync(); await uncertain.CheckForUpdatesAsync(); await uncertain.InstallUpdateAsync();
                True(uncertain.UpdateMaintenanceOwned && !uncertain.StartButton.IsEnabled && !uncertain.ReconnectButton.IsEnabled && !uncertain.RemoveButton.IsEnabled && !uncertain.CheckUpdatesButton.IsEnabled,
                    "uncertain helper outcome keeps sticky controls after busy resets");
                await uncertain.ReconnectPreviewAsync(); await uncertain.PausePreviewAsync(); uncertain.Quit();
                True(uncertain.IsVisible && owned.Removals == 0 && owned.Pauses == 0 && owned.Disposals == 1, "Quit and ordinary actions cannot race an unknown armed helper");
                var timer = (DispatcherTimer?)typeof(ExplorerPreviewWindow).GetField("sessionCheck", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(uncertain);
                True(timer is { IsEnabled: false }, "session timer remains stopped during sticky maintenance");
            } finally { CloseFakeUpdateWindow(uncertain); }
        }

        foreach (var finalAcknowledgementFails in new[] { false, true }) {
            ExplorerPreviewWindow failed = null!;
            failed = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root),
                new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                    if (!finalAcknowledgementFails) throw new IOException("private-principal/header/path");
                    await failed.DrainForUpdateAsync();
                    True(await failed.RequestUpdateExitAsync(() => throw new IOException("private-principal/header/path")) == ExeUpdateParentExitDecision.Uncertain,
                        "lost final acknowledgement cannot be labelled a safe rejection");
                    return new(ExeUpdateHandoffStatus.ExitUncertain, true);
                }), FakeBinding);
            try {
                await failed.StartPreviewAsync(); await failed.CheckForUpdatesAsync(); await failed.InstallUpdateAsync();
                True(failed.IsVisible && failed.UpdateMaintenanceOwned && !failed.UpdateStatusText.Contains("private") && !failed.ReconnectButton.IsEnabled,
                    "unexpected install failure or lost final acknowledgement remains sanitized and sticky");
            } finally { CloseFakeUpdateWindow(failed); }
        }
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var finalCalls = 0;
        ExplorerPreviewWindow cancelling = null!;
        cancelling = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root),
            new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                await cancelling.DrainForUpdateAsync(); drained.SetResult(); await stopped.Task;
                True(await cancelling.RequestUpdateExitAsync(() => { finalCalls++; return Task.CompletedTask; }) == ExeUpdateParentExitDecision.Rejected, "Quit rejects before final commit delegate");
                return new(ExeUpdateHandoffStatus.Postponed, false);
            }), FakeBinding);
        await cancelling.StartPreviewAsync(); await cancelling.CheckForUpdatesAsync(); var install = cancelling.InstallUpdateAsync(); await drained.Task;
        cancelling.Quit(); True(cancelling.IsVisible && !install.IsCompleted, "Quit waits for confirmed update cancellation without blocking dispatcher");
        stopped.SetResult(); await install; await Until(() => !cancelling.IsVisible); True(finalCalls == 0, "cancelled exit never sends final intent");

        foreach (var veto in new[] { false, true }) {
            ExplorerPreviewWindow final = null!; var acknowledgements = 0; var decision = ExeUpdateParentExitDecision.Rejected;
            final = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root),
                new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                    True(await final.RequestUpdateExitAsync(() => throw new InvalidOperationException()) == ExeUpdateParentExitDecision.Rejected, "undrained provider rejects before delegate");
                    await final.DrainForUpdateAsync();
                    decision = await final.RequestUpdateExitAsync(() => { acknowledgements++; return Task.CompletedTask; });
                    return new(decision == ExeUpdateParentExitDecision.Accepted ? ExeUpdateHandoffStatus.ParentExitRequested : ExeUpdateHandoffStatus.ExitUncertain, true);
                }), FakeBinding);
            System.ComponentModel.CancelEventHandler handler = (_, e) => e.Cancel = true;
            if (veto) final.Closing += handler;
            try {
                await final.StartPreviewAsync(); await final.CheckForUpdatesAsync(); await final.InstallUpdateAsync();
                True(acknowledgements == 1 && decision == (veto ? ExeUpdateParentExitDecision.Uncertain : ExeUpdateParentExitDecision.Accepted), "final acknowledgment is one-shot and cancelled close is uncertain");
                True(veto ? final.IsVisible && final.UpdateMaintenanceOwned : !final.IsVisible, "final hook closes without awaiting its own update operation");
            } finally { final.Closing -= handler; if (veto) CloseFakeUpdateWindow(final); }
        }
    }

    private static async Task WindowsStartupSettings(string root)
    {
        var content = ExplorerWindowContent.Connected("Pilot", AccessMode.Employee);
        var session = new FakeSession(root); var writes = new List<bool>();
        var window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, session);
        try {
            await window.SetStartupActionsAsync(new(_ => Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Available)),
                (enabled, _) => { writes.Add(enabled); return Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Available, enabled, enabled ? "employee" : null)); }));
            True(window.WindowsStartupCheckBox.IsEnabled && window.WindowsStartupCheckBox.IsChecked == false, "owned startup read controls the checkbox without enabling startup");
            window.HideAfterWindowsStartup(); True(window.IsVisible, "failed or absent cached reconnect stays visible for sign-in");
            window.WindowsStartupCheckBox.IsChecked = true;
            await Until(() => writes.Count == 1 && window.WindowsStartupCheckBox.IsEnabled);
            True(writes.SequenceEqual(new[] { true }) && window.WindowsStartupCheckBox.IsChecked == true, "explicit startup toggle commits through the supplied installed adapter");
            await window.StartPreviewAsync(); window.HideAfterWindowsStartup();
            True(!window.IsVisible && session.Starts == 1 && session.Disposals == 0, "successful startup hides only with a usable tray and connected provider");
            window.RestoreFromTray(); window.WindowsStartupCheckBox.IsChecked = false;
            await Until(() => writes.Count == 2 && window.WindowsStartupCheckBox.IsEnabled);
            True(writes.SequenceEqual(new[] { true, false }), "explicit disable is not immediately opted back in by refresh");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root));
        try {
            await window.SetStartupActionsAsync(new(_ => Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Conflict)),
                (_, _) => throw new InvalidOperationException("Foreign startup data cannot be changed.")));
            True(!window.WindowsStartupCheckBox.IsEnabled && Labels(window).Contains("kept unchanged"), "foreign startup values remain visible and disabled");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root));
        var loading = window.SetStartupActionsAsync(new(async token => { entered.TrySetResult(); await Task.Delay(Timeout.Infinite, token); return new(WindowsStartupAvailability.Available); },
            (_, _) => throw new InvalidOperationException()));
        await entered.Task; window.Quit(); await loading; await Until(() => !window.IsVisible);
        True(writes.Count == 2, "Quit cancels and joins startup inspection without new writes");
    }

    private static async Task ScheduledUpdates(string root)
    {
        var content = ExplorerWindowContent.Connected("Pilot", AccessMode.Employee);
        var now = new DateTimeOffset(2026, 10, 26, 0, 0, 0, TimeSpan.Zero);
        var checks = 0; var installs = 0;
        var owned = new FakeSession(root);
        var settings = ExplorerUpdateScheduleSettingsStore.CreateForTests(Path.Combine(root, "schedule-safe"));
        var window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, owned,
            new("0.5.2.0", _ => { checks++; return Task.FromResult(AvailableUpdate()); }, _ => { installs++; return Task.FromResult(new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.Postponed, false)); }), FakeBinding);
        try {
            window.ConfigureUpdateSchedule(settings, () => now, TimeSpan.Zero, runTimer: false);
            now += TimeSpan.FromMinutes(5); await window.TickUpdateScheduleAsync();
            True(checks == 0 && installs == 0, "due native schedule waits for a connected provider");
            await window.StartPreviewAsync(); await window.TickUpdateScheduleAsync();
            True(checks == 1 && installs == 1 && !window.UpdateMaintenanceOwned && owned.Removals == 0,
                "scheduled update uses existing check/install lifecycle and safe postponed result");
            await window.TickUpdateScheduleAsync(); True(checks == 1, "completed safe attempt is not repeated immediately");
            window.AutomaticUpdatesCheckBox.IsChecked = false;
            await Until(() => !settings.Load().Settings.AutoUpdatesEnabled);
            True(!settings.Load().Settings.AutoUpdatesEnabled && settings.Load().Settings.NextDueUtc is not null, "checkbox saves ordinary disable distinctly from uncertain helper pause");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }

        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root),
            new("0.5.2.0", async token => { entered.TrySetResult(); await Task.Delay(Timeout.Infinite, token); return AvailableUpdate(); },
                _ => throw new InvalidOperationException("A cancelled scheduled check cannot install.")), FakeBinding);
        window.ConfigureUpdateSchedule(ExplorerUpdateScheduleSettingsStore.CreateForTests(Path.Combine(root, "schedule-quit")), () => now, TimeSpan.Zero, runTimer: false);
        await window.StartPreviewAsync(); now += TimeSpan.FromMinutes(5);
        var checking = window.TickUpdateScheduleAsync(); await entered.Task;
        window.Quit(); await checking; await Until(() => !window.IsVisible);
        True(!window.UpdateMaintenanceOwned, "Quit cancels and joins the actual scheduled check without a dispatcher cycle");

        var successfulStore = ExplorerUpdateScheduleSettingsStore.CreateForTests(Path.Combine(root, "schedule-final"));
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root),
            new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                await window.DrainForUpdateAsync();
                True(await window.RequestUpdateExitAsync(() => Task.CompletedTask) == ExeUpdateParentExitDecision.Accepted,
                    "scheduled final exit does not await its own controller");
                return new(ExeUpdateHandoffStatus.ParentExitRequested, true);
            }), FakeBinding);
        window.ConfigureUpdateSchedule(successfulStore, () => now, TimeSpan.Zero, runTimer: false);
        await window.StartPreviewAsync(); now += TimeSpan.FromMinutes(5); await window.TickUpdateScheduleAsync();
        True(!window.IsVisible && successfulStore.Load().Settings.AutoUpdatesEnabled, "successful scheduled handoff keeps upgrades enabled for the next version");
    }

    private static void CloseFakeUpdateWindow(ExplorerPreviewWindow window)
    {
        // Teardown ONLY after a completed, pure fake update. No actual helper exists; production
        // intentionally has no user action that clears an uncertain handoff's ownership guard.
        typeof(ExplorerPreviewWindow).GetField("readyToClose", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, true);
        window.Close();
    }

    private static ExplorerPreviewWindow Window(Func<Task<IExplorerPreviewSession>> factory, FakeTrayIcon tray,
        ExplorerWindowContent? presentation = null, IExplorerPreviewSession? prepared = null, ExplorerUpdateActions? updates = null,
        Func<IExplorerPreviewSession, CancellationToken, Task<ConnectedExplorerUpdateBinding>>? binding = null)
    {
        var window = new ExplorerPreviewWindow(factory, _ => tray, presentation, prepared, readUpdateBindingForTests: binding) { ShowInTaskbar = false, Left = -20000, Top = -20000,
            WindowStartupLocation = WindowStartupLocation.Manual };
        if (updates is not null) window.SetUpdateActions(updates);
        window.Show(); Pump(); return window;
    }
    private static string Labels(DependencyObject element)
    {
        var result = element is System.Windows.Controls.TextBlock block ? block.Text : "";
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(element); i++) result += "\n" + Labels(VisualTreeHelper.GetChild(element, i));
        return result;
    }
    private static void Snap(Window window, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!); window.UpdateLayout(); Pump();
        var visual = (FrameworkElement)window.Content;
        var bitmap = new RenderTargetBitmap((int)visual.ActualWidth, (int)visual.ActualHeight, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var output = File.Create(path); encoder.Save(output);
    }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, () => frame.Continue = false); Dispatcher.PushFrame(frame); }
    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (!condition()) { if (DateTime.UtcNow > deadline) throw new TimeoutException("Preview window lifecycle did not settle."); await Task.Delay(20); Pump(); }
    }
    private static void True(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    private sealed class FakeSession(string root) : IExplorerPreviewSession, ICachedExplorerReconnect
    {
        internal int Starts, Pauses, Resumes, Removals, Disposals;
        internal int Reconnects;
        internal bool SavedReady, ReconnectPaused;
        internal ConnectedExplorerUpdateBinding Binding = new("pilot", "employee", "odqp1_" + new string('1', 64));
        internal int DisposeThread;
        internal bool RefuseFirstDispose;
        internal ManualResetEventSlim? DisposeGate;
        internal TaskCompletionSource? StartGate;
        internal TaskCompletionSource DisposeEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly List<string> activity = [];
        public string RootPath => root;
        public ExplorerPreviewState State { get; private set; }
        public IReadOnlyList<string> Activity => activity.ToArray();
        public event EventHandler? Changed;
        public bool CanReconnectCached => SavedReady && State == ExplorerPreviewState.NotStarted;
        public async Task ReconnectCachedAsync() { Reconnects++; if (StartGate is { } gate) await gate.Task; Set(ReconnectPaused ? ExplorerPreviewState.Paused : ExplorerPreviewState.Running, "Saved files reconnected with cached authorization."); }
        public async Task StartAsync() { Starts++; if (StartGate is { } gate) await gate.Task; Set(ExplorerPreviewState.Running, "Generated sample files are ready in Explorer."); }
        public Task PauseAsync() { Pauses++; Set(ExplorerPreviewState.Paused, "Preview downloads paused."); return Task.CompletedTask; }
        public Task ResumeAsync() { Resumes++; Set(ExplorerPreviewState.Running, "Preview downloads resumed."); return Task.CompletedTask; }
        public Task RemoveAsync() { Removals++; Set(ExplorerPreviewState.Removed, "Explorer registration removed. Local files kept."); return Task.CompletedTask; }
        public ValueTask DisposeAsync()
        {
            Disposals++;
            StartGate?.TrySetCanceled();
            DisposeThread = Environment.CurrentManagedThreadId;
            DisposeEntered.TrySetResult();
            if (DisposeGate is { } gate && !gate.Wait(TimeSpan.FromSeconds(5)))
                throw new TimeoutException("Synthetic disconnect gate exceeded its test deadline.");
            if (RefuseFirstDispose && Disposals == 1) throw new IOException("Synthetic disconnect refusal.");
            return ValueTask.CompletedTask;
        }
        private void Set(ExplorerPreviewState state, string message) { State = state; activity.Add(message); Changed?.Invoke(this, EventArgs.Empty); }
    }
}
