using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;

namespace LedgeTop.Files;

/// <summary>The window as the access session needs it: ask which files to open, then show one person's view.</summary>
public interface IAccessWindow : IShell
{
    /// <summary>Shows the choice and returns one of <paramref name="modes"/>. Never signs in or opens a browser.</summary>
    Task<AccessMode> ChooseAccessAsync(IReadOnlyList<AccessMode> modes);
    void Attach(MainViewModel model, string? tag);
}

/// <summary>
/// Runs one kind of files at a time: client deliveries or company files. Nothing signs in until a choice is made. Switching
/// first closes the current view exactly as closing the window would (downloads stop and are saved, queues and the
/// backend are released), then opens the other kind. A sign-in problem never falls back to the other kind.
/// </summary>
public sealed class FilesSession(IAccessWindow window, AccessChoice choice, string downloads, string? tag) : IAsyncDisposable
{
    private readonly SemaphoreSlim changing = new(1, 1);
    private MainViewModel? current;
    private bool closed, stuck;
    private Task? closing;

    public MainViewModel? Current => current;
    public AccessMode? Mode { get; private set; }

    public async Task StartAsync()
    {
        var remembered = choice.Preference.Read();
        var mode = remembered is { } saved && choice.Modes.Contains(saved) ? saved
            : choice.Modes.Count == 1 ? choice.Modes[0]
            : await window.ChooseAccessAsync(choice.Modes);
        MainViewModel? opened;
        await changing.WaitAsync();
        try { opened = Open(mode); } finally { changing.Release(); }
        // Signing in happens outside the lock, so closing never waits behind a slow sign-in check.
        if (opened is not null) await opened.StartAsync();
    }

    public async Task SwitchAsync(AccessMode target)
    {
        if (!choice.Modes.Contains(target)) return;
        MainViewModel? opened;
        await changing.WaitAsync();
        try {
            if (closed || stuck || Mode == target) return;
            var old = current; current = null;
            // Stops and saves downloads and releases the old queues and backend, exactly as closing the window does.
            if (old is not null) {
                try { await old.DisposeAsync(); }
                catch (Exception) {
                    // It isn't certain the old downloads stopped and were saved, so open nothing else (no new
                    // backend, no fallback). Clear the old view and ask for a restart; closing still waits on it.
                    stuck = true; current = old;
                    old.ShowRestartRequired();
                    return;
                }
            }
            opened = Open(target);
        } finally { changing.Release(); }
        if (opened is not null) await opened.StartAsync();
    }

    /// <summary>Builds and shows the chosen view; returns it when it is ready to sign in.</summary>
    private MainViewModel? Open(AccessMode mode)
    {
        if (closed) return null;
        IFilesBackend? backend = null; string? problem = null;
        try { backend = choice.Create(mode); }
        catch (SettingsException error) { problem = error.Message; }
        catch (Exception) { problem = Startup.HelperProblem; }
        var model = new MainViewModel(backend ?? new UnavailableBackend(), window, downloads);
        AccessMode? other = choice.Modes.Where(item => item != mode).Select(item => (AccessMode?)item).FirstOrDefault();
        model.ConfigureAccess(Label(mode), SignInDetail(mode),
            other is { } next ? (SwitchText(next), () => SwitchAsync(next)) : null);
        current = model; Mode = mode;
        window.Attach(model, tag);
        if (backend is null) { model.ShowNotSetUp(problem); return null; }
        choice.Preference.Save(mode);
        return model;
    }

    public static string Label(AccessMode mode) => mode == AccessMode.Client ? "Client deliveries" : "Company files";
    public static string SignInDetail(AccessMode mode) => mode == AccessMode.Client
        ? "Use the account Ledge Top invited you with. Files Ledge Top delivered to you appear here."
        : "Use your Ledge Top staff account. Company server files you're allowed to download appear here.";
    public static string SwitchText(AccessMode mode) => mode == AccessMode.Client ? "Switch to client deliveries" : "Switch to company files";

    /// <summary>Closes the current view; a switch still in progress finishes closing first and opens nothing new.</summary>
    public ValueTask DisposeAsync() => new(closing ??= CloseAsync());

    private async Task CloseAsync()
    {
        closed = true;
        var shown = current;
        Exception? failure = null;
        if (shown is not null) { try { await shown.DisposeAsync(); } catch (Exception error) { failure = error; } }
        await changing.WaitAsync();
        try {
            if (current is { } late && late != shown) { try { await late.DisposeAsync(); } catch (Exception error) { failure ??= error; } }
        } finally { changing.Release(); }
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(failure);
    }
}

/// <summary>Used when the chosen files can't be opened on this PC: nothing to browse or download.</summary>
internal sealed class UnavailableBackend : IFilesBackend
{
    public ISessionGateway Session => throw new InvalidOperationException();
    public IFileCatalog Catalog => throw new InvalidOperationException();
    public IReadOnlyList<LedgeTop.WindowsDownload.IQueuedDownloadSource> Sources => [];
    public string StateDirectory => "";
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
