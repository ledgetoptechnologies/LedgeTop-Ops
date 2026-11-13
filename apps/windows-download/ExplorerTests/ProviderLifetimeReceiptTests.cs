using LedgeTop.Files.Explorer;

internal static class ProviderLifetimeReceiptTests
{
    private sealed class Selector : IProviderWorkAuthority
    {
        internal bool Valid = true, Closed;
        public void VerifyHeld() { if (!Valid || Closed) throw new IOException("Selector unavailable."); }
        public void Dispose() { Closed = true; }
    }
    internal static async Task<int> RunAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var basePath = Path.Combine(Path.GetTempPath(), "LedgeTopLifetime-" + Guid.NewGuid().ToString("N"));
        var profile = Path.Combine(basePath, "profile"); var root = Path.Combine(basePath, "root");
        Directory.CreateDirectory(profile); Directory.CreateDirectory(root);
        var profileFile = Path.Combine(profile, "profile.json"); var manifestFile = Path.Combine(profile, "manifest.json");
        var sessionPath = Path.Combine(profile, "session.lock");
        File.WriteAllText(profileFile, "fixture"); File.WriteAllText(manifestFile, "fixture");
        FileStream? session = null; ConnectedGenerationHeldObservation? observation = null; IProviderWorkAuthority? selector = null;
        try {
            session = new FileStream(sessionPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var handles = ConnectedGenerationHandleLease.Open(profile, "manifest.json", root);
            var scope = new ExplorerRootScope("pilot", "employee", "https://example.invalid", "test");
            observation = new ConnectedGenerationHeldObservation(new ConnectedGenerationSnapshot(Guid.NewGuid(), profile, root,
                unchecked((long)handles.RootFileId), Guid.NewGuid(), new string('a', 64), scope, 1), handles);
            var actualSelector = new Selector(); selector = actualSelector; var owner = new object();
            bool allow = false, block = false;
            using var entered = new ManualResetEventSlim(); using var release = new ManualResetEventSlim();
            void Verify(FileStream s, ConnectedGenerationHeldObservation o) {
                o.Handles.VerifySessionLock(s, sessionPath); o.Handles.Recheck();
                if (!allow) throw new IOException("Synthetic proof refused.");
                if (block) { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Proof was not released."); }
            }
            var receipt = ProviderLifetimeReceipt.Take(owner, ref session, ref observation, ref selector, Verify);
            if (session is not null || observation is not null || selector is not null) throw new Exception("Resources not moved.");
            Refused(() => receipt.Reclaim(owner));
            var gate = new ProviderWorkAdmission(); Refused(() => gate.Activate(receipt));
            allow = true; gate.Activate(receipt); var ticket = gate.Enter();
            gate.StopAdmission(); var drain = gate.ReleaseAfterDrainAsync();
            if (drain.IsCompleted) throw new Exception("Drained with an active ticket.");
            Refused(() => receipt.Reclaim(owner));
            block = true;
            var verifying = Task.Run(receipt.VerifyHeld);
            if (!entered.Wait(TimeSpan.FromSeconds(5))) throw new Exception("Concurrent proof did not start.");
            try {
                ticket.Dispose();
                if (drain.IsCompleted) throw new Exception("Receipt drained while its proof was running.");
            } finally { release.Set(); }
            await verifying.WaitAsync(TimeSpan.FromSeconds(5)); await drain.WaitAsync(TimeSpan.FromSeconds(5)); block = false;
            Refused(receipt.VerifyHeld); Refused(() => receipt.Reclaim(new object()));
            allow = false; Refused(() => receipt.Reclaim(owner));
            allow = true; var reclaimed = receipt.Reclaim(owner);
            if (actualSelector.Closed) throw new Exception("Provider closed selector before session reclaim.");
            Refused(() => receipt.Reclaim(owner));
            reclaimed.Selector.Dispose(); reclaimed.Observation.Dispose(); reclaimed.Session.Dispose();
            using var probe = new FileStream(sessionPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            Console.WriteLine("PASS post-drain receipt retains exact session, observation and selector until owner reclaim."); return 0;
        } finally {
            selector?.Dispose(); observation?.Dispose(); session?.Dispose();
            foreach (var p in new[] { profileFile, manifestFile, sessionPath }) if (File.Exists(p)) File.Delete(p);
            Directory.Delete(profile); Directory.Delete(root); Directory.Delete(basePath);
        }
    }
    private static void Refused(Action action) { try { action(); } catch (IOException) { return; } throw new Exception("Expected refusal."); }
}
