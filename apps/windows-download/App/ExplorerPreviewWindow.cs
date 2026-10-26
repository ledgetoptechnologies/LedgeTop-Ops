using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

/// <summary>Settings, activity and tray lifecycle for an explicit generated preview or selected connected source.</summary>
internal sealed class ExplorerPreviewWindow : Window
{
    private readonly Func<Task<IExplorerPreviewSession>> createSession;
    private readonly ExplorerWindowContent presentation;
    private readonly IBackgroundFolderLauncher folderLauncher;
    private readonly TextBlock status = new(), detail = new(), location = new(), footer = new();
    private readonly ListBox activity = new();
    private readonly List<string> localActivity = [];
    internal readonly Button StartButton = new() { Content = "Start Explorer preview" };
    internal readonly Button ReconnectButton = new() { Content = "Reconnect saved files", ToolTip = "Use your saved sign-in to reconnect this PC's existing files. This does not open a browser or refresh the saved inventory." };
    internal readonly Button OpenFolderButton = new() { Content = "Open files folder" };
    internal readonly Button PauseButton = new() { Content = "Pause downloads" };
    internal readonly Button ResumeButton = new() { Content = "Resume downloads" };
    internal readonly Button RemoveButton = new() { Content = "Remove Explorer preview" };
    internal readonly TabControl Pages = new();
    private IExplorerPreviewSession? session;
    private ITrayIcon? tray;
    private Task operation = Task.CompletedTask;
    private Task? shutdown;
    private readonly DispatcherTimer? sessionCheck;
    private bool busy, quitting, readyToClose;
    private string problem = "";
    internal string StatusText => status.Text;

    internal ExplorerPreviewWindow(Func<Task<IExplorerPreviewSession>> createSession,
        Func<Func<IReadOnlyList<TrayAction>>, ITrayIcon>? createTray = null,
        ExplorerWindowContent? presentation = null, IExplorerPreviewSession? preparedSession = null, string? setupProblem = null,
        IBackgroundFolderLauncher? folderLauncher = null)
    {
        this.createSession = createSession;
        this.folderLauncher = folderLauncher ?? new BackgroundFolderLauncher();
        this.presentation = presentation ?? ExplorerWindowContent.Demo;
        problem = setupProblem ?? "";
        if (setupProblem is not null) localActivity.Add(setupProblem);
        session = preparedSession;
        if (session is not null) session.Changed += SessionChanged;
        Title = this.presentation.Generated ? "LedgeTop Files — Explorer preview" : "LedgeTop Files — " + this.presentation.Badge;
        if (!this.presentation.Generated) {
            StartButton.Content = "Sign in and connect files";
            RemoveButton.Content = "Remove this connection";
        }
        Width = 960; Height = 760; MinWidth = 760; MinHeight = 620;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Brush("Page"); Foreground = Brush("Ink");
        FontFamily = (FontFamily)FindResource("UiFont");
        Content = BuildContent();
        StartButton.Click += async (_, _) => await StartPreviewAsync();
        ReconnectButton.Click += async (_, _) => await ReconnectPreviewAsync();
        PauseButton.Click += async (_, _) => await PausePreviewAsync();
        ResumeButton.Click += async (_, _) => await ResumePreviewAsync();
        RemoveButton.Click += async (_, _) => await RemovePreviewAsync();
        OpenFolderButton.Click += (_, _) => OpenFolder();
        KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Q && System.Windows.Input.Keyboard.Modifiers == System.Windows.Input.ModifierKeys.Control) { e.Handled = true; Quit(); } };
        try {
            tray = (createTray ?? (actions => new ShellTrayIcon(actions)))(TrayActions);
            if (!tray.IsAvailable) { tray.Dispose(); tray = null; }
            else { tray.Activated += RestoreFromTray; tray.Unavailable += TrayUnavailable; }
        } catch (Exception) { tray?.Dispose(); tray = null; }
        if (!this.presentation.Generated) {
            var timer = new DispatcherTimer(DispatcherPriority.Background, Dispatcher) { Interval = TimeSpan.FromSeconds(60) };
            sessionCheck = timer;
            timer.Tick += CheckSession;
            Loaded += (_, _) => timer.Start();
        }
        Refresh();
    }

    private UIElement BuildContent()
    {
        var layout = new DockPanel { Background = Brush("Page") };
        var header = new Border { Background = Brush("HeaderBack"), Padding = new Thickness(24, 18, 24, 18) };
        var headerContent = new DockPanel();
        headerContent.Children.Add(new ContentControl {
            Content = "LT", ContentTemplate = (DataTemplate)FindResource("LtMark"), Width = 42, Height = 42,
            Margin = new Thickness(0, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center
        });
        var demo = new Border { Background = new SolidColorBrush(Color.FromRgb(80, 37, 20)), CornerRadius = new CornerRadius(6),
            Padding = new Thickness(10, 5, 10, 5), Margin = new Thickness(20, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock { Text = presentation.Badge.ToUpperInvariant(), Foreground = new SolidColorBrush(Color.FromRgb(255, 184, 148)), FontSize = 11, FontWeight = FontWeights.Bold } };
        DockPanel.SetDock(demo, Dock.Right); headerContent.Children.Add(demo);
        headerContent.Children.Add(new StackPanel { VerticalAlignment = VerticalAlignment.Center, Children = {
            new TextBlock { Text = "LedgeTop Files", Foreground = Brushes.White, FontSize = 21, FontWeight = FontWeights.SemiBold },
            new TextBlock { Text = presentation.Generated ? "Windows Explorer preview" : "Files in Windows Explorer", Foreground = new SolidColorBrush(Color.FromRgb(199, 208, 215)), FontSize = 13 }
        } });
        header.Child = headerContent; DockPanel.SetDock(header, Dock.Top); layout.Children.Add(header);

        var foot = new Border { Background = Brush("Soft"), BorderBrush = Brush("Line"), BorderThickness = new Thickness(0, 1, 0, 0),
            Padding = new Thickness(24, 12, 24, 12) };
        footer.Foreground = Brush("Muted"); footer.FontSize = 12; footer.TextWrapping = TextWrapping.Wrap;
        foot.Child = footer; DockPanel.SetDock(foot, Dock.Bottom); layout.Children.Add(foot);

        Pages.Margin = new Thickness(24, 20, 24, 20);
        Pages.Background = Brushes.Transparent; Pages.BorderThickness = new Thickness(0);
        Pages.Resources.Add(typeof(TabItem), TabStyle());
        var settings = new StackPanel { Margin = new Thickness(0, 18, 0, 0) };
        settings.SetValue(TextBlock.FontWeightProperty, FontWeights.Normal);
        status.FontSize = 24; status.FontWeight = FontWeights.SemiBold;
        detail.Foreground = Brush("Muted"); detail.FontSize = 14; detail.Margin = new Thickness(0, 8, 0, 18);
        detail.TextWrapping = TextWrapping.Wrap;
        var statusContent = new StackPanel(); statusContent.Children.Add(status); statusContent.Children.Add(detail);
        var actions = new WrapPanel();
        StartButton.Style = (Style)FindResource("Primary");
        foreach (var button in new[] { StartButton, ReconnectButton, OpenFolderButton, PauseButton, ResumeButton }) {
            button.Margin = new Thickness(0, 0, 10, 6); actions.Children.Add(button);
        }
        statusContent.Children.Add(actions); settings.Children.Add(Card(statusContent));

        var account = new StackPanel();
        account.Children.Add(Heading("Account"));
        account.Children.Add(Body(presentation.Account, false));
        account.Children.Add(Body(presentation.AccountDetail));
        if (!presentation.Generated) account.Children.Add(Body("This connection downloads files you are allowed to read. Local changes and added files are not uploaded."));
        settings.Children.Add(Card(account));

        var files = new StackPanel(); files.Children.Add(Heading("Files on this PC"));
        files.Children.Add(Body("Browse your files in File Explorer. Opening an online-only file downloads it. Right-click a file or folder to keep it on this device or free up space."));
        location.Margin = new Thickness(0, 12, 0, 0); location.Foreground = Brush("Ink"); location.FontSize = 12; location.TextWrapping = TextWrapping.Wrap;
        files.Children.Add(location); settings.Children.Add(Card(files));

        var removal = new StackPanel(); removal.Children.Add(Heading(presentation.Generated ? "Manage this preview" : "Manage this connection"));
        removal.Children.Add(Body(presentation.Generated
            ? "Remove the Explorer registration and stop preview downloads. Files already downloaded stay on this PC."
            : "Remove this Explorer connection and stop downloads. Files already downloaded stay on this PC."));
        RemoveButton.HorizontalAlignment = HorizontalAlignment.Left; RemoveButton.Margin = new Thickness(0, 12, 0, 0);
        RemoveButton.Foreground = Brush("ErrorInk"); removal.Children.Add(RemoveButton);
        var quitButton = new Button { Content = "Quit LedgeTop Files", HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 12, 0, 0), ToolTip = "Stop downloads and quit (Ctrl+Q). Local files stay on this PC." };
        quitButton.Click += (_, _) => Quit();
        removal.Children.Add(quitButton);
        settings.Children.Add(Card(removal));
        Pages.Items.Add(new TabItem { Header = "Settings", Content = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = settings } });

        var activityPanel = new DockPanel { Margin = new Thickness(0, 18, 0, 0) };
        activityPanel.SetValue(TextBlock.FontWeightProperty, FontWeights.Normal);
        var intro = Body(presentation.Generated ? "Recent preview activity. Your real account and files are not connected." : "Recent connection and download activity.");
        intro.Margin = new Thickness(0, 0, 0, 16); DockPanel.SetDock(intro, Dock.Top); activityPanel.Children.Add(intro);
        activity.Background = Brush("Surface"); activity.BorderBrush = Brush("Line"); activity.Padding = new Thickness(12);
        activity.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        var template = new DataTemplate();
        var text = new FrameworkElementFactory(typeof(TextBlock)); text.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding());
        text.SetValue(TextBlock.TextWrappingProperty, TextWrapping.Wrap); text.SetValue(FrameworkElement.MarginProperty, new Thickness(4, 7, 4, 7));
        template.VisualTree = text; activity.ItemTemplate = template;
        activityPanel.Children.Add(activity);
        Pages.Items.Add(new TabItem { Header = "Activity", Content = activityPanel });
        layout.Children.Add(Pages); return layout;
    }

    private Border Card(UIElement content) => new() { Style = (Style)FindResource("Card"), Padding = new Thickness(22), Margin = new Thickness(0, 0, 0, 14), Child = content };
    private TextBlock Heading(string text) => new() { Text = text, FontSize = 16, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8) };
    private TextBlock Body(string text, bool muted = true) => new() { Text = text, FontSize = 13, Foreground = Brush(muted ? "Muted" : "Ink"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 0) };
    private Brush Brush(string key) => (Brush)FindResource(key);

    private Style TabStyle()
    {
        var style = new Style(typeof(TabItem));
        style.Setters.Add(new Setter(Control.FontSizeProperty, 14d));
        style.Setters.Add(new Setter(Control.FontWeightProperty, FontWeights.SemiBold));
        style.Setters.Add(new Setter(Control.ForegroundProperty, Brush("Muted")));
        style.Setters.Add(new Setter(Control.BackgroundProperty, Brushes.Transparent));
        style.Setters.Add(new Setter(FrameworkElement.MarginProperty, new Thickness(0, 0, 8, 0)));
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(8));
        border.SetValue(Border.PaddingProperty, new Thickness(16, 9, 16, 9));
        border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter)); presenter.SetValue(ContentPresenter.ContentSourceProperty, "Header");
        border.AppendChild(presenter);
        style.Setters.Add(new Setter(Control.TemplateProperty, new ControlTemplate(typeof(TabItem)) { VisualTree = border }));
        var selected = new Trigger { Property = TabItem.IsSelectedProperty, Value = true };
        selected.Setters.Add(new Setter(Control.BackgroundProperty, Brush("Surface")));
        selected.Setters.Add(new Setter(Control.ForegroundProperty, Brush("Ink"))); style.Triggers.Add(selected);
        return style;
    }

    internal Task StartPreviewAsync() => OperateAsync(async () => {
        if (session is null || session.State is ExplorerPreviewState.Removed or ExplorerPreviewState.Failed) {
            if (session is { } old) { await DisposeOnWorkerAsync(old); old.Changed -= SessionChanged; session = null; }
            var prepared = await createSession();
            if (quitting) { await DisposeOnWorkerAsync(prepared); return; }
            session = prepared; session.Changed += SessionChanged;
        }
        if (!quitting) await session.StartAsync();
    });
    internal Task PausePreviewAsync() => OperateAsync(async () => { if (session?.State == ExplorerPreviewState.Running) await session.PauseAsync(); });
    internal Task ReconnectPreviewAsync() => OperateAsync(async () => {
        if (!presentation.Generated && session is ICachedExplorerReconnect { CanReconnectCached: true } saved)
            await saved.ReconnectCachedAsync();
    });
    internal Task ResumePreviewAsync() => OperateAsync(async () => { if (session?.State == ExplorerPreviewState.Paused) await session.ResumeAsync(); });
    internal Task RemovePreviewAsync() => OperateAsync(async () => { if (session is not null) await session.RemoveAsync(); });

    private Task OperateAsync(Func<Task> action)
    {
        if (busy || quitting || readyToClose) return Task.CompletedTask;
        busy = true; problem = ""; Refresh();
        operation = Run(); return operation;
        async Task Run()
        {
            try { await action(); }
            catch (Exception) {
                problem = presentation.Generated ? "The preview couldn't finish that action. Check Activity, then try again."
                    : "The connection couldn't finish that action. Check Activity, then try again.";
                localActivity.Add(presentation.Generated ? "A preview action could not finish. No local files were deleted."
                    : "A connection action could not finish. No local files were deleted.");
            } finally { busy = false; Refresh(); }
        }
    }

    // The native provider's stop path can call synchronous Windows APIs before its next await.
    // Keep the dispatcher responsive, but retain this window and instance ownership until real drain completes.
    private static Task DisposeOnWorkerAsync(IExplorerPreviewSession owned) =>
        Task.Run(async () => await owned.DisposeAsync().ConfigureAwait(false));

    private void SessionChanged(object? sender, EventArgs e)
    {
        if (Dispatcher.HasShutdownStarted || readyToClose) return;
        if (Dispatcher.CheckAccess()) Refresh();
        else Dispatcher.BeginInvoke(() => { if (!readyToClose) Refresh(); });
    }

    private void Refresh()
    {
        var state = session?.State ?? ExplorerPreviewState.NotStarted;
        status.Text = quitting ? "Stopping preview…" : problem.Length > 0 ? "Preview needs attention" : state switch {
            ExplorerPreviewState.Starting => "Starting Explorer preview…", ExplorerPreviewState.Running => "Your preview is ready",
            ExplorerPreviewState.Paused => "Preview downloads are paused", ExplorerPreviewState.Removed => "Explorer preview removed",
            ExplorerPreviewState.Failed => "Preview needs attention", _ => "Try files in File Explorer"
        };
        if (!presentation.Generated) {
            status.Text = quitting ? "Stopping downloads…" : problem.Length > 0 ? "Connection needs attention" : state switch {
                ExplorerPreviewState.Starting => "Connecting your files…", ExplorerPreviewState.Running => "Your files are ready",
                ExplorerPreviewState.Paused => "Downloads are paused", ExplorerPreviewState.Removed => "Connection removed",
                ExplorerPreviewState.Failed => "Connection needs attention", _ => "Connect files in File Explorer"
            };
        }
        detail.Text = problem.Length > 0 ? problem : quitting ? "Stopping downloads and disconnecting the preview. Files already on this PC stay here." : state switch {
            ExplorerPreviewState.Running => "Open your files folder to try files on demand. You can keep this window closed while the preview runs in the tray.",
            ExplorerPreviewState.Paused => "Online-only files cannot download while paused. Files already kept on this device remain available.",
            ExplorerPreviewState.Removed => "The preview no longer appears as a connected Explorer location. Your local files have been preserved.",
            ExplorerPreviewState.Failed => "The Explorer preview couldn't start or complete an operation. Check Activity before trying again.",
            _ => "Start a simulated sign-in to try generated files in an isolated folder. No real account or files are connected."
        };
        if (!presentation.Generated && problem.Length == 0) detail.Text = quitting
            ? "Stopping downloads and disconnecting. Files already on this PC stay here."
            : state switch {
                ExplorerPreviewState.Running => "Open your files folder in Explorer. You can close this window while downloads continue in the tray.",
                ExplorerPreviewState.Paused => "Online-only files cannot download while paused. Files already on this device remain available.",
                ExplorerPreviewState.Removed => "This Explorer connection was removed. Downloaded and modified local files were preserved.",
                ExplorerPreviewState.Failed => "Check Activity for the connection problem. You can remove this PC's existing connection without signing in.",
                ExplorerPreviewState.Starting => "Signing in and preparing the files this account is allowed to read.",
                _ => "Sign in to connect this source. Files appear in Explorer and download when you open them. You can remove an existing connection here without signing in."
            };
        if (!presentation.Generated && !quitting && problem.Length == 0 && state == ExplorerPreviewState.Running &&
            session is ConnectedExplorerSession { InventoryEmpty: true }) {
            status.Text = "Connected — no files shared yet";
            detail.Text = "You're signed in, but no folders or files are currently shared with this account in this source. Your LedgeTop contact can check source access.";
        }
        var enabled = !busy && !quitting;
        var canReconnect = !presentation.Generated && session is ICachedExplorerReconnect { CanReconnectCached: true };
        ReconnectButton.Visibility = canReconnect ? Visibility.Visible : Visibility.Collapsed;
        ReconnectButton.IsEnabled = enabled && canReconnect;
        StartButton.IsEnabled = enabled && state is ExplorerPreviewState.NotStarted or ExplorerPreviewState.Removed or ExplorerPreviewState.Failed;
        StartButton.Visibility = state is ExplorerPreviewState.NotStarted or ExplorerPreviewState.Removed or ExplorerPreviewState.Failed ? Visibility.Visible : Visibility.Collapsed;
        OpenFolderButton.IsEnabled = enabled && session is not null && Directory.Exists(session.RootPath);
        PauseButton.IsEnabled = enabled && state == ExplorerPreviewState.Running;
        PauseButton.Visibility = state == ExplorerPreviewState.Running ? Visibility.Visible : Visibility.Collapsed;
        ResumeButton.IsEnabled = enabled && state == ExplorerPreviewState.Paused;
        ResumeButton.Visibility = state == ExplorerPreviewState.Paused ? Visibility.Visible : Visibility.Collapsed;
        RemoveButton.IsEnabled = enabled && session is not null && state != ExplorerPreviewState.Removed;
        location.Text = session is null ? "A dedicated local preview folder will be shown here after you start." : session.RootPath;
        activity.ItemsSource = (session?.Activity ?? []).Concat(localActivity).TakeLast(100).DefaultIfEmpty(presentation.Generated
            ? "No preview activity yet. Start the Explorer preview when you're ready." : "No connection activity yet. Sign in when you're ready.").ToArray();
        footer.Text = tray?.IsAvailable == true
            ? "Closing this window keeps LedgeTop Files running in the system tray. Use the tray menu to reopen Settings or quit."
            : "The tray icon is unavailable. Closing this window stops downloads; files already downloaded stay on this PC.";
        tray?.Update("LedgeTop Files · " + presentation.Badge + " · " + (quitting ? "Stopping" : state.ToString()));
    }

    private IReadOnlyList<TrayAction> TrayActions() => [
        new("LedgeTop Files · " + presentation.Badge, false), new(""),
        new("Open settings and activity", true, RestoreFromTray),
        new("Open files folder", !quitting && session is not null && Directory.Exists(session.RootPath), OpenFolder),
        new("Pause downloads", !busy && !quitting && session?.State == ExplorerPreviewState.Running, () => _ = PausePreviewAsync()),
        new("Resume downloads", !busy && !quitting && session?.State == ExplorerPreviewState.Paused, () => _ = ResumePreviewAsync()),
        new(""), new("Quit LedgeTop Files", true, Quit)
    ];

    private void OpenFolder()
    {
        if (quitting || session is null || !Directory.Exists(session.RootPath)) return;
        try { folderLauncher.TryOpen(session.RootPath, FolderLaunchFailed); }
        catch (Exception) { FolderLaunchFailed(); }
    }

    private void FolderLaunchFailed()
    {
        if (Dispatcher.HasShutdownStarted || Dispatcher.HasShutdownFinished) return;
        try { Dispatcher.BeginInvoke(() => {
            if (readyToClose || quitting) return;
            problem = "Windows couldn't open the files folder. Try opening it in File Explorer, or try again.";
            localActivity.Add("Windows could not open the files folder. Downloads and local files were kept.");
            Refresh();
        }); } catch (InvalidOperationException) { /* Dispatcher stopped after the check. */ }
    }

    internal void RestoreFromTray()
    {
        if (readyToClose) return;
        Show(); if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Activate();
    }
    private void TrayUnavailable() { RestoreFromTray(); Refresh(); }

    private async void CheckSession(object? sender, EventArgs e)
    {
        if (busy || quitting || readyToClose || session is not ConnectedExplorerSession connected ||
            connected.State is not (ExplorerPreviewState.Running or ExplorerPreviewState.Paused)) return;
        await OperateAsync(connected.RecheckSessionAsync);
    }

    internal void Quit()
    {
        if (quitting || readyToClose) return;
        quitting = true; RestoreFromTray(); Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        if (e.Cancel || readyToClose) return;
        e.Cancel = true;
        if (!quitting && tray?.IsAvailable == true) { Hide(); return; }
        if (shutdown is not null) return;
        quitting = true; Refresh(); shutdown = FinishCloseAsync();
    }

    private async Task FinishCloseAsync()
    {
        // Let OnClosing publish its shutdown task before a synchronous service failure can clear it for retry.
        await Dispatcher.Yield(DispatcherPriority.Background);
        try {
            // Connected sessions cancel pending human login/catalog work before waiting for their
            // operation lock. Begin disposal now so Quit can cancel that work before draining it.
            var stoppingSession = session;
            var disconnect = stoppingSession is null ? null : DisposeOnWorkerAsync(stoppingSession);
            await operation;
            if (disconnect is not null) await disconnect;
            else if (session is not null) await DisposeOnWorkerAsync(session);
        } catch (Exception) {
            shutdown = null; quitting = false;
            problem = "The preview couldn't stop safely. Keep the app open and try quitting again.";
            RestoreFromTray(); Refresh(); return;
        }
        await Dispatcher.Yield(DispatcherPriority.Background);
        readyToClose = true; Close();
    }

    protected override void OnClosed(EventArgs e)
    {
        readyToClose = true;
        folderLauncher.Dispose();
        if (sessionCheck is { } timer) { timer.Stop(); timer.Tick -= CheckSession; }
        if (session is not null) session.Changed -= SessionChanged;
        if (tray is not null) { tray.Activated -= RestoreFromTray; tray.Unavailable -= TrayUnavailable; tray.Dispose(); tray = null; }
        base.OnClosed(e);
    }
}
