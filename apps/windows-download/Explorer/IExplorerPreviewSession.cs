namespace LedgeTop.Files.Explorer;

public enum ExplorerPreviewState { NotStarted, Starting, Running, Paused, Removed, Failed }

/// <summary>Requests another check of pending file-availability actions; it does not change pin states.</summary>
public interface IAvailabilityRetry
{
    bool CanRetryAvailability { get; }
    Task RetryAvailabilityAsync();
}

/// <summary>One owned Windows Explorer connection: generated preview or selected read-only source.
/// Constructing a session does not register a root or start authentication.</summary>
public interface IExplorerPreviewSession : IAsyncDisposable
{
    string RootPath { get; }
    ExplorerPreviewState State { get; }
    IReadOnlyList<string> Activity { get; }
    event EventHandler? Changed;
    Task StartAsync();
    Task PauseAsync();
    Task ResumeAsync();
    /// <summary>Removes the preview registration without deleting local files.</summary>
    Task RemoveAsync();
}
