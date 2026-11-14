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
    internal static async Task FolderRefreshSnapshot()
    {
        var root = Path.GetTempPath();
        var session = new FakeSession(root);
        var launcher = new RecordingFolderLauncher();
        var window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(),
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session, folderLauncher: launcher);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            Pump();
            session.RootReads = 0;
            session.RootSequence = new Queue<string>([root, ""]);
            typeof(ExplorerPreviewWindow).GetMethod("Refresh", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(window, null);
            True(session.RootReads == 1 && window.OpenFolderButton.IsEnabled && Labels((DependencyObject)window.Content).Contains(root),
                "one refresh consistently presents a single root observation");
            window.OpenFolderButton.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(session.RootReads == 2 && launcher.Calls == 0, "click independently rechecks an unconfirmed root");
        } finally { window.Quit(); await Until(() => closed); }
    }
    internal static Task CheckUnavailableGuidance()
    {
        var window = new ExplorerPreviewWindow(() => throw new InvalidOperationException(), _ => new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", AccessMode.Employee));
        var guidance = window.CheckFileChangesUnavailable;
        True(guidance.Text.Contains("unavailable", StringComparison.Ordinal) && guidance.Text.Contains("contact", StringComparison.Ordinal) &&
            ReferenceEquals(guidance.Parent, window.CheckFileChangesButton.Parent), "explanation is next to the check and offers support");
        ExplorerPreviewWindow.SetCheckUnavailableGuidance(guidance, Visibility.Visible, true);
        True(guidance.Visibility == Visibility.Visible, "disabled fresh check explains why");
        ExplorerPreviewWindow.SetCheckUnavailableGuidance(guidance, Visibility.Visible, false);
        True(guidance.Visibility == Visibility.Collapsed, "normal check has no unavailable message");
        ExplorerPreviewWindow.SetCheckUnavailableGuidance(guidance, Visibility.Collapsed, true);
        True(guidance.Visibility == Visibility.Collapsed, "hidden check has no orphan explanation");
        return Task.CompletedTask;
    }
    internal static async Task CatalogCheckUi()
    {
        await using var fixture = new ConnectedExplorerSessionTests.Fixture();
        var connected = fixture.Create(); await connected.StartAsync();
        var window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), connected);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            Pump(); True(window.CheckFileChangesButton.Visibility == Visibility.Visible && window.CheckFileChangesButton.IsEnabled, "running connection offers check");
            await window.CheckFileChangesAsync();
            True(window.Pages.SelectedIndex == 1 && window.ActivityLines.Any(x => x.Contains("File check observed", StringComparison.Ordinal)), "successful check displays Activity results");
            fixture.CaptureFailure = new CatalogCaptureException(CatalogCaptureOperation.Roots, CatalogCaptureBoundary.MetadataRequest, TransferFailureReason.Network, null);
            window.Pages.SelectedIndex = 0; await window.CheckFileChangesAsync();
            True(window.Pages.SelectedIndex == 1 && window.ActivityLines.Any(x => x.Contains("check was incomplete", StringComparison.Ordinal)), "failed check displays incomplete Activity result");
            await connected.PauseAsync(); Pump(); True(window.CheckFileChangesButton.Visibility == Visibility.Collapsed, "paused connection hides check");
        } finally { window.Quit(); await Until(() => closed); }
        var preview = Window(() => throw new InvalidOperationException(), new FakeTrayIcon());
        try { Pump(); True(preview.CheckFileChangesButton.Visibility == Visibility.Collapsed, "preview hides connected catalog check"); }
        finally { preview.Quit(); await Until(() => !preview.IsVisible); }
    }
    internal static async Task FreshRemovalStatusUi()
    {
        await using var fixture = new LedgeTop.Files.Tests.ConnectedExplorerRemovalTests.Fixture();
        await using (var initial = fixture.Open()) await initial.RemoveAsync();
        var restarted = fixture.Open();
        var launcher = new RecordingFolderLauncher { Defer = true };
        var window = Window(() => throw new InvalidOperationException("Removed connection cannot reconnect."),
            new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), restarted, folderLauncher: launcher);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            Pump(); var labels = Labels((DependencyObject)window.Content);
            True(labels.Contains("Files connection removed") && labels.Contains("both files folders were kept") &&
                labels.Contains("Online-only files in either folder may be unavailable or removed") && labels.Contains("Connecting again after removal isn't available") && !labels.Contains("Files connection needs review"),
                "completed removal renders kept folders and unavailable reconnect without false review");
            True(!window.StartButton.IsEnabled && !window.RemoveButton.IsEnabled, "completed removal keeps unsupported actions disabled");
            True(window.OpenFolderButton.IsEnabled, "completed removal offers kept folder");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(launcher.Calls == 1 && launcher.Path == fixture.CandidateRoot && launcher.Validate?.Invoke() == true, "completed removal opens current kept folder with a launch guard");
            True(window.OpenPreviousFolderButton.IsEnabled && window.OpenPreviousFolderButton.Visibility == Visibility.Visible,
                "completed removal offers the previous kept folder separately");
            window.OpenPreviousFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(launcher.Calls == 2 && launcher.Path == fixture.OldRoot && launcher.Validate?.Invoke() == true,
                "previous folder opens its exact path with a launch guard");
            var selectorPath = System.IO.Path.Combine(fixture.Base, "connected-explorer-pilot-employee", FreshGenerationIndexStore.Current);
            var savedSelector = System.IO.File.ReadAllBytes(selectorPath);
            try {
                System.IO.File.WriteAllText(selectorPath, "changed selector");
                True(launcher.Validate?.Invoke() == false, "queued UI launch rejects changed selector");
                launcher.Completion!(false); Pump();
                True(window.StatusText == "Connection needs attention" && !window.OpenFolderButton.IsEnabled && !window.OpenPreviousFolderButton.IsEnabled,
                    "changed selector reports the open issue and disables the stale folder: " + window.StatusText + " enabled=" + window.OpenFolderButton.IsEnabled);
            } finally { System.IO.File.WriteAllBytes(selectorPath, savedSelector); }
            fixture.AssertLocalFilesPreserved();
        } finally { window.Quit(); await Until(() => closed); }
        fixture.AssertLocalFilesPreserved();
    }
    internal static async Task StagingScheduleDisabled()
    {
        True(!FreshGenerationStagingQualification.UpdaterAvailable, "test requires staging-qualified image");
        var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required.");
        var root = Path.Combine(parent, "staging-schedule-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var store = ExplorerUpdateScheduleSettingsStore.CreateForTests(Path.Combine(root, "schedule"));
        store.Save(new(true, DateTimeOffset.UtcNow.AddMinutes(-1)));
        var path = Path.Combine(root, "schedule", ExplorerUpdateScheduleSettingsStore.Leaf); var before = File.ReadAllBytes(path);
        var checks = 0; var installs = 0;
        var window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), new FakeSession(root),
            new("0.5.2.0", _ => { checks++; return Task.FromResult(AvailableUpdate()); }, _ => { installs++; return Task.FromResult(new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.Postponed, false)); }), FakeBinding);
        try {
            window.ConfigureUpdateSchedule(store, () => DateTimeOffset.UtcNow, TimeSpan.Zero, runTimer: true);
            await window.TickUpdateScheduleAsync(); await window.CheckForUpdatesAsync(); await window.InstallUpdateAsync();
            var timer = typeof(ExplorerPreviewWindow).GetField("updateScheduleTimer", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(window);
            True(timer is null && checks == 0 && installs == 0, "persisted enabled preference cannot create a timer, check or install in staging");
            True(!window.CheckUpdatesButton.IsEnabled && !window.InstallUpdateButton.IsEnabled && !window.AutomaticUpdatesCheckBox.IsEnabled &&
                Labels((DependencyObject)window.Content).Contains("Updates are not available in this build."), "staging clearly reports unavailable updates");
            True(File.ReadAllBytes(path).AsSpan().SequenceEqual(before), "staging leaves persisted preference unchanged");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }
    }
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
        foreach (var scenario in new[] { "valid", "malformed", "missing-backup", "changed-backup" }) await FreshRecoveryUi(scenario);
        await FreshReadOnlyUi();
        await FreshRunningEligibilityUi();

        var root = Path.Combine(Path.GetTempPath(), "ltfiles-settings-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root); var retained = Path.Combine(root, "retained.txt"); await File.WriteAllTextAsync(retained, "keep local bytes");
        try {
            var created = new List<FakeSession>();
            var tray = new FakeTrayIcon();
            Func<IReadOnlyList<TrayAction>>? trayActions = null;
            var window = Window(() => { var service = new FakeSession(root); created.Add(service); return Task.FromResult<IExplorerPreviewSession>(service); }, tray, captureTray: actions => trayActions = actions);
            var closed = 0; window.Closed += (_, _) => closed++;
            try {
                True(created.Count == 0 && window.StartButton.IsEnabled, "opening Settings doesn't construct a provider");
                True(!Labels((DependencyObject)window.Content).Contains(ExplorerPreviewWindow.SavedListDisclosure), "generated preview omits connected-pilot file-list disclosure");
                True(window.ReconnectButton.Visibility == Visibility.Collapsed, "generated preview never offers cached connected authorization");
                Snap(window, Path.Combine(screenshots, "explorer-settings-before-start.png"));
                await window.StartPreviewAsync();
                True(created.Count == 1 && created[0].Starts == 1 && window.OpenFolderButton.IsEnabled, "explicit simulated start opens preview controls");
                True(window.PauseButton.Visibility == Visibility.Collapsed && window.ResumeButton.Visibility == Visibility.Collapsed, "download pause controls stay hidden");
                True(trayActions is not null && !trayActions().Any(action => action.Label is "Pause downloads" or "Resume downloads"), "tray menu omits manual pause and resume actions");
                await window.PausePreviewAsync();
                True(created[0].Pauses == 1 && window.ResumeButton.Visibility == Visibility.Collapsed, "internal pause state does not expose a resume control");
                await window.ResumePreviewAsync();
                True(created[0].Resumes == 1 && window.PauseButton.Visibility == Visibility.Collapsed, "internal resume preserves hidden controls");
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
            // A delayed native drain must explain the wait without detaching or starting another stop.
            using var delayedGate = new ManualResetEventSlim(false);
            var delayedSession = new FakeSession(root) { DisposeGate = delayedGate };
            var delayed = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), delayedSession);
            delayed.ShutdownNoticeDelayForTests = TimeSpan.FromMilliseconds(40);
            var delayedClosed = false; delayed.Closed += (_, _) => delayedClosed = true;
            delayed.Quit();
            try {
                await delayedSession.DisposeEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
                await Until(() => delayed.DetailText.Contains("Still waiting for Windows", StringComparison.Ordinal));
                delayed.Quit(); Pump();
                True(delayed.IsVisible && !delayedClosed && delayedSession.Disposals == 1,
                    "delayed message retains owner and does not launch a second disconnect");
            } finally { delayedGate.Set(); await Until(() => delayedClosed); }

            using var delayedFailureGate = new ManualResetEventSlim(false);
            var delayedFailureSession = new FakeSession(root) { DisposeGate = delayedFailureGate, RefuseFirstDispose = true };
            var delayedFailure = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), delayedFailureSession, setupProblem: "Earlier connection problem.");
            delayedFailure.ShutdownNoticeDelayForTests = TimeSpan.FromMilliseconds(40);
            var delayedFailureClosed = false; delayedFailure.Closed += (_, _) => delayedFailureClosed = true;
            True(delayedFailure.DetailText == "Earlier connection problem.", "pre-existing connection problem is visible before quit");
            delayedFailure.Quit();
            try {
                await delayedFailureSession.DisposeEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
                await Until(() => delayedFailure.DetailText.Contains("Still waiting for Windows", StringComparison.Ordinal));
                delayedFailureGate.Set();
                await Until(() => delayedFailure.StatusText == "Connection needs attention");
                True(delayedFailure.IsVisible && !delayedFailureClosed && delayedFailureSession.Disposals == 1,
                    "a delayed failure retains the existing retryable failure behavior");
                True(delayedFailure.DetailText.Contains("couldn't stop safely", StringComparison.Ordinal), "shutdown failure remains visible for retry");
                delayedFailure.Quit(); await Until(() => delayedFailureClosed);
                True(delayedFailureSession.Disposals == 2, "retry begins only after prior stop failed");
            } finally { delayedFailureGate.Set(); delayedFailure.Quit(); await Until(() => delayedFailureClosed); }
            var prepared = new FakeSession(root);
            var connectedFactoryCalls = 0;
            var connected = Window(() => { connectedFactoryCalls++; throw new InvalidOperationException("Offline removal must not prepare a sign-in."); },
                new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", LedgeTop.Files.Backends.AccessMode.Employee), prepared);
            var connectedClosed = false; connected.Closed += (_, _) => connectedClosed = true;
            try {
                True(connected.RemoveButton.IsEnabled && prepared.Starts == 0 && connectedFactoryCalls == 0,
                    "prepared connection offers offline removal without sign-in or factory execution");
                True(connected.ReconnectButton.Visibility == Visibility.Collapsed, "absent saved inventory does not offer reconnect");
                True(connected.FreshFolderButton.Visibility == Visibility.Collapsed, "real composition does not expose an unimplemented fresh-folder action");
                await connected.StartFreshFolderAsync();
                True(prepared.Starts == 0 && connectedFactoryCalls == 0, "direct fresh-folder action refuses an unqualified session");
                True((string)connected.StartButton.Content == "Sign in and connect files", "real connection has explicit sign-in action");
                var labels = Labels((DependencyObject)connected.Content);
                True(labels.Contains(ExplorerPreviewWindow.SavedListDisclosure), "connected pilot explains that its file list does not refresh automatically");
                True(!labels.Contains("simulated sign-in") && !labels.Contains("DEMO DATA") && !labels.Contains("Demo account"),
                    "connected settings do not claim generated data or simulated sign-in");
                True(labels.Contains("Windows may remove online-only files") && labels.Contains("partially downloaded or locally changed files") && labels.Contains("Back up"),
                    "removal description does not promise that every placeholder or local modification survives");
                Snap(connected, Path.Combine(screenshots, "connected-settings-before-sign-in.png"));
                await connected.RemovePreviewAsync();
                True(prepared.Removals == 1 && prepared.Starts == 0 && connectedFactoryCalls == 0 && File.Exists(retained),
                    "offline removal routes directly to the owned connection and preserves files");
            } finally { connected.Quit(); await Until(() => connectedClosed); }
            var freshOwner = new FakeSession(root); var consent = false; var prompts = 0; var freshCalls = 0;
            var freshRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var fakeActions = new FreshFolderUiTestActions(message => {
                prompts++; True(message.Contains("previous folder remains") && message.Contains("online-only files") && message.Contains("partially downloaded or locally changed files") && message.Contains("Back up") && message.Contains("not uploaded"), "confirmation describes retention, availability and read-only limitations"); return consent;
            }, async current => { True(ReferenceEquals(current, freshOwner), "action receives exact existing session"); freshCalls++; await freshRelease.Task; });
            var freshWindow = Window(() => throw new InvalidOperationException("Must not create a replacement session in UI."), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), freshOwner, fresh: fakeActions);
            var freshClosed = false; freshWindow.Closed += (_, _) => freshClosed = true;
            try {
                True(freshWindow.FreshFolderButton.Visibility == Visibility.Visible && freshWindow.FreshFolderButton.IsEnabled, "injected fake action appears only in connected settings");
                await freshWindow.StartFreshFolderForTestsAsync(); True(prompts == 1 && freshCalls == 0, "dismissal never starts a generation");
                consent = true; var pendingFresh = freshWindow.StartFreshFolderForTestsAsync();
                True(freshCalls == 1 && !pendingFresh.IsCompleted && !freshWindow.FreshFolderButton.IsEnabled, "accepted action serializes while pending");
                await freshWindow.StartFreshFolderForTestsAsync(); True(freshCalls == 1 && prompts == 2, "repeat click cannot start a second action");
                freshRelease.TrySetResult(); await pendingFresh; True(File.Exists(retained), "fake action does not delete existing files");
            } finally { freshRelease.TrySetResult(); freshWindow.Quit(); await Until(() => freshClosed); }
            var demoOwner = new FakeSession(root);
            var demoFresh = Window(() => Task.FromResult<IExplorerPreviewSession>(demoOwner), new FakeTrayIcon(), prepared: demoOwner, fresh: fakeActions);
            var demoFreshClosed = false; demoFresh.Closed += (_, _) => demoFreshClosed = true;
            try {
                True(demoFresh.FreshFolderButton.Visibility == Visibility.Collapsed, "generated preview never offers fresh connected generation");
                await demoFresh.StartFreshFolderForTestsAsync(); True(prompts == 2 && freshCalls == 1, "generated preview cannot invoke injected action");
            } finally { demoFresh.Quit(); await Until(() => demoFreshClosed); }
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
                True(savedWindow.PauseButton.Visibility == Visibility.Collapsed && savedWindow.ResumeButton.Visibility == Visibility.Collapsed,
                    "connected settings never expose manual pause/resume, including legacy paused state");
                True(saved.Starts == 0 && saved.State == ExplorerPreviewState.Paused && savedWindow.ReconnectButton.Visibility == Visibility.Collapsed,
                    "button routes cached-only action, preserves pause and disappears once connected");
                await savedWindow.RemovePreviewAsync();
                True(savedWindow.ReconnectButton.Visibility == Visibility.Collapsed, "removed saved connection cannot reconnect");
            } finally { savedWindow.Quit(); await Until(() => savedClosed); }
            var retrySession = new FakeSession(root);
            var retryWindow = Window(() => Task.FromResult<IExplorerPreviewSession>(retrySession), new FakeTrayIcon(),
                ExplorerWindowContent.Connected("Pilot", LedgeTop.Files.Backends.AccessMode.Employee), retrySession);
            var retryClosed = false; retryWindow.Closed += (_, _) => retryClosed = true;
            try {
                True(retryWindow.RetryAvailabilityButton.Visibility == Visibility.Collapsed, "retry unavailable before connection");
                await retrySession.StartAsync(); Pump();
                True(retryWindow.RetryAvailabilityButton.Visibility == Visibility.Visible && retryWindow.RetryAvailabilityButton.IsEnabled, "running connection offers retry");
                True((string)retryWindow.RetryAvailabilityButton.Content == "Check file availability actions" &&
                    ((string)retryWindow.RetryAvailabilityButton.ToolTip).Contains("if needed", StringComparison.Ordinal), "action describes a check rather than promising work");
                retrySession.RetryGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
                var pendingRetry = retryWindow.RetryAvailabilityAsync();
                True(retrySession.Retries == 1 && !retryWindow.RetryAvailabilityButton.IsEnabled && !pendingRetry.IsCompleted, "retry serializes controls");
                retrySession.RetryGate.TrySetResult(); await pendingRetry;
                True(retrySession.Starts == 1 && retrySession.Reconnects == 0, "retry does not reconnect or sign in");
                await retrySession.PauseAsync(); Pump();
                True(retryWindow.RetryAvailabilityButton.Visibility == Visibility.Collapsed, "paused connection does not offer retry");
            } finally { retrySession.RetryGate?.TrySetResult(); retryWindow.Quit(); await Until(() => retryClosed); }
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
            await FailedReplacementDiagnostics(root, retained);
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

    private static async Task FreshRecoveryUi(string scenario)
    {
        var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required.");
        var baseDir = Path.Combine(parent, "fresh-review-ui-" + Guid.NewGuid().ToString("N"));
        var indexDir = Path.Combine(baseDir, "connected-explorer-pilot-employee"); Directory.CreateDirectory(indexDir);
        const string origin = "https://example.invalid"; var principal = "odqp1_" + new string('a', 64);
        var scope = new FreshGenerationPlan.Scope("pilot", "employee", origin, principal);
        var old = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, Path.Combine(baseDir, "old-profile"), Path.Combine(baseDir, "old-root"), new string('b', 64), 1, 2, 1, 1, 3, 1, 6, Guid.NewGuid());
        var next = new FreshGenerationPlan.Generation(Guid.NewGuid(), scope, Path.Combine(baseDir, "new-profile"), Path.Combine(baseDir, "new-root"), new string('c', 64), 1, 4, 1, 1, 5);
        var prepared = FreshGenerationPlan.Prepare(new(old, null, FreshGenerationPlan.Phase.OldActive), next, scope, true, true);
        var legacy = System.Text.Encoding.UTF8.GetBytes("{\"Schema\":1}");
        File.WriteAllBytes(Path.Combine(indexDir, FreshGenerationIndexStore.LegacyBackup), legacy);
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var selector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, identity.User!.Value, "pilot", "employee",
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(origin))), principal,
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(legacy)), 2, prepared, old.Id);
        var path = Path.Combine(indexDir, "current.json"); var bytes = scenario == "malformed" ? System.Text.Encoding.UTF8.GetBytes("{broken") : FreshGenerationIndexCodec.Encode(selector); File.WriteAllBytes(path, bytes);
        var backup = Path.Combine(indexDir, FreshGenerationIndexStore.LegacyBackup);
        if (scenario == "missing-backup") File.Delete(backup);
        if (scenario == "changed-backup") File.WriteAllText(backup, "changed synthetic backup");
        var calls = 0;
        var session = new ConnectedExplorerSession(() => { calls++; throw new IOException("No backend"); }, "pilot", "employee", new Uri(origin), baseDir, old.RootPath);
        True(session.RequiresOwnershipReview, "saved selector requires ownership review: " + scenario);
        var window = Window(() => { calls++; throw new IOException("No replacement"); }, new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            True(!window.StartButton.IsEnabled && !window.RemoveButton.IsEnabled && !window.CheckUpdatesButton.IsEnabled,
                "recovery hold disables sign-in, removal and updates");
            var labels = Labels((DependencyObject)window.Content);
            True(labels.Contains("Files connection needs review") && labels.Contains("Previous online-only files may be unavailable"),
                "recovery status explains the issue without promising file access");
            await window.StartPreviewAsync(); await window.RemovePreviewAsync();
            True(calls == 0 && File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes), "direct actions do not replace, authenticate or remove a held selector");
        } finally { window.Quit(); await Until(() => closed); }
    }

    private static async Task FreshRunningEligibilityUi()
    {
        await using var fixture = new ConnectedExplorerSessionTests.Fixture { Alias = "employee" };
        var hooks = new SyntheticFirstTransitionHooks((profile, root, source, scope, manifest) =>
            OwnedExplorerRootSession.CandidateForTest(profile, root, source, scope, manifest, priorVerify: _ => true, priorDrain: _ => Task.CompletedTask),
            (_, _) => { });
        var session = fixture.Create(transition: hooks); await session.StartAsync();
        var source = fixture.StartedSources.Single();
        var scope = new ExplorerRootScope("pilot", "employee", source.Origin.GetLeftPart(UriPartial.Authority), ConnectedExplorerSessionTests.Fixture.PersonA);
        var manifest = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        var profile = Path.Combine(fixture.TestRoot, "ui-prior-profile"); var root = Path.Combine(fixture.TestRoot, "ui-prior-root");
        Directory.CreateDirectory(profile); Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(profile, "profile.json"), "synthetic profile"); File.WriteAllText(Path.Combine(profile, "manifest.json"), "synthetic manifest");
        var sentinel = Path.Combine(root, "keep.txt"); File.WriteAllText(sentinel, "keep");
        var prior = OwnedExplorerRootSession.CandidateForTest(profile, root, source, scope, manifest, priorVerify: _ => true, priorDrain: _ => Task.CompletedTask);
        prior.AttachSyntheticPriorLeaseForTest(new FileStream(Path.Combine(profile, "session.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None));
        using var initial = ConnectedGenerationHandleLease.Open(profile, "manifest.json", root);
        var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), profile, root, unchecked((long)initial.RootFileId), Guid.NewGuid(), manifest.Digest, scope, 1);
        prior.ConfigureSyntheticPriorForTest(() => new ConnectedGenerationHeldObservation(snapshot, ConnectedGenerationHandleLease.Open(profile, "manifest.json", root)), root);
        await session.InstallSyntheticPriorForTestAsync(prior);
        var window = Window(() => throw new InvalidOperationException("Unexpected replacement."), new FakeTrayIcon(), ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            True(session.CanStartFreshReadOnlyConnection && window.FreshFolderButton.Visibility == Visibility.Visible && window.FreshFolderButton.IsEnabled,
                "genuine running synthetic employee session offers qualified fresh folder while index lease is retained");
            True(File.ReadAllText(sentinel) == "keep", "displaying the action does not change prior files");
        } finally { window.Quit(); await Until(() => closed); }
    }

    internal static async Task FreshReadOnlyUi()
    {
        var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic artifact root required.");
        var fixture = Path.Combine(parent, "fresh-active-ui-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(fixture);
        using var source = new ExplorerDemoSource(signedIn: true, chunkDelay: TimeSpan.Zero);
        var origin = source.Origin.GetLeftPart(UriPartial.Authority); var scope = new FreshGenerationPlan.Scope("pilot", "employee", origin, source.PrincipalId);
        var nativeScope = new ExplorerRootScope(scope.Channel, scope.Source, scope.Origin, scope.Principal);
        var manifest = new ExplorerRootManifest(nativeScope, new Dictionary<string, PlaceholderIdentity>());
        var allowPriorStop = true;
        (OwnedExplorerRootSession Session, RestartGenerationEvidence Evidence) Prepare(string name, Func<bool> verify) {
            var profile = Path.Combine(fixture, name + "-profile"); var root = Path.Combine(fixture, name + "-root");
            Directory.CreateDirectory(profile); Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(profile, "profile.json"), "synthetic profile"); File.WriteAllText(Path.Combine(profile, "manifest.json"), "synthetic manifest");
            var owned = OwnedExplorerRootSession.CandidateForTest(profile, root, source, nativeScope, manifest, priorVerify: _ => verify(), priorDrain: _ => Task.CompletedTask);
            var stream = new FileStream(Path.Combine(profile, "session.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var handles = ConnectedGenerationHandleLease.Open(profile, "manifest.json", root);
            var snapshot = new ConnectedGenerationSnapshot(Guid.NewGuid(), profile, root, unchecked((long)handles.RootFileId), Guid.NewGuid(), manifest.Digest, nativeScope, 2);
            var evidence = new RestartGenerationEvidence(snapshot, handles.ProfileDirectoryVolume, handles.ProfileDirectoryFileId, handles.ProfileVolume, handles.ProfileFileId, handles.RootVolume, handles.RootFileId);
            owned.AttachSyntheticRestartForTest(stream, new ConnectedGenerationHeldObservation(snapshot, handles)); return (owned, evidence);
        }
        var prior = Prepare("old", () => allowPriorStop); var current = Prepare("current", () => true); var p = prior.Evidence; var c = current.Evidence;
        var old = new FreshGenerationPlan.Generation(p.Snapshot.Identity, scope, p.Snapshot.ProfileDirectory, p.Snapshot.RootPath, p.Snapshot.ManifestDigest, p.ProfileDirectoryVolume, p.ProfileDirectoryFileId, p.Snapshot.ProfileRevision, p.ProfileDocumentVolume, p.ProfileDocumentFileId, p.RootVolume, p.RootFileId, p.Snapshot.NamespaceClsid);
        var next = new FreshGenerationPlan.Generation(c.Snapshot.Identity, scope, c.Snapshot.ProfileDirectory, c.Snapshot.RootPath, c.Snapshot.ManifestDigest, c.ProfileDirectoryVolume, c.ProfileDirectoryFileId, 1, c.ProfileDocumentVolume, c.ProfileDocumentFileId);
        var prepared = FreshGenerationPlan.Prepare(new(old, null, FreshGenerationPlan.Phase.OldActive), next, scope, true, true);
        var ready = FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope, next.Id, next.ManifestDigest, next.RootPath,
            new(c.RootVolume, c.RootFileId, c.Snapshot.NamespaceClsid, c.Snapshot.ProfileRevision, c.ProfileDocumentVolume, c.ProfileDocumentFileId), true);
        var stateBase = Path.Combine(fixture, "state"); var indexDir = Path.Combine(stateBase, "connected-explorer-pilot-employee"); Directory.CreateDirectory(indexDir);
        var backup = System.Text.Encoding.UTF8.GetBytes("synthetic backup"); using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var selector = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, identity.User!.Value, "pilot", "employee",
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(origin))), scope.Principal,
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(backup)), 4, FreshGenerationPlan.Publish(ready, true), next.Id);
        var index = Path.Combine(indexDir, "current.json"); var bytes = FreshGenerationIndexCodec.Encode(selector); File.WriteAllBytes(index, bytes);
        File.WriteAllBytes(Path.Combine(indexDir, FreshGenerationIndexStore.LegacyBackup), backup); using (File.Create(Path.Combine(indexDir, "index.lock"))) { }
        var restart = FreshGenerationColdRestart.CreateSyntheticHeldForTest(prior.Session, current.Session, selector, () => true);
        current.Session.MarkSyntheticRestartRunningForTest(); var calls = 0;
        var session = new ConnectedExplorerSession(() => { calls++; throw new Exception("No backend"); }, "pilot", "employee", new Uri(origin), stateBase, old.RootPath,
            _ => throw new Exception("No engine"), (_, _, _, _) => throw new Exception("No capture"), syntheticColdPreparationAdmission: () => true);
        var freshTray = new FakeTrayIcon(); var launcher = new FailingFolderLauncher();
        var window = Window(() => { calls++; throw new Exception("No replacement"); }, freshTray, ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session, folderLauncher: launcher);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            var reconnectLabels = Labels((DependencyObject)window.Content);
            True(window.DetailText.Contains("browse files already on this PC", StringComparison.Ordinal) &&
                window.DetailText.Contains("Reconnect to open online-only files", StringComparison.Ordinal),
                "cold published guidance distinguishes local files from online-only files");
            True(session.CanStartPublishedFresh && reconnectLabels.Contains(ExplorerPreviewWindow.FreshSavedListDisclosure) &&
                !reconnectLabels.Contains(ExplorerPreviewWindow.SavedListDisclosure) && !window.CheckFileChangesButton.IsEnabled,
                "saved fresh connection explains unavailable checks before reconnect");
            await session.PublishSyntheticColdReadOnlyProviderForTestAsync(restart);
            Pump();
            True(window.OpenFolderButton.IsEnabled && !window.StartButton.IsEnabled && !window.RemoveButton.IsEnabled && !window.CheckUpdatesButton.IsEnabled,
                "read-only active state permits opening the folder but disables unsupported actions");
            var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
            var coldFencedField = typeof(ConnectedExplorerSession).GetField("coldFenced", flags)!;
            var stopAllowedField = typeof(ConnectedExplorerSession).GetField("coldStopRetryAllowed", flags)!;
            var originalColdFenced = coldFencedField.GetValue(session); var originalStopAllowed = stopAllowedField.GetValue(session);
            var refresh = typeof(ExplorerPreviewWindow).GetMethod("Refresh", flags)!;
            var busyField = typeof(ExplorerPreviewWindow).GetField("busy", flags)!;
            var actionField = typeof(ExplorerPreviewWindow).GetField("activeAction", flags)!;
            var activeField = typeof(ConnectedExplorerSession).GetField("freshReadOnlyActive", flags)!;
            var pendingField = typeof(ConnectedExplorerSession).GetField("coldRemovalPending", flags)!;
            var stateField = typeof(ConnectedExplorerSession).GetField("state", flags)!;
            var updatesField = typeof(ExplorerPreviewWindow).GetField("updates", flags)!;
            var updateAvailableField = typeof(ExplorerPreviewWindow).GetField("updateAvailable", flags)!;
            var originalUpdates = updatesField.GetValue(window); var originalUpdateAvailable = updateAvailableField.GetValue(window);
            var originalActive = activeField.GetValue(session); var originalPending = pendingField.GetValue(session); var originalState = stateField.GetValue(session);
            try {
            coldFencedField.SetValue(session, true); stopAllowedField.SetValue(session, false); refresh.Invoke(window, null); Pump();
            True(!window.RemoveButton.IsEnabled, "active cold connection without a confirmed stop receipt cannot be removed");
            stopAllowedField.SetValue(session, true); refresh.Invoke(window, null); Pump();
            True(window.RemoveButton.IsEnabled, "active cold connection with a stop receipt offers removal");
            busyField.SetValue(window, true); actionField.SetValue(window, ConnectionAction.Remove); refresh.Invoke(window, null); Pump();
            True(window.StatusText == "Removing connection…" && window.DetailText.Contains("Waiting for Windows", StringComparison.Ordinal) && !window.RemoveButton.IsEnabled,
                "in-flight removal reports waiting instead of failure");
            busyField.SetValue(window, false); actionField.SetValue(window, null);
            activeField.SetValue(session, false); pendingField.SetValue(session, true); stateField.SetValue(session, ExplorerPreviewState.Failed);
            var updateCalls = 0;
            updatesField.SetValue(window, new ExplorerUpdateActions("0.5.0.0",
                _ => { updateCalls++; throw new IOException("Unexpected update check."); },
                _ => { updateCalls++; throw new IOException("Unexpected update install."); }));
            updateAvailableField.SetValue(window, true);
            refresh.Invoke(window, null); Pump();
            True(window.StatusText == "Waiting for Windows" && window.RemoveButton.IsEnabled && !session.RequiresOwnershipReview &&
                !window.StartButton.IsEnabled && !window.CheckUpdatesButton.IsEnabled && !window.InstallUpdateButton.IsEnabled &&
                !window.WindowsStartupCheckBox.IsEnabled && !window.AutomaticUpdatesCheckBox.IsEnabled,
                "unconfirmed shutdown permits retry but disables unrelated actions");
            await window.StartPreviewAsync(); await window.CheckForUpdatesAsync(); await window.InstallUpdateAsync();
            True(updateCalls == 0 && calls == 0 && session.CanRetryColdRemoval && File.ReadAllBytes(index).AsSpan().SequenceEqual(bytes),
                "direct start and update calls do not run during pending shutdown");
            } finally {
                busyField.SetValue(window, false); actionField.SetValue(window, null);
                updatesField.SetValue(window, originalUpdates); updateAvailableField.SetValue(window, originalUpdateAvailable);
                activeField.SetValue(session, originalActive); pendingField.SetValue(session, originalPending); stateField.SetValue(session, originalState);
                coldFencedField.SetValue(session, originalColdFenced); stopAllowedField.SetValue(session, originalStopAllowed); refresh.Invoke(window, null); Pump();
            }
            var labels = Labels((DependencyObject)window.Content);
            True(labels.Contains("Files are ready to view") && labels.Contains("changes you make here are not uploaded"), "active status describes read-only behavior");
            // Simulate the owned provider reporting a paused state through its actual Changed event.
            var setOwnedState = typeof(OwnedExplorerRootSession).GetMethod("SetState", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
            setOwnedState.Invoke(current.Session, [ExplorerPreviewState.Paused]); Pump();
            True(session.State == ExplorerPreviewState.Paused && window.StatusText == "Downloads are paused" && freshTray.LastStatus.Contains("Downloads are paused", StringComparison.Ordinal),
                "paused fresh connection is not presented as ready in Settings or tray");
            True(window.DetailText.Contains("ask your Ledge Top contact", StringComparison.Ordinal) && window.ResumeButton.Visibility == Visibility.Collapsed,
                "paused fresh connection offers support guidance when resume is unavailable");
            setOwnedState.Invoke(current.Session, [ExplorerPreviewState.Running]); Pump();
            True(session.State == ExplorerPreviewState.Running && window.StatusText == "Files are ready to view", "fresh connection returns to ready only after provider resumes");
            setOwnedState.Invoke(current.Session, [ExplorerPreviewState.Failed]); Pump();
            True(session.State == ExplorerPreviewState.Failed && window.StatusText == "Connection needs attention" && freshTray.LastStatus.Contains("Connection needs attention", StringComparison.Ordinal),
                "failed fresh connection is not presented as ready in Settings or tray");
            True(window.DetailText.Contains("ask your Ledge Top contact", StringComparison.Ordinal) && !window.DetailText.Contains("remove", StringComparison.OrdinalIgnoreCase) && !window.RemoveButton.IsEnabled,
                "failed fresh connection does not suggest unavailable removal");
            // Failed is sticky in the real coordinator; restore the simulated fixture for the remaining tests.
            typeof(ConnectedExplorerSession).GetMethod("SetState", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(session, [ExplorerPreviewState.Running]);
            setOwnedState.Invoke(current.Session, [ExplorerPreviewState.Running]); Pump();
            True(labels.Contains(ExplorerPreviewWindow.FreshSavedListDisclosure) && !labels.Contains(ExplorerPreviewWindow.SavedListDisclosure) && !window.CheckFileChangesButton.IsEnabled, "fresh active disclosure explains unavailable file checks");
            True(window.CheckFileChangesUnavailable.Visibility == Visibility.Visible && window.CheckFileChangesUnavailable.Text.Contains("unavailable", StringComparison.Ordinal) &&
                ReferenceEquals(window.CheckFileChangesUnavailable.Parent, window.CheckFileChangesButton.Parent), "unavailable guidance sits beside the disabled action");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            launcher.Completions[0](false);
            await Until(() => window.DetailText.Contains("A previous attempt to open the files folder failed", StringComparison.Ordinal));
            True(window.StatusText == "Connection needs attention" && freshTray.LastStatus.Contains("Connection needs attention", StringComparison.Ordinal), "fresh connection surfaces Explorer launch failure in status and tray");
            Pump(); True(window.DetailText.Contains("A previous attempt to open the files folder failed", StringComparison.Ordinal), "refresh does not silently clear launch failure");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            launcher.Accept = false;
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            launcher.Completions[1](true); Pump();
            True(window.StatusText == "Files are ready to view", "successful accepted retry clears only launch failure despite rejected busy request");
            launcher.Completions[0](false); Pump();
            True(window.StatusText == "Files are ready to view", "late failure from prior accepted attempt is ignored");
            launcher.Accept = true;
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            var problemField = typeof(ExplorerPreviewWindow).GetField("problem", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
            problemField.SetValue(window, "Separate connection problem.");
            launcher.Completions[2](true); Pump();
            True(window.DetailText == "Separate connection problem." && window.StatusText == "Connection needs attention", "successful launch does not clear unrelated problem");
            await window.StartPreviewAsync(); await window.RemovePreviewAsync(); await window.PausePreviewAsync(); await window.ResumePreviewAsync();
            True(session.FreshReadOnlyActive && calls == 0 && File.ReadAllBytes(index).AsSpan().SequenceEqual(bytes), "unsupported actions leave active synthetic session unchanged");
            allowPriorStop = false;
            try { await session.StopColdFreshRestartAsync(); throw new Exception("Partial stop unexpectedly succeeded"); } catch (IOException) { }
            Pump(); labels = Labels((DependencyObject)window.Content);
            True(labels.Contains(ExplorerPreviewWindow.FreshSavedListDisclosure) && !labels.Contains(ExplorerPreviewWindow.SavedListDisclosure) && !window.CheckFileChangesButton.IsEnabled, "ownership review explains unavailable file checks");
            True(!session.FreshReadOnlyActive && session.RequiresOwnershipReview && labels.Contains("Files connection needs review") &&
                !labels.Contains("Files are ready to view") && !window.RemoveButton.IsEnabled, "partial stop shows ownership review, not ready files");
            allowPriorStop = true; // Quit retries the retained partial stop in this synthetic fixture.
        } finally { window.Quit(); await Until(() => closed); }
        True(Directory.Exists(old.RootPath) && Directory.Exists(next.RootPath), "quit retains both generated roots");
        await FolderOwnerChangesUi(parent);
    }

    private static async Task FolderOwnerChangesUi(string parent)
    {
        var root = Path.Combine(parent, "folder-owner-" + Guid.NewGuid().ToString("N"));
        var next = Path.Combine(root, "next"); Directory.CreateDirectory(next);
        var fake = new FakeSession(root); var replacement = new FakeSession(next); var launcher = new FailingFolderLauncher(); var tray = new FakeTrayIcon();
        var window = Window(() => Task.FromResult<IExplorerPreviewSession>(replacement), tray, ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), fake, folderLauncher: launcher);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            await window.StartPreviewAsync();
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            fake.SetRoot(next); Pump(); launcher.Completions[0](false); Pump();
            True(!window.DetailText.Contains("previous attempt", StringComparison.Ordinal), "old root failure ignored after root change");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            await fake.RemoveAsync(); Pump(); launcher.Completions[1](false); Pump();
            True(!window.DetailText.Contains("previous attempt", StringComparison.Ordinal), "old root failure ignored after removal");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            launcher.Completions[2](false);
            await Until(() => window.DetailText.Contains("previous attempt", StringComparison.Ordinal));
            True(window.StatusText == "Connection needs attention", "new launch failure after removal is reported");
            await window.StartPreviewAsync(); Pump(); launcher.Completions[1](false); Pump();
            True(replacement.Starts == 1 && !window.DetailText.Contains("previous attempt", StringComparison.Ordinal), "old session callback ignored after replacement with same root");
        } finally { window.Quit(); await Until(() => closed); Console.WriteLine("Synthetic folder-owner fixture retained for identity-safe cleanup: " + root); }
    }

    private static async Task FailedReplacementDiagnostics(string root, string retained)
    {
        var previous = new FakeSession(root) { RefuseFirstDispose = true };
        previous.MarkFailed(); var replacements = 0;
        var replacement = new FakeSession(root);
        var window = Window(() => { replacements++; return Task.FromResult<IExplorerPreviewSession>(replacement); }, new FakeTrayIcon(),
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), previous);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            await window.StartPreviewAsync();
            True(previous.Disposals == 1 && previous.Starts == 0 && replacements == 0 &&
                window.ActivityLines.Any(line => line.EndsWith("settings/ExplicitConnect/DisposePrevious/LocalIO/Unknown", StringComparison.Ordinal)),
                "failed old-session drain is identified before factory or explicit login can run");
            True(window.ActivityLines.All(line => !line.Contains("Synthetic disconnect refusal", StringComparison.Ordinal)) && File.Exists(retained),
                "drain diagnostic never reports exception message or changes local data");
            await window.StartPreviewAsync();
            True(previous.Disposals == 2 && replacements == 1 && replacement.Starts == 1 && replacement.State == ExplorerPreviewState.Running && File.Exists(retained),
                "a later explicit action can recover only after the same previous session confirms drain");
        } finally { window.Quit(); await Until(() => closed); }
        var failed = Window(() => throw new TransferException("private source URL and credentials", TransferFailureReason.Timeout), new FakeTrayIcon(),
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee));
        closed = false; failed.Closed += (_, _) => closed = true;
        try {
            await failed.StartPreviewAsync();
            True(failed.ActivityLines.Any(line => line.EndsWith("settings/ExplicitConnect/CreateSession/Transfer/Timeout", StringComparison.Ordinal)) &&
                failed.ActivityLines.All(line => !line.Contains("private source URL", StringComparison.Ordinal)),
                "factory failure is distinguishable from failed old-session disposal without leaking its message");
        } finally { failed.Quit(); await Until(() => closed); }
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

        var pin = new ConnectedExplorerGenerationBinding(Guid.NewGuid(), 7, new string('a', 64), 123, Guid.NewGuid(), 4);
        var generationOld = new FakeSession(root) { Binding = new("pilot", "employee", "odqp1_" + new string('1', 64), pin) };
        var generationWrong = new FakeSession(root) { SavedReady = true, Binding = generationOld.Binding with { Generation = pin with { GenerationId = Guid.NewGuid() } } };
        var generationGood = new FakeSession(root) { SavedReady = true, Binding = generationOld.Binding };
        var generationReplacements = new Queue<IExplorerPreviewSession>([generationWrong, generationGood]);
        ExplorerPreviewWindow generationWindow = null!;
        generationWindow = Window(() => Task.FromResult(generationReplacements.Dequeue()), new FakeTrayIcon(), content, generationOld,
            new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                var expected = await generationWindow.GetVerifiedUpdateBindingAsync(); await generationWindow.DrainForUpdateAsync(expected);
                True(!await generationWindow.RecoverForUpdateAsync(expected), "same account with a different generation cannot be adopted");
                return new(ExeUpdateHandoffStatus.NeedsReconnect, true);
            }), FakeBinding);
        try {
            await generationWindow.StartPreviewAsync(); await generationWindow.CheckForUpdatesAsync(); await generationWindow.InstallUpdateAsync();
            True(generationWrong.Reconnects == 1 && generationWrong.Disposals == 1 && generationWrong.Removals == 0,
                "mismatched generation is disposed without removal or adoption");
            await generationWindow.ReconnectPreviewAsync();
            True(generationGood.Reconnects == 1 && generationGood.Disposals == 0, "exact generation can reconnect without browser fallback");
        } finally { generationWindow.Quit(); await Until(() => !generationWindow.IsVisible); }

        var changing = new FakeSession(root) { Binding = generationOld.Binding }; ExplorerPreviewWindow changingWindow = null!; var drainRejected = false;
        changingWindow = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, changing,
            new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), async _ => {
                var expected = await changingWindow.GetVerifiedUpdateBindingAsync();
                changing.Binding = changing.Binding with { Generation = pin with { SelectorRevision = pin.SelectorRevision + 1 } };
                try { await changingWindow.DrainForUpdateAsync(expected); } catch (IOException) { drainRejected = true; }
                return new(ExeUpdateHandoffStatus.PreparationFailed, false);
            }), FakeBinding);
        try {
            await changingWindow.StartPreviewAsync(); await changingWindow.CheckForUpdatesAsync(); await changingWindow.InstallUpdateAsync();
            True(drainRejected && changing.Disposals == 0 && changing.Removals == 0, "changed generation before drain is refused before provider disposal");
        } finally { changingWindow.Quit(); await Until(() => !changingWindow.IsVisible); }
        var invalidOwner = new FakeSession(root) { Binding = generationOld.Binding with { Generation = pin with { ManifestDigest = "invalid" } } };
        var invalidWindow = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, invalidOwner, binding: FakeBinding);
        try {
            await invalidWindow.StartPreviewAsync();
            try { _ = await invalidWindow.GetVerifiedUpdateBindingAsync(); throw new InvalidOperationException("Invalid generation pin was accepted."); }
            catch (IOException) { }
        } finally { invalidWindow.Quit(); await Until(() => !invalidWindow.IsVisible); }

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

        // Uncertainty may arise before the connected session is drained. Even
        // with a running provider and tray, startup must not hide the warning.
        var stillRunning = new FakeSession(root);
        var visibleUncertain = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, stillRunning,
            new("0.5.2.0", _ => Task.FromResult(AvailableUpdate()), _ => Task.FromResult(new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.RecoveryBlocked, true))), FakeBinding);
        try {
            await visibleUncertain.StartPreviewAsync(); await visibleUncertain.CheckForUpdatesAsync(); await visibleUncertain.InstallUpdateAsync();
            True(stillRunning.State == ExplorerPreviewState.Running && visibleUncertain.UpdateMaintenanceOwned, "synthetic uncertainty retains the running provider");
            visibleUncertain.HideAfterWindowsStartup();
            True(visibleUncertain.IsVisible, "uncertain update remains visible after Windows startup");
        } finally { CloseFakeUpdateWindow(visibleUncertain); }

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
            await window.SetStartupActionsAsync(new(_ => Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Available, true, "employee")),
                (_, _) => throw new InvalidOperationException("Reading an applied default must not trigger another toggle.")));
            True(window.WindowsStartupCheckBox.IsEnabled && window.WindowsStartupCheckBox.IsChecked == true,
                "verified installed default appears checked without a recursive checkbox write");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root));
        try {
            await window.SetStartupActionsAsync(new(_ => Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Conflict)),
                (_, _) => throw new InvalidOperationException("Foreign startup data cannot be changed.")));
            True(!window.WindowsStartupCheckBox.IsEnabled && Labels(window).Contains("kept unchanged"), "foreign startup values remain visible and disabled");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }
        // An intervening user action can acquire the window operation after
        // reconnect completes but before startup setup resumes.
        var actionGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var intervening = new FakeSession(root) { StartGate = actionGate };
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, intervening);
        var action = window.StartPreviewAsync();
        var startupReads = 0;
        var deferred = window.InitializeStartupWhenIdleAsync(new(_ => { startupReads++; return Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Available)); },
            (_, _) => throw new InvalidOperationException()));
        True(!deferred.IsCompleted && startupReads == 0, "startup initialization waits for an intervening operation");
        actionGate.TrySetResult(); await action; await deferred;
        True(startupReads == 1 && window.WindowsStartupCheckBox.IsEnabled, "startup initialization resumes after the intervening action");
        window.Quit(); await Until(() => !window.IsVisible);
        var quitGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var quitSession = new FakeSession(root) { StartGate = quitGate };
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, quitSession);
        action = window.StartPreviewAsync(); startupReads = 0;
        deferred = window.InitializeStartupWhenIdleAsync(new(_ => { startupReads++; return Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Available)); },
            (_, _) => throw new InvalidOperationException()));
        window.Quit(); await action; await deferred; await Until(() => !window.IsVisible);
        True(startupReads == 0, "quitting while an action is active skips deferred startup initialization");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, new FakeSession(root));
        var loading = window.SetStartupActionsAsync(new(token => WindowsStartupStaleRepair.BeforeStartupReadAsync(async cancellation => {
            entered.TrySetResult(); await Task.Delay(Timeout.Infinite, cancellation);
        }, () => Task.FromResult(new WindowsStartupState(WindowsStartupAvailability.Available)), token),
            (_, _) => throw new InvalidOperationException()));
        await entered.Task; True(window.IsVisible, "window remains responsive while startup repair waits");
        window.Quit(); await loading; await Until(() => !window.IsVisible);
        True(writes.Count == 2, "Quit cancels and joins background startup repair without new writes");
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

        await ScheduleAfterFailedQuit();

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

    internal static async Task ScheduleAfterFailedQuit()
    {
        var root = Path.Combine(Path.GetTempPath(), "ltfiles-stopped-schedule-" + Guid.NewGuid().ToString("N"));
        var content = ExplorerWindowContent.Connected("Pilot", AccessMode.Employee);
        var now = new DateTimeOffset(2026, 10, 26, 0, 0, 0, TimeSpan.Zero);
        var refusing = new FakeSession(root) { RefuseFirstDispose = true };
        var stoppedStore = ExplorerUpdateScheduleSettingsStore.CreateForTests(Path.Combine(root, "schedule-failed-quit"));
        var stoppedChecks = 0;
        var window = Window(() => throw new InvalidOperationException(), new FakeTrayIcon(), content, refusing,
            new("0.5.2.0", _ => { stoppedChecks++; return Task.FromResult(AvailableUpdate()); },
                _ => throw new InvalidOperationException("Stopped schedule must not install.")), FakeBinding);
        try {
            window.ConfigureUpdateSchedule(stoppedStore, () => now, TimeSpan.Zero, runTimer: false);
            await window.StartPreviewAsync();
            True(window.AutomaticUpdatesCheckBox.IsEnabled && window.AutomaticUpdatesCheckBox.IsChecked == true, "configured automatic updates are initially enabled");
            window.Quit();
            await Until(() => window.DetailText.Contains("couldn't stop safely", StringComparison.Ordinal));
            var status = (System.Windows.Controls.TextBlock)typeof(ExplorerPreviewWindow).GetField("automaticUpdateStatus", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
            True(window.IsVisible && !window.AutomaticUpdatesCheckBox.IsEnabled && status.Text.Contains("checks are stopped", StringComparison.Ordinal), "failed quit exposes the stopped schedule instead of promising checks");
            now += TimeSpan.FromHours(8); await window.TickUpdateScheduleAsync();
            True(stoppedChecks == 0 && stoppedStore.Load().Settings.AutoUpdatesEnabled, "stopped schedule does not check and preserves saved preference");
        } finally { window.Quit(); await Until(() => !window.IsVisible); }

    }

    private static void CloseFakeUpdateWindow(ExplorerPreviewWindow window)
    {
        // Teardown ONLY after a completed, pure fake update. No actual helper exists; production
        // intentionally has no user action that clears an uncertain handoff's ownership guard.
        typeof(ExplorerPreviewWindow).GetField("readyToClose", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, true);
        window.Close();
    }

    internal static async Task ProductCopyOnQuitFailure()
    {
        foreach (var generated in new[] { true, false }) {
            var presentation = generated ? ExplorerWindowContent.Demo : ExplorerWindowContent.Connected("Pilot", AccessMode.Employee);
            var empty = Window(() => throw new InvalidOperationException("Unexpected start."), new FakeTrayIcon(), presentation);
            var emptyClosed = false; empty.Closed += (_, _) => emptyClosed = true;
            try {
                var location = (System.Windows.Controls.TextBlock)typeof(ExplorerPreviewWindow).GetField("location", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(empty)!;
                True(location.Text == (generated ? "A dedicated local preview folder will be shown here after you start." : "Your files folder will be shown here after you connect."), "empty location matches app mode");
            } finally { empty.Quit(); await Until(() => emptyClosed); }
            var refusing = new FakeSession(Path.GetTempPath()) { RefuseFirstDispose = true };
            var window = Window(() => throw new InvalidOperationException("Unexpected start."), new FakeTrayIcon(), presentation, refusing);
            var closed = false; window.Closed += (_, _) => closed = true;
            try {
                window.Quit();
                await Until(() => window.StatusText == (generated ? "Preview needs attention" : "Connection needs attention"));
                var expected = generated ? "The preview couldn't stop safely. Keep the app open and try quitting again." : "LedgeTop Files couldn't stop safely. Keep the app open and try quitting again.";
                True(window.IsVisible && !closed && window.DetailText == expected && refusing.Disposals == 1, "failed quit uses accurate product copy and keeps retry available");
                window.Quit(); await Until(() => closed);
                True(refusing.Disposals == 2, "retry drains the same session");
            } finally { window.Quit(); await Until(() => closed); }
        }
    }
    internal static async Task ConnectedTrayOnly()
    {
        var session = new FakeSession(Path.GetTempPath()) { SavedReady = true, ReconnectPaused = true };
        Func<IReadOnlyList<TrayAction>>? actions = null;
        var tray = new FakeTrayIcon();
        var window = Window(() => throw new InvalidOperationException("Unexpected replacement session."), tray,
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session, captureTray: value => actions = value);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            void CheckStatus(string expected) {
                True(window.StatusText == expected, "settings shows expected status");
                True(tray.LastStatus == "LedgeTop Files · " + expected, "tray tooltip shows readable status");
                True(actions is not null && actions().Any(action => action.Label == expected && !action.Enabled), "tray menu shows readable status");
            }
            CheckStatus("Connect files in File Explorer");
            await window.ReconnectPreviewAsync();
            CheckStatus("Downloads are paused");
            await window.ResumePreviewAsync();
            CheckStatus("Your files are ready");
        } finally { window.Quit(); await Until(() => closed); }
    }

    internal static Task RetiredPackagedProfileHold()
    {
        var profile = ReleaseProfiles.For(ReleaseChannel.Pilot) ?? throw new InvalidOperationException("Pilot profile is unavailable.");
        True(profile.StaffApplicationUrl is not null && RetiredStagingSource.IsHeld(true, profile.Channel, profile.StaffApplicationUrl),
            "the packaged employee profile including its path must remain held");
        True(RetiredStagingSource.IsHeld(true, profile.Channel, profile.PortalApplicationUrl),
            "the packaged client profile including its path must remain held");
        True(RetiredStagingSource.IsHeld(true, ReleaseChannel.Pilot, new Uri("https://OPS-STAGING.LEDGETOPDRONESERVICES.COM:443/api/staff/files")),
            "case and explicit HTTPS default port must not bypass the retired-origin hold");
        True(!RetiredStagingSource.IsHeld(true, ReleaseChannel.Pilot, new Uri("https://ops-staging.ledgetopdroneservices.com.example.invalid/api/staff/files")),
            "a lookalike hostname must not be mistaken for the exact old host");
        return Task.CompletedTask;
    }

    internal static async Task RetiredSourceHold()
    {
        var employee = new Uri("https://ops-staging.ledgetopdroneservices.com");
        var portal = new Uri("https://portal-staging.ledgetopdroneservices.com");
        True(RetiredStagingSource.IsHeld(true, ReleaseChannel.Pilot, employee) && RetiredStagingSource.IsHeld(true, ReleaseChannel.Pilot, portal), "both retired pilot sources are held");
        True(!RetiredStagingSource.IsHeld(false, ReleaseChannel.Pilot, employee) && !RetiredStagingSource.IsHeld(true, ReleaseChannel.Stable, employee) &&
            !RetiredStagingSource.IsHeld(true, ReleaseChannel.Pilot, new Uri("https://ops-staging.ledgetopdroneservices.com.example.com")) &&
            !RetiredStagingSource.IsHeld(true, ReleaseChannel.Pilot, new Uri("https://example.com")), "developer, stable and other hosts are not held");
        True(!App.ShouldAutoReconnect(true, true) && App.ShouldAutoReconnect(true, false) && !App.ShouldAutoReconnect(false, false), "held startup never invokes cached reconnect");
        var root = Path.Combine(Path.GetTempPath(), "ltfiles-retired-hold-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var local = Path.Combine(root, "local.txt"); File.WriteAllText(local, "preserve");
        var calls = 0;
        var session = new ConnectedExplorerSession(() => { calls++; throw new InvalidOperationException("backend must not be created"); },
            "pilot", "employee", employee, Path.Combine(root, "state"), root, sourceUnavailable: true);
        Func<IReadOnlyList<TrayAction>>? trayActions = null;
        var window = Window(() => throw new InvalidOperationException("factory must not be called"), new FakeTrayIcon(),
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session, captureTray: actions => trayActions = actions);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            True(window.StatusText == "Staging connection unavailable" && window.DetailText == RetiredStagingSource.Message,
                "settings explains the source hold");
            True(trayActions is not null && trayActions().Any(action => action.Label == "Staging connection unavailable"), "tray reports the same unavailable status");
            True(!window.StartButton.IsEnabled && !window.ReconnectButton.IsEnabled && window.OpenFolderButton.IsEnabled && window.RemoveButton.IsEnabled,
                "connection actions disabled while local folder and removal remain available");
            await window.StartPreviewAsync(); await window.ReconnectPreviewAsync(); await window.TickSessionCheckAsync();
            foreach (var operation in new Func<Task>[] { session.StartAsync, session.ReconnectCachedAsync, () => session.ComposeColdFreshRestartAsync(false, CancellationToken.None), () => session.StartFreshReadOnlyConnectionAsync(CancellationToken.None) }) {
                try { await operation(); throw new InvalidOperationException("held operation unexpectedly succeeded"); }
                catch (IOException error) when (error.Message == RetiredStagingSource.Message) { }
            }
            True(calls == 0 && !Directory.Exists(Path.Combine(root, "state")) && File.ReadAllText(local) == "preserve", "held operations do not create a backend or change local files");
        } finally {
            window.Quit(); await Until(() => closed);
            File.Delete(local); Directory.Delete(root);
        }
    }

    internal static async Task AssertHeldFreshFolder(ConnectedExplorerSession session, string expectedRoot, Action invalidateSelector, Action malformedSelector)
    {
        var launcher = new RecordingFolderLauncher();
        var window = Window(() => throw new InvalidOperationException("factory must not be called"), new FakeTrayIcon(),
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session, folderLauncher: launcher);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            True(window.OpenFolderButton.IsEnabled && window.StatusText == "Staging connection unavailable", "held fresh folder is available in Settings");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(launcher.Path == expectedRoot, "Open files folder targets the published generation");
            invalidateSelector();
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(launcher.Calls == 1 && session.RootPath == "", "a selector changed before the next click does not open a stale folder");
            malformedSelector();
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(launcher.Calls == 1 && session.RootPath == "", "a malformed selector does not open a stale folder or throw");
        } finally { window.Quit(); await Until(() => closed); }
    }

    internal static async Task AssertNoHeldFolder(ConnectedExplorerSession session)
    {
        var launcher = new RecordingFolderLauncher();
        var window = Window(() => throw new InvalidOperationException("factory must not be called"), new FakeTrayIcon(),
            ExplorerWindowContent.Connected("Pilot", AccessMode.Employee), session, folderLauncher: launcher);
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            True(!window.OpenFolderButton.IsEnabled, "unconfirmed folder is disabled in Settings");
            window.OpenFolderButton.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            True(launcher.Calls == 0, "unconfirmed folder is not opened");
        } finally { window.Quit(); await Until(() => closed); }
    }

    private sealed class RecordingFolderLauncher : IBackgroundFolderLauncher
    {
        internal string? Path;
        internal int Calls;
        internal Func<bool>? Validate;
        internal Action<bool>? Completion;
        internal bool Defer;
        public bool TryOpen(string path, Action<bool> completed, Func<bool>? validate = null) { Calls++; Path = path; Validate = validate; Completion = completed; if (!Defer) completed(true); return true; }
        public void Dispose() { }
    }

    private static ExplorerPreviewWindow Window(Func<Task<IExplorerPreviewSession>> factory, FakeTrayIcon tray,
        ExplorerWindowContent? presentation = null, IExplorerPreviewSession? prepared = null, ExplorerUpdateActions? updates = null,
        Func<IExplorerPreviewSession, CancellationToken, Task<ConnectedExplorerUpdateBinding>>? binding = null, FreshFolderUiTestActions? fresh = null,
        string? setupProblem = null, Action<Func<IReadOnlyList<TrayAction>>>? captureTray = null, IBackgroundFolderLauncher? folderLauncher = null)
    {
        var window = new ExplorerPreviewWindow(factory, actions => { captureTray?.Invoke(actions); return tray; }, presentation, prepared, setupProblem: setupProblem, readUpdateBindingForTests: binding, freshFolderForTests: fresh, folderLauncher: folderLauncher) { ShowInTaskbar = false, Left = -20000, Top = -20000,
            WindowStartupLocation = WindowStartupLocation.Manual };
        if (updates is not null) window.SetUpdateActions(updates);
        window.Show(); Pump(); return window;
    }
    private sealed class FailingFolderLauncher : IBackgroundFolderLauncher {
        internal bool Accept = true; internal readonly List<Action<bool>> Completions = [];
        public bool TryOpen(string path, Action<bool> completed, Func<bool>? validate = null) { if (!Accept) return false; Completions.Add(completed); return true; }
        public void Dispose() { }
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
    private static string FirstVisibleActivity(System.Windows.Controls.ListBox list,System.Windows.Controls.ScrollViewer scroller) {
        foreach(var row in list.Items) if(list.ItemContainerGenerator.ContainerFromItem(row) is FrameworkElement item && item.IsVisible) {
            var y=item.TransformToAncestor(scroller).Transform(new Point(0,0)).Y; if(y+item.ActualHeight>0) return row.ToString() ?? "";
        }
        return "";
    }
    private static T? FindVisual<T>(DependencyObject parent) where T : DependencyObject {
        for(var i=0;i<System.Windows.Media.VisualTreeHelper.GetChildrenCount(parent);i++) {var child=System.Windows.Media.VisualTreeHelper.GetChild(parent,i); if(child is T found)return found; if(FindVisual<T>(child) is { } nested)return nested;} return null;
    }
    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, () => frame.Continue = false); Dispatcher.PushFrame(frame); }
    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (!condition()) { if (DateTime.UtcNow > deadline) throw new TimeoutException("Preview window lifecycle did not settle."); await Task.Delay(20); Pump(); }
    }
    private static void True(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    internal static async Task ActivityOrderingAndRetention()
    {
        var root = Path.GetTempPath();
        var session = new FakeSession(root);
        var window = Window(() => Task.FromResult<IExplorerPreviewSession>(session), new FakeTrayIcon(),
            prepared: session, setupProblem: "Earlier window issue");
        var closed = false; window.Closed += (_, _) => closed = true;
        try {
            session.MarkFailed();
            var initialLines=window.ActivityLines;
            True(initialLines.Contains("Earlier window issue") && initialLines.Contains("Synthetic failed session.") &&
                Array.IndexOf(initialLines.ToArray(), "Earlier window issue") < Array.IndexOf(initialLines.ToArray(), "Synthetic failed session."),
                "a later session event must follow an earlier window event");
            window.Pages.SelectedIndex=1; Pump();
            for(var i=0;i<80;i++) session.EmitActivity("scroll row " + i);
            Pump();
            var list=(System.Windows.Controls.ListBox)typeof(ExplorerPreviewWindow).GetField("activity",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.GetValue(window)!;
            var scroller=FindVisual<System.Windows.Controls.ScrollViewer>(list) ?? throw new InvalidOperationException("Activity scroll viewer missing");
            True(scroller.ScrollableHeight>100,"realized activity content scrolls");
            list.SelectedIndex=35; scroller.ScrollToVerticalOffset(scroller.ScrollableHeight/2); Pump();
            var selectedBefore=list.SelectedItem!.ToString(); var beforeOffset=scroller.VerticalOffset;
            session.EmitActivity("new event while reading"); Pump();
            True(list.SelectedItem?.ToString()==selectedBefore && Math.Abs(scroller.VerticalOffset-beforeOffset)<2,"selection and reading position survive update");
            scroller.ScrollToEnd(); Pump(); session.EmitActivity("new event at bottom"); Pump();
            True(scroller.ScrollableHeight-scroller.VerticalOffset<2,"activity follows bottom only when already there");
            scroller.ScrollToVerticalOffset(20); Pump();
            for(var i=0;i<100;i++) session.EmitActivity("evict " + i);
            Pump();
            var top=FirstVisibleActivity(list,scroller);
            True(top.Contains("evict 0",StringComparison.Ordinal),"evicted anchor selects nearest surviving later row");
            list.SelectedIndex=20; var sessionField=typeof(ExplorerPreviewWindow).GetField("session",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!;
            var refresh=typeof(ExplorerPreviewWindow).GetMethod("Refresh",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!;
            var replacement=new FakeSession(root); sessionField.SetValue(window,replacement); refresh.Invoke(window,null); Pump();
            True(list.SelectedItem is null,"selection must not cross session replacement");
            replacement.OverrideActivity=[new ActivityEntry(long.MaxValue-1,"duplicate one"),new ActivityEntry(long.MaxValue-1,"duplicate two")]; refresh.Invoke(window,null); Pump();
            list.SelectedIndex=list.Items.Count-2;
            replacement.OverrideActivity=[new ActivityEntry(long.MaxValue-1,"duplicate one changed"),new ActivityEntry(long.MaxValue-1,"duplicate two")]; refresh.Invoke(window,null); Pump();
            True(list.SelectedItem is null,"ambiguous sequence must not restore wrong selection");
            sessionField.SetValue(window,session); refresh.Invoke(window,null); Pump();
            session.MarkFailed();
            var lines = window.ActivityLines;

            var local = (OrderedActivity)typeof(ExplorerPreviewWindow).GetField("localActivity",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(window)!;
            for (var i = 0; i < 150; i++) local.Add("window " + i);
            session.MarkFailed();
            lines = window.ActivityLines;
            True(lines.Count == 100 && lines[^1] == "Synthetic failed session." && !lines.Contains("window 0"),
                "bounded local history must not hide newer session events");
        } finally { window.Quit(); await Until(() => closed); }
    }

    internal static async Task ActivityIncrementalEdges() {
        var root=Path.GetTempPath(); var session=new FakeSession(root);
        var window=Window(()=>Task.FromResult<IExplorerPreviewSession>(session),new FakeTrayIcon(),prepared:session);
        var closed=false; window.Closed+=(_,_)=>closed=true;
        try {
            window.Pages.SelectedIndex=1; Pump();
            var list=(System.Windows.Controls.ListBox)typeof(ExplorerPreviewWindow).GetField("activity",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.GetValue(window)!;
            var refresh=typeof(ExplorerPreviewWindow).GetMethod("Refresh",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!;
            void Update(params ActivityEntry[] entries) {session.OverrideActivity=entries;refresh.Invoke(window,null);Pump();}
            Update(new ActivityEntry(1000,"old text")); list.SelectedIndex=0;
            Update(new ActivityEntry(1000,"retained text")); True(list.SelectedItem?.ToString()?.Contains("retained text",StringComparison.Ordinal)==true,"same sequence text transition preserves selection");
            Update(new ActivityEntry(2000,"identical"),new ActivityEntry(2000,"identical")); list.SelectedIndex=0;
            Update(new ActivityEntry(2000,"identical"),new ActivityEntry(2000,"identical"),new ActivityEntry(2001,"additional"));
            True(list.SelectedItem is null,"identical duplicate identities never restore selection");
            Update(Enumerable.Range(0,100).Select(i=>new ActivityEntry(3000+i,"old "+i)).ToArray());
            var scroller=FindVisual<System.Windows.Controls.ScrollViewer>(list)!; scroller.ScrollToVerticalOffset(scroller.ScrollableHeight/2); list.SelectedIndex=40; Pump();
            Update(Enumerable.Range(0,100).Select(i=>new ActivityEntry(4000+i,"new "+i)).ToArray());
            True(list.SelectedItem is null && list.Items.Count==100 && scroller.VerticalOffset>=0 && scroller.VerticalOffset<=scroller.ScrollableHeight,"all evicted anchors do not restore stale selection");
            window.Pages.SelectedIndex=0; Pump(); Update(new ActivityEntry(5000,"hidden update")); window.Pages.SelectedIndex=1; Pump();
            True(list.Items.Count==1 && list.Items[0].ToString()!.Contains("hidden update",StringComparison.Ordinal),"hidden updates render when visible");
            var replacement=new FakeSession(root) { OverrideActivity=[new ActivityEntry(6000,"replacement event")] };
            session.OverrideActivity=null;
            Task.Run(()=>session.EmitActivity("late old session event")).GetAwaiter().GetResult();
            typeof(ExplorerPreviewWindow).GetField("session",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic)!.SetValue(window,replacement);
            refresh.Invoke(window,null); Pump();
            True(window.ActivityLines.Contains("replacement event") && !window.ActivityLines.Contains("late old session event"),"queued old-session refresh reads current session");
        } finally { window.Quit(); await Until(()=>closed); }
    }
    private sealed class FakeSession(string root) : IExplorerPreviewSession, ICachedExplorerReconnect, IAvailabilityRetry, IOrderedActivitySource
    {
        internal int Starts, Pauses, Resumes, Removals, Disposals;
        internal int Reconnects;
        internal int Retries;
        internal TaskCompletionSource? RetryGate;
        internal bool SavedReady, ReconnectPaused;
        internal ConnectedExplorerUpdateBinding Binding = new("pilot", "employee", "odqp1_" + new string('1', 64));
        internal int DisposeThread;
        internal bool RefuseFirstDispose;
        internal ManualResetEventSlim? DisposeGate;
        internal TaskCompletionSource? StartGate;
        internal TaskCompletionSource DisposeEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly OrderedActivity activity = new();
        private string rootPath = root;
        internal int RootReads;
        internal Queue<string>? RootSequence;
        public string RootPath { get { RootReads++; return RootSequence is { Count: > 0 } ? RootSequence.Dequeue() : rootPath; } }
        internal void SetRoot(string next) { rootPath = next; Changed?.Invoke(this, EventArgs.Empty); }
        public ExplorerPreviewState State { get; private set; }
        internal IReadOnlyList<ActivityEntry>? OverrideActivity;
        public IReadOnlyList<ActivityEntry> ActivityEntries => OverrideActivity ?? activity.Snapshot();
        public IReadOnlyList<string> Activity => ActivityEntries.Select(entry => entry.Text).ToArray();
        public event EventHandler? Changed;
        public bool CanReconnectCached => SavedReady && State == ExplorerPreviewState.NotStarted;
        public bool CanRetryAvailability => State == ExplorerPreviewState.Running;
        public async Task RetryAvailabilityAsync() { Retries++; if (RetryGate is { } gate) await gate.Task; }
        public async Task ReconnectCachedAsync() { Reconnects++; if (StartGate is { } gate) await gate.Task; Set(ReconnectPaused ? ExplorerPreviewState.Paused : ExplorerPreviewState.Running, "Saved files reconnected with cached authorization."); }
        public async Task StartAsync() { Starts++; if (StartGate is { } gate) await gate.Task; Set(ExplorerPreviewState.Running, "Generated sample files are ready in Explorer."); }
        public Task PauseAsync() { Pauses++; Set(ExplorerPreviewState.Paused, "Preview downloads paused."); return Task.CompletedTask; }
        public Task ResumeAsync() { Resumes++; Set(ExplorerPreviewState.Running, "Preview downloads resumed."); return Task.CompletedTask; }
        public Task RemoveAsync() { Removals++; Set(ExplorerPreviewState.Removed, "Explorer registration removed. Local files kept."); return Task.CompletedTask; }
        internal void EmitActivity(string message) { activity.Add(message); Changed?.Invoke(this, EventArgs.Empty); }
        internal void MarkFailed() => Set(ExplorerPreviewState.Failed, "Synthetic failed session.");
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


