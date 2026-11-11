using System.Security.Cryptography;
using System.Text;

namespace LedgeTop.Files.Tests;

// Pure fake-selector/root tests. These never construct an Explorer provider or invoke
// Cloud Files, Shell registration, credentials, or network operations.
internal static class FreshGenerationRemovalCoordinatorTests
{
    private sealed class Fixture
    {
        internal readonly FreshGenerationPlan.Generation Old;
        internal readonly FreshGenerationPlan.Generation Candidate;
        internal FreshGenerationIndexCodec.Index Current;
        internal readonly HashSet<Guid> Registered;
        internal readonly Dictionary<Guid, string> LocalFiles;
        internal readonly List<Guid> Attempts = [];
        internal readonly List<Guid> Unregistrations = [];
        internal int PublishCount;
        internal Fixture()
        {
            var temp = Path.Combine(Path.GetTempPath(), "generation-removal-" + Guid.NewGuid().ToString("N"));
            var origin = "https://example.invalid";
            var scope = new FreshGenerationPlan.Scope("pilot", "employee", origin, "odqp1_" + new string('a', 64));
            Old = Generation(Guid.NewGuid(), scope, Path.Combine(temp, "old-profile"), Path.Combine(temp, "old-root"), 'b', 100, 101, 100, 201, 100, 301, Guid.NewGuid());
            Candidate = Generation(Guid.NewGuid(), scope, Path.Combine(temp, "new-profile"), Path.Combine(temp, "new-root"), 'c', 100, 102, 100, 202, 0, 0, Guid.Empty);
            var prepared = FreshGenerationPlan.Prepare(new(Old, null, FreshGenerationPlan.Phase.OldActive), Candidate, scope, true, true);
            var ready = new FreshGenerationPlan.RootEvidence(100, 303, Guid.NewGuid(), 2, 100, 203);
            var state = FreshGenerationPlan.Publish(FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope,
                Candidate.Id, Candidate.ManifestDigest, Candidate.RootPath, ready, true), true);
            var legacy = Encoding.UTF8.GetBytes("synthetic retained schema-1 receipt");
            Current = new(2, FreshGenerationIndexCodec.Owner, "S-1-5-test", scope.Channel, scope.Source,
                Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(origin))), scope.Principal,
                Convert.ToHexStringLower(SHA256.HashData(legacy)), 4, state, Candidate.Id);
            _ = FreshGenerationIndexCodec.Encode(Current);
            Registered = [Old.Id, Candidate.Id];
            LocalFiles = new() { [Old.Id] = "prior local bytes", [Candidate.Id] = "candidate local bytes" };
        }
        internal async Task<FreshGenerationIndexCodec.Index> Run(Func<Guid, bool>? beforeRemove = null)
        {
            var current = Current;
            Task Publish(FreshGenerationIndexCodec.Index next)
            {
                if (next.Revision != current.Revision + 1 || next.State.Removal != FreshGenerationIndexStore.NextRemoval(current.State.Removal))
                    throw new IOException("Nonconsecutive fake selector transition.");
                _ = FreshGenerationIndexCodec.Encode(next);
                Current = current = next; PublishCount++; return Task.CompletedTask;
            }
            bool Exact() => Current == current;
            Task<FreshGenerationPlan.RemovalReceipt?> Remove(FreshGenerationPlan.Generation generation, Func<bool> selector, CancellationToken token)
            {
                token.ThrowIfCancellationRequested();
                if (!selector()) throw new IOException("Fake selector mismatch.");
                Attempts.Add(generation.Id);
                if (beforeRemove?.Invoke(generation.Id) == false) return Task.FromResult<FreshGenerationPlan.RemovalReceipt?>(null);
                if (Registered.Remove(generation.Id)) Unregistrations.Add(generation.Id);
                if (!Exact()) throw new IOException("Fake selector changed.");
                FreshGenerationPlan.RemovalReceipt? receipt = Registered.Contains(generation.Id) ? null :
                    new(generation.Id, generation.ProfileDocumentVolume, generation.ProfileDocumentFileId + 1000, generation.ProfileRevision + 2);
                return Task.FromResult(receipt);
            }
            return await FreshGenerationRemovalCoordinator.RemoveAsync(current, () => Current, Publish, Remove);
        }
        internal void CheckPreserved()
        {
            if (LocalFiles[Old.Id] != "prior local bytes" || LocalFiles[Candidate.Id] != "candidate local bytes")
                throw new Exception("Local files changed during registration removal.");
        }
    }

    internal static async Task Run()
    {
        var complete = new Fixture();
        var completed = await complete.Run();
        Require(completed.State.Removal == FreshGenerationPlan.RemovalPhase.Complete &&
            complete.Registered.Count == 0 && complete.Attempts.SequenceEqual(new[] {
                complete.Candidate.Id, complete.Candidate.Id, complete.Candidate.Id, complete.Old.Id,
                complete.Candidate.Id, complete.Old.Id }),
            "coordinator verifies both roots and idempotent completion");
        complete.CheckPreserved();

        // Candidate is removed once; a failure at the prior root leaves a durable
        // prior intent. Retry must not repeat candidate unregister.
        {
            var f = new Fixture(); var failedOnce = false;
            try { await f.Run(id => id != f.Old.Id || failedOnce ? true : (failedOnce = true) && false); throw new Exception("Injected prior-root failure was ignored."); }
            catch (IOException) { }
            Require(f.Current.State.Removal == FreshGenerationPlan.RemovalPhase.PriorIntent && !f.Registered.Contains(f.Candidate.Id), "partial removal retains prior intent");
            var candidateUnregistrations = f.Unregistrations.Count(id => id == f.Candidate.Id);
            var done = await f.Run();
            Require(done.State.Removal == FreshGenerationPlan.RemovalPhase.Complete && f.Unregistrations.Count(id => id == f.Candidate.Id) == candidateUnregistrations,
                "retry resumes only the remaining root");
            f.CheckPreserved();
        }

        // Ambiguous native outcome: callback throws after intent is durable. A later
        // unresolved inspection fails closed and never replays unregister.
        {
            var f = new Fixture();
            try { await f.Run(_ => throw new IOException("ambiguous native outcome")); throw new Exception("Ambiguous root outcome was ignored."); }
            catch (IOException) { }
            var intent = f.Current.State.Removal;
            var calls = f.Attempts.Count;
            try { await f.Run(_ => false); throw new Exception("Unconfirmed root removal was accepted."); }
            catch (IOException) { }
            Require(intent == FreshGenerationPlan.RemovalPhase.CandidateIntent && f.Current.State.Removal == intent && f.Attempts.Count == calls + 1,
                "ambiguous outcome retains intent for inspection and does not advance selector");
            f.CheckPreserved();
        }

        // Selector drift between root operations blocks progress and preserves the
        // journal, even when one root was already confirmed absent.
        {
            var f = new Fixture(); var altered = false;
            async Task PublishDrift(FreshGenerationIndexCodec.Index next)
            {
                await Task.CompletedTask;
                if (altered) throw new IOException();
                f.Current = next; altered = true;
            }
            var start = f.Current;
            try {
                await FreshGenerationRemovalCoordinator.RemoveAsync(start, () => f.Current, PublishDrift,
                    (generation, selector, token) => {
                        f.Registered.Remove(generation.Id);
                        FreshGenerationPlan.RemovalReceipt? receipt = new(generation.Id, generation.ProfileDocumentVolume,
                            generation.ProfileDocumentFileId + 1000, generation.ProfileRevision + 2);
                        return Task.FromResult<FreshGenerationPlan.RemovalReceipt?>(receipt);
                    });
                throw new Exception("Changed selector was accepted.");
            } catch (IOException) { }
            Require(f.Current.State.Removal == FreshGenerationPlan.RemovalPhase.CandidateIntent && f.Registered.Contains(f.Old.Id),
                "selector/journal uncertainty prevents prior root removal");
            f.CheckPreserved();
        }
    }

    private static FreshGenerationPlan.Generation Generation(Guid id, FreshGenerationPlan.Scope scope, string profile, string root,
        char digest, uint profileVolume, ulong profileId, uint documentVolume, ulong documentId, uint rootVolume, ulong rootId, Guid clsid) =>
        new(id, scope, profile, root, new string(digest, 64), profileVolume, profileId, 1, documentVolume, documentId, rootVolume, rootId, clsid);
    private static void Require(bool value, string label) { if (!value) throw new Exception(label); }
}
