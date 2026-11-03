namespace LedgeTop.WindowsDownload;

// Internal cooperating-source contract. This is not a boundary against other same-user processes.
internal interface IHydrationMutationAwareSource { bool CoordinatesHydrationMutations { get; } }

internal sealed class HydrationMutationScope : IDisposable
{
    private static readonly AsyncLocal<HydrationMutationScope?> Current = new();
    private readonly HydrationMutationScope? previous;
    private readonly Action<Action> gate;
    private readonly CancellationToken cancellationToken;
    private HydrationMutationScope(Action<Action> gate, CancellationToken cancellationToken) { this.gate = gate; this.cancellationToken = cancellationToken; previous = Current.Value; Current.Value = this; }
    internal static IDisposable Begin(Action<Action> gate, CancellationToken cancellationToken) => new HydrationMutationScope(gate, cancellationToken);
#if LEDGETOP_CACHE_RACE_TEST
    internal static Action? BeforeGateTestHook;
#endif
    internal static void Run(Action mutation, CancellationToken token = default, bool committedCleanup = false) {
        if (Current.Value is { } scope) {
            if (!committedCleanup) { scope.cancellationToken.ThrowIfCancellationRequested(); token.ThrowIfCancellationRequested(); }
#if LEDGETOP_CACHE_RACE_TEST
            BeforeGateTestHook?.Invoke();
#endif
#if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.CacheMutationEnter);
            try {
#endif
            scope.gate(() => { if (!committedCleanup) { scope.cancellationToken.ThrowIfCancellationRequested(); token.ThrowIfCancellationRequested(); } mutation(); });
#if LEDGETOP_NATIVE_DIAGNOSTICS
            } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheMutationExit); }
#endif
        } else mutation();
    }
    public void Dispose() { if (ReferenceEquals(Current.Value, this)) Current.Value = previous; }
}
