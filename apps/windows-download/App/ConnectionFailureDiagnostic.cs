using System.Globalization;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files;

internal enum ConnectionAction { ExplicitConnect, CachedReconnect, Recheck, Pause, Resume, Remove, UpdateBinding, Dispose, StartupSetting, RetryAvailability, CatalogCheck }
internal enum ConnectionPhase { LocalOwnership, ProviderDrain, BackendDispose, BackendConstruction, SourceSelection, ExplicitLogin,
    CurrentSession, SourceSession, PrincipalBinding, SessionExpiry, InventoryPreparation, ProviderPreparation, OwnershipPublication,
    ProviderStart, ProviderPause, ProviderResume, ProviderRemoval, DisposePrevious, CreateSession, ExecuteSession, UpdateRecovery, StartupSetting }
internal enum ConnectionFailureKind { Transfer, LoginRequired, AccessDenied, ResourceUnavailable, LocalIO, LocalAccessDenied, Disposed, Cancelled, Unknown }

/// <summary>Closed diagnostic coordinates only; never retains an exception or serializes its message, inner exception, URL or data.</summary>
internal sealed class ConnectionFailureTrace(ConnectionAction action)
{
    internal ConnectionPhase Phase { get; set; } = ConnectionPhase.LocalOwnership;
    internal string Failure(Exception error, bool settings = false) => Format(action, Phase, error, settings);
    internal static string Format(ConnectionAction action, ConnectionPhase phase, Exception error, bool settings = false)
    {
        if (!Enum.IsDefined(action) || !Enum.IsDefined(phase)) throw new ArgumentOutOfRangeException();
        var kind = error switch {
            LoginRequiredException => ConnectionFailureKind.LoginRequired,
            AccessDeniedException => ConnectionFailureKind.AccessDenied,
            ResourceUnavailableException => ConnectionFailureKind.ResourceUnavailable,
            UnauthorizedAccessException => ConnectionFailureKind.LocalAccessDenied,
            IOException => ConnectionFailureKind.LocalIO,
            ObjectDisposedException => ConnectionFailureKind.Disposed,
            OperationCanceledException => ConnectionFailureKind.Cancelled,
            TransferException => ConnectionFailureKind.Transfer,
            _ => ConnectionFailureKind.Unknown
        };
        var reason = error is TransferException transfer ? transfer.Reason : TransferFailureReason.Unknown;
        var http = error is TransferException typed ? typed.HttpStatus : null;
        return "Connection action failed. Support code: " + (settings ? "settings/" : "connection/") + action + "/" + phase + "/" + kind + "/" + reason +
            (http is { } status ? "; HTTP " + status.ToString(CultureInfo.InvariantCulture) : "") +
            (error is LoginRequiredException login ? "; auth=" + login.Operation + "/" + login.Reason +
                (login.Reason == LoginFailureReason.HttpUnauthorized ? "; HTTP 401" : "") : "");
    }
}
