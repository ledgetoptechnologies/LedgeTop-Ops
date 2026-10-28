using System.Windows;
using System.Reflection;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

public partial class App : Application
{
    private SingleInstance? instance;
    private bool restorePending;
    // Retain uncertain helper/fence ownership for the lifetime of this process.
    private ExplorerInstalledUpdateController? updateController;

    // ReleaseProfiles rejects mixed/duplicate markers; no flag can opt a packaged or unmarked build into OS preview registration.
    internal static bool ExplorerDemoRequested(IEnumerable<AssemblyMetadataAttribute> metadata, IReadOnlyList<string> arguments) =>
        !ReleaseProfiles.Compiled(metadata).Packaged && arguments.Contains("--explorer-demo");

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var metadata = typeof(App).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().ToArray();
        var compiled = ReleaseProfiles.Compiled(metadata);
        if (ExeUpdateWindowsHelperEntry.Requested(e.Args)) {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            var exitCode = await ExeUpdateWindowsHelperEntry.RunAsync(e.Args, CancellationToken.None);
            Shutdown(exitCode);
            return;
        }
        var resume = ExplorerResumeRequest.Parse(e.Args);
        if (!resume.AllowedIn(compiled)) { Shutdown(20); return; }
        var startupAdapter = compiled.Packaged && compiled.Channel == ReleaseChannel.Pilot ? new WindowsStartupAdapter() : null;
        if (InstallerMaintenance.Requested(e.Args)) {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            var exitCode = await InstallerMaintenance.RunAsync(compiled, e.Args);
            Shutdown(exitCode);
            return;
        }
        if (compiled.Packaged && compiled.Channel == ReleaseChannel.Pilot &&
            ExeUpdateWindowsPlatform.HasPendingOperation("pilot")) {
            MessageBox.Show("A LedgeTop Files update is running, or its status couldn't be checked. Let setup finish, then open LedgeTop Files again. If this keeps appearing, ask your LedgeTop contact to check the update.",
                "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(20);
            return;
        }
        if (InstallerActivity.BlocksStartup(compiled, e.Args)) {
            MessageBox.Show("LedgeTop Files setup is running or its status couldn't be checked. Finish or close setup, then open LedgeTop Files again.",
                "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }
        if (resume.StartWithWindows && (startupAdapter is null || !await startupAdapter.ValidateRunningInstallationAsync(CancellationToken.None))) {
            Shutdown(20); return;
        }
        var scope = SingleInstance.ScopeFor(compiled, e.Args);
        try {
            instance = SingleInstance.TryOwn(scope, RequestRestore, compiled.Packaged && compiled.Channel == ReleaseChannel.Pilot ? RequestInstallerQuit : null);
            if (instance is null) {
                if (!await SingleInstance.NotifyExistingAsync(scope))
                    MessageBox.Show("LedgeTop Files is already running, but couldn't bring its window forward. Open it from the system tray, or quit that copy before trying again.",
                        "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown();
                return;
            }
        } catch (Exception) {
            MessageBox.Show("LedgeTop Files couldn't check whether another copy is running. Restart the app before trying again.",
                "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }
        if (ExplorerDemoRequested(metadata, e.Args)) {
            // Only the exact developer marker can reach this route. Session creation and OS registration
            // are deferred until the person clicks Start Explorer preview in the settings window.
            var preview = new ExplorerPreviewWindow(() => Task.FromResult<IExplorerPreviewSession>(new ExplorerPreviewSession()));
            MainWindow = preview;
            preview.Show(); RestoreWhenReady(preview);
            return;
        }
        // The compiled channel supplies trusted setup. Real sources remain deferred until an explicit connection action.
        StartupPlan plan;
        try {
            plan = Backends.Startup.Choose(compiled, e.Args,
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), AppContext.BaseDirectory, ReleaseProfiles.For);
        } catch (Exception) {
            plan = new(null, "Ledge Top Files couldn't start on this PC. Restart it, and if this keeps happening, ask your Ledge Top contact to check the installation.",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Ledge Top"), null);
        }
        if (plan.Access is { } access) {
            // Pick one source without constructing either backend or starting browser authentication.
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            AccessMode? mode;
            if (resume.SourceMode is { } requestedMode) {
                if (!resume.AllowedIn(compiled, access.Modes)) { Shutdown(20); return; }
                mode = requestedMode;
            }
            else if (access.Modes.Count == 1) mode = access.Modes[0];
            else {
                var chooser = new ExplorerSourceChoiceWindow(access.Modes, plan.Tag ?? "Files");
                MainWindow = chooser; chooser.Show(); RestoreWhenReady(chooser);
                mode = await chooser.Selection;
            }
            if (mode is null) { Shutdown(); return; }
            if (access.TrustedOrigins is null || !access.TrustedOrigins.TryGetValue(mode.Value, out var origin)) {
                MessageBox.Show(Backends.Startup.UnreviewedProblem, "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown(); return;
            }
            var channel = compiled.Channel == ReleaseChannel.Stable ? "stable" : "pilot";
            var stateFolder = compiled.Packaged ? channel : "developer";
            var stateBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", stateFolder);
            var label = mode == AccessMode.Client ? "Client deliveries" : "Company files";
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "LedgeTop Files " + (plan.Tag ?? "") + " — " + label);
            IExplorerPreviewSession Prepare() => new ConnectedExplorerSession(() => access.Create(mode.Value), channel,
                AccessModes.Alias(mode.Value), origin, stateBase, root);
            ExplorerPreviewWindow settings;
            try {
                var prepared = Prepare(); // Only owned local profile/index reads; no source/helper/authentication call.
                settings = new ExplorerPreviewWindow(() => Task.FromResult(Prepare()), presentation:
                    ExplorerWindowContent.Connected(plan.Tag ?? "Files", mode.Value), preparedSession: prepared, setupProblem: plan.Problem);
            } catch (Exception) {
                MessageBox.Show("LedgeTop Files couldn't prepare its local connection. Restart the app, and ask your LedgeTop contact to check setup if this continues.",
                    "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown(); return;
            }
            MainWindow = settings; ShutdownMode = ShutdownMode.OnMainWindowClose;
            if (compiled.Packaged && compiled.Channel == ReleaseChannel.Pilot) {
                var currentVersion = typeof(App).Assembly.GetName().Version?.ToString(4) ?? "0.0.0.0";
                updateController = new ExplorerInstalledUpdateController(settings.GetVerifiedUpdateBindingAsync,
                    ExeUpdateWindowsPlatform.CheckAvailableAsync,
                    binding => new ExeUpdateHandoffCoordinator(new ExeUpdateWindowsPlatform(
                        binding.SourceAlias, binding.PrincipalId, settings.DrainForUpdateAsync,
                        () => settings.RecoverForUpdateAsync(binding), settings.RequestUpdateExitAsync)));
                settings.SetUpdateActions(updateController.Actions(currentVersion));
                settings.ConfigureUpdateSchedule(ExplorerUpdateScheduleSettingsStore.CreatePilot(stateBase),
                    () => DateTimeOffset.UtcNow, TimeSpan.FromSeconds(Random.Shared.Next(0, 121)));
            }
            settings.Show(); RestoreWhenReady(settings);
            if (startupAdapter is not null) {
                await settings.SetStartupActionsAsync(new ExplorerStartupActions(token => startupAdapter.ApplyDefaultAsync(AccessModes.Alias(mode.Value), token),
                    (enabled, token) => startupAdapter.SetEnabledAsync(enabled, AccessModes.Alias(mode.Value), token)));
            }
            if (resume.Requested) await settings.ReconnectPreviewAsync();
            if (resume.StartWithWindows) settings.HideAfterWindowsStartup();
            return;
        }
        if (resume.Requested) { Shutdown(20); return; }
        var window = new MainWindow();
        window.EnableTray(plan.Downloads, plan.Tag);
        var notSetUp = plan.Backend is null; var setupProblem = plan.Problem;
        var model = new MainViewModel(plan.Backend ?? new UnavailableBackend(), window, plan.Downloads);
        window.Attach(model, plan.Tag);
        window.Show();
        RestoreWhenReady(window);
        // Nothing escapes startup: a problem shows a plain setup message instead of crashing the app.
        try {
            if (notSetUp) model.ShowNotSetUp(setupProblem);
            else await model.StartAsync();
        } catch (Exception) {
            model.ShowNotSetUp("Ledge Top Files couldn't start on this PC. Restart it, and if this keeps happening, ask your Ledge Top contact to check the installation.");
        }
    }

    private void RequestInstallerQuit()
    {
        if (Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
        Dispatcher.BeginInvoke(() => {
            // Use exactly the human Quit path: it cancels work and retains the process if
            // provider drain or update-helper ownership is uncertain.
            if (MainWindow is ExplorerPreviewWindow preview) preview.Quit();
            else if (MainWindow is ExplorerSourceChoiceWindow chooser) chooser.Close();
        });
    }

    private void RequestRestore()
    {
        if (Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
        Dispatcher.BeginInvoke(() => {
            if (MainWindow is { IsLoaded: true } window) RestoreWindow(window);
            else restorePending = true;
        });
    }

    private void RestoreWhenReady(Window window)
    {
        if (!restorePending) return;
        restorePending = false; RestoreWindow(window);
    }

    private static void RestoreWindow(Window window)
    {
        if (window is MainWindow files) files.RestoreFromTray();
        else if (window is ExplorerPreviewWindow preview) preview.RestoreFromTray();
        else if (window is ExplorerSourceChoiceWindow) {
            window.Show(); if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal; window.Activate();
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        instance?.Dispose(); instance = null;
        base.OnExit(e);
    }

}
