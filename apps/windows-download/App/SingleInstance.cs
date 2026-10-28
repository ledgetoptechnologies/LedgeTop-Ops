using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using LedgeTop.Files.Backends;

namespace LedgeTop.Files;

/// <summary>
/// One owner per Windows user, interactive session and compiled product mode. A second launch can only
/// ask that owner to restore its window. Packaged pilot owners also accept a graceful Quit request;
/// no arguments, identities, URLs or file paths cross the pipe.
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    private const byte Restore = 1, Quit = 2;
    private readonly Mutex mutex;
    private readonly int ownerThread = Environment.CurrentManagedThreadId;
    private readonly string pipeName;
    private readonly Action restore;
    private readonly Action? quit;
    private readonly CancellationTokenSource stop = new();
    private readonly object gate = new();
    private readonly Task listener;
    private NamedPipeServerStream? currentPipe;
    private bool disposed;
    internal bool RecoveredAbandonedOwner { get; }

    private SingleInstance(Mutex mutex, string pipeName, Action restore, Action? quit, bool abandoned)
    {
        this.mutex = mutex; this.pipeName = pipeName; this.restore = restore; this.quit = quit;
        RecoveredAbandonedOwner = abandoned;
        // Create the endpoint before returning ownership, so a racing second launch can connect immediately.
        listener = ListenAsync(NewPipe());
    }

    /// <summary>Only compiled release metadata can choose stable/pilot; developer arguments cannot impersonate them.</summary>
    internal static string ScopeFor((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments) =>
        compiled.Packaged ? compiled.Channel switch {
            ReleaseChannel.Stable => "stable", ReleaseChannel.Pilot => "pilot", _ => "unconfigured-release"
        } : arguments.Contains("--explorer-demo") ? "developer-explorer-demo" :
            arguments.Contains("--demo") || arguments.Contains("--demo-signed-in") ? "developer-demo" : "developer-live";

    internal static (string Mutex, string Pipe) Names(string scope)
    {
        if (scope.Length is 0 or > 128) throw new ArgumentException("Invalid application instance scope.", nameof(scope));
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? throw new InvalidOperationException("The current Windows user is unavailable.");
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid + "\n" + process.SessionId + "\n" + scope)));
        return (@"Local\LedgeTop.Files." + hash, "LedgeTop.Files." + hash);
    }

    /// <summary>Must be acquired and disposed on the same thread, as required by a Windows mutex.</summary>
    internal static SingleInstance? TryOwn(string scope, Action restore, Action? quit = null)
    {
        var names = Names(scope);
        var mutex = new Mutex(false, names.Mutex);
        var owned = false; var abandoned = false;
        try {
            try { owned = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { owned = abandoned = true; }
            if (!owned) { mutex.Dispose(); return null; }
            return new SingleInstance(mutex, names.Pipe, restore, quit, abandoned);
        } catch {
            if (owned) mutex.ReleaseMutex();
            mutex.Dispose();
            throw;
        }
    }

    internal static async Task<bool> NotifyExistingAsync(string scope, TimeSpan? timeout = null)
        => await SendAsync(scope, Restore, null, timeout).ConfigureAwait(false);

    // The installer must bind the actual OS pipe peer to the exact active installed payload
    // before byte2 crosses the pipe. An acknowledgement means accepted, never fully drained.
    internal static Task<bool> RequestQuitAsync(string scope, Func<PipeStream, CancellationToken, Task<IAsyncDisposable>> verifyPeer,
        TimeSpan? timeout = null) => SendAsync(scope, Quit, verifyPeer, timeout);

    private static async Task<bool> SendAsync(string scope, byte command,
        Func<PipeStream, CancellationToken, Task<IAsyncDisposable>>? verifyPeer, TimeSpan? timeout)
    {
        var names = Names(scope);
        using var deadline = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(3));
        try {
            using var pipe = new NamedPipeClientStream(".", names.Pipe, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.ConnectAsync(deadline.Token).ConfigureAwait(false);
            await using var peer = verifyPeer is null ? null : await verifyPeer(pipe, deadline.Token).ConfigureAwait(false);
            await pipe.WriteAsync(new byte[] { command }, deadline.Token).ConfigureAwait(false);
            var reply = new byte[1];
            return await pipe.ReadAsync(reply, deadline.Token).ConfigureAwait(false) == 1 && reply[0] == command;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or OperationCanceledException) {
            return false;
        }
    }

    private NamedPipeServerStream NewPipe()
    {
        lock (gate) {
            ObjectDisposedException.ThrowIf(disposed, this);
            return currentPipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance, 1, 1);
        }
    }

    private async Task ListenAsync(NamedPipeServerStream first)
    {
        var pipe = first;
        try {
            while (!stop.IsCancellationRequested) {
                using (pipe) {
                    try {
                        await pipe.WaitForConnectionAsync(stop.Token).ConfigureAwait(false);
                        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                        deadline.CancelAfter(TimeSpan.FromMilliseconds(750));
                        var request = new byte[1];
                        if (await pipe.ReadAsync(request, deadline.Token).ConfigureAwait(false) == 1 &&
                            (request[0] == Restore || request[0] == Quit && quit is not null)) {
                            var accepted = false;
                            try { (request[0] == Restore ? restore : quit!)(); accepted = true; }
                            catch (Exception) { /* a dispatcher already shutting down cannot accept a restore */ }
                            if (accepted) await pipe.WriteAsync(new byte[] { request[0] }, deadline.Token).ConfigureAwait(false);
                        }
                    } catch (Exception error) when (error is IOException or UnauthorizedAccessException or OperationCanceledException or ObjectDisposedException) {
                        // A disconnected or silent launcher cannot hold the restore endpoint indefinitely.
                    }
                }
                if (stop.IsCancellationRequested) return;
                pipe = NewPipe();
            }
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or OperationCanceledException or ObjectDisposedException) {
            // Ownership remains exclusive if the endpoint fails. A second launch explains that it couldn't restore.
        } finally { pipe.Dispose(); }
    }

    public void Dispose()
    {
        if (Environment.CurrentManagedThreadId != ownerThread)
            throw new InvalidOperationException("Application instance ownership must be released by its owning thread.");
        lock (gate) {
            if (disposed) return;
            disposed = true; stop.Cancel(); currentPipe?.Dispose();
        }
        try { listener.GetAwaiter().GetResult(); }
        finally { stop.Dispose(); mutex.ReleaseMutex(); mutex.Dispose(); }
    }
}
