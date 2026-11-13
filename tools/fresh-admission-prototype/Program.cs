// Deliberately isolated behavioral model, not referenced by the application.
// An Authority here is a FAKE; no Windows selector handle or OS callback is fenced.
await Tests.Run();

enum Kind { Fetch, Explicit, Scanner }
enum Phase { Pending, Active, Draining, Stopped }

sealed class Authority
{
    private readonly object sync = new();
    private bool held = true;
    public bool Held { get { lock (sync) return held; } }
    public void LoseForTest() { lock (sync) held = false; }
    public void Release() { lock (sync) held = false; }
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
        // Losing the fake authority denies future admission; it cannot undo work
        // admitted earlier. Stop must still join that work before completing.
        var lost = new Gate(); var lostLease = new Authority(); lost.Activate(lostLease, true, true);
        var priorTicket = lost.Admit(Kind.Explicit); lostLease.LoseForTest();
        Refused(() => lost.Admit(Kind.Fetch));
        var lostStop = lost.Stop(); Check(!lostStop.IsCompleted, "authority loss discarded admitted work");
        priorTicket.Dispose(); await lostStop.WaitAsync(TimeSpan.FromSeconds(2));
        // Both contestants leave the barrier together. Whichever enters the
        // gate first must determine one of two allowed, fully drained outcomes.
        for (int i = 0; i < 100; i++) {
            var contested = new Gate(); var contestedLease = new Authority(); contested.Activate(contestedLease, true, true);
            using var barrier = new Barrier(3);
            var outcome = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseWorker = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void Meet() { if (!barrier.SignalAndWait(TimeSpan.FromSeconds(5))) throw new TimeoutException("admission race barrier timed out"); }
            var admitting = Task.Run(async () => {
                Meet();
                IDisposable? ticket;
                try { ticket = contested.Admit(Kind.Fetch); }
                catch (InvalidOperationException) { outcome.SetResult(false); return; }
                using (ticket) { outcome.SetResult(true); await releaseWorker.Task; }
            });
            var stopping = Task.Run(async () => { Meet(); await contested.Stop(); });
            try {
                Meet();
                bool admitted = await outcome.Task.WaitAsync(TimeSpan.FromSeconds(5));
                if (admitted) Check(!stopping.IsCompleted && contestedLease.Held, "stop overtook admitted work");
            } finally {
                releaseWorker.TrySetResult();
                await Task.WhenAll(admitting, stopping).WaitAsync(TimeSpan.FromSeconds(10));
            }
            Check(!contestedLease.Held, "contested stop retained authority");
            Refused(() => contested.Admit(Kind.Scanner));
        }
        Console.WriteLine("PASS: modeled fetch/explicit/scanner admission, failed publication, owner loss, stop/drain, concurrent stop/admission and later generation");
    }
}
