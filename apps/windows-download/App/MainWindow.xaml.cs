using System.Collections.Specialized;
using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using LedgeTop.Files.Presentation;

namespace LedgeTop.Files;

public partial class MainWindow : Window, IShell
{
    private readonly DispatcherTimer clock = new() { Interval = TimeSpan.FromSeconds(15) };
    private MainViewModel? model;

    public MainWindow() => InitializeComponent();

    /// <param name="tag">A small header label such as "Demo data" or "Pilot"; null shows none.</param>
    public void Attach(MainViewModel viewModel, string? tag)
    {
        model = viewModel; DataContext = viewModel;
        DemoTag.Visibility = tag is null ? Visibility.Collapsed : Visibility.Visible;
        DemoTagText.Text = tag ?? "";
        viewModel.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(MainViewModel.Screen)) ShowScreen(); };
        viewModel.Files.CollectionChanged += (_, _) => FilesEmpty.Visibility = viewModel.Files.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        viewModel.Transfers.CollectionChanged += (_, _) => TransfersEmpty.Visibility = viewModel.Transfers.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        clock.Tick += (_, _) => viewModel.Tick();
        clock.Start();
        ShowScreen();
    }

    private void ShowScreen()
    {
        if (model is null) return;
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
        if (e.Cancel || readyToClose || model is null) return;
        e.Cancel = true;
        if (shutdown is not null) return;
        clock.Stop();
        IsEnabled = false;
        Title = "Ledge Top Files - stopping downloads";
        shutdown = FinishAsync(model);
    }

    private async Task FinishAsync(MainViewModel closingModel)
    {
        // Running work was already told to stop; a save failure or a stuck sign-in check must not keep the app open forever.
        try { await closingModel.DisposeAsync().AsTask().WaitAsync(ShutdownLimit); }
        catch (Exception) { /* the queue keeps its own durable state; an interrupted transfer resumes as "needs checking" */ }
        readyToClose = true;
        Close();
    }
}
