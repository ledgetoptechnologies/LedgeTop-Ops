using LedgeTop.Files.Explorer;

internal static class ProviderWorkAdmissionTests
{
    private sealed class Authority : IProviderWorkAuthority
    {
        internal bool Held = true, Disposed;
        public void VerifyHeld() { if (!Held || Disposed) throw new IOException("Authority unavailable."); }
        public void Dispose() { Disposed = true; }
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
        Console.WriteLine("PASS deferred provider admission and held authority drain (synthetic)."); return 0;
    }
    private static void Refused(Action action) { try { action(); } catch (IOException) { return; } throw new Exception("Expected admission refusal."); }
}
