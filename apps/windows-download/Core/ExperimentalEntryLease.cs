#if LEDGETOP_CACHE_RACE_TEST
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.WindowsDownload;

// Gated synthetic component; it is not yet connected to reservation ownership.
internal sealed class ExperimentalEntryLease : IDisposable
{
    private sealed class State
    {
        internal readonly object Gate = new();
        internal readonly List<ExperimentalOwnedStream.DirectoryPin> Pins = [];
        internal SafeFileHandle? Handle;
        internal ExperimentalOwnedStream.Identity Id;
        internal string Path = "";
        internal ExperimentalEntryLease? Current;
        internal HydrationCacheConcurrency.Lease? Admission;
        internal string Root = "", Key = "";
        internal bool Uncertain, Bound;
    }
    private static readonly object RegistryGate = new();
    private static readonly HashSet<State> Registry = [];
    private readonly State state;
    private ExperimentalEntryLease(State state) { this.state = state; }
    internal static int RetainedCount { get { lock (RegistryGate) return Registry.Count; } }
    internal static ExperimentalEntryLease Open(HydrationCacheConcurrency.Lease admission, string root, string scope, string key)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(scope, "\\A[a-f0-9]{64}\\z") ||
            !System.Text.RegularExpressions.Regex.IsMatch(key, "\\A[a-f0-9]{64}\\z")) throw new IOException("Experimental entry identity invalid.");
        root = Path.GetFullPath(root);
        ExperimentalEntryLease? result = null;
        admission.RunExperimentalForEntry(root, scope + key, () => {
            _ = admission.ExperimentalMarkers; // Confirms the exact root legacy lease is held.
            var state = new State { Path = Path.Combine(root, scope, key, ".hydration.lock"), Admission = admission, Root = root, Key = scope + key };
            lock (RegistryGate) Registry.Add(state);
            try {
                admission.RegisterExperimentalEntry(); state.Bound = true;
                ExperimentalOwnedStream.PinDirectories(Path.GetDirectoryName(state.Path)!, state.Pins);
                ExperimentalOwnedStream.VerifyPins(state.Pins);
                // OPEN_ALWAYS and no sharing, with OPEN_REPARSE_POINT; fail closed on contention.
                state.Handle = ExperimentalOwnedStream.Open(state.Path, 0xC0000080, 0, 4, 0x00200000);
                state.Uncertain = true;
                ExperimentalOwnedStream.RequireRegularKind(state.Handle, false);
                ExperimentalOwnedStream.RequireSingleLink(state.Handle);
                state.Id = ExperimentalOwnedStream.GetIdentity(state.Handle);
                Verify(state); result = new ExperimentalEntryLease(state); state.Current = result; state.Uncertain = false;
            } catch {
                if (!state.Uncertain) {
                    try { state.Handle?.Dispose(); foreach (var pin in state.Pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); if (state.Bound) { admission.UnregisterExperimentalEntry(); state.Bound = false; } lock (RegistryGate) Registry.Remove(state); }
                    catch { state.Uncertain = true; }
                }
                throw;
            }
        });
        return result!;
    }
    private static void Verify(State state)
    {
        if (state.Handle is null || ExperimentalOwnedStream.GetIdentity(state.Handle) != state.Id ||
            !string.Equals(ExperimentalOwnedStream.FinalPath(state.Handle), state.Path, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Experimental entry binding changed.");
        ExperimentalOwnedStream.VerifyPins(state.Pins);
    }
    internal ExperimentalEntryLease JointMoveTo(HydrationCacheConcurrency.Lease original, HydrationCacheConcurrency.Lease successor, Action commit)
    {
        lock (state.Gate) {
            if (!ReferenceEquals(state.Current, this) || state.Uncertain || !ReferenceEquals(state.Admission, original))
                throw new ObjectDisposedException(nameof(ExperimentalEntryLease));
            Verify(state); var next = new ExperimentalEntryLease(state);
            commit(); state.Admission = successor; state.Current = next;
            return next;
        }
    }
    internal ExperimentalEntryLease Move()
    {
        ExperimentalEntryLease? result = null;
        state.Admission!.RunExperimentalForEntry(state.Root, state.Key, () => {
            lock (state.Gate) {
                if (!ReferenceEquals(state.Current, this) || state.Uncertain) throw new ObjectDisposedException(nameof(ExperimentalEntryLease));
                Verify(state); result = new ExperimentalEntryLease(state); state.Current = result;
            }
        });
        return result!;
    }
    internal void Validate()
    {
        state.Admission!.RunExperimentalForEntry(state.Root, state.Key, () => {
            lock (state.Gate) {
                if (!ReferenceEquals(state.Current, this) || state.Uncertain) throw new ObjectDisposedException(nameof(ExperimentalEntryLease));
                Verify(state);
            }
        });
    }
    public void Dispose()
    {
        state.Admission!.RunExperimentalForEntry(state.Root, state.Key, () => {
            lock (state.Gate) {
                if (!ReferenceEquals(state.Current, this)) throw new ObjectDisposedException(nameof(ExperimentalEntryLease));
                if (state.Uncertain) throw new IOException("Experimental entry close remains uncertain.");
                state.Uncertain = true;
                state.Handle!.Dispose(); state.Handle = null;
                foreach (var pin in state.Pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); state.Pins.Clear();
                state.Admission.UnregisterExperimentalEntry(); state.Bound = false;
                state.Current = null; state.Uncertain = false;
                lock (RegistryGate) Registry.Remove(state);
            }
        });
    }
}
#endif
