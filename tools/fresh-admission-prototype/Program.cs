// Deliberately isolated behavioral model, not referenced by the application.
// An Authority here is a FAKE; no Windows selector handle or OS callback is fenced.
using System.Collections.Concurrent;

await Tests.Run();

enum Kind { Fetch, Explicit, Scanner }
enum Phase { Pending, Active, Draining, Stopped }

sealed class Authority
{
    public bool Held { get; private set; } = true;
    public void LoseForTest() => Held = false;
    public void Release() => Held = false;
}

sealed class Gate
{
    private readonly object sync = new();
    private Phase phase = Phase.Pending;
    private Authority? authority;
    private int count;
    private TaskCompletionSource drained = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Activate(Authority held, bool published, bool matched)
    {
        lock (sync) {
            if (phase != Phase.Pending || !published || !matched || !held.Held) throw new InvalidOperationException("publication or authority unconfirmed");
            authority = held; phase = Phase.Active;
        }
    }
    public IDisposable Admit(Kind kind)
    {
        lock (sync) {
            if (!Enum.IsDefined(kind) || phase != Phase.Active || authority?.Held != true) throw new InvalidOperationException("admission refused");
            count++;
            return new Ticket(this);
        }
    }
    public Task Stop()
    {
        lock (sync) {
            if (phase == Phase.Stopped) return Task.CompletedTask;
            if (phase != Phase.Draining) phase = Phase.Draining;
            CompleteIfDrained();
            return drained.Task;
        }
    }
    private void Done()
    {
        lock (sync) { if (count <= 0) throw new InvalidOperationException("unbalanced ticket"); count--; CompleteIfDrained(); }
    }
    private void CompleteIfDrained()
    {
        if (phase == Phase.Draining && count == 0) {
            authority?.Release(); authority = null; phase = Phase.Stopped; drained.TrySetResult();
        }
    }
    private sealed class Ticket(Gate owner) : IDisposable
    {
        private Gate? current = owner;
        public void Dispose() => Interlocked.Exchange(ref current, null)?.Done();
    }
}

static class Tests
{
    static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
    static void Refused(Action a) { try { a(); } catch (InvalidOperationException) { return; } throw new Exception("expected refusal"); }
    public static async Task Run()
    {
        var g = new Gate(); var a = new Authority();
        foreach (var k in Enum.GetValues<Kind>()) Refused(() => g.Admit(k));
        Refused(() => g.Activate(a, false, true)); Refused(() => g.Activate(a, true, false));
        foreach (var k in Enum.GetValues<Kind>()) Refused(() => g.Admit(k));
        g.Activate(a, true, true);
        var t = Enum.GetValues<Kind>().Select(g.Admit).ToArray();
        Task stop = g.Stop(); Check(!stop.IsCompleted && a.Held, "authority released before all admissions drained");
        foreach (var k in Enum.GetValues<Kind>()) Refused(() => g.Admit(k));
        t[0].Dispose(); t[0].Dispose(); t[1].Dispose(); Check(!stop.IsCompleted && a.Held, "drain completed early");
        t[2].Dispose(); await stop.WaitAsync(TimeSpan.FromSeconds(2)); Check(!a.Held, "authority not released");
        Refused(() => g.Activate(new Authority(), true, true));
        var next = new Gate(); var nextAuthority = new Authority(); next.Activate(nextAuthority, true, true);
        using (next.Admit(Kind.Fetch)) { }
        nextAuthority.LoseForTest(); foreach (var k in Enum.GetValues<Kind>()) Refused(() => next.Admit(k));
        await next.Stop().WaitAsync(TimeSpan.FromSeconds(2));
        var pending = new Gate(); await pending.Stop().WaitAsync(TimeSpan.FromSeconds(2));
        Refused(() => pending.Activate(new Authority(), true, true));
        var live = new Gate(); var lease = new Authority(); live.Activate(lease, true, true);
        var began = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker = Task.Run(async () => { using var ticket = live.Admit(Kind.Scanner); began.SetResult(); await finish.Task; });
        await began.Task.WaitAsync(TimeSpan.FromSeconds(2)); var draining = live.Stop();
        Check(!draining.IsCompleted && lease.Held, "worker was not joined"); finish.SetResult();
        await Task.WhenAll(worker, draining).WaitAsync(TimeSpan.FromSeconds(2)); Check(!lease.Held, "lease survived completed drain");
        Console.WriteLine("PASS: modeled fetch/explicit/scanner admission, failed publication, owner loss, stop/drain and later generation");
    }
}
