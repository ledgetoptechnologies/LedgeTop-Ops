using LedgeTop.Files.Explorer;

internal static class ProviderWorkAdmissionTests
{
    private sealed class Authority : IProviderWorkAuthority
    {
        internal bool Held = true, Disposed;
        public void VerifyHeld() { if (!Held || Disposed) throw new IOException("Authority unavailable."); }
        public void Dispose() { Disposed = true; }
    }
    private sealed class BlockingAuthority : IProviderWorkAuthority
    {
        internal bool Block, Disposed;
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly ManualResetEventSlim Release = new();
        public void VerifyHeld() { if (Block) { Entered.TrySetResult(); if (!Release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException(); } }
        public void Dispose() => Disposed = true;
    }
    internal static async Task<int> RunAsync()
    {
        var gate = new ProviderWorkAdmission();
        Refused(() => gate.Enter());
        var bad = new Authority { Held = false };
        Refused(() => gate.Activate(bad));
        if (bad.Disposed) throw new Exception("Failed activation consumed the authority.");
        var authority = new Authority(); gate.Activate(authority);
        var active = gate.Enter(); var second = gate.Enter();
        authority.Held = false; Refused(() => gate.Enter()); authority.Held = true;
        gate.StopAdmission(); Refused(() => gate.Enter());
        var drain = gate.ReleaseAfterDrainAsync();
        if (drain.IsCompleted || authority.Disposed) throw new Exception("Authority released while work was active.");
        active.Dispose(); active.Dispose();
        if (drain.IsCompleted || authority.Disposed) throw new Exception("Authority released while second work was active.");
        second.Dispose(); await drain.WaitAsync(TimeSpan.FromSeconds(5));
        if (!authority.Disposed) throw new Exception("Authority not released after drain.");
        Refused(() => gate.Activate(new Authority()));
        var pending = new ProviderWorkAdmission(); pending.StopAdmission();
        await pending.ReleaseAfterDrainAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Refused(() => pending.Enter());
        var blocked = new ProviderWorkAdmission(); var blockingAuthority = new BlockingAuthority(); blocked.Activate(blockingAuthority); blockingAuthority.Block = true;
        var entering = Task.Run(() => { try { using var ignored = blocked.Enter(); throw new Exception("Stopped admission granted a ticket."); } catch (IOException) { } });
        try {
            await blockingAuthority.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Task.Run(blocked.StopAdmission).WaitAsync(TimeSpan.FromSeconds(2));
            var blockedDrain = blocked.ReleaseAfterDrainAsync();
            if (blockedDrain.IsCompleted || blockingAuthority.Disposed) throw new Exception("Authority released while proof was in flight.");
            blockingAuthority.Release.Set(); await entering.WaitAsync(TimeSpan.FromSeconds(5)); await blockedDrain.WaitAsync(TimeSpan.FromSeconds(5));
            if (!blockingAuthority.Disposed) throw new Exception("Authority not released after proof finished.");
        } finally { blockingAuthority.Release.Set(); await entering.WaitAsync(TimeSpan.FromSeconds(5)); blockingAuthority.Release.Dispose(); }
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var scanned = 0;
        var scan = NativePlaceholderProvider.RunScannerAfterAdmissionAsync(ready.Task, () => { scanned++; return Task.CompletedTask; }, CancellationToken.None);
        if (scan.IsCompleted || scanned != 0) throw new Exception("Scanner ran before admission.");
        ready.TrySetResult(); await scan.WaitAsync(TimeSpan.FromSeconds(5));
        if (scanned != 1) throw new Exception("Scanner did not run after admission.");
        var stoppedReady = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); using var stopped = new CancellationTokenSource();
        var stoppedScan = NativePlaceholderProvider.RunScannerAfterAdmissionAsync(stoppedReady.Task, () => { scanned++; return Task.CompletedTask; }, stopped.Token);
        stopped.Cancel(); await stoppedScan.WaitAsync(TimeSpan.FromSeconds(5)); stoppedReady.TrySetResult();
        if (scanned != 1) throw new Exception("Stopped pending scanner ran.");
        Console.WriteLine("PASS deferred provider admission and held authority drain (synthetic)."); return 0;
    }
    private static void Refused(Action action) { try { action(); } catch (IOException) { return; } throw new Exception("Expected admission refusal."); }
}
