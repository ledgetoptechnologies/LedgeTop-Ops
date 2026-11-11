using System.Collections.Specialized;
using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;

namespace LedgeTop.Files;

public partial class MainWindow : Window, IAccessWindow
{
    private readonly DispatcherTimer clock = new() { Interval = TimeSpan.FromSeconds(15) };
    private MainViewModel? model;
    private TaskCompletionSource<AccessMode>? choosing;
    private Func<ValueTask>? closer;
    private ITrayIcon? tray;
    private bool quitting;
    private string trayTag = "";
    private string trayFolder = "";

    public MainWindow()
    {
        InitializeComponent();
        clock.Tick += (_, _) => model?.Tick();
    }

    /// <summary>When set, closing the window closes this (the access session) instead of only the shown view.</summary>
    public void CloseWith(Func<ValueTask> close) => closer = close;

    /// <summary>App composition opts in; a directly created/test window keeps normal close behavior.</summary>
    internal bool EnableTray(string defaultFolder, string? tag, Func<Func<IReadOnlyList<TrayAction>>, ITrayIcon>? create = null)
    {
        if (tray is not null) return tray.IsAvailable;
        trayFolder = defaultFolder; trayTag = tag is null ? "" : " · " + tag;
        try {
            tray = (create ?? (actions => new ShellTrayIcon(actions)))(TrayActions);
            if (!tray.IsAvailable) { tray.Dispose(); tray = null; return false; }
            tray.Activated += RestoreFromTray;
            tray.Unavailable += TrayUnavailable;
            TrayHint.Visibility = Visibility.Visible;
            UpdateTray();
            return tray.IsAvailable;
        } catch (Exception) {
            tray?.Dispose(); tray = null;
            return false; // Never hide a window whose tray icon could not actually be registered.
        }
    }

    internal IReadOnlyList<TrayAction> TrayActions() => [
        new(TrayStatus(), false),
        new(""),
        new("Open LedgeTop Files", true, RestoreFromTray),
        new("Open downloads folder", Directory.Exists(model?.Destination ?? trayFolder), OpenDownloadsFolder),
        new(""),
        new("Quit LedgeTop Files", true, Quit)
    ];

    private string TrayStatus()
    {
        var state = quitting ? "Stopping downloads" : model is null ? "Choose your files" :
            model.Screen == Screen.SignIn ? "Sign in needed" : model.Screen == Screen.NotSetUp ? "Setup needed" :
            model.BannerIsError ? "Needs attention" : model.Transfers.Any(item => item.IsActive) ? "Downloading" :
            model.Transfers.Any(item => item.State == LedgeTop.WindowsDownload.QueuedTransferState.Paused) ? "Downloads paused" :
            model.Screen == Screen.Loading ? "Loading" : "Ready";
        return "LedgeTop Files" + trayTag + " · " + state;
    }

    private void UpdateTray() => tray?.Update(TrayStatus());

    internal void RestoreFromTray()
    {
        if (quitting || readyToClose) return;
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    private void TrayUnavailable()
    {
        TrayHint.Visibility = Visibility.Collapsed;
        RestoreFromTray();
    }

    private void OpenDownloadsFolder()
    {
        var folder = model?.Destination ?? trayFolder;
        if (!Directory.Exists(folder)) return;
        try { Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true }); }
        catch (Exception) {
            RestoreFromTray();
            MessageBox.Show(this, "Windows couldn't open the downloads folder. Check its location in LedgeTop Files.",
                "LedgeTop Files", MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }

    internal void Quit()
    {
        if (quitting || readyToClose) return;
        quitting = true;
        UpdateTray();
        // Quit owns the existing bounded drain/save sequence, including when the window is hidden.
        Close();
    }

    /// <param name="tag">A small header label such as "Demo data" or "Pilot"; null shows none.</param>
    public void Attach(MainViewModel viewModel, string? tag)
    {
        // A switch attaches a new view; the previous one is already closed and must no longer drive the window.
        if (model is { } previous) {
            previous.PropertyChanged -= OnModelChanged;
            previous.Files.CollectionChanged -= OnFilesChanged;
            previous.Transfers.CollectionChanged -= OnTransfersChanged;
        }
        model = viewModel; DataContext = viewModel;
        DemoTag.Visibility = tag is null ? Visibility.Collapsed : Visibility.Visible;
        DemoTagText.Text = tag ?? "";
        viewModel.PropertyChanged += OnModelChanged;
        viewModel.Files.CollectionChanged += OnFilesChanged;
        viewModel.Transfers.CollectionChanged += OnTransfersChanged;
        OnFilesChanged(null, null); OnTransfersChanged(null, null);
        clock.Start();
        ShowScreen();
        UpdateTray();
    }

    private void OnModelChanged(object? sender, PropertyChangedEventArgs e) { if (e.PropertyName == nameof(MainViewModel.Screen)) ShowScreen(); UpdateTray(); }
    private void OnFilesChanged(object? sender, NotifyCollectionChangedEventArgs? e) =>
        FilesEmpty.Visibility = model?.Files.Count is null or 0 ? Visibility.Visible : Visibility.Collapsed;
    private void OnTransfersChanged(object? sender, NotifyCollectionChangedEventArgs? e)
    {
        TransfersEmpty.Visibility = model?.Transfers.Count is null or 0 ? Visibility.Visible : Visibility.Collapsed;
        UpdateTray();
    }

    /// <summary>Shows the choice screen; nothing signs in until the person picks one of the offered kinds of files.</summary>
    public Task<AccessMode> ChooseAccessAsync(IReadOnlyList<AccessMode> modes)
    {
        choosing?.TrySetCanceled();
        choosing = new TaskCompletionSource<AccessMode>(TaskCreationOptions.RunContinuationsAsynchronously);
        ChooseClient.Visibility = modes.Contains(AccessMode.Client) ? Visibility.Visible : Visibility.Collapsed;
        ChooseEmployee.Visibility = modes.Contains(AccessMode.Employee) ? Visibility.Visible : Visibility.Collapsed;
        ChooseAccessScreen.Visibility = Visibility.Visible;
        SignInScreen.Visibility = NotSetUpScreen.Visibility = FilesScreen.Visibility = Visibility.Collapsed;
        return choosing.Task;
    }

    private void OnChooseClient(object sender, RoutedEventArgs e) => Chosen(AccessMode.Client);
    private void OnChooseEmployee(object sender, RoutedEventArgs e) => Chosen(AccessMode.Employee);
    private void Chosen(AccessMode mode)
    {
        if (choosing is not { } pending) return;
        choosing = null;
        ChooseAccessScreen.Visibility = Visibility.Collapsed;
        pending.TrySetResult(mode);
    }

    private void ShowScreen()
    {
        if (model is null) return;
        ChooseAccessScreen.Visibility = Visibility.Collapsed;
        SignInScreen.Visibility = model.Screen == Screen.SignIn ? Visibility.Visible : Visibility.Collapsed;
        NotSetUpScreen.Visibility = model.Screen == Screen.NotSetUp ? Visibility.Visible : Visibility.Collapsed;
        FilesScreen.Visibility = model.Screen == Screen.Files ? Visibility.Visible : Visibility.Collapsed;
    }

    public void OnUi(Action action)
    {
        if (Dispatcher.CheckAccess()) action();
        else Dispatcher.BeginInvoke(action);
    }

    public string? PickFolder(string current)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Choose where to save downloads", InitialDirectory = Directory.Exists(current) ? current : "" };
        return dialog.ShowDialog(this) == true ? dialog.FolderName : null;
    }

    public void OpenFile(string path) => Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });

    public void ShowInFolder(string path) => Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { "/select,", path } });

    /// <summary>The longest the window waits for downloads to stop and save before closing anyway.</summary>
    public TimeSpan ShutdownLimit { get; set; } = TimeSpan.FromSeconds(30);
    private Task? shutdown;
    private bool readyToClose;

    /// <summary>
    /// The first close is held until downloads have stopped and been saved (or the limit passes), then the window
    /// really closes. Closing again meanwhile just waits for that same shutdown.
    /// </summary>
    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        if (!e.Cancel && !quitting && !readyToClose && tray?.IsAvailable == true) {
            e.Cancel = true;
            Hide();
            return; // Keep selection, sign-in, the active session and downloads alive.
        }
        // A choice still on screen is abandoned: nothing opens after the window closes.
        choosing?.TrySetCanceled(); choosing = null;
        if (e.Cancel || readyToClose || (model is null && closer is null)) return;
        e.Cancel = true;
        if (shutdown is not null) return;
        clock.Stop();
        IsEnabled = false;
        Title = "Ledge Top Files - stopping downloads";
        shutdown = FinishAsync(closer ?? model!.DisposeAsync);
    }

    protected override void OnClosed(EventArgs e)
    {
        readyToClose = true;
        clock.Stop();
        if (tray is { } owned) {
            owned.Activated -= RestoreFromTray; owned.Unavailable -= TrayUnavailable;
            owned.Dispose(); tray = null;
        }
        if (model is { } previous) {
            previous.PropertyChanged -= OnModelChanged;
            previous.Files.CollectionChanged -= OnFilesChanged;
            previous.Transfers.CollectionChanged -= OnTransfersChanged;
        }
        base.OnClosed(e);
    }

    private async Task FinishAsync(Func<ValueTask> close)
    {
        // Running work was already told to stop; a save failure or a stuck sign-in check must not keep the app open forever.
        try { await close().AsTask().WaitAsync(ShutdownLimit); }
        catch (Exception) { /* the queue keeps its own durable state; an interrupted transfer resumes as "needs checking" */ }
        // The shutdown may already have been finished, so let the first OnClosing unwind before closing for real:
        // WPF refuses Close while the window is still closing.
        await Dispatcher.Yield(DispatcherPriority.Background);
        readyToClose = true;
        try { Close(); }
        catch (InvalidOperationException) { readyToClose = false; IsEnabled = true; }
    }
}
