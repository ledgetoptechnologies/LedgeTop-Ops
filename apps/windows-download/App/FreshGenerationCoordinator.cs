using System.Security.Cryptography;

namespace LedgeTop.Files;

// This coordinator is not exposed by production UI. The adapter must supply exact held
// filesystem/registration proofs; no such production adapter is currently qualified.
internal interface IFreshGenerationCoordinatorAdapter
{
    Task<FreshGenerationCandidate> CaptureAndReserveAsync(FreshGenerationPlan.Scope expected, CancellationToken token);
    Task<bool> DrainPriorAsync(FreshGenerationPlan.Generation expected, CancellationToken token);
    Task<FreshGenerationReady> StartAndObserveAsync(FreshGenerationPlan.Generation expected, CancellationToken token);
    Task<FreshGenerationPlan.Scope> RecheckAuthenticatedScopeAsync(CancellationToken token);
}
internal sealed record FreshGenerationCandidate(FreshGenerationPlan.Generation Generation,
    FreshGenerationPlan.Scope AuthenticatedScope, bool FilesystemSeparationVerified);
internal sealed record FreshGenerationReady(Guid GenerationId, string ManifestDigest, string RootPath,
    FreshGenerationPlan.RootEvidence Root, bool OwnedReady);

internal static class FreshGenerationCoordinator
{
    // On a failure or cancellation, no compensation/unregister/remove is attempted. The
    // adapter retains exact sessions and the caller keeps the durable selector for review.
    internal static async Task<FreshGenerationIndexCodec.Index> ExecuteAsync(string ownedIndexDirectory, byte[] legacyBytes,
        FreshGenerationIndexStore.LegacyBinding legacy, Func<bool> exactLeaseOwned,
        Func<byte[], FreshGenerationIndexStore.LegacyBinding?> verifyLegacy,
        IFreshGenerationCoordinatorAdapter adapter, bool explicitOptIn, CancellationToken token)
    {
        if (!explicitOptIn) throw new IOException("Fresh connection was not explicitly requested.");
        ArgumentNullException.ThrowIfNull(adapter); ArgumentNullException.ThrowIfNull(legacy);
        ArgumentNullException.ThrowIfNull(legacyBytes);
        using var ownership = adapter is FreshGenerationOwnedAdapter owned
            ? await owned.HoldTransitionAsync(token).ConfigureAwait(false) : null;
        var immutableLegacyBytes = legacyBytes.ToArray();
        token.ThrowIfCancellationRequested();
        var old = legacy.Old;
        var candidate = await adapter.CaptureAndReserveAsync(old.Scope, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        var planned = FreshGenerationPlan.Prepare(new(old, null, FreshGenerationPlan.Phase.OldActive), candidate.Generation,
            candidate.AuthenticatedScope, explicitOptIn, candidate.FilesystemSeparationVerified);
        var index = new FreshGenerationIndexCodec.Index(2, FreshGenerationIndexCodec.Owner, legacy.Sid, legacy.Channel,
            legacy.Source, legacy.OriginSha256, legacy.Principal, Convert.ToHexStringLower(SHA256.HashData(immutableLegacyBytes)),
            checked(legacy.Revision + 1), planned, old.Id);
        var bytes = await FreshGenerationIndexStore.PublishAsync(ownedIndexDirectory, immutableLegacyBytes, index,
            exactLeaseOwned, verifyLegacy).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!await adapter.DrainPriorAsync(old, token).ConfigureAwait(false)) throw new IOException("Prior provider did not confirm drain.");
        token.ThrowIfCancellationRequested();
        index = index with { Revision = checked(index.Revision + 1), State = FreshGenerationPlan.Drained(index.State, true) };
        bytes = await FreshGenerationIndexStore.PublishAsync(ownedIndexDirectory, bytes, index, exactLeaseOwned, verifyLegacy).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        var rechecked = await adapter.RecheckAuthenticatedScopeAsync(token).ConfigureAwait(false);
        if (rechecked != old.Scope) throw new IOException("Authenticated scope changed.");
        token.ThrowIfCancellationRequested();
        var ready = await adapter.StartAndObserveAsync(candidate.Generation, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        rechecked = await adapter.RecheckAuthenticatedScopeAsync(token).ConfigureAwait(false);
        index = index with { Revision = checked(index.Revision + 1), State = FreshGenerationPlan.Ready(index.State,
            rechecked, ready.GenerationId, ready.ManifestDigest, ready.RootPath, ready.Root, ready.OwnedReady) };
        bytes = await FreshGenerationIndexStore.PublishAsync(ownedIndexDirectory, bytes, index, exactLeaseOwned, verifyLegacy).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        index = index with { Revision = checked(index.Revision + 1), State = FreshGenerationPlan.Publish(index.State, true), ActiveGeneration = candidate.Generation.Id };
        _ = await FreshGenerationIndexStore.PublishAsync(ownedIndexDirectory, bytes, index, exactLeaseOwned, verifyLegacy).ConfigureAwait(false);
        return index;
    }
}
