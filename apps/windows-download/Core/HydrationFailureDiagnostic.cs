using System.Globalization;

namespace LedgeTop.WindowsDownload;

public enum HydrationStage { Context, AuthorizationBefore, CachePreparation, Download, CacheVerification, AuthorizationAfter, Transfer, NativeProgress, NativeTransfer }
public enum HydrationFailureCategory { Transfer, LoginRequired, AccessDenied, ResourceUnavailable, LocalIO, LocalAccessDenied, Native, Cancelled, Unknown }

/// <summary>Bounded failure facts only: never stores an exception, filename, selector, URL or message.</summary>
public sealed class HydrationFailureDiagnostic
{
    public HydrationStage Stage { get; }
    public HydrationFailureCategory Category { get; }
    public TransferFailureReason Reason { get; }
    public int? HttpStatus { get; }
    public int? NativeHResult { get; }
    public int? SettlementHResult { get; }
    internal HydrationFailureDiagnostic(HydrationStage stage, HydrationFailureCategory category,
        TransferFailureReason reason = TransferFailureReason.Unknown, int? httpStatus = null, int? nativeHResult = null, int? settlementHResult = null)
    {
        if (!Enum.IsDefined(stage) || !Enum.IsDefined(category) ||
            (category == HydrationFailureCategory.Native ? nativeHResult is null or 0 || stage is not (HydrationStage.NativeProgress or HydrationStage.NativeTransfer) : nativeHResult is not null) ||
            settlementHResult == 0) throw new ArgumentException("A bounded hydration failure is required.");
        var validated = new TransferException("Hydration failure facts.", reason, httpStatus);
        Stage = stage; Category = category; Reason = validated.Reason; HttpStatus = validated.HttpStatus;
        NativeHResult = nativeHResult; SettlementHResult = settlementHResult;
    }
    internal HydrationFailureDiagnostic WithSettlement(int status) => new(Stage, Category, Reason, HttpStatus, NativeHResult, status);
    public string ActivityText => "File availability failed. Support code: hydrate/" + Stage + "/" + Category + "/" + Reason +
        (HttpStatus is { } http ? "; HTTP " + http.ToString(CultureInfo.InvariantCulture) : "") +
        (NativeHResult is { } native ? "; native=0x" + unchecked((uint)native).ToString("X8", CultureInfo.InvariantCulture) : "") +
        (SettlementHResult is { } settlement ? "; settlement=0x" + unchecked((uint)settlement).ToString("X8", CultureInfo.InvariantCulture) : "");
    internal static HydrationFailureDiagnostic FromException(HydrationStage stage, Exception error)
    {
        if (error is TransferException { HydrationFailure: { } retained }) return retained;
        var category = error switch {
            LoginRequiredException => HydrationFailureCategory.LoginRequired,
            AccessDeniedException => HydrationFailureCategory.AccessDenied,
            ResourceUnavailableException => HydrationFailureCategory.ResourceUnavailable,
            UnauthorizedAccessException => HydrationFailureCategory.LocalAccessDenied,
            IOException => HydrationFailureCategory.LocalIO,
            OperationCanceledException => HydrationFailureCategory.Cancelled,
            TransferException => HydrationFailureCategory.Transfer,
            _ => HydrationFailureCategory.Unknown
        };
        return new(stage, category, error is TransferException transfer ? transfer.Reason : TransferFailureReason.Unknown,
            error is TransferException typed ? typed.HttpStatus : null);
    }
}

internal interface IPlaceholderFailureDiagnostics
{
    void ObservePrimaryFailure(HydrationFailureDiagnostic diagnostic);
    HydrationFailureDiagnostic? PrimaryFailure { get; }
}
