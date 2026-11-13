using System.Runtime.InteropServices;

namespace LedgeTop.WindowsDownload;

// The native implementation is deliberately absent. This seam can only be supplied by reviewed
// internal composition/tests; there is no root path, root registration or operational entry point.
internal interface ICloudFilesConnectionNative
{
    int Connect(nint callbackTable, nint callbackContext, out long connectionKey);
    int Disconnect(long connectionKey);
    void RejectFetch(CloudFilesOperationContext context, int status);
}
[UnmanagedFunctionPointer(CallingConvention.Winapi)]
internal delegate void CloudFilesNativeCallback(nint info, nint parameters);
[StructLayout(LayoutKind.Sequential)]
internal struct CloudCallbackRegistration { internal int Type; internal nint Callback; }
[StructLayout(LayoutKind.Sequential)]
internal struct CloudCallbackInfo {
    internal uint StructSize;
    internal long ConnectionKey;
    internal nint CallbackContext, VolumeGuidName, VolumeDosName;
    internal uint VolumeSerialNumber;
    internal long SyncRootFileId;
    internal nint SyncRootIdentity;
    internal uint SyncRootIdentityLength;
    internal long FileId, FileSize;
    internal nint FileIdentity;
    internal uint FileIdentityLength;
    internal nint NormalizedPath;
    internal long TransferKey;
    internal byte PriorityHint;
    internal nint CorrelationVector, ProcessInfo;
    internal long RequestKey;
}
[StructLayout(LayoutKind.Explicit, Size = 64)]
internal struct CloudCallbackParameters {
    [FieldOffset(0)] internal uint ParamSize;
    [FieldOffset(8)] internal uint Flags;
    [FieldOffset(16)] internal long Offset;
    [FieldOffset(24)] internal long Length;
}
internal enum CloudFilesConnectionNotice {
    Malformed, Unmapped, Stopping, Capacity, SubsetUnsupported, CancelNotFound, CancelledBeforeAdmission, WorkFailed, Quarantined
}

/// <summary>Unactivated, injected-native ownership rehearsal. Does not register or connect a Windows root.
/// Rooted delegates and copied callback prefixes survive until successful disconnect AND managed drain.</summary>
internal sealed class CloudFilesConnectionOwner : IAsyncDisposable
{
    private enum Phase { New, Connecting, Connected, Stopping, Closed, Quarantined }
    private sealed record Snapshot(bool Cancel, long Connection, nint Cookie, CloudFilesOperationContext Context, byte[]? Identity,
        long RequestedOffset, long RequestedLength) {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        internal long SyntheticCallbackId;
#endif
        internal bool Settled;
        internal bool CancellationAmbiguous;
        internal Snapshot? DeferredFetch;
        internal readonly TaskCompletionSource CancelRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    // Quarantine deliberately retains roots on ambiguous native failure. Capacity is process-wide,
    // including quarantined owners, so repeated failures cannot allocate an unbounded native graph.
    private static readonly object rootsSync = new();
    private static readonly Dictionary<nint, CloudFilesConnectionOwner> roots = [];
    private static long nextCookie;
    private readonly object sync = new();
    private readonly ICloudFilesConnectionNative native;
    private readonly Func<long, CloudFilesCallbackDispatcher> createDispatcher;
    private readonly Action<CloudFilesConnectionNotice>? report;
    private readonly Action? rejectionGateReleasedForTests;
    private readonly bool normalizeNativeRanges;
    private readonly Func<IDisposable?>? admitFetch;
    private readonly CloudFilesNativeCallback fetch, cancel;
    private readonly int capacity;
    private readonly List<Snapshot> pending = [];
    private readonly Dictionary<Task, Snapshot> work = [];
    private readonly object settlementGate = new();
    private bool settlementsAllowed;
    private readonly HashSet<CloudFilesRequestKey> settlements = [];
    private readonly TaskCompletionSource connected = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private TaskCompletionSource? callbacksDrained;
    private nint table, cookie;
    private long connection;
    private int callbacks;
    private Phase phase;
    private bool stopRequested, connectCallbackLost;
    private Task? stop;
    private CloudFilesCallbackDispatcher? dispatcher;

    internal CloudFilesConnectionOwner(ICloudFilesConnectionNative native,
        Func<long, CloudFilesCallbackDispatcher> createDispatcher, Action<CloudFilesConnectionNotice>? report = null, int capacity = 64,
        Action? rejectionGateReleasedForTests = null, bool normalizeNativeRanges = false, Func<IDisposable?>? admitFetch = null)
    {
        AssertAbi();
        if (capacity is < 1 or > 256) throw new ArgumentOutOfRangeException(nameof(capacity));
        this.native = native ?? throw new ArgumentNullException(nameof(native));
        this.createDispatcher = createDispatcher ?? throw new ArgumentNullException(nameof(createDispatcher));
        this.report = report; this.capacity = capacity;
        this.rejectionGateReleasedForTests = rejectionGateReleasedForTests;
        this.normalizeNativeRanges = normalizeNativeRanges;
        this.admitFetch = admitFetch;
        fetch = (info, parameters) => Callback(false, info, parameters);
        cancel = (info, parameters) => Callback(true, info, parameters);
    }
    internal bool RootsRetained { get { lock (sync) return table != 0; } }

    internal void Connect()
    {
        lock (sync) {
            if (phase != Phase.New || stopRequested) throw new TransferException("Connection owner cannot reconnect.");
            lock (rootsSync) {
                if (roots.Count >= 16) throw new TransferException("Connection owner capacity reached.");
                // An opaque non-dereferenced cookie, never a GCHandle that could be recycled into
                // another generation. No callback-controlled pointer is used to recover an owner.
                cookie = checked((nint)Interlocked.Increment(ref nextCookie));
                table = Marshal.AllocHGlobal(48);
                Marshal.StructureToPtr(new CloudCallbackRegistration { Type = 0, Callback = Marshal.GetFunctionPointerForDelegate(fetch) }, table, false);
                Marshal.StructureToPtr(new CloudCallbackRegistration { Type = 2, Callback = Marshal.GetFunctionPointerForDelegate(cancel) }, table + 16, false);
                Marshal.StructureToPtr(new CloudCallbackRegistration { Type = -1 }, table + 32, false);
                roots.Add(cookie, this);
            }
            phase = Phase.Connecting;
        }
        try {
            // Must be outside the owner lock: an implementation can callback before it returns.
            var status = native.Connect(table, cookie, out var key);
            if (status != 0) throw new TransferException("Connection could not be established.");
            var provider = createDispatcher(key);
            lock (settlementGate) lock (sync) {
                connection = key; dispatcher = provider;
                if (connectCallbackLost) throw new TransferException("Connecting callback capacity was exceeded.");
                phase = stopRequested ? Phase.Stopping : Phase.Connected;
                settlementsAllowed = true;
                foreach (var snapshot in pending) QueueLocked(snapshot);
                pending.Clear();
            }
        } catch {
            lock (sync) { phase = Phase.Quarantined; pending.Clear(); }
            Notice(CloudFilesConnectionNotice.Quarantined);
            throw new TransferException("Connection ownership is uncertain; resources remain retained.");
        } finally { connected.TrySetResult(); }
    }

    private void Callback(bool isCancel, nint infoPointer, nint parametersPointer)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CallbackArrival);
#endif
        bool accepted, copyIdentity;
        lock (sync) {
            accepted = phase is Phase.Connecting or Phase.Connected or Phase.Stopping;
            copyIdentity = accepted && callbacks + work.Count + pending.Count < capacity;
            if (accepted) callbacks++;
        }
        if (!accepted) { Notice(CloudFilesConnectionNotice.Unmapped); return; }
        try {
            // These are trusted native callback allocations, not arbitrary addresses from external
            // input. Marshal cannot turn an invalid OS pointer into a memory-safe managed buffer.
            if (infoPointer == 0 || parametersPointer == 0 || Marshal.ReadInt32(infoPointer) < 152
                || Marshal.ReadInt32(parametersPointer) is < 32 or > 4096) {
                lock (sync) { if (phase == Phase.Connecting) connectCallbackLost = true; }
                Notice(CloudFilesConnectionNotice.Malformed); return;
            }
            var info = Marshal.PtrToStructure<CloudCallbackInfo>(infoPointer);
            // Only read the 32-byte common prefix. CANCEL's union member is smaller than
            // the full 64-byte structure: PtrToStructure of that allocation would overread.
            var context = new CloudFilesOperationContext(info.ConnectionKey, info.TransferKey, info.RequestKey,
                info.FileSize, Marshal.ReadInt64(parametersPointer, 16), Marshal.ReadInt64(parametersPointer, 24));
            var requestedOffset = context.RequiredOffset;
            var requestedLength = context.RequiredLength;
            if (normalizeNativeRanges) context = NormalizeNativeRange(context, isCancel, out requestedLength);
            byte[]? identity = null;
            if (copyIdentity && !isCancel && info.FileIdentity != 0 && info.FileIdentityLength is > 0 and <= 4096) {
                identity = new byte[info.FileIdentityLength];
                Marshal.Copy(info.FileIdentity, identity, 0, identity.Length);
            }
            var snapshot = new Snapshot(isCancel, info.ConnectionKey, info.CallbackContext, context, identity, requestedOffset, requestedLength);
#if LEDGETOP_NATIVE_DIAGNOSTICS
            bool syntheticMapped;
            lock (sync) syntheticMapped = info.CallbackContext == cookie && (phase == Phase.Connecting || (phase == Phase.Connected && info.ConnectionKey == connection));
            if (!isCancel && syntheticMapped && SyntheticCallbackProcessInfo.Eligible(identity)) {
                var copied = SyntheticCallbackProcessInfo.CopyPrefix(info.ProcessInfo);
                snapshot.SyntheticCallbackId = NativeStallTrace.NextSyntheticCallbackId();
                NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticCallbackProcess, snapshot.SyntheticCallbackId, copied.ProcessId, (byte)copied.Status);
            }
#endif
            Handle(snapshot, copyIdentity);
        } catch {
            // No managed exception may cross a void unmanaged callback. Shape failures that lack
            // a trustworthy mapped positive range cannot invent a native completion operation.
            lock (sync) { if (phase == Phase.Connecting) connectCallbackLost = true; }
            Notice(CloudFilesConnectionNotice.Malformed);
        } finally {
            lock (sync) { if (--callbacks == 0) callbacksDrained?.TrySetResult(); }
        }
    }

    private static CloudFilesRequestKey Key(Snapshot value) => new(value.Connection, value.Context.TransferKey, value.Context.RequestKey);
    private static long NormalizedLength(Snapshot value) => value.Context.RequiredLength == -1
        && value.Context.FileSize >= value.Context.RequiredOffset ? value.Context.FileSize - value.Context.RequiredOffset : value.Context.RequiredLength;

    // Windows specifies the bytes needed by IO, but only the returned TRANSFER_DATA range must
    // be page-aligned. Expand valid native requests before passing them to the strict hydrator.
    // https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_callback_parameters
    private static CloudFilesOperationContext NormalizeNativeRange(CloudFilesOperationContext context, bool isCancel, out long requestedLength)
    {
        var offset = context.RequiredOffset;
        if (context.FileSize is <= 0 or > (1L << 40) || offset < 0 || offset >= context.FileSize)
            throw new TransferException("Native callback range is outside the file.");
        requestedLength = context.RequiredLength == -1 ? context.FileSize - offset : context.RequiredLength;
        // Subtraction first avoids wrapping offset + length on malformed native input.
        var available = context.FileSize - offset;
        if (requestedLength <= 0)
            throw new TransferException("Native callback range is outside the file.");
        if (requestedLength > available) {
            // A synthetic VM run observed CANCEL_DATA ending at the next page after
            // EOF; this is not a documented guarantee for cancellation ranges.
            // Accept only that exact observed EOF rounding, not intermediate ends.
            // FETCH_DATA remains strict; matching below still requires the original
            // start and the entire effective interval, never merely the same page.
            var eofPadding = context.FileSize % 4096 == 0 ? 0 : 4096 - context.FileSize % 4096;
            if (!isCancel || requestedLength - available != eofPadding)
                throw new TransferException("Native callback range is outside the file.");
            requestedLength = available;
        }
        var end = offset + requestedLength;
        var start = offset - offset % 4096;
        var padding = end % 4096 == 0 ? 0 : 4096 - end % 4096;
        var alignedEnd = padding > context.FileSize - end ? context.FileSize : end + padding;
        return context with { RequiredOffset = start, RequiredLength = alignedEnd - start };
    }
    private void Handle(Snapshot snapshot, bool copyIdentity)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CallbackHandling);
#endif
        CloudFilesConnectionNotice? notice = null; bool reject = false;
        lock (settlementGate) lock (sync) {
            if (snapshot.Cookie != cookie || (phase != Phase.Connecting && snapshot.Connection != connection))
                notice = CloudFilesConnectionNotice.Unmapped;
            else if (phase == Phase.Stopping) { notice = CloudFilesConnectionNotice.Stopping; reject = true; }
            else if (phase is not (Phase.Connected or Phase.Connecting)) notice = CloudFilesConnectionNotice.Unmapped;
            else {
                var existing = phase == Phase.Connecting ? pending.FirstOrDefault(value => Key(value) == Key(snapshot))
                    : work.Values.FirstOrDefault(value => !value.Settled && Key(value) == Key(snapshot));
                if (snapshot.Cancel) {
                    // One coalesced control signal per unique fetch. It bypasses fetch capacity,
                    // including before dispatcher admission, and creates no extra queued work.
                    if (existing is null) notice = CloudFilesConnectionNotice.CancelNotFound;
                    else if (normalizeNativeRanges ? existing.CancellationAmbiguous || snapshot.Context.FileSize != existing.Context.FileSize
                        || snapshot.RequestedOffset != existing.RequestedOffset || snapshot.RequestedLength != existing.RequestedLength
                        : snapshot.Context.RequiredOffset != existing.Context.RequiredOffset
                            || snapshot.Context.RequiredLength != NormalizedLength(existing)) notice = CloudFilesConnectionNotice.SubsetUnsupported;
                    else {
                        existing.CancelRequested.TrySetResult();
                        // Cancellation covers duplicate callbacks already observed for this same
                        // interval. A later FETCH is a fresh request and gets a fresh signal.
                        existing.DeferredFetch?.CancelRequested.TrySetResult();
                    }
                }
                else if (existing is not null) {
                    // Existing tuple retains sole terminal ownership even for conflicting duplicates.
                    var differentRequest = normalizeNativeRanges && (existing.RequestedOffset != snapshot.RequestedOffset
                        || existing.RequestedLength != snapshot.RequestedLength);
                    // Distinct requested intervals can expand to the same page. Never mistake a
                    // cancellation of just one interval for cancellation of all needed IO.
                    if (differentRequest) {
                        existing.CancellationAmbiguous = true;
                        if (existing.DeferredFetch is { } deferred) deferred.CancellationAmbiguous = true;
                    }
                    if (differentRequest || existing.Context != snapshot.Context || (snapshot.Identity is not null && existing.Identity is not null
                        && !existing.Identity.AsSpan().SequenceEqual(snapshot.Identity))) notice = CloudFilesConnectionNotice.Malformed;
                    else if (normalizeNativeRanges && snapshot.Identity is not null && existing.Identity is not null) {
                        // Windows can issue a new FETCH with identical opaque keys immediately
                        // after native settlement, while the old managed worker is still draining.
                        // Keep only one copied exact request; never invent one from an identity
                        // omitted at the callback-admission limit. Reauthorize after retirement.
                        snapshot.CancellationAmbiguous = existing.CancellationAmbiguous;
                        existing.DeferredFetch = snapshot;
                    }
                }
                else if (settlements.Contains(Key(snapshot))) notice = CloudFilesConnectionNotice.Capacity;
                else if (!copyIdentity || (phase == Phase.Connecting ? pending.Count : work.Count) >= capacity) {
                    notice = CloudFilesConnectionNotice.Capacity;
                    if (phase == Phase.Connecting) connectCallbackLost = true;
                    else reject = true;
                }
                else if (phase == Phase.Connecting) pending.Add(snapshot);
                else QueueLocked(snapshot);
            }
        }
        if (notice is { } reason) {
            if (reject) Reject(snapshot, reason);
            else Notice(reason);
        }
    }

    private void QueueLocked(Snapshot snapshot)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CallbackQueued);
#endif
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        work.Add(completion.Task, snapshot);
        // Queue before releasing sync; no async work or native call executes under that lock.
        ThreadPool.QueueUserWorkItem(_ => RunAsync(snapshot, completion));
    }
    private async void RunAsync(Snapshot snapshot, TaskCompletionSource completion)
    {
        IDisposable? fetchAdmission = null;
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.WorkerStart, snapshot.SyntheticCallbackId);
#endif
        try {
            CloudFilesCallbackDispatcher? provider; Phase current;
            lock (sync) { provider = dispatcher; current = phase; }
 #if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.WorkerStateCaptured, snapshot.SyntheticCallbackId);
 #endif
            if (snapshot.Cookie != cookie || snapshot.Connection != connection || provider is null) {
 #if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.WorkerUnmapped, snapshot.SyntheticCallbackId);
 #endif
                Notice(CloudFilesConnectionNotice.Unmapped); return;
            }
            if (current != Phase.Connected) {
 #if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.WorkerStopping, snapshot.SyntheticCallbackId);
 #endif
                Reject(snapshot, CloudFilesConnectionNotice.Stopping); return;
            }
            if (snapshot.CancelRequested.Task.IsCompleted) {
 #if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.WorkerCancelled, snapshot.SyntheticCallbackId);
 #endif
                Notice(CloudFilesConnectionNotice.CancelledBeforeAdmission); return;
            }
            if (snapshot.Identity is null) {
 #if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.WorkerMalformed, snapshot.SyntheticCallbackId);
 #endif
                Reject(snapshot, CloudFilesConnectionNotice.Malformed); return;
            }
            Task hydration;
            // Admission must occur before the dispatcher takes native terminal ownership.
            // If it is unavailable, settle the fetch with the normal rejection path.
            try { fetchAdmission = admitFetch?.Invoke(); }
            catch { Reject(snapshot, CloudFilesConnectionNotice.Stopping); return; }
            try {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.DispatcherFetchEnter, snapshot.SyntheticCallbackId);
#endif
                hydration = provider.FetchDataAsync(snapshot.Identity, snapshot.Context);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.DispatcherFetchExit, snapshot.SyntheticCallbackId);
#endif
            }
            catch { Reject(snapshot, CloudFilesConnectionNotice.Malformed); return; }
            // The trusted hydrator owns terminal handling once admitted. Never fail an already
            // committed native range again merely because its managed task faults/cancels.
            try {
                if (await Task.WhenAny(hydration, snapshot.CancelRequested.Task) == snapshot.CancelRequested.Task)
                    await provider.CancelFetchDataAsync(Key(snapshot), snapshot.Context.RequiredOffset, NormalizedLength(snapshot));
                await hydration;
            } catch { Notice(CloudFilesConnectionNotice.WorkFailed); }
        } catch { Notice(CloudFilesConnectionNotice.WorkFailed); }
        finally {
            fetchAdmission?.Dispose();
            lock (sync) {
                work.Remove(completion.Task);
                var deferred = snapshot.DeferredFetch;
                snapshot.DeferredFetch = null;
                // FetchDataAsync has fully retired its dispatcher entry before its completion
                // task finishes. Only now can an observed duplicate safely authorize a new
                // operation. Even successful delivery may already have been dehydrated again;
                // responding to this real callback is not a timer or network retry.
                if (normalizeNativeRanges && phase == Phase.Connected && deferred is not null && work.Count < capacity
                    && !work.Values.Any(current => !current.Settled && Key(current) == Key(deferred)))
                    QueueLocked(deferred);
                completion.TrySetResult();
            }
        }
    }
    private void Reject(Snapshot snapshot, CloudFilesConnectionNotice reason)
    {
        bool failed = false;
        lock (settlementGate) {
            bool anotherOwner;
            lock (sync) anotherOwner = work.Values.Any(existing => !existing.Settled && !ReferenceEquals(existing, snapshot) && Key(existing) == Key(snapshot));
            var c = snapshot.Context; var length = NormalizedLength(snapshot);
            if (!anotherOwner && !snapshot.Cancel && snapshot.Cookie == cookie && snapshot.Connection == connection
                && settlementsAllowed && c.FileSize > 0 && c.RequiredOffset >= 0 && c.RequiredOffset <= c.FileSize && length > 0
                && length <= c.FileSize - c.RequiredOffset && c.RequiredOffset % 4096 == 0
                && (length % 4096 == 0 || length == c.FileSize - c.RequiredOffset)
                && settlements.Count < capacity && settlements.Add(Key(snapshot))) {
                // Callback admission uses the same gate and sees this terminal claim, including
                // reentrant fake callbacks. No tuple can be replaced between this check and call.
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.RejectEnter);
#endif
                try { native.RejectFetch(c with { RequiredLength = length }, CloudFilesNativeTransfer.Unavailable); }
                catch { failed = true; }
                finally {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    NativeStallTrace.Record(NativeStallTrace.Stage.RejectExit);
#endif
                    settlements.Remove(Key(snapshot));
                }
            }
            // Retire atomically with terminal settlement, before admission can reacquire this
            // gate. Managed drain still owns the worker/observer, but no longer owns its tuple.
            lock (sync) snapshot.Settled = true;
        }
        // Deterministic test seam only, never invoked while either lock is held.
        rejectionGateReleasedForTests?.Invoke();
        // A blocked observer never delays a future native call: settlement has already ended.
        Notice(reason);
        if (failed) Notice(CloudFilesConnectionNotice.WorkFailed);
    }
    private void Notice(CloudFilesConnectionNotice value) { try { report?.Invoke(value); } catch { } }

    internal Task EvictVerifiedCacheAsync(PlaceholderIdentity identity, CancellationToken cancellationToken = default)
    {
        CloudFilesCallbackDispatcher provider;
        lock (sync) {
            if (phase != Phase.Connected || dispatcher is null) throw new TransferException("Connection is not active for cache reclamation.");
            provider = dispatcher;
        }
        // Dispatcher admission and stop/drain own the operation. Never await/cache hash under owner/native locks.
        return provider.EvictVerifiedCacheAsync(identity, cancellationToken);
    }

    internal Task StopAsync(CancellationToken cancellationToken = default)
    {
        Task task;
        lock (sync) {
            stopRequested = true;
            if (phase == Phase.New) { phase = Phase.Closed; connected.TrySetResult(); }
            else if (phase == Phase.Connected) phase = Phase.Stopping;
            task = stop ??= StopCoreAsync();
        }
        return task.WaitAsync(cancellationToken);
    }
    private async Task StopCoreAsync()
    {
        await Task.Yield();
        await connected.Task;
        CloudFilesCallbackDispatcher? provider;
        lock (sync) {
            if (phase == Phase.Quarantined) throw new TransferException("Connection ownership remains uncertain.");
            provider = dispatcher;
        }
        if (provider is null) return;
        try {
            await provider.StopAsync();
            await DrainWorkAsync();
            // Join prior native rejection calls, then prevent NEW calls before Disconnect starts.
            // Do not hold settlementGate across Disconnect: it can reenter on another thread.
            // Reentrant stopping callbacks are fenced/reported, and Disconnect's documented
            // platform cleanup fails the IO; no delayed callback may issue a post-disconnect call.
            lock (settlementGate) settlementsAllowed = false;
            if (native.Disconnect(connection) != 0) throw new TransferException("Disconnect failed.");
            Task callbacksTask;
            lock (sync) {
                phase = Phase.Closed;
                callbacksTask = callbacks == 0 ? Task.CompletedTask : (callbacksDrained ??= new(TaskCreationOptions.RunContinuationsAsynchronously)).Task;
            }
            await callbacksTask;
            await DrainWorkAsync();
            lock (sync) {
                Marshal.FreeHGlobal(table); table = 0;
                lock (rootsSync) roots.Remove(cookie);
            }
            GC.KeepAlive(fetch); GC.KeepAlive(cancel);
        } catch {
            lock (sync) phase = Phase.Quarantined;
            Notice(CloudFilesConnectionNotice.Quarantined);
            throw new TransferException("Disconnect did not complete; callback roots remain retained.");
        }
    }
    private async Task DrainWorkAsync() {
        while (true) {
            Task[] tasks; lock (sync) tasks = work.Keys.ToArray();
            if (tasks.Length == 0) return;
            await Task.WhenAll(tasks);
        }
    }
    public async ValueTask DisposeAsync() => await StopAsync();

    internal static void AssertAbi() {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        if (Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.ProcessInfo)).ToInt32() != 136)
            throw new TransferException("Cloud Files diagnostic callback ABI is unsupported.");
#endif
        if (IntPtr.Size != 8 || Marshal.SizeOf<CloudCallbackInfo>() != 152 || Marshal.SizeOf<CloudCallbackRegistration>() != 16
            || Marshal.SizeOf<CloudCallbackParameters>() != 64
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.ConnectionKey)).ToInt32() != 8
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.CallbackContext)).ToInt32() != 16
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.FileSize)).ToInt32() != 80
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.FileIdentity)).ToInt32() != 88
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.FileIdentityLength)).ToInt32() != 96
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.TransferKey)).ToInt32() != 112
            || Marshal.OffsetOf<CloudCallbackInfo>(nameof(CloudCallbackInfo.RequestKey)).ToInt32() != 144
            || Marshal.OffsetOf<CloudCallbackRegistration>(nameof(CloudCallbackRegistration.Callback)).ToInt32() != 8)
            throw new TransferException("Cloud Files connection ABI is unsupported.");
    }
}
