using System.Diagnostics;

namespace LedgeTop.Files;

internal interface IBackgroundFolderLauncher : IDisposable
{
    bool TryOpen(string path, Action failed);
}

/// <summary>One background STA worker per window. A blocked Windows Shell never owns app shutdown.</summary>
internal sealed class BackgroundFolderLauncher(Action<string>? open = null) : IBackgroundFolderLauncher
{
    internal static bool IsExplorerPathTooLong(string path) => path.Length >= 260;
    private readonly Action<string> open = open ?? OpenWithShell;
    private readonly object gate = new();
    private readonly AutoResetEvent signal = new(false);
    private Thread? worker;
    private (string Path, Action Failed)? pending;
    private bool busy, stopped;

    private static void OpenWithShell(string path)
    {
        using var opened = Process.Start(ExplorerStartInfo(path));
    }

    internal static ProcessStartInfo ExplorerStartInfo(string path)
    {
        // Explorer's command-line parser treats commas as separators. Always quote
        // the single local folder argument, including paths without whitespace.
        // Preview roots are canonical local directories and never drive roots.
        // Explorer can silently open Documents for paths of 260 or more UTF-16
        // characters, even though the filesystem and Process.Start accept them.
        if (string.IsNullOrWhiteSpace(path) || IsExplorerPathTooLong(path) || !Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) ||
            path.EndsWith('\\') || path.EndsWith('/') || path.Any(c => c is '"' or '%' || char.IsControl(c)) ||
            !string.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A local folder path is required.", nameof(path));
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        if (string.IsNullOrWhiteSpace(windows) || !Path.IsPathFullyQualified(windows)) throw new IOException("Windows Explorer is unavailable.");
        return new ProcessStartInfo(Path.Combine(windows, "explorer.exe")) {
            UseShellExecute = false,
            Arguments = "\"" + path + "\""
        };
    }

    public bool TryOpen(string path, Action failed)
    {
        lock (gate) {
            if (stopped || busy) return false;
            busy = true; pending = (path, failed);
            if (worker is null) {
                var next = new Thread(Run) { IsBackground = true, Name = "LedgeTop folder launcher" };
                next.SetApartmentState(ApartmentState.STA);
                try { next.Start(); worker = next; }
                catch { busy = false; pending = null; throw; }
            }
            signal.Set(); return true;
        }
    }

    private void Run()
    {
        try {
            while (true) {
                signal.WaitOne();
                (string Path, Action Failed) request;
                lock (gate) {
                    if (stopped) return;
                    request = pending!.Value; pending = null;
                }
                try { open(request.Path); }
                catch { try { request.Failed(); } catch { /* UI already closed; no worker exception escapes. */ } }
                finally { lock (gate) busy = false; }
            }
        } finally { signal.Dispose(); }
    }

    public void Dispose()
    {
        lock (gate) {
            if (stopped) return;
            stopped = true; pending = null;
            if (worker is null) signal.Dispose();
            else signal.Set(); // Never join or wait for ShellExecuteExW. Background worker may remain blocked until process exit.
        }
    }
}
