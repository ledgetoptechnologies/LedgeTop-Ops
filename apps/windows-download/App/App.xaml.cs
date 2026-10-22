using System.Windows;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;

namespace LedgeTop.Files;

public partial class App : Application
{
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // The release channel is compiled in; setup checks and source construction finish before the window exists.
        StartupPlan plan;
        try {
            plan = Backends.Startup.Choose(ReleaseProfiles.Compiled(typeof(App).Assembly), e.Args,
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), AppContext.BaseDirectory, ReleaseProfiles.For);
        } catch (Exception) {
            plan = new(null, "Ledge Top Files couldn't start on this PC. Restart it, and if this keeps happening, ask your Ledge Top contact to check the installation.",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "Ledge Top"), null);
        }
        var notSetUp = plan.Backend is null; var setupProblem = plan.Problem;
        var window = new MainWindow();
        var model = new MainViewModel(plan.Backend ?? new NotSetUpBackend(), window, plan.Downloads);
        window.Attach(model, plan.Tag);
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
