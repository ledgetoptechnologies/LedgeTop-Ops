using System.Globalization;

namespace LedgeTop.WindowsDownload;

public enum HydrationStage { Context, AuthorizationBefore, CachePreparation, Download, CacheVerification, AuthorizationAfter, Transfer, NativeProgress, NativeTransfer }
public enum HydrationFailureCategory { Transfer, LoginRequired, AccessDenied, ResourceUnavailable, LocalIO, LocalAccessDenied, Native, Cancelled, Unknown, DownloadsPaused }

/// <summary>Local availability state only; never indicates missing or rejected credentials.</summary>
public sealed class DownloadsPausedException() : Exception("Downloads are paused. Resume downloads to open online-only files.");

/// <summary>Bounded failure facts only: never stores an exception, filename, selector, URL or message.</summary>
public sealed class HydrationFailureDiagnostic
{
    public HydrationStage Stage { get; }
    public HydrationFailureCategory Category { get; }
    public TransferFailureReason Reason { get; }
    public int? HttpStatus { get; }
    public int? NativeHResult { get; }
    public int? SettlementHResult { get; }
    public LoginFailureReason? LoginReason { get; }
    public LoginFailureOperation? LoginOperation { get; }
    public AccessDenialReason? AccessReason { get; }
    public DenialOperation? DenialOperation { get; }
    public DenialMediaType? DenialMediaType { get; }
    internal HydrationFailureDiagnostic(HydrationStage stage, HydrationFailureCategory category,
        TransferFailureReason reason = TransferFailureReason.Unknown, int? httpStatus = null, int? nativeHResult = null, int? settlementHResult = null,
        LoginFailureReason? loginReason = null, LoginFailureOperation? loginOperation = null, AccessDenialReason? accessReason = null,
        DenialOperation? denialOperation = null, DenialMediaType? denialMediaType = null)
    {
        if (!Enum.IsDefined(stage) || !Enum.IsDefined(category) ||
            (category == HydrationFailureCategory.Native ? nativeHResult is null or 0 || stage is not (HydrationStage.NativeProgress or HydrationStage.NativeTransfer) : nativeHResult is not null) ||
            settlementHResult == 0 ||
            loginReason.HasValue != loginOperation.HasValue ||
            loginReason is { } login && (!Enum.IsDefined(login) || category != HydrationFailureCategory.LoginRequired) ||
            loginOperation is { } operation && !Enum.IsDefined(operation) ||
            accessReason is { } denial && (!Enum.IsDefined(denial) || category != HydrationFailureCategory.AccessDenied) ||
            denialOperation.HasValue != denialMediaType.HasValue ||
            denialOperation is { } op && (!Enum.IsDefined(op) || accessReason != AccessDenialReason.HttpForbidden) ||
            denialMediaType is { } media && !Enum.IsDefined(media)) throw new ArgumentException("A bounded hydration failure is required.");
        var validated = new TransferException("Hydration failure facts.", reason, httpStatus);
        Stage = stage; Category = category; Reason = validated.Reason; HttpStatus = validated.HttpStatus;
        NativeHResult = nativeHResult; SettlementHResult = settlementHResult;
        LoginReason = loginReason; LoginOperation = loginOperation;
        AccessReason = accessReason;
        DenialOperation=denialOperation; DenialMediaType=denialMediaType;
    }
    internal HydrationFailureDiagnostic WithSettlement(int status) => new(Stage, Category, Reason, HttpStatus, NativeHResult, status, LoginReason, LoginOperation, AccessReason, DenialOperation, DenialMediaType);
    public string ActivityText => (Category == HydrationFailureCategory.Transfer && Reason == TransferFailureReason.ServiceBusy
        ? "The file service is busy. Please try opening the file again shortly. Support code: hydrate/"
        : Category == HydrationFailureCategory.DownloadsPaused
        ? "Downloads are paused. Resume downloads to open online-only files. Support code: hydrate/"
        : Category == HydrationFailureCategory.AccessDenied && AccessReason == AccessDenialReason.HttpForbidden
        ? "The file service denied access to this file. Ask your LedgeTop contact to check access and the saved file reference. Support code: hydrate/"
        : "File availability failed. Support code: hydrate/") + Stage + "/" + Category + "/" + Reason +
        (HttpStatus is { } http ? "; HTTP " + http.ToString(CultureInfo.InvariantCulture) : "") +
        (LoginOperation is { } operation ? "; auth=" + operation + "/" + LoginReason : "") +
        (LoginReason == LoginFailureReason.HttpUnauthorized ? "; HTTP 401" : "") +
        (NativeHResult is { } native ? "; native=0x" + unchecked((uint)native).ToString("X8", CultureInfo.InvariantCulture) : "") +
        (SettlementHResult is { } settlement ? "; settlement=0x" + unchecked((uint)settlement).ToString("X8", CultureInfo.InvariantCulture) : "");
    internal static HydrationFailureDiagnostic FromException(HydrationStage stage, Exception error)
    {
        if (error is TransferException { HydrationFailure: { } retained }) return retained;
        var category = error switch {
            DownloadsPausedException => HydrationFailureCategory.DownloadsPaused,
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
            error is TransferException typed ? typed.HttpStatus : null,
            loginReason: error is LoginRequiredException login ? login.Reason : null,
            loginOperation: error is LoginRequiredException operation ? operation.Operation : null,
            accessReason: error is AccessDeniedException denial ? denial.Reason : null,
            denialOperation: error is AccessDeniedException access ? access.Operation : null,
            denialMediaType: error is AccessDeniedException accessMedia ? accessMedia.MediaType : null);
    }
}

internal interface IPlaceholderFailureDiagnostics
{
    void ObservePrimaryFailure(HydrationFailureDiagnostic diagnostic);
    HydrationFailureDiagnostic? PrimaryFailure { get; }
}
