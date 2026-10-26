using System.Diagnostics;

namespace LedgeTop.Files;

internal interface IBackgroundFolderLauncher : IDisposable
{
    bool TryOpen(string path, Action failed);
}

/// <summary>One background STA worker per window. A blocked Windows Shell never owns app shutdown.</summary>
internal sealed class BackgroundFolderLauncher(Action<string>? open = null) : IBackgroundFolderLauncher
{
    private readonly Action<string> open = open ?? OpenWithShell;
    private readonly object gate = new();
    private readonly AutoResetEvent signal = new(false);
    private Thread? worker;
    private (string Path, Action Failed)? pending;
    private bool busy, stopped;

    private static void OpenWithShell(string path)
    {
        using var opened = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
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
