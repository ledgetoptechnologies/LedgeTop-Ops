using System.Windows;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;

namespace LedgeTop.Files;

public partial class App : Application
{
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var arguments = e.Args;
        var demo = arguments.Contains("--demo") || arguments.Contains("--demo-signed-in");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        IFilesBackend backend; string downloads; var notSetUp = false; string? setupProblem = null;
        if (demo) {
            var root = Path.Combine(Path.GetTempPath(), "LedgeTopFilesDemo");
            var minutes = arguments.SkipWhile(value => value != "--demo-session-minutes").Skip(1).FirstOrDefault();
            backend = new DemoBackend(Path.Combine(root, "queue"), signedIn: arguments.Contains("--demo-signed-in"),
                sessionLength: double.TryParse(minutes, out var length) ? TimeSpan.FromMinutes(length) : null);
            downloads = Path.Combine(root, "Downloads");
        } else {
            downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Ledge Top");
            LiveSettings? settings = null;
            try { settings = LiveSettings.Load(LiveSettings.DefaultPath); }
            catch (SettingsException error) { setupProblem = error.Message; }
            if (settings is null) { backend = new NotSetUpBackend(); notSetUp = true; }
            else backend = new LiveBackend(settings, Path.Combine(local, "LedgeTop", "Files", "queue"));
        }
        var window = new MainWindow();
        var model = new MainViewModel(backend, window, downloads);
        window.Attach(model, demo);
        window.Show();
        // Nothing escapes startup: a problem shows a plain setup message instead of crashing the app.
        try {
            if (notSetUp) model.ShowNotSetUp(setupProblem);
            else await model.StartAsync();
        } catch (Exception) {
            model.ShowNotSetUp("Ledge Top Files couldn't start on this PC. Restart it, and if this keeps happening, ask your Ledge Top contact to check the installation.");
        }
    }

    /// <summary>Used when this PC has no trusted setup: nothing to browse or download.</summary>
    private sealed class NotSetUpBackend : IFilesBackend
    {
        public ISessionGateway Session => throw new InvalidOperationException();
        public IFileCatalog Catalog => throw new InvalidOperationException();
        public IReadOnlyList<LedgeTop.WindowsDownload.IQueuedDownloadSource> Sources => [];
        public string StateDirectory => "";
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
