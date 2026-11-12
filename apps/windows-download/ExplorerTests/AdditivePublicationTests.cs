using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class AdditivePublicationTests
{
    internal static async Task<int> RunAsync()
    {
        foreach (var mode in new[] { "effect", "commit", "conflict", "authority", "torn", "tamper" }) await Scenario(mode);
        Console.WriteLine("PASS additive disk journal interruption, conflict, authority and binding checks; fake native/profile surface only.");
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
        var plan = new AdditivePublicationPlan(Guid.NewGuid(), previous, candidate); var journal = new AdditiveDiskJournal(root, plan.Id); var surface = new Surface(previous.Digest);
        try {
            if (mode == "effect") surface.InterruptCreate = true;
            if (mode == "commit") surface.InterruptCommit = true;
            if (mode == "conflict") surface.Conflict = true;
            if (mode == "authority") surface.Deny = true;
            if (mode == "tamper") surface.Binding = candidate.Digest;
            if (mode == "torn") File.WriteAllText(Path.Combine(root, $"addition-{plan.Id:N}-00001.json"), "{");
            try { await new AdditivePublication(journal, surface).ExecuteAsync(plan); throw new IOException("expected hold"); }
            catch (IOException error) when (error.Message != "expected hold") { }
            if (mode is "effect" or "commit") {
                var count = surface.Creates; surface.InterruptCreate = surface.InterruptCommit = false;
                using var resumed = new AdditiveDiskJournal(root, plan.Id);
                if (!await new AdditivePublication(resumed, surface).ExecuteAsync(plan) || surface.Binding != candidate.Digest)
                    throw new IOException("restart did not finish");
                if (mode == "effect" && surface.Creates != count + 1 || mode == "commit" && surface.Creates != count)
                    throw new IOException("restart repeated or skipped a creation");
            } else if (surface.Creates != 0 || surface.Binding != (mode == "tamper" ? candidate.Digest : previous.Digest))
                throw new IOException("held transaction changed data");
        } finally { journal.Dispose(); foreach (var file in Directory.GetFiles(root)) File.Delete(file); Directory.Delete(root); }
    }
    private sealed class Surface(string binding) : IAdditivePublicationSurface
    {
        private readonly HashSet<string> created = new(StringComparer.OrdinalIgnoreCase);
        internal string Binding = binding; internal bool InterruptCreate, InterruptCommit, Conflict, Deny; internal int Creates;
        public Task VerifyOwnershipAndManifestsAsync(AdditivePublicationPlan plan, CancellationToken token) => Task.CompletedTask;
        public Task VerifyFreshAuthorityAsync(AdditivePublicationPlan plan, AdditiveEntry? entry, CancellationToken token) => Deny ? Task.FromException(new IOException("denied")) : Task.CompletedTask;
        public Task<AdditiveObservation> InspectAsync(AdditivePublicationPlan plan, AdditiveEntry entry, CancellationToken token) => Task.FromResult(Conflict ? AdditiveObservation.Conflict : created.Contains(entry.Path) ? AdditiveObservation.ExactOwned : AdditiveObservation.Absent);
        public Task CreateIfAbsentAsync(AdditivePublicationPlan plan, AdditiveEntry entry, CancellationToken token) { Creates++; created.Add(entry.Path); if (InterruptCreate) throw new IOException("interrupted after create"); return Task.CompletedTask; }
        public Task<string> ReadBindingDigestAsync(CancellationToken token) => Task.FromResult(Binding);
        public Task<bool> CompareExchangeBindingAsync(AdditivePublicationPlan plan, CancellationToken token) { if (Binding != plan.Previous.Digest) return Task.FromResult(false); Binding = plan.Candidate.Digest; if (InterruptCommit) throw new IOException("interrupted after commit"); return Task.FromResult(true); }
    }
}
