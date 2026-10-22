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

    protected override async void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        clock.Stop();
        // Stopping and saving happen in the queue; a failure while closing must never crash the app.
        try { if (model is not null) await model.DisposeAsync(); }
        catch (Exception) { /* the queue keeps its own durable state and shows any problem next time */ }
    }
}
