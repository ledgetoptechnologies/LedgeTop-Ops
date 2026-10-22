using System.Collections.ObjectModel;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Presentation;

public enum Screen { Loading, SignIn, Files, NotSetUp }

/// <summary>Platform services the view model needs from the window, so the logic stays testable.</summary>
public interface IShell
{
    void OnUi(Action action);
    string? PickFolder(string current);
    void OpenFile(string path);
    void ShowInFolder(string path);
}

/// <summary>One window: sign-in when needed, then every authorized source in one tree with one transfer list.</summary>
public sealed class MainViewModel : Observable, IAsyncDisposable
{
    private static readonly TimeSpan ExpiryWarning = TimeSpan.FromMinutes(5);
    private readonly IFilesBackend backend;
    private readonly IShell shell;
    private readonly Func<DateTimeOffset> now;
    private readonly Dictionary<Guid, (long Bytes, DateTimeOffset At, double Rate)> rates = [];
    private QueueHost? queue;
    private SessionInfo? session;
    private Screen screen = Screen.Loading;
    private string signInStatus = "", banner = "", sessionText = "", notice = "", destination;
    private bool signingIn, bannerIsError;
    private NodeViewModel? selected;

    public MainViewModel(IFilesBackend backend, IShell shell, string defaultDestination, Func<DateTimeOffset>? clock = null)
    {
        this.backend = backend; this.shell = shell; now = clock ?? (() => DateTimeOffset.Now);
        destination = defaultDestination;
        SignIn = new Command(SignInAsync, () => !signingIn, Fail);
        DownloadSelected = new Command(DownloadSelectedAsync, () => Files.Any(file => file.IsChecked && file.CanDownload), Fail);
        ChangeFolder = new Command(ChooseFolder);
        PauseAll = new Command(() => queue?.PauseAllAsync() ?? Task.CompletedTask, () => Transfers.Any(item => item.IsActive), Fail);
        ResumeAll = new Command(() => queue?.ResumeAllAsync() ?? Task.CompletedTask, () => Transfers.Any(item => item.State == QueuedTransferState.Paused), Fail);
        ClearFinished = new Command(() => { foreach (var done in Transfers.Where(item => item.IsFinished).ToList()) Transfers.Remove(done); },
            () => Transfers.Any(item => item.IsFinished));
    }

    public Screen Screen { get => screen; private set => Set(ref screen, value); }
    public string SignInStatus { get => signInStatus; private set => Set(ref signInStatus, value); }
    public string Banner { get => banner; private set { if (Set(ref banner, value)) Raise(nameof(HasBanner)); } }
    public bool BannerIsError { get => bannerIsError; private set => Set(ref bannerIsError, value); }
    public bool HasBanner => Banner.Length > 0;
    public string SessionText { get => sessionText; private set => Set(ref sessionText, value); }
    public string Notice { get => notice; private set { if (Set(ref notice, value)) Raise(nameof(HasNotice)); } }
    public bool HasNotice => Notice.Length > 0;
    public string Destination { get => destination; private set => Set(ref destination, value); }

    public ObservableCollection<NodeViewModel> Sections { get; } = [];
    public ObservableCollection<FileRow> Files { get; } = [];
    public ObservableCollection<TransferRow> Transfers { get; } = [];
    public string Location => selected?.Path ?? "";
    public string FilesEmptyText => selected is null ? "Choose a folder on the left to see its files." : "This folder has no files.";

    public Command SignIn { get; }
    public Command DownloadSelected { get; }
    public Command ChangeFolder { get; }
    public Command PauseAll { get; }
    public Command ResumeAll { get; }
    public Command ClearFinished { get; }

    /// <summary>Shown when this PC has no trusted setup for the real sources.</summary>
    public void ShowNotSetUp() => Screen = Screen.NotSetUp;

    /// <summary>Uses a cached session if there is one; never opens a browser.</summary>
    public async Task StartAsync()
    {
        try {
            var current = await backend.Session.TryCurrentAsync();
            if (current is null) { Screen = Screen.SignIn; return; }
            await EnterAsync(current);
        } catch (Exception error) { Fail(error); Screen = Screen.SignIn; }
    }

    private async Task SignInAsync()
    {
        signingIn = true; SignIn.Refresh();
        SignInStatus = "Finish signing in in your browser, then come back here.";
        try {
            await backend.Session.SignInAsync();
            var current = await backend.Session.TryCurrentAsync();
            if (current is null) { SignInStatus = "You weren't signed in. Try again when you're ready."; return; }
            SignInStatus = "";
            await EnterAsync(current);
        } catch (OperationCanceledException) {
            SignInStatus = "Sign-in was cancelled.";
        } catch (Exception) {
            SignInStatus = "Couldn't sign you in. Check your connection and try again.";
        } finally { signingIn = false; SignIn.Refresh(); }
    }

    private async Task EnterAsync(SessionInfo current)
    {
        session = current; Banner = ""; UpdateSession();
        if (queue is null) {
            queue = await QueueHost.OpenAsync(backend.StateDirectory, backend.Sources);
            queue.Changed += () => shell.OnUi(() => _ = RefreshTransfersAsync());
            queue.Progress += (id, progress) => shell.OnUi(() => OnProgress(id, progress));
        }
        Screen = Screen.Files;
        await LoadSectionsAsync();
        await RefreshTransfersAsync();
        _ = queue.PumpAsync();
    }

    /// <summary>Called every few seconds by the window: warns before expiry and pauses work after it.</summary>
    public void Tick()
    {
        if (session is null || Screen != Screen.Files) return;
        var left = session.ExpiresAt - now();
        if (left <= TimeSpan.Zero) {
            session = null; Screen = Screen.SignIn; SignInStatus = Text.SessionExpired;
            _ = RefreshTransfersAsync();
            return;
        }
        UpdateSession();
        if (left <= ExpiryWarning) { Banner = Text.SessionExpiring(left); BannerIsError = false; }
    }

    private void UpdateSession() => SessionText = session is null ? "" : Text.SignedInUntil(session.ExpiresAt);

    private async Task LoadSectionsAsync()
    {
        Sections.Clear();
        foreach (var node in await backend.Catalog.GetSectionsAsync())
            Sections.Add(new NodeViewModel(node, null, this));
    }

    internal async Task<IReadOnlyList<CatalogNode>> ChildrenAsync(CatalogNode node) => await backend.Catalog.GetChildrenAsync(node);

    /// <summary>Shows a folder's files. Sections and roots without files just expand.</summary>
    public async Task SelectAsync(NodeViewModel? node)
    {
        selected = node; Raise(nameof(Location)); Raise(nameof(FilesEmptyText));
        Files.Clear(); Notice = "";
        if (node is null || node.Node.Kind == NodeKind.Section) { DownloadSelected.Refresh(); return; }
        try {
            var listing = await backend.Catalog.ListAsync(node.Node);
            if (selected != node) return;
            foreach (var file in listing.Files.OrderBy(file => file.Name, StringComparer.CurrentCultureIgnoreCase))
                Files.Add(new FileRow(file, DownloadSelected.Refresh));
        } catch (Exception error) { Fail(error); }
        DownloadSelected.Refresh();
    }

    private async Task DownloadSelectedAsync()
    {
        if (queue is null) return;
        var chosen = Files.Where(file => file.IsChecked && file.CanDownload).ToList();
        var problem = Text.DestinationProblem(Destination);
        if (problem is not null) { Notice = problem; return; }
        Directory.CreateDirectory(Destination);
        var taken = new List<string>(); var already = 0;
        foreach (var row in chosen) {
            var reference = await backend.Catalog.GetReferenceAsync(row.File);
            switch (await queue.EnqueueAsync(row.File.SourceAlias, reference, row.File.Name, Destination)) {
                case EnqueueOutcome.NameTaken: taken.Add(row.File.Name); break;
                case EnqueueOutcome.AlreadyQueued: already++; break;
                default: row.IsChecked = false; break;
            }
        }
        var skipped = Files.Count(file => file.IsChecked && !file.CanDownload);
        Notice = string.Join(" ", new[] {
            taken.Count == 0 ? "" : taken.Count == 1
                ? $"{taken[0]} is already in this folder, so it wasn't downloaded again. Move it or choose another folder."
                : $"{taken.Count} files are already in this folder, so they weren't downloaded again. Move them or choose another folder.",
            already == 0 ? "" : already == 1 ? "One file was already in your downloads." : $"{already} files were already in your downloads.",
            skipped == 0 ? "" : skipped == 1 ? "One file couldn't be verified yet and was skipped." : $"{skipped} files couldn't be verified yet and were skipped.",
        }.Where(part => part.Length > 0));
        await RefreshTransfersAsync();
    }

    private void ChooseFolder()
    {
        var picked = shell.PickFolder(Destination);
        if (picked is null) return;
        var problem = Text.DestinationProblem(picked);
        if (problem is not null) { Notice = problem; return; }
        Destination = picked; Notice = "";
    }

    public async Task RefreshTransfersAsync()
    {
        if (queue is null) return;
        IReadOnlyList<TransferItem> items;
        try { items = await queue.SnapshotAsync(); }
        catch (LoginRequiredException) {
            if (Screen == Screen.Files) { session = null; Screen = Screen.SignIn; SignInStatus = Text.SessionExpired; }
            return;
        }
        catch (AccessDeniedException) {
            // Another person signed in: never show the previous person's downloads.
            Transfers.Clear(); Banner = "You're signed in as someone else. Their downloads are hidden."; BannerIsError = true;
            return;
        }
        catch (Exception error) { Fail(error); return; }
        var byId = Transfers.ToDictionary(row => row.Id);
        var ordered = new List<TransferRow>();
        foreach (var item in items) {
            if (!byId.TryGetValue(item.Job.JobId, out var row)) row = new TransferRow(this);
            row.Update(item);
            ordered.Add(row);
        }
        Transfers.Clear();
        foreach (var row in ordered) Transfers.Add(row);
        PauseAll.Refresh(); ResumeAll.Refresh(); ClearFinished.Refresh();
    }

    private void OnProgress(Guid id, DownloadProgress progress)
    {
        var at = now(); double rate = 0;
        if (rates.TryGetValue(id, out var last) && at > last.At && progress.BytesTransferred >= last.Bytes) {
            var instant = (progress.BytesTransferred - last.Bytes) / (at - last.At).TotalSeconds;
            rate = last.Rate <= 0 ? instant : last.Rate * 0.8 + instant * 0.2;
        }
        rates[id] = (progress.BytesTransferred, at, rate);
        Transfers.FirstOrDefault(row => row.Id == id)?.ShowProgress(progress, rate);
    }

    internal Task PauseAsync(TransferRow row) => queue is null || row.Item is null ? Task.CompletedTask : queue.PauseAsync(row.Item);
    internal Task CancelAsync(TransferRow row) => queue is null || row.Item is null ? Task.CompletedTask : queue.CancelAsync(row.Item);
    internal Task ResumeAsync(TransferRow row) => queue is null || row.Item is null ? Task.CompletedTask : queue.ResumeAsync(row.Item);
    internal void Open(TransferRow row) { if (row.OutputPath is { } path && File.Exists(path)) shell.OpenFile(path); }
    internal void Reveal(TransferRow row) { if (row.OutputPath is { } path) shell.ShowInFolder(path); }

    internal void Fail(Exception error)
    {
        Banner = error switch {
            LoginRequiredException => Text.SessionExpired,
            AccessDeniedException => "You don't have access to that anymore. Refresh to see what you can download.",
            ResourceUnavailableException => "That isn't available anymore. Refresh to see the current files.",
            QueueStorageException { CompletedFilePath: not null } => "The file was saved, but the download list couldn't be updated. Keep the saved file.",
            QueueStorageException => "The download list couldn't be saved, so no new download was started. Check that your drive has space.",
            HttpRequestException => "Couldn't reach Ledge Top. Check your connection and try again.",
            _ => "Something went wrong. Try again.",
        };
        BannerIsError = true;
    }

    public async ValueTask DisposeAsync()
    {
        if (queue is not null) await queue.DisposeAsync();
    }
}

/// <summary>A folder in the tree; children load the first time it expands.</summary>
public sealed class NodeViewModel : Observable
{
    private readonly MainViewModel owner;
    private bool expanded, loaded, isSelected;

    public NodeViewModel(CatalogNode node, NodeViewModel? parent, MainViewModel owner)
    {
        Node = node; Parent = parent; this.owner = owner;
        // A per-node placeholder makes the expander show until the real children load.
        Children.Add(new NodeViewModel());
    }

    private NodeViewModel() { Node = new CatalogNode("", "Loading…", NodeKind.Folder, ""); owner = null!; loaded = true; }

    public CatalogNode Node { get; }
    public NodeViewModel? Parent { get; }
    public string Name => Node.Name;
    public bool IsSection => Node.Kind == NodeKind.Section;
    public string Path => Parent is null || Parent.IsSection ? Name : Parent.Path + "  ›  " + Name;
    public ObservableCollection<NodeViewModel> Children { get; } = [];

    public bool IsExpanded
    {
        get => expanded;
        set { if (Set(ref expanded, value) && value) _ = LoadAsync(); }
    }

    public bool IsSelected
    {
        get => isSelected;
        set { if (Set(ref isSelected, value) && value && owner is not null && Node.Key.Length > 0) _ = owner.SelectAsync(this); }
    }

    private async Task LoadAsync()
    {
        if (loaded || owner is null) return;
        loaded = true;
        try {
            var children = await owner.ChildrenAsync(Node);
            Children.Clear();
            foreach (var child in children) Children.Add(new NodeViewModel(child, this, owner));
        } catch (Exception error) { Children.Clear(); loaded = false; owner.Fail(error); }
    }
}

public sealed class FileRow(CatalogFile file, Action changed) : Observable
{
    private bool isChecked;
    public CatalogFile File { get; } = file;
    public string Name => File.Name;
    public string Type => Text.FileType(File.Name);
    public string Size => Text.Size(File.Size);
    public bool CanDownload => File.Verifiable;
    public string Status => File.Verifiable ? "" : Text.ChecksumUnavailable;
    public string StatusDetail => File.Verifiable ? "" : Text.ChecksumUnavailableDetail;
    public bool IsChecked { get => isChecked; set { if (Set(ref isChecked, value)) changed(); } }
}

public sealed class TransferRow : Observable
{
    private readonly MainViewModel owner;
    private string status = "", detail = "", progressText = "";
    private double percent;
    private QueuedTransferState state;

    public TransferRow(MainViewModel owner)
    {
        this.owner = owner;
        Pause = new Command(() => owner.PauseAsync(this), () => IsActive, owner.Fail);
        Resume = new Command(() => owner.ResumeAsync(this), () => CanResume, owner.Fail);
        Cancel = new Command(() => owner.CancelAsync(this), () => !IsFinished, owner.Fail);
        Open = new Command(() => owner.Open(this), () => State == QueuedTransferState.Completed);
        Reveal = new Command(() => owner.Reveal(this), () => OutputPath is not null);
    }

    public TransferItem? Item { get; private set; }
    public Guid Id => Item?.Job.JobId ?? Guid.Empty;
    public string Name => Item?.Job.FileName ?? "";
    public string Type => Text.FileType(Name);
    public QueuedTransferState State { get => state; private set => Set(ref state, value); }
    public string Status { get => status; private set => Set(ref status, value); }
    public string Detail { get => detail; private set { if (Set(ref detail, value)) Raise(nameof(HasDetail)); } }
    public bool HasDetail => Detail.Length > 0;
    public string ProgressText { get => progressText; private set => Set(ref progressText, value); }
    public double Percent { get => percent; private set => Set(ref percent, value); }
    public bool IsActive => State is QueuedTransferState.Running or QueuedTransferState.Queued;
    public bool IsRunning => State == QueuedTransferState.Running;
    public bool IsFinished => State is QueuedTransferState.Completed or QueuedTransferState.Cancelled or QueuedTransferState.VersionChanged
        or QueuedTransferState.AccessDenied or QueuedTransferState.ResourceUnavailable;
    /// <summary>Paused or failed items can continue; a session problem continues after signing in.</summary>
    public bool CanResume => State is QueuedTransferState.Paused or QueuedTransferState.Failed or QueuedTransferState.LoginRequired;
    public string ResumeLabel => State == QueuedTransferState.Paused ? "Resume" : "Retry";
    public bool IsWarning => State is QueuedTransferState.VersionChanged or QueuedTransferState.LoginRequired
        || (State == QueuedTransferState.Paused && Item?.Job.RecoveryRequired == true);
    public bool IsError => State is QueuedTransferState.Failed or QueuedTransferState.AccessDenied or QueuedTransferState.ResourceUnavailable;
    public string? OutputPath => Item is { Job.State: QueuedTransferState.Completed } done ? System.IO.Path.Combine(done.Job.Destination, done.Job.FileName) : null;

    public Command Pause { get; }
    public Command Resume { get; }
    public Command Cancel { get; }
    public Command Open { get; }
    public Command Reveal { get; }

    public void Update(TransferItem item)
    {
        Item = item; State = item.Job.State;
        Status = Text.State(item.Job); Detail = Text.Detail(item.Job);
        if (State == QueuedTransferState.Completed) { Percent = 100; ProgressText = Text.Size(item.Job.Length) + " · saved to " + item.Job.Destination; }
        else if (State != QueuedTransferState.Running) ProgressText = Text.Size(item.Job.Length);
        foreach (var name in new[] { nameof(Name), nameof(Type), nameof(Id), nameof(IsActive), nameof(IsRunning), nameof(IsFinished),
            nameof(CanResume), nameof(ResumeLabel), nameof(IsWarning), nameof(IsError), nameof(OutputPath) }) Raise(name);
        foreach (var command in new[] { Pause, Resume, Cancel, Open, Reveal }) command.Refresh();
    }

    public void ShowProgress(DownloadProgress progress, double rate)
    {
        Percent = progress.TotalBytes <= 0 ? 0 : Math.Round(100.0 * progress.BytesTransferred / progress.TotalBytes, 1);
        ProgressText = Text.Progress(progress, rate);
    }
}
