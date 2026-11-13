using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using LedgeTop.Files;
using LedgeTop.Files.Explorer;

internal static class BackgroundFolderLauncherTests
{
    internal static int ExitHelper(string[] args)
    {
        if (args.Length != 1) return 90;
        // Intentionally not disposed/released by the main thread: the worker must stay in this
        // finite fake shell call through helper return. Process exit itself releases these resources.
        var release = new ManualResetEventSlim(false);
        using var started = new ManualResetEventSlim(false);
        using var launcher = new BackgroundFolderLauncher(_ => { started.Set(); release.Wait(TimeSpan.FromSeconds(10)); });
        if (!launcher.TryOpen("fake-shell-path", () => { }) || !started.Wait(TimeSpan.FromSeconds(3))) return 91;
        Console.WriteLine("BLOCKED"); Console.Out.Flush();
        launcher.Dispose();
        return 0; // Do not release the fake shell call. A foreground-worker regression naturally takes ten seconds.
    }

    internal static async Task Run(string outputDirectory)
    {
        var folder = Path.Combine(Path.GetTempPath(), "LedgeTop, QA folder");
        var launch = BackgroundFolderLauncher.ExplorerStartInfo(folder);
        Require(launch.FileName == Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe") &&
            !launch.UseShellExecute && launch.Arguments == "\"" + folder + "\"", "Windows Explorer receives one explicitly quoted folder argument");
        var boundary = @"C:\" + new string('x', 120) + "\\" + new string('y', 135);
        Require(boundary.Length == 259 && BackgroundFolderLauncher.ExplorerStartInfo(boundary).Arguments == "\"" + boundary + "\"", "259-character local path is passed intact");
        try { _ = BackgroundFolderLauncher.ExplorerStartInfo(boundary + "x"); throw new InvalidOperationException("Unopenable long Explorer path was accepted."); }
        catch (ArgumentException) { }
        var unicodeBoundary = @"C:\" + new string('x', 120) + "\\" + new string('y', 133) + "😀";
        Require(unicodeBoundary.Length == 259 && BackgroundFolderLauncher.ExplorerStartInfo(unicodeBoundary).Arguments == "\"" + unicodeBoundary + "\"", "surrogate pair counts as two UTF-16 units at 259 boundary");
        try { _ = BackgroundFolderLauncher.ExplorerStartInfo(unicodeBoundary + "x"); throw new InvalidOperationException("260-unit Unicode path was accepted."); }
        catch (ArgumentException) { }
        var longPathFailed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var longPathLauncher = new BackgroundFolderLauncher()) {
            Require(longPathLauncher.TryOpen(boundary + "x", () => longPathFailed.TrySetResult()), "long path request reaches worker");
            await longPathFailed.Task.WaitAsync(TimeSpan.FromSeconds(3));
        }
        foreach (var invalid in new[] { "relative", @"\\server\share", folder + "\\", folder + "\" --bad", folder + "%bad", folder + "\\..\\other" }) {
            try { _ = BackgroundFolderLauncher.ExplorerStartInfo(invalid); throw new InvalidOperationException("Unsafe folder argument was accepted."); }
            catch (ArgumentException) { }
        }
        await NaturalProcessExit();
        var output = Path.GetFullPath(outputDirectory); Directory.CreateDirectory(output);
        var root = Path.Combine(output, "shell-worker-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            using var release = new ManualResetEventSlim(false);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var returned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var calls = 0; var workerBackground = false; var apartment = ApartmentState.Unknown;
            using var launcher = new BackgroundFolderLauncher(_ => {
                Interlocked.Increment(ref calls); workerBackground = Thread.CurrentThread.IsBackground;
                apartment = Thread.CurrentThread.GetApartmentState(); entered.TrySetResult();
                try { if (!release.Wait(TimeSpan.FromSeconds(8))) throw new TimeoutException("Bounded synthetic shell wait expired."); }
                finally { returned.TrySetResult(); }
            });
            var service = new Session(root); var tray = new FakeTrayIcon();
            var window = Create(service, tray, launcher); var closed = false; window.Closed += (_, _) => closed = true;
            try {
                await window.StartPreviewAsync();
                var clock = Stopwatch.StartNew(); Click(window.OpenFolderButton); clock.Stop();
                Require(clock.Elapsed < TimeSpan.FromSeconds(1), "Open click returns without waiting for Windows Shell");
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
                Click(window.OpenFolderButton); Click(window.OpenFolderButton);
                Require(calls == 1 && workerBackground && apartment == ApartmentState.STA,
                    "repeated clicks coalesce onto one background STA worker while Shell is blocked");
                var heartbeat = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                _ = Dispatcher.CurrentDispatcher.BeginInvoke(() => heartbeat.TrySetResult());
                await heartbeat.Task.WaitAsync(TimeSpan.FromSeconds(2));
                window.Quit(); await Until(() => closed);
                Require(!returned.Task.IsCompleted && service.Disposals == 1 && tray.Disposals == 1,
                    "Quit drains provider and tray and closes while shell worker remains blocked");
                Require(!launcher.TryOpen(root, () => throw new InvalidOperationException()), "closed window rejects new shell work");
            } finally { release.Set(); window.Quit(); await returned.Task.WaitAsync(TimeSpan.FromSeconds(3)); }

            using var failure = new BackgroundFolderLauncher(_ => throw new IOException("private failure text"));
            var failedService = new Session(root); var failedWindow = Create(failedService, new FakeTrayIcon(), failure);
            var failedClosed = false; failedWindow.Closed += (_, _) => failedClosed = true;
            try {
                await failedWindow.StartPreviewAsync(); Click(failedWindow.OpenFolderButton);
                await Until(() => failedWindow.StatusText == "Preview needs attention");
                Require(failedWindow.IsVisible && failedService.Disposals == 0, "worker failure posts safe UI status without ending provider ownership");
            } finally { failedWindow.Quit(); await Until(() => failedClosed); }

            var deep = root;
            while (deep.Length < 260) {
                var remaining = 260 - deep.Length;
                // A separator and at least one character are required for each component.
                deep = Path.Combine(deep, new string('a', Math.Min(100, Math.Max(1, remaining - 1))));
            }
            Require(deep.Length >= 260 && deep.Length <= 261, "test path crosses the Explorer limit regardless of test root length");
            Directory.CreateDirectory(deep);
            var blockedLauncher = new DeferredLauncher();
            var longWindow = Create(new Session(deep), new FakeTrayIcon(), blockedLauncher);
            var longClosed = false; longWindow.Closed += (_, _) => longClosed = true;
            try {
                await longWindow.StartPreviewAsync(); Click(longWindow.OpenFolderButton);
                await Until(() => longWindow.StatusText == "Preview needs attention");
                var detailField = typeof(ExplorerPreviewWindow).GetField("detail", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
                var detail = ((TextBlock)detailField.GetValue(longWindow)!).Text;
                Require(blockedLauncher.Failed is null && detail.Contains("too long") && detail.Contains("shorter folder path") && detail.Contains("Keep your existing files"), "long path displays actionable safe guidance without launching Explorer");
            } finally { longWindow.Quit(); await Until(() => longClosed); }

            var deferred = new DeferredLauncher(); var lateService = new Session(root);
            var lateWindow = Create(lateService, new FakeTrayIcon(), deferred); var lateClosed = false;
            lateWindow.Closed += (_, _) => lateClosed = true;
            await lateWindow.StartPreviewAsync(); Click(lateWindow.OpenFolderButton);
            lateWindow.Quit(); await Until(() => lateClosed);
            var status = lateWindow.StatusText;
            await Task.Run(() => deferred.Failed!()); await Dispatcher.Yield(DispatcherPriority.Background);
            Require(lateWindow.StatusText == status && !lateWindow.IsVisible && deferred.Disposed,
                "late worker failure after closing never revives or changes the window");
        } finally {
            var full = Path.GetFullPath(root);
            if (!full.StartsWith(Path.TrimEndingDirectorySeparator(output) + Path.DirectorySeparatorChar + "shell-worker-", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Refusing unexpected shell test cleanup path.");
            Directory.Delete(full, true);
        }
        Console.WriteLine("Folder launcher: blocked Shell is coalesced on one background STA, dispatcher/Quit stay responsive, child exits naturally while blocked, failures respect window lifetime. No actual shell launch.");
    }

    private static async Task NaturalProcessExit()
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Test host unavailable.");
        var start = new ProcessStartInfo(executable) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        start.ArgumentList.Add("--folder-launcher-exit-helper");
        var clock = Stopwatch.StartNew();
        using var child = Process.Start(start) ?? throw new InvalidOperationException("Could not start shell exit proof.");
        var errors = child.StandardError.ReadToEndAsync();
        var marker = await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
        // Never kill the child on regression: its fake wait is bounded to ten seconds and Dispose
        // has already signaled worker shutdown, so a foreground worker can finish naturally.
        await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(14));
        var error = await errors;
        Require(marker == "BLOCKED" && child.ExitCode == 0 && error.Length == 0, "exit helper reached and retained its blocked fake shell call");
        Require(clock.Elapsed < TimeSpan.FromSeconds(3), "background worker must not retain the process for its ten-second blocked shell action");
        Console.WriteLine($"Blocked shell child exited naturally in {clock.ElapsedMilliseconds}ms; no forced termination.");
    }

    private static ExplorerPreviewWindow Create(Session service, FakeTrayIcon tray, IBackgroundFolderLauncher launcher)
    {
        var window = new ExplorerPreviewWindow(() => Task.FromResult<IExplorerPreviewSession>(service), _ => tray, folderLauncher: launcher) {
            ShowInTaskbar = false, Left = -20000, Top = -20000, WindowStartupLocation = WindowStartupLocation.Manual
        };
        window.Show(); return window;
    }
    private static void Click(Button button) => button.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(4);
        while (!condition()) { if (DateTime.UtcNow > deadline) throw new TimeoutException("Shell lifecycle did not settle."); await Task.Delay(10); }
    }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class DeferredLauncher : IBackgroundFolderLauncher
    {
        internal Action? Failed; internal bool Disposed;
        public bool TryOpen(string path, Action<bool> completed, Func<bool>? validate = null) { Failed = () => completed(false); return true; }
        public void Dispose() => Disposed = true;
    }
    private sealed class Session(string root) : IExplorerPreviewSession
    {
        internal int Disposals;
        public string RootPath => root;
        public ExplorerPreviewState State { get; private set; }
        public IReadOnlyList<string> Activity => [];
        public event EventHandler? Changed { add { } remove { } }
        public Task StartAsync() { State = ExplorerPreviewState.Running; return Task.CompletedTask; }
        public Task PauseAsync() { State = ExplorerPreviewState.Paused; return Task.CompletedTask; }
        public Task ResumeAsync() { State = ExplorerPreviewState.Running; return Task.CompletedTask; }
        public Task RemoveAsync() { State = ExplorerPreviewState.Removed; return Task.CompletedTask; }
        public ValueTask DisposeAsync() { Disposals++; return ValueTask.CompletedTask; }
    }
}
