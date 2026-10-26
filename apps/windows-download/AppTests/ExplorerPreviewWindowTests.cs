using System.Reflection;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;

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

    private static ExplorerPreviewWindow Window(Func<Task<IExplorerPreviewSession>> factory, FakeTrayIcon tray,
        ExplorerWindowContent? presentation = null, IExplorerPreviewSession? prepared = null)
    {
        var window = new ExplorerPreviewWindow(factory, _ => tray, presentation, prepared) { ShowInTaskbar = false, Left = -20000, Top = -20000,
            WindowStartupLocation = WindowStartupLocation.Manual };
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
