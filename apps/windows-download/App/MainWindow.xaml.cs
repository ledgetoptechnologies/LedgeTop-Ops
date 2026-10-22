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

    public void Attach(MainViewModel viewModel, bool demo)
    {
        model = viewModel; DataContext = viewModel;
        DemoTag.Visibility = demo ? Visibility.Visible : Visibility.Collapsed;
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
        if (model is not null) await model.DisposeAsync();
    }
}
