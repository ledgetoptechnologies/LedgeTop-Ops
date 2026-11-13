using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

internal sealed record FencedShutdownObservation(bool ObservationTimedOut, bool ProviderDrainConfirmed,
    bool CancellationSettled, bool CancellationFailed, bool ShutdownTaskFinished, bool ShutdownTaskFailed);

// Disabled composition: the caller must retain this object, its selector lease,
// both sessions and their provider tasks on every outcome. This does not yet
// expose an operational ConnectedExplorerSession or support updates/uninstall.
internal sealed class FreshGenerationColdRestart
{
    // Deliberately false until selector/root fencing, session lifecycle, update
    // handoff and provider recovery have all passed qualification.
    private readonly OwnedExplorerRootSession prior, current;
    private readonly FreshGenerationIndexCodec.Index selector;
    private readonly Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate;
    private readonly Func<bool> selectorProof, qualified;
    private readonly bool synthetic;
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    private int attempted;
    private bool priorAttempted, currentAttempted, priorHeld, currentHeld, priorStopped, currentStopped;
    private bool priorDisposed, currentDisposed;
    private OwnedExplorerRootSession.FencedRestartReceipt? fencedReceipt;
    private FreshGenerationSelectorLease? fencedSelectorLease;
    private readonly CancellationTokenSource fencedLifetime = new();
    private readonly object fencedLifetimeSync = new();
    private Task? fencedCancellation, fencedShutdown;
    private bool fencedDrainConfirmed;
    private bool fencedConnectAttempted;
    private readonly Guid fencedConnectAttempt = Guid.NewGuid();
    private bool fencedLifetimeDisposed;
    private static readonly TimeSpan FencedCancellationDeadline = TimeSpan.FromSeconds(5);
    private FreshGenerationColdRestart(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate,
        Func<bool> selectorProof, Func<bool> qualified, bool synthetic = false)
    { this.prior = prior; this.current = current; this.selector = selector; this.authenticate = authenticate; this.selectorProof = selectorProof; this.qualified = qualified; this.synthetic = synthetic; }
    internal static FreshGenerationColdRestart CreateDisabled(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate) =>
        new(prior, current, selector, authenticate, () => false, () => false);
    internal static FreshGenerationColdRestart CreateForSession(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate, Func<bool> selectorProof) =>
        new(prior, current, selector, authenticate, selectorProof, () => FreshGenerationStagingQualification.Allows(selector.State.Old.Scope));
    internal static FreshGenerationColdRestart CreateForFencedSession(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate, FreshGenerationSelectorLease lease)
    {
        var owned = lease.Transfer();
        try { return new(prior, current, selector, authenticate, () => { owned.Verify(); return true; }, () => FreshGenerationStagingQualification.Allows(selector.State.Old.Scope)) { fencedSelectorLease = owned }; }
        catch (Exception original) { FreshGenerationSelectorLease.CleanupAfterFailure(original, owned); throw; }
    }
#if DEBUG && !LEDGETOP_PACKAGED_BUILD
    // Synthetic test seam: both supplied sessions must already hold generated-only
    // observations. It does not admit a production factory or native startup.
    internal static FreshGenerationColdRestart CreateSyntheticHeldForTest(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<bool> selectorProof) =>
        new(prior, current, selector, _ => throw new InvalidOperationException(), selectorProof, () => true, synthetic: true) {
            attempted = 1, priorAttempted = true, currentAttempted = true, priorHeld = true, currentHeld = true
        };
    internal static FreshGenerationColdRestart CreateSyntheticPartialForTest(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<bool> selectorProof, bool currentAttempted) =>
        new(prior, current, selector, _ => throw new InvalidOperationException(), selectorProof, () => true, synthetic: true) {
            attempted = 1, priorAttempted = true, priorHeld = true, currentAttempted = currentAttempted
        };
#endif
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
    internal static FreshGenerationColdRestart CreateSyntheticFencedForTest(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate, FreshGenerationSelectorLease lease)
    {
        if (!prior.IsSyntheticFixtureForTest || !current.IsSyntheticFixtureForTest) throw new InvalidOperationException();
        var owned = lease.Transfer();
        try { return new(prior, current, selector, authenticate, () => { owned.Verify(); return true; }, () => true, synthetic: true) {
            priorAttempted = true, currentAttempted = true, priorHeld = true, currentHeld = true, fencedSelectorLease = owned
        }; } catch (Exception original) { FreshGenerationSelectorLease.CleanupAfterFailure(original, owned); throw; }
    }
#endif
    internal void VerifyCapability() { if (!qualified()) throw new IOException("Fresh generation restart is not qualified."); }
    internal bool MatchesSelector(FreshGenerationIndexCodec.Index expected) => selector == expected;
    internal OwnedExplorerRootSession CurrentSession => current;
    internal bool SyntheticForTest => synthetic;
    internal bool HasFencedReceipt => fencedReceipt is not null;
    // Observed only after VerifyAndConnectFencedAsync has settled under the parent operation lock.
    internal bool CanStopWithoutReceipt => fencedReceipt is null && (!fencedConnectAttempted || current.FailedFencedAttemptDrained(fencedConnectAttempt) || Volatile.Read(ref fencedDrainConfirmed));
    internal void VerifyFencedSelector() => (fencedSelectorLease ?? throw new IOException("Held selector is required.")).Verify();
    internal void RequestFencedOwnerStop() { _ = RequestFencedCancellation(); }
    internal async Task PublishCommittedFencedAsync()
    {
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try { await current.PublishHeldFencedAsync(fencedReceipt ?? throw new IOException("No fenced restart is retained.")).ConfigureAwait(false); }
        finally { lifecycle.Release(); }
    }
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
    internal void DisposeSelectorForTest() { if (!synthetic) throw new InvalidOperationException(); (fencedSelectorLease ?? throw new IOException()).Dispose(); }
    internal void TransferSelectorForTest() {
        if (!synthetic) throw new InvalidOperationException();
        var transferred = (fencedSelectorLease ?? throw new IOException()).Transfer();
        transferred.Dispose();
        throw new InvalidOperationException("A busy selector unexpectedly transferred.");
    }
    internal void CancelFencedOwnerForTest() { if (!synthetic) throw new InvalidOperationException(); fencedLifetime.Cancel(); }
    internal CancellationTokenRegistration RegisterFencedOwnerCallbackForTest(Action callback) { if (!synthetic) throw new InvalidOperationException(); return fencedLifetime.Token.Register(callback); }
    // Fixture teardown only; production never erases uncertain outcomes.
    internal void ResetFencedFailuresForFixture()
    {
        if (!synthetic) throw new InvalidOperationException();
        lock (fencedLifetimeSync) {
            if (fencedShutdown is { IsCompleted: false } || fencedCancellation is { IsCompleted: false }) throw new InvalidOperationException();
            if (fencedShutdown is { IsFaulted: true }) fencedShutdown = null;
            if (fencedCancellation is { IsFaulted: true }) fencedCancellation = Task.CompletedTask;
        }
    }
#endif
    private Task RequestFencedCancellation()
    {
        lock (fencedLifetimeSync) {
            if (fencedCancellation is not null) return fencedCancellation;
            if (fencedLifetimeDisposed) return fencedCancellation = Task.FromException(new IOException("Fenced lifetime was disposed without confirmed cancellation."));
            try { return fencedCancellation = fencedLifetime.CancelAsync(); }
            catch (Exception error) { return fencedCancellation = Task.FromException(error); }
        }
    }
    internal Task AbortFencedAsync()
    {
        lock (fencedLifetimeSync) {
            if (fencedShutdown is not null) return fencedShutdown;
            // CancelAsync marks the owner canceled before returning. Provider
            // pause/drain may invoke arbitrary callbacks, so never enter that
            // work synchronously on the bounded observer's caller thread.
            var cancellation = RequestFencedCancellation();
            return fencedShutdown = Task.Run(() => AbortFencedCoreAsync(cancellation));
        }
    }
    // The bounded observer never cancels, replaces or abandons the retained
    // shutdown task. A later call observes the same attempt and eventual drain.
    internal async Task<FencedShutdownObservation> ObserveFencedShutdownAsync(TimeSpan timeout, CancellationToken token)
    {
        if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(30)) throw new ArgumentOutOfRangeException(nameof(timeout));
        token.ThrowIfCancellationRequested();
        var shutdown = AbortFencedAsync(); var timedOut = false;
        try { await shutdown.WaitAsync(timeout, token).ConfigureAwait(false); }
        catch (TimeoutException) { timedOut = true; }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { /* Report bounded facts, never infer completion from an error. */ }
        Task? cancellation; lock (fencedLifetimeSync) cancellation = fencedCancellation;
        return new(timedOut, Volatile.Read(ref fencedDrainConfirmed), cancellation?.IsCompleted == true,
            cancellation?.IsFaulted == true || cancellation?.IsCanceled == true, shutdown.IsCompleted, shutdown.IsFaulted || shutdown.IsCanceled);
    }
    private async Task AbortFencedCoreAsync(Task cancellation)
    {
        Exception? drainFailure = null, cancellationFailure = null;
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            if (fencedReceipt is null) {
                if (currentAttempted && !fencedDrainConfirmed) throw new IOException("A current provider outcome is unconfirmed.");
            } else {
                await current.AbortFencedHeldRestartAsync(fencedReceipt).ConfigureAwait(false);
                fencedReceipt = null; Volatile.Write(ref fencedDrainConfirmed, true);
            }
        } catch (Exception error) { drainFailure = error; }
        finally { lifecycle.Release(); }
        try { await cancellation.WaitAsync(FencedCancellationDeadline).ConfigureAwait(false); } catch (Exception error) { cancellationFailure = error; }
        if (drainFailure is not null && cancellationFailure is not null) throw new AggregateException("Fenced provider drain and cancellation both failed; ownership remains retained.", drainFailure, cancellationFailure);
        if (drainFailure is not null) throw new IOException("Fenced provider drain is unconfirmed; ownership remains retained.", drainFailure);
        if (cancellationFailure is TimeoutException) throw new IOException("Fenced provider drained, but cancellation callbacks have not finished; lifetime remains retained.", cancellationFailure);
        if (cancellationFailure is not null) throw new IOException("Fenced provider drained, but cancellation callbacks reported an error.", cancellationFailure);
    }
    // Unwired post-connect commit. The retained restart owns the gate lifetime;
    // the caller supplies only cancellation for this one operation.
    internal async Task CommitFencedAsync(CancellationToken token)
    {
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            VerifyCapability();
            var receipt = fencedReceipt ?? throw new IOException("No fenced restart is retained.");
            try {
            var owner = fencedLifetime.Token;
            token.ThrowIfCancellationRequested(); owner.ThrowIfCancellationRequested();
            using var selectorOperation = (fencedSelectorLease ?? throw new IOException("Held selector is required.")).Begin(selector);
            var state = selector.State; var next = state.New ?? throw new IOException("Candidate missing.");
            var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
            bool PriorAndSelector() {
                token.ThrowIfCancellationRequested(); owner.ThrowIfCancellationRequested(); selectorOperation.Verify();
                return Matches(prior.RecheckExistingRestartObservation(), state.Old, state.Old.RootVolume, state.Old.RootFileId,
                    state.Old.NamespaceClsid, state.Old.ProfileRevision, state.Old.ProfileDocumentVolume, state.Old.ProfileDocumentFileId);
            }
            bool CurrentMatches(RestartGenerationEvidence e) => Matches(e, next, ready.Volume, ready.FileId,
                ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId);
                if (!PriorAndSelector() || !CurrentMatches(current.RecheckExistingRestartObservation())) throw new IOException("Held restart ownership changed.");
                var scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested(); owner.ThrowIfCancellationRequested();
                if (scope != state.Old.Scope || scope != next.Scope || !PriorAndSelector() || !CurrentMatches(current.RecheckExistingRestartObservation()))
                    throw new IOException("Restart account or ownership changed before commit.");
                await current.CommitHeldFencedAsync(receipt, owner, PriorAndSelector, token).ConfigureAwait(false);
                owner.ThrowIfCancellationRequested();
            } catch (Exception error) {
                try { await current.AbortFencedHeldRestartAsync(receipt).ConfigureAwait(false); fencedReceipt = null; Volatile.Write(ref fencedDrainConfirmed, true); }
                catch (Exception abort) { throw new AggregateException("Fenced restart abort is uncertain; both generations remain retained.", error, abort); }
                throw;
            }
        } finally { lifecycle.Release(); }
    }

    // Unwired composition: a successful result remains paused and retains both
    // generations. Authentication here is the supplied session check, not
    // evidence of a fresh server-side revocation decision.
    internal async Task VerifyAndConnectFencedAsync(CancellationToken token)
    {
        await lifecycle.WaitAsync(token).ConfigureAwait(false);
        try {
            VerifyCapability();
            if (Interlocked.Exchange(ref attempted, 1) != 0) throw new IOException("A restart was already attempted; retain ownership for review.");
            using var selectorOperation = (fencedSelectorLease ?? throw new IOException("Held selector is required.")).Begin(selector);
            bool ExactSelector() { selectorOperation.Verify(); return true; }
            var state = selector.State; var next = state.New ?? throw new IOException("Candidate missing.");
            var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
            if (state.Phase != FreshGenerationPlan.Phase.Published || selector.ActiveGeneration != next.Id || !ExactSelector())
                throw new IOException("Published selector is unavailable.");
            var scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
            if (scope != state.Old.Scope || scope != next.Scope || !ExactSelector()) throw new IOException("Restart account or selector changed.");
            priorAttempted = true;
            var old = priorHeld ? prior.RecheckExistingRestartObservation() : prior.AcquireExistingRestartObservation(); priorHeld = true;
            bool OldMatches(RestartGenerationEvidence e) => Matches(e, state.Old, state.Old.RootVolume, state.Old.RootFileId,
                state.Old.NamespaceClsid, state.Old.ProfileRevision, state.Old.ProfileDocumentVolume, state.Old.ProfileDocumentFileId);
            if (!OldMatches(old)) throw new IOException("Prior generation differs from selector.");
            currentAttempted = true;
            var candidate = currentHeld ? current.RecheckExistingRestartObservation() : current.AcquireExistingRestartObservation(); currentHeld = true;
            bool NewMatches(RestartGenerationEvidence e) => Matches(e, next, ready.Volume, ready.FileId,
                ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId);
            if (!NewMatches(candidate) || !ExactSelector()) throw new IOException("Candidate generation differs from selector.");
            token.ThrowIfCancellationRequested();
            try {
                fencedConnectAttempted = true;
                fencedReceipt = await current.ConnectHeldRestartFencedAsync(e => ExactSelector() && NewMatches(e), token, fencedConnectAttempt).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                if (!OldMatches(prior.RecheckExistingRestartObservation()) || !NewMatches(current.RecheckExistingRestartObservation()) || !ExactSelector())
                    throw new IOException("Held generation or selector changed after connection.");
                scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
                if (scope != state.Old.Scope || scope != next.Scope || !ExactSelector() ||
                    !OldMatches(prior.RecheckExistingRestartObservation()) || !NewMatches(current.RecheckExistingRestartObservation()))
                    throw new IOException("Restart account or held generation changed after connection.");
            } catch (Exception error) {
                if (fencedReceipt is not null) {
                    try { await current.AbortFencedHeldRestartAsync(fencedReceipt).ConfigureAwait(false); fencedReceipt = null; Volatile.Write(ref fencedDrainConfirmed, true); }
                    catch (Exception abort) { throw new AggregateException("Fenced restart abort is uncertain; both generations remain retained.", error, abort); }
                }
                throw;
            }
        } finally { lifecycle.Release(); }
    }

    internal async Task VerifyAndStartAsync(CancellationToken token)
    {
        await lifecycle.WaitAsync(token).ConfigureAwait(false);
        try {
        VerifyCapability();
        if (Interlocked.Exchange(ref attempted, 1) != 0) throw new IOException("A restart was already attempted; retain ownership for review.");
        var state = selector.State; var next = state.New ?? throw new IOException("Candidate missing.");
        var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
        if (state.Phase != FreshGenerationPlan.Phase.Published || selector.ActiveGeneration != next.Id || !selectorProof())
            throw new IOException("Published selector is unavailable.");
        var scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (scope != state.Old.Scope || scope != next.Scope || !selectorProof()) throw new IOException("Restart account or selector changed.");
        priorAttempted = true;
        var old = prior.AcquireExistingRestartObservation();
        priorHeld = true;
        if (!Matches(old, state.Old, state.Old.RootVolume, state.Old.RootFileId, state.Old.NamespaceClsid,
            state.Old.ProfileRevision, state.Old.ProfileDocumentVolume, state.Old.ProfileDocumentFileId))
            throw new IOException("Prior generation differs from selector.");
        currentAttempted = true;
        var candidate = current.AcquireExistingRestartObservation();
        currentHeld = true;
        if (!Matches(candidate, next, ready.Volume, ready.FileId, ready.NamespaceClsid,
            ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId) || !selectorProof())
            throw new IOException("Candidate generation differs from selector.");
        token.ThrowIfCancellationRequested();
        bool Proof(RestartGenerationEvidence e) => selectorProof() && Matches(e, next, ready.Volume, ready.FileId,
            ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId);
        // Do not abandon the provider task when cancellation arrives: await settlement,
        // then retain both sessions on cancellation or any uncertain outcome.
        await current.StartHeldRestartProviderAsync(Proof).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!Matches(prior.RecheckExistingRestartObservation(), state.Old, state.Old.RootVolume, state.Old.RootFileId,
            state.Old.NamespaceClsid, state.Old.ProfileRevision, state.Old.ProfileDocumentVolume, state.Old.ProfileDocumentFileId) || !selectorProof())
            throw new IOException("Prior generation or selector changed during restart.");
        scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (scope != next.Scope || !selectorProof()) throw new IOException("Restart account or selector changed after startup.");
        } finally { lifecycle.Release(); }
    }
    // No root unregistration or deletion. Partial stop outcomes stay attached;
    // only successful, individually verified drains advance their in-memory state.
    internal async Task StopHeldAsync()
    {
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            VerifyCapability();
            var state = selector.State; var next = state.New ?? throw new IOException("Candidate missing.");
            var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
            if (!selectorProof()) throw new IOException("Restart selector is not current.");
            if (currentHeld && !currentStopped) {
                await current.StopHeldRestartProviderAsync(e => selectorProof() && Matches(e, next, ready.Volume, ready.FileId,
                    ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId)).ConfigureAwait(false);
                currentStopped = true;
            }
            if (priorHeld && !priorStopped) {
                var old = state.Old;
                await prior.StopHeldRestartProviderAsync(e => selectorProof() && Matches(e, old, old.RootVolume, old.RootFileId,
                    old.NamespaceClsid, old.ProfileRevision, old.ProfileDocumentVolume, old.ProfileDocumentFileId)).ConfigureAwait(false);
                priorStopped = true;
            }
            if ((priorAttempted && !priorHeld) || (currentAttempted && !currentHeld))
                throw new IOException("A restart acquisition outcome is uncertain; retain it for ownership review.");
        } finally { lifecycle.Release(); }
    }
    // Called only after both provider stops have completed. No unregistration or
    // profile deletion is performed; failures retain exact session objects.
    internal async Task DisposeStoppedSessionsAsync()
    {
        var cancellation = RequestFencedCancellation();
        try { await cancellation.WaitAsync(FencedCancellationDeadline).ConfigureAwait(false); }
        catch (TimeoutException error) { throw new IOException("Fenced cancellation has not finished; lifetime remains retained.", error); }
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            if ((currentHeld && !currentStopped) || (priorHeld && !priorStopped) ||
                (currentAttempted && !currentHeld) || (priorAttempted && !priorHeld))
                throw new IOException("Restart sessions are not confirmed stopped.");
            if (!currentDisposed) { await current.DisposeAsync().ConfigureAwait(false); currentDisposed = true; }
            if (!priorDisposed) { await prior.DisposeAsync().ConfigureAwait(false); priorDisposed = true; }
            if (fencedSelectorLease is not null) { fencedSelectorLease.Dispose(); fencedSelectorLease = null; }
            lock (fencedLifetimeSync) { if (!fencedLifetimeDisposed) { fencedLifetime.Dispose(); fencedLifetimeDisposed = true; } }
        } finally { lifecycle.Release(); }
    }
    internal static bool Matches(RestartGenerationEvidence e, FreshGenerationPlan.Generation g, uint volume, ulong file,
        Guid clsid, long revision, uint documentVolume, ulong documentFile)
    {
        var s = e.Snapshot;
        return s.Identity == g.Id && s.ProfileDirectory == g.ProfileDirectory && s.RootPath == g.RootPath &&
            s.ManifestDigest == g.ManifestDigest && s.Scope.Channel == g.Scope.Channel && s.Scope.Alias == g.Scope.Source &&
            s.Scope.Origin == g.Scope.Origin && s.Scope.PrincipalId == g.Scope.Principal && s.ProfileRevision == revision &&
            s.NamespaceClsid == clsid && e.ProfileDirectoryVolume == g.ProfileDirectoryVolume && e.ProfileDirectoryFileId == g.ProfileDirectoryFileId &&
            e.ProfileDocumentVolume == documentVolume && e.ProfileDocumentFileId == documentFile && e.RootVolume == volume && e.RootFileId == file;
    }
}
