namespace LedgeTop.Files.Explorer;

internal enum LocalAvailabilityStage { Inspect, Hydrate, Open, Unpin, Dehydrate, CacheReclamation }
internal enum LocalAvailabilityFailureKind { Native, LocalIO, LocalAccessDenied, Transfer, Unknown }

/// <summary>Bounded operation facts only. No paths, exception messages or inner exceptions.</summary>
internal sealed class LocalAvailabilityException : IOException
{
    internal LocalAvailabilityStage Stage { get; }
    internal LocalAvailabilityFailureKind Kind { get; }
    internal int? NativeHResult { get; }
    private LocalAvailabilityException(LocalAvailabilityStage stage, LocalAvailabilityFailureKind kind, int? nativeHResult = null)
        : base("The local availability operation was not confirmed.")
    {
        if (!Enum.IsDefined(stage) || !Enum.IsDefined(kind) ||
            (kind == LocalAvailabilityFailureKind.Native ? nativeHResult is null or >= 0 : nativeHResult is not null))
            throw new ArgumentException("Bounded local availability facts are required.");
        Stage = stage; Kind = kind; NativeHResult = nativeHResult;
    }
    internal static LocalAvailabilityException FromException(LocalAvailabilityStage stage, Exception error) =>
        error as LocalAvailabilityException ?? new(stage, error switch {
            UnauthorizedAccessException => LocalAvailabilityFailureKind.LocalAccessDenied,
            IOException => LocalAvailabilityFailureKind.LocalIO,
            LedgeTop.WindowsDownload.TransferException => LocalAvailabilityFailureKind.Transfer,
            _ => LocalAvailabilityFailureKind.Unknown
        });
    internal static void Check(int result, LocalAvailabilityStage stage)
    { if (result < 0) throw new LocalAvailabilityException(stage, LocalAvailabilityFailureKind.Native, result); }
    internal string ActivityText => (Stage == LocalAvailabilityStage.CacheReclamation
        ? "The file is online-only, but its temporary download cache could not be cleared. Support code: availability/"
        : "Could not change local availability. Support code: availability/") + Stage + "/" + Kind +
        (NativeHResult is { } result ? "; native=0x" + unchecked((uint)result).ToString("X8", System.Globalization.CultureInfo.InvariantCulture) : "");
}

internal interface ILocalAvailabilityNative
{
    int Open(out nint handle);
    int Unpin(nint handle);
    int Dehydrate(nint handle);
    void Close(nint handle);
}

internal static class LocalAvailabilityOperations
{
    // Do not infer complete dehydration from Offline/Recall attributes or change oplock protection.
    internal static void FreeNative(ILocalAvailabilityNative native, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var stage = LocalAvailabilityStage.Open;
        nint handle = 0; var opened = false;
        try {
            LocalAvailabilityException.Check(native.Open(out handle), stage); opened = true;
            stage = LocalAvailabilityStage.Unpin;
            LocalAvailabilityException.Check(native.Unpin(handle), stage);
            stage = LocalAvailabilityStage.Dehydrate;
            LocalAvailabilityException.Check(native.Dehydrate(handle), stage);
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) { throw LocalAvailabilityException.FromException(stage, error); }
        finally { if (opened) native.Close(handle); }
    }
}
