namespace LedgeTop.Files;

/// <summary>
/// Resumes an exact published two-root removal. The selector records intent before each
/// root is touched, and the root callback must return only after exact native absence is
/// confirmed. An uncertain callback leaves its intent in place for inspection on retry.
/// </summary>
internal static class FreshGenerationRemovalCoordinator
{
    internal delegate Task<FreshGenerationPlan.RemovalReceipt?> RemoveExactRoot(FreshGenerationPlan.Generation generation,
        Func<bool> exactSelectorStillOwned, CancellationToken cancellationToken);

    internal static async Task<FreshGenerationIndexCodec.Index> RemoveAsync(
        FreshGenerationIndexCodec.Index expected,
        Func<FreshGenerationIndexCodec.Index> readCurrent,
        Func<FreshGenerationIndexCodec.Index, Task> publish,
        RemoveExactRoot removeExactRoot,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(readCurrent);
        ArgumentNullException.ThrowIfNull(publish);
        ArgumentNullException.ThrowIfNull(removeExactRoot);
        var current = expected;
        var candidate = current.State.New ?? throw new IOException("The fresh generation candidate is missing.");
        var ready = current.State.ReadyRoot;
        var prior = current.State.Old;
        if (current.State.Phase != FreshGenerationPlan.Phase.Published || current.ActiveGeneration != candidate.Id ||
            candidate.Scope != prior.Scope || ready is null)
            throw new IOException("Only the exact published fresh-files selector can be removed.");
        candidate = candidate with {
            ProfileRevision = ready.ProfileRevision,
            ProfileDocumentVolume = ready.ProfileDocumentVolume,
            ProfileDocumentFileId = ready.ProfileDocumentFileId,
            RootVolume = ready.Volume,
            RootFileId = ready.FileId,
            NamespaceClsid = ready.NamespaceClsid
        };

        bool Exact() => readCurrent() == current;
        async Task PublishRemoval(FreshGenerationPlan.RemovalPhase progress,
            FreshGenerationPlan.RemovalReceipt? candidateReceipt = null, FreshGenerationPlan.RemovalReceipt? priorReceipt = null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!Exact()) throw new IOException("The fresh-files selector changed during removal.");
            var next = current with {
                Revision = checked(current.Revision + 1),
                State = current.State with { Removal = progress,
                    CandidateRemoval = candidateReceipt ?? current.State.CandidateRemoval,
                    PriorRemoval = priorReceipt ?? current.State.PriorRemoval }
            };
            await publish(next).ConfigureAwait(false);
            current = next;
            if (!Exact()) throw new IOException("The fresh-files removal journal could not be confirmed.");
        }

        while (true) {
            cancellationToken.ThrowIfCancellationRequested();
            if (!Exact()) throw new IOException("The fresh-files selector changed during removal.");
            switch (current.State.Removal) {
                case null:
                    await PublishRemoval(FreshGenerationPlan.RemovalPhase.CandidateIntent).ConfigureAwait(false);
                    break;
                case FreshGenerationPlan.RemovalPhase.CandidateIntent:
                    var removedCandidate = await removeExactRoot(candidate, Exact, cancellationToken).ConfigureAwait(false);
                    if (!ValidReceipt(removedCandidate, candidate) || !Exact())
                        throw new IOException("The current files folder removal was not confirmed.");
                    await PublishRemoval(FreshGenerationPlan.RemovalPhase.CandidateRemoved, candidateReceipt: removedCandidate).ConfigureAwait(false);
                    break;
                case FreshGenerationPlan.RemovalPhase.CandidateRemoved:
                    var candidateProof = await removeExactRoot(candidate, Exact, cancellationToken).ConfigureAwait(false);
                    if (candidateProof != current.State.CandidateRemoval || !Exact())
                        throw new IOException("The current files folder removal receipt could not be reverified.");
                    await PublishRemoval(FreshGenerationPlan.RemovalPhase.PriorIntent).ConfigureAwait(false);
                    break;
                case FreshGenerationPlan.RemovalPhase.PriorIntent:
                    var priorIntentCandidateProof = await removeExactRoot(candidate, Exact, cancellationToken).ConfigureAwait(false);
                    if (priorIntentCandidateProof != current.State.CandidateRemoval || !Exact())
                        throw new IOException("The current files folder removal receipt could not be reverified.");
                    var removedPrior = await removeExactRoot(prior, Exact, cancellationToken).ConfigureAwait(false);
                    if (!ValidReceipt(removedPrior, prior) || !Exact())
                        throw new IOException("The previous files folder removal was not confirmed.");
                    await PublishRemoval(FreshGenerationPlan.RemovalPhase.Complete, priorReceipt: removedPrior).ConfigureAwait(false);
                    break;
                case FreshGenerationPlan.RemovalPhase.Complete:
                    // Idempotent verification: the callback must inspect the saved Removed
                    // receipt and native absence without replaying an uncertain unregister.
                    var verifiedCandidate = await removeExactRoot(candidate, Exact, cancellationToken).ConfigureAwait(false);
                    var verifiedPrior = await removeExactRoot(prior, Exact, cancellationToken).ConfigureAwait(false);
                    if (verifiedCandidate != current.State.CandidateRemoval || verifiedPrior != current.State.PriorRemoval || !Exact())
                        throw new IOException("Both files folders could not be verified removed.");
                    return current;
                default:
                    throw new IOException("The fresh-files removal journal is invalid.");
            }
        }
    }

    private static bool ValidReceipt(FreshGenerationPlan.RemovalReceipt? receipt, FreshGenerationPlan.Generation expected) =>
        receipt is { } actual && actual.GenerationId == expected.Id && actual.ProfileVolume == expected.ProfileDocumentVolume &&
        actual.ProfileFileId != 0 && actual.ProfileRevision == checked(expected.ProfileRevision + 2);
}
