using System.Buffers.Binary;
using System.Text;
using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

internal static class ExeUpdateHelperTests
{
    internal static async Task Run()
    {
        await Codec();
        var good = new Fixture();
        Require(await good.Helper.RunAsync(default) == ExeUpdateHelperStatus.NewProcessStarted &&
            string.Join(',', good.Log) == "read,accept,Ready,read,Armed,read,ExitCommitted,wait-parent,read,reverify,install,verify-installed,relaunch,dispose", "exact helper sequence");
        Require(await good.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && good.Log.Count(x => x == "install") == 1, "one instance cannot install twice");
        foreach (var step in new[] { "accept", "wait-parent", "reverify", "verify-installed", "relaunch" }) {
            var f = new Fixture { FalseAt = step };
            var result = await f.Helper.RunAsync(default);
            var expected = step switch {
                "accept" => ExeUpdateHelperStatus.Refused, "wait-parent" => ExeUpdateHelperStatus.ParentDidNotExit,
                "reverify" => ExeUpdateHelperStatus.AuthorityChanged,
                "verify-installed" => ExeUpdateHelperStatus.InstalledVerificationFailed, _ => ExeUpdateHelperStatus.RelaunchFailed
            };
            Require(result == expected, "typed refusal: " + step);
            if (step is "accept" or "wait-parent" or "reverify") Require(!f.Log.Contains("install"), "no install before all gates");
        }
        foreach (var reason in new[] { "spoofed-peer", "pid-reused", "wrong-image", "changed-owner", "changed-account", "modified-artifact" }) {
            // The Windows adapter must implement these OS/authority checks; this proves refusal propagation.
            var f = new Fixture { FalseAt = "accept" };
            Require(await f.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !f.Log.Contains("install"), reason);
        }
        foreach (var kind in new[] { ExeUpdateIpcKind.Disarm, ExeUpdateIpcKind.Ready, ExeUpdateIpcKind.Prepare }) {
            var f = new Fixture();
            f.Incoming[1] = kind == ExeUpdateIpcKind.Prepare ? f.Incoming[0] : new(1, kind, f.Offer.Handoff.Id);
            Require(await f.Helper.RunAsync(default) == (kind == ExeUpdateIpcKind.Disarm ? ExeUpdateHelperStatus.Disarmed : ExeUpdateHelperStatus.Refused) && !f.Log.Contains("wait-parent"), "uncommitted/disarmed request never waits to install");
        }
        var stale = new Fixture(); stale.Incoming[1] = new(1, ExeUpdateIpcKind.CommitExit, Guid.NewGuid());
        Require(await stale.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !stale.Log.Contains("install"), "stale commit cannot arm another record");
        var afterArmed = new Fixture(); afterArmed.Incoming[2] = new(1, ExeUpdateIpcKind.Disarm, afterArmed.Offer.Handoff.Id);
        Require(await afterArmed.Helper.RunAsync(default) == ExeUpdateHelperStatus.Disarmed &&
            afterArmed.Log.Contains("Armed") && afterArmed.Log.Contains("Stopped") && !afterArmed.Log.Contains("install"),
            "rejected parent exit can positively disarm after Armed");
        var crashBeforeIntent = new Fixture(); crashBeforeIntent.Incoming.RemoveAt(2);
        Require(await crashBeforeIntent.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !crashBeforeIntent.Log.Contains("install"),
            "parent crash after uncertain arm but before final exit intent never installs");
        foreach (var code in new int?[] { 1, -1, null }) {
            Require(!ExeUpdateExitPolicy.KnownCleanExit(true, code), "nonzero/crash/unknown termination is not clean");
            var f = new Fixture { ParentExitCode = code };
            Require(await f.Helper.RunAsync(default) == ExeUpdateHelperStatus.ParentDidNotExit && !f.Log.Contains("install"), "bad parent exit never installs");
        }
        Require(!ExeUpdateExitPolicy.KnownCleanExit(false, 0), "exit code0 without terminated handle is not proof");
        var corruptControl = new Fixture { CorruptFinalControl = true };
        Require(await corruptControl.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !corruptControl.Log.Contains("install"),
            "malformed post-final-intent control cannot be mistaken for benign parent EOF");
        var unfinishedControl = new Fixture { StallFinalControl = true };
        Require(await unfinishedControl.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !unfinishedControl.Log.Contains("install"),
            "parent termination without observable clean EOF cannot accept a cancelled/partial control read");
        var disarmWhileWaiting = new Fixture { WaitUntilCanceled = true };
        disarmWhileWaiting.Incoming.Add(new(1, ExeUpdateIpcKind.Disarm, disarmWhileWaiting.Offer.Handoff.Id));
        Require(await disarmWhileWaiting.Helper.RunAsync(default) == ExeUpdateHelperStatus.Disarmed &&
            disarmWhileWaiting.Log.Contains("Stopped") && !disarmWhileWaiting.Log.Contains("install"),
            "late Disarm joins parent-handle wait before Stopped and never races recovery");
        foreach (var fault in new[] { "read", "accept", "Ready", "Armed", "wait-parent", "reverify" }) {
            var f = new Fixture { Fault = fault };
            Require(await f.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !f.Log.Contains("install") && f.Log.Contains("dispose"), "pipe loss/early fault cannot install: " + fault);
        }
        foreach (var outcome in new[] { ExeUpdateInstallResult.Failed, ExeUpdateInstallResult.Uncertain }) {
            var f = new Fixture { InstallResult = outcome };
            Require(await f.Helper.RunAsync(default) == (outcome == ExeUpdateInstallResult.Failed ? ExeUpdateHelperStatus.InstallFailed : ExeUpdateHelperStatus.InstallUncertain) &&
                !f.Log.Contains("verify-installed") && !f.Log.Contains("relaunch"), "failed/uncertain installer is never retried/relaunched");
        }
        var uncertain = new Fixture { Fault = "install" };
        Require(await uncertain.Helper.RunAsync(default) == ExeUpdateHelperStatus.InstallUncertain && !uncertain.Log.Contains("relaunch"), "installer exception is uncertain, never ordinary refusal");
        using (var cancel = new CancellationTokenSource()) {
            var f = new Fixture { After = step => { if (step == "reverify") cancel.Cancel(); } };
            Require(await f.Helper.RunAsync(cancel.Token) == ExeUpdateHelperStatus.Refused && !f.Log.Contains("install"), "late cancellation before installer commit");
        }
        var signaled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var cancel = new CancellationTokenSource()) {
            var f = new Fixture { InstallWork = async () => { signaled.SetResult(); await finish.Task; } };
            var running = f.Helper.RunAsync(cancel.Token); await signaled.Task;
            cancel.Cancel(); Require(!running.IsCompleted, "cancellation cannot abandon/kill running installer");
            finish.SetResult();
            Require(await running == ExeUpdateHelperStatus.InstalledVerificationFailed && f.Log.Count(x => x == "install") == 1 && !f.Log.Contains("relaunch"), "join installer, preserve unknown postinstall verification");
        }
        var timeout = new Fixture(TimeSpan.FromMilliseconds(5)) { StallHandshake = true };
        Require(await timeout.Helper.RunAsync(default) == ExeUpdateHelperStatus.Refused && !timeout.Log.Contains("install"), "bounded handshake");
        Console.WriteLine("EXE helper/IPC pure synthetic tests passed; OS peer checks and process/install adapters not executed.");
    }

    private static async Task Codec()
    {
        var offer = Offer(); var id = offer.Handoff.Id;
        using var stream = new MemoryStream(); var codec = new ExeUpdateIpc(stream);
        await codec.WriteAsync(new(1, ExeUpdateIpcKind.Prepare, id, offer), default);
        stream.Position = 0;
        Require((await codec.ReadAsync(default)).Offer == offer, "private memory frame exact roundtrip");
        foreach (var raw in new[] {
            "{}", "null", "[]", "{\"protocolVersion\":1,\"protocolVersion\":1}",
            "{\"protocolVersion\":1,\"kind\":\"ready\",\"handoffId\":\""+id+"\"}",
            "{\"protocolVersion\":1,\"kind\":1,\"handoffId\":\""+id+"\"}",
            "{\"protocolVersion\":1,\"kind\":\"Ready\",\"handoffId\":\""+id+"\",\"token\":\"forbidden\"}",
            "{\"protocolVersion\":2,\"kind\":\"Ready\",\"handoffId\":\""+id+"\"}"
        }) await RejectRead(Encoding.UTF8.GetBytes(raw));
        foreach (var length in new[] { -1, 0, ExeUpdateIpc.MaximumFrameBytes + 1 }) {
            using var invalid = new MemoryStream(); var prefix = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(prefix, length);
            invalid.Write(prefix); invalid.Position = 0; await Refuses(() => new ExeUpdateIpc(invalid).ReadAsync(default));
        }
        await RejectRead("{\"protocolVersion\":1"u8.ToArray());
        using (var empty = new MemoryStream()) {
            try { await new ExeUpdateIpc(empty).ReadAsync(default); throw new Exception("Expected clean closure."); }
            catch (ExeUpdatePeerClosedException) { }
        }
        using (var partial = new MemoryStream(new byte[] { 1, 0 })) await Refuses(() => new ExeUpdateIpc(partial).ReadAsync(default));
        using (var partial = new PartialThenCancelStream()) using (var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(10)))
            await Refuses(() => new ExeUpdateIpc(partial).ReadAsync(cancel.Token));
        await Refuses(() => codec.WriteAsync(new(1, ExeUpdateIpcKind.Ready, id, offer), default));
        var wrong = offer with { Account = offer.Account with { SourceAlias = "portal" } };
        await Refuses(() => codec.WriteAsync(new(1, ExeUpdateIpcKind.Prepare, id, wrong), default));
    }
    private static async Task RejectRead(byte[] bytes)
    {
        using var stream = new MemoryStream(); var prefix = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(prefix, bytes.Length);
        stream.Write(prefix); stream.Write(bytes); stream.Position = 0; await Refuses(() => new ExeUpdateIpc(stream).ReadAsync(default));
    }
    private static async Task Refuses(Func<Task> work)
    { try { await work(); } catch (ExeUpdateProtocolException) { return; } throw new Exception("Expected strict IPC refusal."); }
    private static void Require(bool value, string reason) { if (!value) throw new Exception(reason); }
    private static ExeUpdateHelperOffer Offer()
    {
        var owner = new ExeUpdateInstalledOwner("S-1-5-21-111-222-333-1001", 1, "0.5.2.0", @"C:\synthetic\installed",
            "LedgeTop.Files.UnsignedPilotInstaller/1", new string('c', 64), new string('d', 40), new string('e', 64), new string('f', 64));
        var candidate = new ExeUpdateCandidate(owner, "pilot", new Uri("https://synthetic.invalid/"), "/api/app", "0.5.2.0", new(1234, 123456),
            new WindowsAppReleasePins("pilot", "0.5.3.0", 100, new string('a', 64), "\"exact-artifact\"", new string('b', 40), "exe"), @"C:\synthetic\update.exe");
        return new(new(Guid.NewGuid(), candidate), new("odqp1_" + new string('1', 64), "employee"));
    }
    private sealed class Fixture : IExeUpdateHelperPlatform, IExeUpdateIpc
    {
        internal readonly List<string> Log = [];
        internal readonly ExeUpdateHelperOffer Offer = ExeUpdateHelperTests.Offer();
        internal readonly List<ExeUpdateIpcFrame> Incoming;
        internal string? Fault, FalseAt;
        internal bool StallHandshake, WaitUntilCanceled, CorruptFinalControl, StallFinalControl;
        internal int? ParentExitCode = 0;
        internal Action<string>? After;
        internal Func<Task>? InstallWork;
        internal ExeUpdateInstallResult InstallResult = ExeUpdateInstallResult.Succeeded;
        internal ExeUpdateHelper Helper { get; }
        internal Fixture(TimeSpan? timeout = null)
        { Incoming = [new(1, ExeUpdateIpcKind.Prepare, Offer.Handoff.Id, Offer), new(1, ExeUpdateIpcKind.CommitExit, Offer.Handoff.Id), new(1, ExeUpdateIpcKind.ExitNow, Offer.Handoff.Id)]; Helper = new(this, this, timeout); }
        private void Step(string step) { Log.Add(step); if (Fault == step) throw new IOException("private adapter detail"); After?.Invoke(step); }
        public async Task<ExeUpdateIpcFrame> ReadAsync(CancellationToken token)
        { Step("read"); if (StallHandshake) await Task.Delay(Timeout.Infinite, token); if (Incoming.Count == 0) { if (StallFinalControl) await Task.Delay(Timeout.Infinite, token); if (CorruptFinalControl) throw new ExeUpdateProtocolException(); throw new ExeUpdatePeerClosedException(); } var next = Incoming[0]; Incoming.RemoveAt(0); return next; }
        public Task WriteAsync(ExeUpdateIpcFrame frame, CancellationToken token) { Step(frame.Kind.ToString()); return Task.CompletedTask; }
        public Task<bool> AcceptParentAsync(ExeUpdateHelperOffer offer, CancellationToken token) { Step("accept"); return Task.FromResult(FalseAt != "accept"); }
        public async Task<bool> WaitForParentExitAsync(ExeUpdateParentIdentity parent, CancellationToken token)
        { Step("wait-parent"); if (WaitUntilCanceled) await Task.Delay(Timeout.Infinite, token); return FalseAt != "wait-parent" && ExeUpdateExitPolicy.KnownCleanExit(true, ParentExitCode); }
        public Task<bool> ReverifyAfterExitAsync(ExeUpdateHelperOffer offer, CancellationToken token) { Step("reverify"); return Task.FromResult(FalseAt != "reverify"); }
        public async Task<ExeUpdateInstallResult> InstallOnceAsync(ExeUpdateHelperOffer offer) { Step("install"); if (InstallWork is { } work) await work(); return InstallResult; }
        public Task<bool> VerifyInstalledAsync(ExeUpdateHelperOffer offer, CancellationToken token) { token.ThrowIfCancellationRequested(); Step("verify-installed"); return Task.FromResult(FalseAt != "verify-installed"); }
        public Task<bool> RelaunchVerifiedAsync(ExeUpdateHelperOffer offer, CancellationToken token) { Step("relaunch"); return Task.FromResult(FalseAt != "relaunch"); }
        public ValueTask DisposeAsync() { Step("dispose"); return ValueTask.CompletedTask; }
    }
    private sealed class PartialThenCancelStream : Stream
    {
        private bool prefix;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            if (!prefix) { prefix = true; buffer.Span[0] = 1; buffer.Span[1] = 0; return 2; }
            await Task.Delay(Timeout.Infinite, token); return 0;
        }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
