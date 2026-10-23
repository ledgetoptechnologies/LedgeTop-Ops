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
        var window = new MainWindow();
        if (plan.Access is { } access) {
            // Real sources: ask which files to open (unless remembered), then sign in to that kind only.
            var session = new FilesSession(window, access, plan.Downloads, plan.Tag);
            window.CloseWith(session.DisposeAsync);
            window.Show();
            try { await session.StartAsync(); }
            catch (OperationCanceledException) { /* the window closed while the choice was still showing */ }
            catch (Exception) {
                session.Current?.ShowNotSetUp("Ledge Top Files couldn't start on this PC. Restart it, and if this keeps happening, ask your Ledge Top contact to check the installation.");
            }
            return;
        }
        var notSetUp = plan.Backend is null; var setupProblem = plan.Problem;
        var model = new MainViewModel(plan.Backend ?? new UnavailableBackend(), window, plan.Downloads);
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

}
