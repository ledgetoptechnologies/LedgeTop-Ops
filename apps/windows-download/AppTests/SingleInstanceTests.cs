using System.Diagnostics;
using System.IO.Pipes;
using LedgeTop.Files;
using LedgeTop.Files.Backends;

internal static class SingleInstanceTests
{
    // Runs before any WPF Application exists. The owner stays on one thread for Windows mutex ownership.
    internal static int Helper(string[] args)
    {
        if (args.Length != 3) return 90;
        var mode = args[1]; var scope = args[2];
        if (mode == "signal") return SingleInstance.NotifyExistingAsync(scope).GetAwaiter().GetResult() ? 0 : 3;
        using var owner = SingleInstance.TryOwn(scope, () => { Console.WriteLine("RESTORE"); Console.Out.Flush(); },
            mode == "own-quittable" ? () => { Console.WriteLine("QUIT"); Console.Out.Flush(); } : null);
        if (mode == "try") return owner is null ? 20 : 21;
        if (owner is null) return 2;
        Console.WriteLine(owner.RecoveredAbandonedOwner ? "OWNED-RECOVERED" : "OWNED"); Console.Out.Flush();
        if (Console.ReadLine() == "crash") Environment.Exit(23);
        return 0;
    }

    internal static async Task Run()
    {
        Equal("stable", SingleInstance.ScopeFor((true, ReleaseChannel.Stable), ["--demo", "--explorer-demo"]));
        Equal("pilot", SingleInstance.ScopeFor((true, ReleaseChannel.Pilot), ["--demo-signed-in"]));
        Equal("unconfigured-release", SingleInstance.ScopeFor((true, null), ["--demo"]));
        Equal("developer-demo", SingleInstance.ScopeFor((false, null), ["--demo-signed-in"]));
        Equal("developer-explorer-demo", SingleInstance.ScopeFor((false, null), ["--explorer-demo"]));
        Equal("developer-live", SingleInstance.ScopeFor((false, null), ["--Demo"]));

        var scope = "test-" + Guid.NewGuid().ToString("N");
        await using (var first = await Child.Own(scope)) {
            await using (var contender = Child.Start("try", scope))
                Equal(20, await contender.Exit());
            await using (var launch = Child.Start("signal", scope))
                Equal(0, await launch.Exit());
            Equal("RESTORE", await first.Line());

            // A completely silent launcher gets only 750ms; a normal launch behind it must still work.
            using (var silent = new NamedPipeClientStream(".", SingleInstance.Names(scope).Pipe, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly)) {
                await silent.ConnectAsync().WaitAsync(TimeSpan.FromSeconds(3));
                var clock = Stopwatch.StartNew();
                True(await SingleInstance.NotifyExistingAsync(scope), "a stalled client doesn't block later launches");
                True(clock.Elapsed < TimeSpan.FromSeconds(3), "restore endpoint is bounded");
            }
            Equal("RESTORE", await first.Line());

            using (var malformed = new NamedPipeClientStream(".", SingleInstance.Names(scope).Pipe, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly)) {
                await malformed.ConnectAsync().WaitAsync(TimeSpan.FromSeconds(3));
                await malformed.WriteAsync(new byte[] { 99 });
                var reply = new byte[1];
                Equal(0, await malformed.ReadAsync(reply).AsTask().WaitAsync(TimeSpan.FromSeconds(3)));
            }
            True(await SingleInstance.NotifyExistingAsync(scope), "malformed signal didn't poison listener");
            Equal("RESTORE", await first.Line()); // No additional restore was accepted for byte99.

            // Distinct product modes retain independent owners and independent restore endpoints.
            await using (var otherMode = await Child.Own(scope + "-other")) {
                True(await SingleInstance.NotifyExistingAsync(scope + "-other"), "other mode restores independently");
                Equal("RESTORE", await otherMode.Line());
                True(await SingleInstance.NotifyExistingAsync(scope), "original mode still owns its session");
                Equal("RESTORE", await first.Line());
            }
        }

        await using (var supported = Child.Start("own-quittable", scope)) {
            Equal("OWNED", await supported.Line());
            True(!await SingleInstance.RequestQuitAsync(scope, (_, _) => throw new IOException("Synthetic wrong peer.")),
                "failed peer validation never sends quit");
            True(await SingleInstance.NotifyExistingAsync(scope), "failed verification leaves owner untouched");
            Equal("RESTORE", await supported.Line());
            True(await SingleInstance.RequestQuitAsync(scope, (_, _) => Task.FromResult<IAsyncDisposable>(new Peer())),
                "supported byte2 acknowledges the quit callback after verification");
            Equal("QUIT", await supported.Line());
            // Acceptance is not drain: this fake deliberately retains its singleton.
            await using var contender = Child.Start("try", scope);
            Equal(20, await contender.Exit());
        }
        await using (var legacy = await Child.Own(scope))
            True(!await SingleInstance.RequestQuitAsync(scope, (_, _) => Task.FromResult<IAsyncDisposable>(new Peer())),
                "restore-only owner does not acknowledge quit");

        // Keep a non-owning handle open so the killed process leaves a genuinely abandoned mutex to recover.
        using (var keeper = new Mutex(false, SingleInstance.Names(scope).Mutex)) {
            await using (var crashed = await Child.Own(scope)) {
                await crashed.Process.StandardInput.WriteLineAsync("crash");
                Equal(23, await crashed.Exit());
            }
            await using var replacement = await Child.Own(scope, recovered: true);
        }
        // No owner: a relaunch attempt times out rather than hanging indefinitely or opening a second process.
        var deadline = Stopwatch.StartNew();
        True(!await SingleInstance.NotifyExistingAsync(scope, TimeSpan.FromMilliseconds(300)), "absent owner is reported");
        True(deadline.Elapsed < TimeSpan.FromSeconds(2), "absent owner is bounded");
    }

    private static void Equal<T>(T expected, T actual)
    { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new InvalidOperationException($"Expected {expected}; got {actual}."); }
    private static void True(bool condition, string message)
    { if (!condition) throw new InvalidOperationException(message); }

    private sealed class Peer : IAsyncDisposable { public ValueTask DisposeAsync() => ValueTask.CompletedTask; }

    private sealed class Child(Process process) : IAsyncDisposable
    {
        internal Process Process => process;
        internal static Child Start(string mode, string scope)
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Test host unavailable.");
            var start = new ProcessStartInfo(executable) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                start.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
            start.ArgumentList.Add("--single-instance-helper"); start.ArgumentList.Add(mode); start.ArgumentList.Add(scope);
            return new(Process.Start(start) ?? throw new InvalidOperationException("Could not start test child."));
        }
        internal static async Task<Child> Own(string scope, bool recovered = false)
        {
            var child = Start("own", scope);
            try { Equal(recovered ? "OWNED-RECOVERED" : "OWNED", await child.Line()); return child; }
            catch { await child.DisposeAsync(); throw; }
        }
        internal async Task<string> Line() => await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(8))
            ?? throw new InvalidOperationException("Child exited before reporting ownership/restore.");
        internal async Task<int> Exit()
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(8));
            return process.ExitCode;
        }
        public async ValueTask DisposeAsync()
        {
            try {
                if (!process.HasExited) {
                    await process.StandardInput.WriteLineAsync("exit");
                    try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
                    catch (TimeoutException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
                }
            } finally { process.Dispose(); }
        }
    }
}
