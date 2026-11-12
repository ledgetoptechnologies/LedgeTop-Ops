using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class AdditivePublicationTests
{
    internal static async Task<int> RunAsync()
    {
        foreach (var mode in new[] { "success", "before", "before-parent", "replace-after-create", "deleted", "foreign-identical", "parent", "file", "lost-tail", "earlier", "revoked", "null-fence", "commit", "conflict", "authority", "torn", "tamper", "wrong-root" }) await Scenario(mode);
        Console.WriteLine("PASS additive disk journal holds interrupted intent and checks postimages, authority, root and binding; fake native/profile surface only.");
        return 0;
    }
    private static async Task Scenario(string mode)
    {
        var root = Path.Combine(Path.GetTempPath(), "lt-add-journal-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var scope = new ExplorerRootScope("pilot", "employee", "https://source.example.invalid", "odqp1_" + new string('a', 64));
        var sha = new string('b', 64);
        var item = new PlaceholderIdentity(scope.Channel, scope.Alias, scope.Origin, scope.PrincipalId, "odqr1_test", "oef1_" + new string('c', 64), sha, "new.bin", 1, "\"" + sha + "\"", sha);
        var previous = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity>());
        var candidate = new ExplorerRootManifest(scope, new Dictionary<string, PlaceholderIdentity> { ["folder\\new.bin"] = item });
        var pins = new AdditiveRootPins("S-1-5-21-test", Guid.NewGuid(), Guid.NewGuid(), 1, 2, 3);
        var plan = new AdditivePublicationPlan(Guid.NewGuid(), pins, previous, candidate);
        var journal = new AdditiveDiskJournal(root, plan.Id); var surface = new Surface(previous.Digest, pins);
        try {
            surface.ThrowBeforeCreate = mode == "before";
            surface.ChangeParentBeforeCreate = mode == "before-parent";
            surface.ReplaceAfterCreate = mode == "replace-after-create";
            surface.InterruptCreate = mode is "deleted" or "foreign-identical" or "parent" or "file" or "lost-tail";
            surface.ChangeEarlier = mode == "earlier"; surface.InterruptCommit = mode == "commit";
            surface.RevokeAfterCreates = mode == "revoked"; surface.NullFence = mode == "null-fence";
            surface.Conflict = mode == "conflict"; surface.Deny = mode == "authority";
            if (mode == "tamper") surface.Binding = candidate.Digest;
            if (mode == "wrong-root") surface.Root = pins with { RootFileId = 99 };
            if (mode == "torn") File.WriteAllText(Path.Combine(root, $"addition-{plan.Id:N}-00001.json"), "{");
            if (mode == "success") {
                if (!await new AdditivePublication(journal, surface).ExecuteAsync(plan) || surface.Binding != candidate.Digest || surface.Creates != 2 ||
                    journal.Read().Last().Kind != AdditiveRecordKind.Committed) throw new IOException("clean publication failed");
                using var resumed = new AdditiveDiskJournal(root, plan.Id);
                if (!await new AdditivePublication(resumed, surface).ExecuteAsync(plan) || surface.Creates != 2) throw new IOException("clean restart repeated work");
                return;
            }
            await MustHold(() => new AdditivePublication(journal, surface).ExecuteAsync(plan));
            if (mode is "before" or "before-parent" or "replace-after-create" or "deleted" or "foreign-identical" or "parent" or "file" or "lost-tail") {
                // Every uncertain intent holds, regardless of the current path appearance.
                if (mode == "deleted") surface.Created.Clear();
                if (mode == "foreign-identical") surface.Created[plan.Entries[0].Path] = new(1, 11, 12, new string('d', 64));
                if (mode == "parent") surface.Created[plan.Entries[0].Path] = new(1, 99, 12, new string('d', 64));
                if (mode == "file") surface.Created[plan.Entries[0].Path] = new(1, 11, 99, new string('d', 64));
                if (mode == "lost-tail") File.Delete(Path.Combine(root, $"addition-{plan.Id:N}-00002.json"));
                surface.ThrowBeforeCreate = surface.InterruptCreate = false; var calls = surface.Creates;
                using var resumed = new AdditiveDiskJournal(root, plan.Id);
                await MustHold(() => new AdditivePublication(resumed, surface).ExecuteAsync(plan));
                if (surface.Creates != calls || surface.Binding != previous.Digest) throw new IOException("uncertain intent was retried");
            } else if (mode == "commit") {
                var count = surface.Creates; surface.InterruptCommit = false;
                using var resumed = new AdditiveDiskJournal(root, plan.Id);
                if (!await new AdditivePublication(resumed, surface).ExecuteAsync(plan) || surface.Binding != candidate.Digest || surface.Creates != count)
                    throw new IOException("committed restart did not validate and finish");
            } else if (mode is "earlier" or "revoked" or "null-fence") {
                if (surface.Binding != previous.Digest) throw new IOException("unverified entries were committed");
            } else if (surface.Creates != 0 || surface.Binding != (mode == "tamper" ? candidate.Digest : previous.Digest))
                throw new IOException("held transaction changed data");
        } finally { journal.Dispose(); foreach (var file in Directory.GetFiles(root)) File.Delete(file); Directory.Delete(root); }
    }
    private static async Task MustHold(Func<Task<bool>> action) { try { await action(); } catch (IOException) { return; } throw new IOException("expected hold"); }
    private sealed class Surface(string binding, AdditiveRootPins root) : IAdditivePublicationSurface
    {
        internal readonly Dictionary<string, AdditivePostimage> Created = new(StringComparer.OrdinalIgnoreCase);
        internal string Binding = binding; internal AdditiveRootPins Root = root;
        private AdditiveJournalHead? head;
        internal bool ThrowBeforeCreate, ChangeParentBeforeCreate, ReplaceAfterCreate, InterruptCreate, InterruptCommit, Conflict, Deny, ChangeEarlier, RevokeAfterCreates, NullFence; internal int Creates;
        public Task VerifyOwnershipAndManifestsAsync(AdditivePublicationPlan plan, CancellationToken token) => Root != plan.Root ? Task.FromException(new IOException("wrong root")) : Task.CompletedTask;
        public Task VerifyJournalHeadAsync(AdditivePublicationPlan plan, AdditiveJournalHead expected, CancellationToken token) =>
            head is null ? expected.Count == 0 ? Task.CompletedTask : Task.FromException(new IOException("journal head missing")) : head != expected ? Task.FromException(new IOException("journal head differs")) : Task.CompletedTask;
        public Task AcknowledgeJournalHeadAsync(AdditivePublicationPlan plan, AdditiveJournalHead expected, CancellationToken token) { head = expected; return Task.CompletedTask; }
        public Task VerifyFreshAuthorityAsync(AdditivePublicationPlan plan, AdditiveEntry? entry, CancellationToken token) => Deny || RevokeAfterCreates && Creates == 2 ? Task.FromException(new IOException("denied")) : Task.CompletedTask;
        public Task<IAsyncDisposable> AcquireCommitFenceAsync(AdditivePublicationPlan plan, CancellationToken token) => Deny ? Task.FromException<IAsyncDisposable>(new IOException("denied")) : Task.FromResult<IAsyncDisposable>(NullFence ? null! : new Fence());
        public Task<AdditiveInspection> InspectAsync(AdditivePublicationPlan plan, AdditiveEntry entry, CancellationToken token) => Task.FromResult(Conflict ? new AdditiveInspection(AdditiveObservation.Conflict, null, null) : Created.TryGetValue(entry.Path, out var post) ? new(AdditiveObservation.ExactOwned, post, null) : new(AdditiveObservation.Absent, null, new(1, 11, new string('e', 64))));
        public Task<AdditiveInspection> InspectCreatedAsync(AdditivePublicationPlan plan, AdditiveEntry entry, IAdditiveCreatedLease lease, CancellationToken token) => InspectAsync(plan, entry, token);
        public Task<IAdditiveCreatedLease> CreateIfAbsentAsync(AdditivePublicationPlan plan, AdditiveEntry entry, AdditiveAbsenceProof expectedParent, CancellationToken token) {
            if (ThrowBeforeCreate) throw new IOException("interrupted before effect");
            if (ChangeParentBeforeCreate || expectedParent.Volume != 1 || expectedParent.ParentFileId != 11) throw new IOException("parent changed before create");
            Creates++; var receipt = new AdditivePostimage(1, 11, (ulong)(11 + Creates), new string('d', 64)); Created.Add(entry.Path, receipt);
            if (ReplaceAfterCreate) Created[entry.Path] = receipt with { FileId = 999 };
            if (ChangeEarlier && Creates == 2) Created[plan.Entries[0].Path] = new(1, 99, 12, new string('d', 64));
            if (InterruptCreate) throw new IOException("interrupted after effect"); return Task.FromResult<IAdditiveCreatedLease>(new CreatedLease(receipt));
        }
        public Task<string> ReadBindingDigestAsync(CancellationToken token) => Task.FromResult(Binding);
        public Task<bool> CompareExchangeBindingAsync(AdditivePublicationPlan plan, CancellationToken token) { if (Binding != plan.Previous.Digest) return Task.FromResult(false); Binding = plan.Candidate.Digest; if (InterruptCommit) throw new IOException("interrupted after commit"); return Task.FromResult(true); }
        private sealed class Fence : IAsyncDisposable { public ValueTask DisposeAsync() => ValueTask.CompletedTask; }
        private sealed class CreatedLease(AdditivePostimage image) : IAdditiveCreatedLease { public AdditivePostimage CreatedPostimage => image; public ValueTask DisposeAsync() => ValueTask.CompletedTask; }
    }
}
