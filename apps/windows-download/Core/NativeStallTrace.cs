#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Diagnostics;

namespace LedgeTop.WindowsDownload;

// Explicitly enabled in test builds only. Native callbacks never invoke an
// observer, perform I/O, take a diagnostic lock, or retain identifying data.
internal static class NativeStallTrace
{
    internal enum Stage {
        CallbackArrival, CallbackHandling, CallbackQueued, WorkerStart, WorkerStateCaptured,
        WorkerUnmapped, WorkerStopping, WorkerCancelled, WorkerMalformed,
        DispatcherFetchEnter, DispatcherFetchExit, IdentityDecodeEnter, IdentityDecodeExit,
        DispatcherContextValidated, DispatcherRequestRegistered, HydrationDelegateEnter, HydrationDelegateReturned,
        SyntheticHydratorEnter, SyntheticMarkerIoEnter, SyntheticMarkerIoExit, SyntheticOwnedDownloaderEnter,
        HydratorEnter, HydratorAbiValidated, HydratorContextValidated, HydratorSinkConstructed,
        HydratorProgressStart, HydratorProgressStarted, CoordinatorHydrationEnter, CoordinatorHydrationReturned,
        // ProgressExit means the native call returned OR threw; it is not a success receipt.
        ProgressEnter, ProgressExit, AdmissionEnter, AdmissionAcquired,
        AuthorizationEnter, AuthorizationExit, MetadataAttemptEnter,
        MetadataAttemptExit, MetadataBusy, RetryDelayEnter, RetryDelayExit,
        AuthorizationAfterEnter, AuthorizationAfterExit, TransferEnter, TransferExit,
        ExecuteEnter, ExecuteExit, RejectEnter, RejectExit,
        SyntheticMarkerReadEnter, SyntheticMarkerReadExit,
        CacheLegacyLeaseEnter, CacheLegacyLeaseAcquired,
        CacheQuotaEnter, CacheQuotaAcquired, CacheQuotaExit,
        CacheDirectoryEnter, CacheDirectoryExit,
        CacheScopeCheckEnter, CacheScopeCheckExit, CacheEntryCheckEnter, CacheEntryCheckExit,
        CacheReservationDirCheckEnter, CacheReservationDirCheckExit,
        CacheReservedBytesEnter, CacheReservedBytesExit, CacheCapacityEnter, CacheCapacityExit,
        CacheWalkEnter, CacheWalkExit, CacheScopeOwnEnter, CacheScopeOwnExit, CacheEntryOwnEnter, CacheEntryOwnExit,
        OwnedSafeEnter, OwnedSafeExit, OwnedDirectoryExistsEnter, OwnedDirectoryExistsExit,
        OwnedFileExistsEnter, OwnedFileExistsExit, OwnedCreateEnter, OwnedCreateExit,
        OwnedMarkerOpenEnter, OwnedMarkerOpenExit, OwnedMarkerWriteEnter, OwnedMarkerWriteExit,
        OwnedMarkerFlushEnter, OwnedMarkerFlushExit, OwnedMarkerSafeEnter, OwnedMarkerSafeExit,
        OwnedMarkerVerifyEnter, OwnedMarkerVerifyExit,
        OwnedVerifyExistsEnter, OwnedVerifyExistsExit, OwnedVerifyLengthEnter, OwnedVerifyLengthExit,
        OwnedVerifyReadEnter, OwnedVerifyReadExit,
        CacheOwnerPathSafeEnter, CacheOwnerPathSafeExit,
        CacheOwnerDirectoryExistsEnter, CacheOwnerDirectoryExistsExit,
        CacheOwnerFileExistsEnter, CacheOwnerFileExistsExit,
        CacheOwnerMarkerPathSafeEnter, CacheOwnerMarkerPathSafeExit,
        CacheOwnerMarkerExistsEnter, CacheOwnerMarkerExistsExit,
        CacheOwnerMarkerLengthEnter, CacheOwnerMarkerLengthExit,
        CacheOwnerMarkerReadEnter, CacheOwnerMarkerReadExit,
        OwnedVerifyReaderOpenEnter, OwnedVerifyReaderOpenExit,
        OwnedVerifyContentReadEnter, OwnedVerifyContentReadExit,
        RootOwnerPinVerifyEnter, RootOwnerPinVerifyExit,
        OwnedVerifyReaderDisposeEnter, OwnedVerifyReaderDisposeExit,
        CacheEntryLeaseEnter, CacheEntryLeaseAcquired,
        CacheReserveEnter, CacheReserveAcquired, CacheReleaseEnter, CacheReleaseExit,
        CacheDownloadEnter, CacheDownloadExit, CacheVerifyEnter, CacheVerifyExit,
        CacheMutationEnter, CacheMutationExit,
        SyntheticMarkerCreateEnter, SyntheticMarkerCreateExit,
        SyntheticMarkerWriteEnter, SyntheticMarkerWriteExit,
        SyntheticMarkerFlushEnter, SyntheticMarkerFlushExit,
        SyntheticMarkerCloseEnter, SyntheticMarkerCloseExit,
        SyntheticRootPrepareEnter, SyntheticRootPrepareExit,
        SyntheticEntryLeaseGapOpen, SyntheticEntryLeaseGapClosed,
        SyntheticOutsidePrecheckEnter, SyntheticOutsidePrecheckExit,
        SyntheticPrewarmStart, SyntheticPrewarmComplete,
        OwnedDirectoryGateEnter, OwnedDirectoryGateAcquired, OwnedDirectoryGateExit,
        ReserveOwnerExistsEnter, ReserveOwnerExistsExit,
        ReservePathSafeEnter, ReservePathSafeExit,
        ReserveStaleEnter, ReserveStaleExit,
        ReservationTemporaryOpenEnter, ReservationTemporaryOpenExit,
        ReservationWriteEnter, ReservationWriteExit,
        ReservationFlushEnter, ReservationFlushExit,
        ReservationTemporaryDisposeEnter, ReservationTemporaryDisposeExit,
        ReservationPublishGuardOpenEnter, ReservationPublishGuardOpenExit,
        ReservationMoveEnter, ReservationMoveExit,
        ReservationFinalOpenEnter, ReservationFinalOpenExit,
        ReservationIdentityEnter, ReservationIdentityExit,
        ReservationRegisterEnter, ReservationRegisterExit,
        SyntheticReservationOwnerPrewarmStart, SyntheticReservationOwnerPrewarmComplete,
        // These Exit events mean the operation returned or threw, not success.
        ReservedOwnerCheckEnter, ReservedOwnerCheckExit,
        ReservedDirectoriesCheckEnter, ReservedDirectoriesCheckExit,
        ReservedFilesEnumeratorEnter, ReservedFilesEnumeratorExit,
        ReservedFilesMoveEnter, ReservedFilesMoveExit, ReservedFilesDisposeEnter, ReservedFilesDisposeExit,
        ReservedRecordReadEnter, ReservedRecordReadExit,
        SyntheticSerialTransferEnter, SyntheticSerialTransferExit, SyntheticAdmissionTimedOut,
        SyntheticCallbackProcess,
        PendingMarkerMutateOpenEnter, PendingMarkerMutateOpenVerified, PendingMarkerMutateWriteComplete,
        PendingMarkerMutateFlushComplete, PendingMarkerMutateCloseComplete,
        PendingMarkerAWaiting, PendingMarkerBReadEnter, PendingMarkerBReadVerified,
        PendingMarkerBReadExit, PendingMarkerAReleased, PendingMarkerInvalid,
        CacheEntryPathSafeEnter, CacheEntryPathSafeExit,
        CacheFilePathSafeEnter, CacheFilePathSafeExit,
        CacheEntryLeaseOpenExit
    }
    internal readonly record struct Event(long Sequence, long Timestamp, int ThreadId, Stage Kind, long CallbackId = 0, uint ProcessId = 0, byte ProcessInfoStatus = 0);
    internal sealed class Capture
    {
        internal readonly Event[] Events = new Event[2048];
        internal readonly int[] Published = new int[2048];
        internal long Count;
    }
    private static Capture? active;
    private static long syntheticCallbackSequence;
    internal static long NextSyntheticCallbackId() => Interlocked.Increment(ref syntheticCallbackSequence);
    internal static Capture Enable()
    {
        var capture = new Capture();
        if (Interlocked.CompareExchange(ref active, capture, null) is not null)
            throw new InvalidOperationException("A diagnostic capture is already active.");
        return capture;
    }
    internal static void Disable(Capture capture) => Interlocked.CompareExchange(ref active, null, capture);
    // Attempted may include still-unpublished reservations. Dropped counts only
    // reservations beyond capacity, not slots a preempted writer has yet to publish.
    internal static long Attempted(Capture capture) => Math.Max(0L, Volatile.Read(ref capture.Count));
    internal static long Dropped(Capture capture) => Math.Max(0L, Attempted(capture) - capture.Events.Length);
    internal static void Record(Stage kind, long callbackId = 0, uint processId = 0, byte processInfoStatus = 0)
    {
        var capture = Volatile.Read(ref active);
        if (capture is null) return;
        var slot = ReserveSlot(capture);
        if (slot >= 0) PublishSlot(capture, slot, kind, callbackId, processId, processInfoStatus);
    }
    // Separated primitives also let the test deterministically model a writer
    // preempted between reserving a slot and publishing it. Neither invokes
    // callbacks, waits, or performs I/O on the native path.
    internal static int ReserveSlot(Capture capture)
    {
        var index = Interlocked.Increment(ref capture.Count) - 1;
        return (ulong)index >= (ulong)capture.Events.Length ? -1 : (int)index;
    }
    internal static void PublishSlot(Capture capture, int slot, Stage kind, long callbackId = 0, uint processId = 0, byte processInfoStatus = 0)
    {
        capture.Events[slot] = new(slot + 1L, Stopwatch.GetTimestamp(), Environment.CurrentManagedThreadId, kind, callbackId, processId, processInfoStatus);
        Volatile.Write(ref capture.Published[slot], 1);
    }
    // Publications can arrive out of sequence. A consumer must track each seen
    // Sequence, not use the greatest observed sequence as a high-water mark.
    // Disable prevents new writers joining but does not wait for an already
    // reserved slot to publish; snapshots are not proof that writers drained.
    internal static Event[] Snapshot(Capture capture)
    {
        var count = (int)Math.Min(Math.Max(Volatile.Read(ref capture.Count), 0L), capture.Events.Length);
        var result = new List<Event>(count);
        for (var i = 0; i < count; i++)
            if (Volatile.Read(ref capture.Published[i]) != 0) result.Add(capture.Events[i]);
        return result.ToArray();
    }
}
#endif
