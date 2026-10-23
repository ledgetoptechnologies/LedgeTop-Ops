namespace LedgeTop.WindowsDownload;

// Values must be copied from a trusted FETCH_DATA callback, never derived from paths or guessed handles.
internal sealed record CloudFilesOperationContext(long ConnectionKey, long TransferKey, long RequestKey,
    long FileSize, long RequiredOffset, long RequiredLength);
