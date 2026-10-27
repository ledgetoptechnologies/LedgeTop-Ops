namespace LedgeTop.Files.Explorer;

/// <summary>Generated-data facade. Existing schema2 ownership, paths and phase serialization are unchanged.</summary>
public sealed class ExplorerPreviewSession : IExplorerPreviewSession
{
    private readonly OwnedExplorerRootSession owned;
    public ExplorerPreviewSession() : this(
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFilesExplorerPreview", "v2"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "LedgeTop Files Preview")) { }

    public ExplorerPreviewSession(string profileDirectory, string preferredRoot)
    {
        owned = OwnedExplorerRootSession.Generated(profileDirectory, preferredRoot);
        owned.Changed += (_, e) => Changed?.Invoke(this, e);
    }

    public string RootPath => owned.RootPath;
    public ExplorerPreviewState State => owned.State;
    public IReadOnlyList<string> Activity => owned.Activity;
    public event EventHandler? Changed;
    public Task StartAsync() => owned.StartAsync();
    public Task PauseAsync() => owned.PauseAsync();
    public Task ResumeAsync() => owned.ResumeAsync();
    public Task RemoveAsync() => owned.RemoveAsync();
    public bool VerifyRecordedRemovedAbsence() => owned.VerifyRecordedRemovedAbsence();
    public ValueTask DisposeAsync() => owned.DisposeAsync();
}
