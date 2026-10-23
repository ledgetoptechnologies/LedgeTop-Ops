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
    /// <summary>The person whose files and queue are open; everything shown belongs to them.</summary>
    private string? person;
    /// <summary>Bumped whenever the person's views are torn down, so late results from before are dropped.</summary>
    private int generation;
    private Screen screen = Screen.Loading;
    private string signInStatus = "", banner = "", sessionText = "", notice = "", destination, setupText = DefaultSetupText,
        setupTitle = "Ledge Top Files isn't set up on this PC yet";
    private bool signingIn, bannerIsError, checkingPerson;
    private NodeViewModel? selected;
    private object? moreFiles;
    private Task? closing;
    /// <summary>Set once the window is closing; anything still waiting on sign-in then opens nothing.</summary>
    private bool closed;
    /// <summary>A queue that is being opened right now, so closing can wait for it and release it.</summary>
    private Task<QueueHost>? opening;
    /// <summary>Previous people's queues while they stop after a sign-in change, so closing waits for them too.</summary>
    private readonly HashSet<Task> retiring = [];
    /// <summary>One sign-in at a time opens views, so two can never both open (and orphan) a queue.</summary>
    private readonly SemaphoreSlim entering = new(1, 1);

    private const string DefaultSetupText = "Install it from the link in Ledge Top Operations or your client portal. If you already did, ask your Ledge Top contact to check the installation.";

    public MainViewModel(IFilesBackend backend, IShell shell, string defaultDestination, Func<DateTimeOffset>? clock = null)
    {
        this.backend = backend; this.shell = shell; now = clock ?? (() => DateTimeOffset.Now);
        destination = defaultDestination;
        SignIn = new Command(SignInAsync, () => !signingIn, Fail);
        DownloadSelected = new Command(DownloadSelectedAsync, () => Files.Any(file => file.IsChecked && file.CanDownload), Fail);
        ChangeFolder = new Command(ChooseFolder);
        PauseAll = new Command(() => queue?.PauseAllAsync() ?? Task.CompletedTask, () => Transfers.Any(item => item.IsActive), Fail);
        ResumeAll = new Command(() => queue?.ResumeAllAsync() ?? Task.CompletedTask,
            () => Transfers.Any(item => item.State == QueuedTransferState.Paused) || queue?.HasHeld == true, Fail);
        LoadMoreFiles = new Command(LoadMoreFilesAsync, () => moreFiles is not null, Fail);
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
    public string SetupText { get => setupText; private set => Set(ref setupText, value); }
    public string SetupTitle { get => setupTitle; private set => Set(ref setupTitle, value); }
    public bool HasMoreFiles => moreFiles is not null;
    /// <summary>True while a transfer is running or still stopping; no network.</summary>
    public bool IsTransferring => queue?.IsBusy == true;

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
    public Command LoadMoreFiles { get; }

    /// <summary>Shown when this PC has no usable setup for the real sources; <paramref name="problem"/> says why.</summary>
    public void ShowNotSetUp(string? problem = null)
    {
        SetupTitle = problem is null ? "Ledge Top Files isn't set up on this PC yet" : "Ledge Top Files can't open on this PC";
        SetupText = problem ?? DefaultSetupText; Screen = Screen.NotSetUp;
    }

    internal bool IsCurrent(int view) => view == generation;

    /// <summary>Uses a cached session if there is one; never opens a browser.</summary>
    public async Task StartAsync()
    {
        if (closed) return;
        try {
            var current = await backend.Session.TryCurrentAsync();
            if (closed) return;
            if (current is null) { Screen = Screen.SignIn; return; }
            await EnterAsync(current);
        } catch (Exception error) { if (!closed) { Fail(error); Screen = Screen.SignIn; } }
    }

    private async Task SignInAsync()
    {
        if (closed) return;
        signingIn = true; SignIn.Refresh();
        SignInStatus = "Finish signing in in your browser, then come back here.";
        try {
            await backend.Session.SignInAsync();
            if (closed) return;
            var current = await backend.Session.TryCurrentAsync();
            if (closed) return;
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
        await entering.WaitAsync();
        try { await EnterOnceAsync(current); }
        finally { entering.Release(); }
    }

    private async Task EnterOnceAsync(SessionInfo current)
    {
        if (closed) return;
        if (person is not null && person != current.PrincipalId) {
            await CloseViewsAsync();
            // The window may have closed while the previous person's downloads were stopping.
            if (closed) return;
        }
        session = current; Banner = ""; UpdateSession();
        if (queue is null) {
            var view = generation;
            var open = QueueHost.OpenAsync(backend.StateDirectory, backend.Sources);
            opening = open;
            QueueHost host;
            try { host = await open; } finally { if (opening == open) opening = null; }
            // Closing took ownership of this queue while it opened and releases it.
            if (closed) return;
            if (view != generation) { await host.DisposeAsync(); return; }
            queue = host; person = current.PrincipalId;
            // Events from a host that has since been closed are ignored.
            host.Changed += () => shell.OnUi(() => { if (queue == host) _ = RefreshTransfersAsync(); });
            host.Progress += (id, progress) => shell.OnUi(() => { if (queue == host) OnProgress(id, progress); });
        }
        Screen = Screen.Files;
        await LoadSectionsAsync();
        await RefreshTransfersAsync();
        if (!closed) _ = queue?.PumpAsync();
    }

    /// <summary>
    /// Closes everything that belongs to the person who was signed in: their running transfer is stopped and
    /// drained, their queues are released, and every list and message is cleared. Results that were already
    /// on the way are dropped because the generation changes first.
    /// </summary>
    private async Task CloseViewsAsync()
    {
        generation++;
        var old = queue; queue = null; person = null;
        selected = null; moreFiles = null;
        Sections.Clear(); Files.Clear(); Transfers.Clear(); rates.Clear();
        Notice = ""; Banner = "";
        foreach (var name in new[] { nameof(Location), nameof(FilesEmptyText), nameof(HasMoreFiles) }) Raise(name);
        foreach (var command in new[] { DownloadSelected, PauseAll, ResumeAll, ClearFinished, LoadMoreFiles }) command.Refresh();
        if (old is null) return;
        var drain = old.DisposeAsync().AsTask();
        retiring.Add(drain);
        try { await drain; } finally { retiring.Remove(drain); }
    }

    /// <summary>
    /// Rechecks who is signed in (no browser). A different person replaces every view; no session goes back to sign-in.
    /// </summary>
    public async Task CheckPersonAsync()
    {
        if (closed || checkingPerson || person is null) return;
        checkingPerson = true;
        try {
            var current = await backend.Session.TryCurrentAsync();
            if (closed) return;
            if (current is null) { if (Screen == Screen.Files) { session = null; Screen = Screen.SignIn; SignInStatus = Text.SessionExpired; } return; }
            if (current.PrincipalId == person) return;
            await CloseViewsAsync();
            await EnterAsync(current);
            Banner = "You're signed in as someone else now, so the previous person's files and downloads were closed."; BannerIsError = false;
        } catch (Exception error) { Fail(error, recheck: false); }
        finally { checkingPerson = false; }
    }

    /// <summary>Called every few seconds by the window: warns before expiry, pauses work after it and notices a different sign-in.</summary>
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
        _ = CheckPersonAsync();
    }

    private void UpdateSession() => SessionText = session is null ? "" : Text.SignedInUntil(session.ExpiresAt);

    private async Task LoadSectionsAsync()
    {
        var view = generation;
        var sections = await backend.Catalog.GetSectionsAsync();
        if (view != generation) return;
        Sections.Clear();
        foreach (var node in sections) Sections.Add(new NodeViewModel(node, null, this, view));
    }

    internal Task<NodePage> ChildrenAsync(CatalogNode node, object? more) => backend.Catalog.GetChildrenAsync(node, more);

    /// <summary>Shows a folder's first page of files. Sections and roots without files just expand.</summary>
    public async Task SelectAsync(NodeViewModel? node)
    {
        // A node from a previous person's tree changes nothing, not even the breadcrumb.
        if (node is not null && !IsCurrent(node.View)) return;
        selected = node; moreFiles = null;
        foreach (var name in new[] { nameof(Location), nameof(FilesEmptyText), nameof(HasMoreFiles) }) Raise(name);
        Files.Clear(); Notice = ""; LoadMoreFiles.Refresh();
        if (node is null || node.Node.Kind == NodeKind.Section) { DownloadSelected.Refresh(); return; }
        await AddFilesAsync(node, null);
    }

    private Task LoadMoreFilesAsync() => selected is { } node && moreFiles is { } more ? AddFilesAsync(node, more) : Task.CompletedTask;

    private async Task AddFilesAsync(NodeViewModel node, object? more)
    {
        var view = generation;
        try {
            var listing = await backend.Catalog.ListAsync(node.Node, more);
            // Another folder, or another person, may have been chosen meanwhile.
            if (view != generation || selected != node) return;
            foreach (var file in listing.Files.OrderBy(file => file.Name, StringComparer.CurrentCultureIgnoreCase))
                Files.Add(new FileRow(file, DownloadSelected.Refresh));
            moreFiles = listing.More;
        } catch (Exception error) { if (view == generation) Fail(error); }
        Raise(nameof(HasMoreFiles)); LoadMoreFiles.Refresh(); DownloadSelected.Refresh();
    }

    private async Task DownloadSelectedAsync()
    {
        if (queue is not { } host) return;
        var chosen = Files.Where(file => file.IsChecked && file.CanDownload).ToList();
        var problem = Text.DestinationProblem(Destination);
        if (problem is not null) { Notice = problem; return; }
        Directory.CreateDirectory(Destination);
        var taken = new List<string>(); var already = 0; var unsafeNames = 0;
        foreach (var row in chosen) {
            var reference = await backend.Catalog.GetReferenceAsync(row.File);
            if (queue != host) return;
            switch (await host.EnqueueAsync(row.File.SourceAlias, reference, row.File.Name, Destination)) {
                case EnqueueOutcome.NameTaken: taken.Add(row.File.Name); break;
                case EnqueueOutcome.AlreadyQueued: already++; break;
                case EnqueueOutcome.UnsafeName: unsafeNames++; break;
                default: row.IsChecked = false; break;
            }
        }
        if (queue != host) return;
        var skipped = Files.Count(file => file.IsChecked && !file.CanDownload);
        Notice = string.Join(" ", new[] {
            taken.Count == 0 ? "" : taken.Count == 1
                ? $"{taken[0]} is already in this folder, so it wasn't downloaded again. Move it or choose another folder."
                : $"{taken.Count} files are already in this folder, so they weren't downloaded again. Move them or choose another folder.",
            already == 0 ? "" : already == 1 ? "One file was already in your downloads." : $"{already} files were already in your downloads.",
            unsafeNames == 0 ? "" : unsafeNames == 1 ? "One file has a name Windows can't save safely, so it was skipped. Ask your Ledge Top contact to rename it."
                : $"{unsafeNames} files have names Windows can't save safely, so they were skipped. Ask your Ledge Top contact to rename them.",
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
        if (queue is not { } host) return;
        IReadOnlyList<TransferItem> items;
        try { items = await host.SnapshotAsync(); }
        catch (LoginRequiredException) {
            if (queue == host && Screen == Screen.Files) { session = null; Screen = Screen.SignIn; SignInStatus = Text.SessionExpired; }
            return;
        }
        catch (AccessDeniedException) {
            // The queue belongs to someone else now: never show it, and find out who is signed in.
            if (queue != host) return;
            Transfers.Clear();
            await CheckPersonAsync();
            return;
        }
        catch (Exception error) { if (queue == host) Fail(error); return; }
        if (queue != host) return;
        var byId = Transfers.ToDictionary(row => row.Id);
        var ordered = new List<TransferRow>();
        foreach (var item in items) {
            if (!byId.TryGetValue(item.Job.JobId, out var row)) row = new TransferRow(this);
            // Show what the person asked for: held items read as paused and resumed ones as waiting.
            var shown = item.Job.State switch {
                QueuedTransferState.Queued when host.IsHeld(item.Job.JobId) => item with { Job = item.Job with { State = QueuedTransferState.Paused } },
                QueuedTransferState.Paused when host.IsWanted(item.Job.JobId) => item with { Job = item.Job with { State = QueuedTransferState.Queued } },
                _ => item,
            };
            row.Update(shown);
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

    internal void Fail(Exception error) => Fail(error, recheck: true);

    private void Fail(Exception error, bool recheck)
    {
        // Access can be denied because a different person signed in; that is handled as a switch, not an error.
        if (recheck && error is AccessDeniedException) _ = CheckPersonAsync();
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

    /// <summary>
    /// Stops and saves this person's downloads and releases their queues. Closing twice (window and owner) waits on the
    /// same shutdown. A queue still opening (sign-in finishing while the window closes) is released too.
    /// The model owns its backend, so the backend's connections are released last, after every queue.
    /// </summary>
    public ValueTask DisposeAsync() => new(closing ??= CloseAsync());

    private async Task CloseAsync()
    {
        closed = true; generation++;
        var old = queue; queue = null; var pending = opening; var draining = retiring.ToArray();
        Exception? failure = null;
        if (old is not null) {
            try { await old.DisposeAsync(); } catch (Exception error) { failure = error; }
        }
        foreach (var drain in draining) {
            try { await drain; } catch (Exception error) { failure ??= error; }
        }
        if (pending is not null) {
            QueueHost? late = null;
            try { late = await pending; } catch (Exception) { /* it never opened, so there is nothing to release */ }
            if (late is not null && late != old) {
                try { await late.DisposeAsync(); } catch (Exception error) { failure ??= error; }
            }
        }
        try { await backend.DisposeAsync(); } catch (Exception error) { failure ??= error; }
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw(failure);
    }
}

/// <summary>A folder in the tree; children load the first time it expands, a page at a time.</summary>
public sealed class NodeViewModel : Observable
{
    private readonly MainViewModel owner;
    private bool expanded, loaded, isSelected, loadingMore;
    private object? more;

    public NodeViewModel(CatalogNode node, NodeViewModel? parent, MainViewModel owner, int view)
    {
        Node = node; Parent = parent; this.owner = owner; View = view;
        // A per-node placeholder makes the expander show until the real children load.
        Children.Add(new NodeViewModel("Loading…", null));
    }

    /// <summary>A placeholder, or (with a parent) the "Show more" row that loads the parent's next page.</summary>
    private NodeViewModel(string label, NodeViewModel? moreOf)
    {
        Node = new CatalogNode("", label, NodeKind.Folder, ""); owner = moreOf?.owner!; Parent = moreOf; loaded = true; IsMore = moreOf is not null;
        View = moreOf?.View ?? -1;
    }

    public CatalogNode Node { get; }
    public NodeViewModel? Parent { get; }
    /// <summary>Which person's view this belongs to; a node from before a sign-in change does nothing.</summary>
    public int View { get; }
    public bool IsMore { get; }
    public string Name => Node.Name;
    public bool IsSection => Node.Kind == NodeKind.Section && !IsMore;
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
        set {
            if (!Set(ref isSelected, value) || !value || owner is null) return;
            if (IsMore) _ = Parent!.LoadMoreAsync();
            else if (Node.Key.Length > 0) _ = owner.SelectAsync(this);
        }
    }

    private async Task LoadAsync()
    {
        if (loaded || owner is null) return;
        loaded = true;
        try {
            var page = await owner.ChildrenAsync(Node, null);
            if (!owner.IsCurrent(View)) return;
            Children.Clear();
            Add(page);
        } catch (Exception error) { Children.Clear(); loaded = false; if (owner.IsCurrent(View)) owner.Fail(error); }
    }

    /// <summary>Loads the next page in place of the "Show more" row.</summary>
    internal async Task LoadMoreAsync()
    {
        if (loadingMore || more is null || !owner.IsCurrent(View)) return;
        loadingMore = true;
        try {
            var page = await owner.ChildrenAsync(Node, more);
            if (!owner.IsCurrent(View)) return;
            foreach (var row in Children.Where(child => child.IsMore).ToList()) Children.Remove(row);
            Add(page);
        } catch (Exception error) { if (owner.IsCurrent(View)) owner.Fail(error); }
        finally { loadingMore = false; }
    }

    private void Add(NodePage page)
    {
        foreach (var child in page.Nodes) Children.Add(new NodeViewModel(child, this, owner, View));
        more = page.More;
        if (more is not null) Children.Add(new NodeViewModel(Node.Kind == NodeKind.Section ? "Show more…" : "Show more folders…", this));
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
