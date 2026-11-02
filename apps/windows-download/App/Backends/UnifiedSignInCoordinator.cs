namespace LedgeTop.Files.Backends;

// Only an explicit Sign in click may call the factory. A production implementation must
// authenticate on the agreed discovery audience, validate the fixed-origin response, and
// bind its account to that assertion. No production implementation exists until owner agreement.
internal interface IUnifiedAuthenticatedDiscoverySession : IAsyncDisposable
{
    UnifiedAccountBinding Account { get; }
    Task<UnifiedDiscoveryObservation> DiscoverAsync(Guid attempt, CancellationToken token);
    Task VerifyCurrentAsync(CancellationToken token);
}

// Retain the authenticated lease through the consumer's account-bound source admission.
// The selected source still requires its own audience/session and normal file authorization.
internal sealed class UnifiedSignInSelection(AccessMode mode, IUnifiedAuthenticatedDiscoverySession session, UnifiedAccountBinding verifiedAccount, Func<bool> isCurrent) : IAsyncDisposable
{
    private IUnifiedAuthenticatedDiscoverySession? owner = session;
    private readonly UnifiedAccountBinding binding = verifiedAccount;
    internal AccessMode Mode { get; } = mode;
    internal UnifiedAccountBinding Account => binding;
    internal async Task VerifyCurrentAsync(CancellationToken token)
    {
        var active = Volatile.Read(ref owner) ?? throw new ObjectDisposedException(nameof(UnifiedSignInSelection));
        if (!ReferenceEquals(active, Volatile.Read(ref owner)) || !isCurrent() || !ReferenceEquals(binding, active.Account)) throw new InvalidOperationException("The sign-in attempt has changed.");
        await active.VerifyCurrentAsync(token);
        token.ThrowIfCancellationRequested();
        if (!ReferenceEquals(active, Volatile.Read(ref owner)) || !isCurrent() || !ReferenceEquals(binding, active.Account)) throw new InvalidOperationException("The sign-in attempt has changed.");
    }
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref owner, null) is { } active) await active.DisposeAsync();
    }
}
internal sealed record UnifiedSignInResult(UnifiedSignInDecision Decision, UnifiedSignInSelection? Selection = null);

internal sealed class UnifiedSignInCoordinator(Func<CancellationToken, Task<IUnifiedAuthenticatedDiscoverySession>> authenticate)
{
    private long generation;
    // Cancellation always retires the generation, even if an injected/native operation
    // ignores cancellation and returns late. This class never probes another source.
    internal void Invalidate() => Interlocked.Increment(ref generation);

    internal async Task<UnifiedSignInResult> SignInAsync(CancellationToken token)
    {
        var current = Interlocked.Increment(ref generation);
        var attempt = Guid.NewGuid();
        IUnifiedAuthenticatedDiscoverySession? session = null;
        try {
            token.ThrowIfCancellationRequested();
            session = await authenticate(token);
            token.ThrowIfCancellationRequested();
            if (current != Volatile.Read(ref generation)) return Stale();
            var account = session.Account;
            var observation = await session.DiscoverAsync(attempt, token);
            token.ThrowIfCancellationRequested();
            if (current != Volatile.Read(ref generation)) return Stale();
            await session.VerifyCurrentAsync(token);
            token.ThrowIfCancellationRequested();
            if (current != Volatile.Read(ref generation) || !ReferenceEquals(account, session.Account)) return Stale();
            var decision = UnifiedSignInPolicy.Decide(attempt, account, observation);
            if (decision is { Status: UnifiedSignInStatus.Selected, Mode: { } mode }) {
                var selection = new UnifiedSignInSelection(mode, session, account, () => current == Volatile.Read(ref generation)); session = null;
                return new(decision, selection);
            }
            return new(decision);
        } finally { if (session is not null) await session.DisposeAsync(); }
    }
    private static UnifiedSignInResult Stale() => new(new(UnifiedSignInStatus.Stale));
}
