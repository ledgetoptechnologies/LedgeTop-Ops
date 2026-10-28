using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

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
    internal readonly Button CheckUpdatesButton = new() { Content = "Check for updates" };
    internal readonly Button InstallUpdateButton = new() { Content = "Install and restart" };
    internal readonly CheckBox AutomaticUpdatesCheckBox = new() { Content = "Install approved updates automatically", Margin = new Thickness(0, 4, 0, 8), IsEnabled = false };
    internal readonly CheckBox WindowsStartupCheckBox = new() { Content = "Start with Windows", Margin = new Thickness(0, 4, 0, 8), IsEnabled = false };
    private readonly TextBlock windowsStartupStatus = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) };
    private ExplorerStartupActions? startupActions;
    private WindowsStartupState? startupState;
    private CancellationTokenSource? startupCancellation;
    private bool refreshingStartup;
    private readonly TextBlock updateVersion = new(), updateStatus = new();
    private readonly TextBlock automaticUpdateStatus = new() { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) };
    private ExplorerUpdateScheduleController? updateSchedule;
    private DispatcherTimer? updateScheduleTimer;
    private ExeUpdateHandoffResult? lastUpdateResult;
    private bool lastUpdateCheckSucceeded;
    private bool refreshingSchedule;
    private readonly Func<IExplorerPreviewSession, CancellationToken, Task<ConnectedExplorerUpdateBinding>>? readUpdateBindingForTests;
    private ExplorerUpdateActions? updates;
    private CancellationTokenSource? updateCancellation;
    private ConnectedExplorerUpdateBinding? drainedBinding;
    private string? drainedRoot;
    private bool updateApplying, updateMaintenance, updateHelperUncertain, updateDrainUncertain, updateQuitRequested, finalExitAttempted, closed;
    private bool updateAvailable;
    private string updateMessage = "Updates are not available in this build.";
    internal readonly TabControl Pages = new();
    private IExplorerPreviewSession? session;
    private ITrayIcon? tray;
    private Task operation = Task.CompletedTask;
    private Task? shutdown;
    private readonly DispatcherTimer? sessionCheck;
    private bool busy, quitting, readyToClose;
    private string problem = "";
    internal string StatusText => status.Text;
    internal string UpdateStatusText => updateStatus.Text;
    internal bool UpdateMaintenanceOwned => updateMaintenance;

    internal ExplorerPreviewWindow(Func<Task<IExplorerPreviewSession>> createSession,
        Func<Func<IReadOnlyList<TrayAction>>, ITrayIcon>? createTray = null,
        ExplorerWindowContent? presentation = null, IExplorerPreviewSession? preparedSession = null, string? setupProblem = null,
        IBackgroundFolderLauncher? folderLauncher = null,
        Func<IExplorerPreviewSession, CancellationToken, Task<ConnectedExplorerUpdateBinding>>? readUpdateBindingForTests = null)
    {
        this.createSession = createSession;
        this.readUpdateBindingForTests = readUpdateBindingForTests;
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
        CheckUpdatesButton.Click += async (_, _) => await CheckForUpdatesAsync();
        InstallUpdateButton.Click += async (_, _) => await InstallUpdateAsync();
        AutomaticUpdatesCheckBox.Checked += async (_, _) => await ChangeAutomaticUpdatesAsync();
        AutomaticUpdatesCheckBox.Unchecked += async (_, _) => await ChangeAutomaticUpdatesAsync();
        WindowsStartupCheckBox.Checked += async (_, _) => await ChangeWindowsStartupAsync();
        WindowsStartupCheckBox.Unchecked += async (_, _) => await ChangeWindowsStartupAsync();
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
            Loaded += (_, _) => { if (!updateMaintenance && !quitting) timer.Start(); };
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
        if (!presentation.Generated) {
            var startup = new StackPanel(); startup.Children.Add(Heading("Startup"));
            startup.Children.Add(WindowsStartupCheckBox); startup.Children.Add(windowsStartupStatus);
            settings.Children.Add(Card(startup));
        }

        var files = new StackPanel(); files.Children.Add(Heading("Files on this PC"));
        files.Children.Add(Body("Browse your files in File Explorer. Opening an online-only file downloads it. Right-click a file or folder to keep it on this device or free up space."));
        location.Margin = new Thickness(0, 12, 0, 0); location.Foreground = Brush("Ink"); location.FontSize = 12; location.TextWrapping = TextWrapping.Wrap;
        files.Children.Add(location); settings.Children.Add(Card(files));
        var update = new StackPanel(); update.Children.Add(Heading("Application updates"));
        updateVersion.Foreground = Brush("Muted"); updateVersion.Margin = new Thickness(0, 3, 0, 6);
        updateStatus.TextWrapping = TextWrapping.Wrap; updateStatus.Margin = new Thickness(0, 0, 0, 12);
        update.Children.Add(updateVersion); update.Children.Add(updateStatus);
        update.Children.Add(AutomaticUpdatesCheckBox); update.Children.Add(automaticUpdateStatus);
        var updateButtons = new WrapPanel();
        foreach (var button in new[] { CheckUpdatesButton, InstallUpdateButton }) { button.Margin = new Thickness(0, 0, 10, 6); updateButtons.Children.Add(button); }
        update.Children.Add(updateButtons);
        if (!presentation.Generated) settings.Children.Add(Card(update));
        else { CheckUpdatesButton.Visibility = Visibility.Collapsed; InstallUpdateButton.Visibility = Visibility.Collapsed; }

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
        if (drainedBinding is not null) return; // A saved update recovery never falls back to interactive sign-in.
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
        else if (!presentation.Generated && session is null && drainedBinding is { } expected) {
            if (!await RecoverForUpdateAsync(expected)) throw new LoginRequiredException();
            updateMessage = "Your files are reconnected. Check for updates when ready.";
        }
    });
    internal Task ResumePreviewAsync() => OperateAsync(async () => { if (session?.State == ExplorerPreviewState.Paused) await session.ResumeAsync(); });
    internal Task RemovePreviewAsync() => OperateAsync(async () => {
        if (session is null && drainedBinding is not null) {
            var prepared = await createSession();
            if (quitting) { await DisposeOnWorkerAsync(prepared); return; }
            session = prepared; session.Changed += SessionChanged;
        }
        if (!quitting && session is not null) { await session.RemoveAsync(); if (session.State == ExplorerPreviewState.Removed) drainedBinding = null; }
    });

    private Task OperateAsync(Func<Task> action)
    {
        if (busy || quitting || readyToClose || updateMaintenance) return Task.CompletedTask;
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

    internal void SetUpdateActions(ExplorerUpdateActions actions)
    {
        Dispatcher.VerifyAccess();
        if (presentation.Generated || busy || quitting || readyToClose || updateMaintenance || updates is not null || !VersionText(actions.CurrentVersion))
            throw new InvalidOperationException("Update actions are unavailable.");
        updates = actions; updateMessage = "Check for an approved update using your saved sign-in."; Refresh();
    }

    internal Task SetStartupActionsAsync(ExplorerStartupActions actions)
    {
        Dispatcher.VerifyAccess();
        if (presentation.Generated || startupActions is not null || busy || quitting || readyToClose || updateMaintenance)
            throw new InvalidOperationException("Windows startup settings are unavailable.");
        startupActions = actions;
        return ChangeStartupAsync(null);
    }
    private Task ChangeWindowsStartupAsync()
    {
        if (refreshingStartup || startupActions is null) return Task.CompletedTask;
        return ChangeStartupAsync(WindowsStartupCheckBox.IsChecked == true);
    }
    private Task ChangeStartupAsync(bool? enabled) => OperateAsync(async () => {
        using var cancellation = new CancellationTokenSource(); startupCancellation = cancellation;
        try {
            startupState = enabled is { } requested
                ? await startupActions!.SetAsync(requested, cancellation.Token)
                : await startupActions!.ReadAsync(cancellation.Token);
        } finally { startupCancellation = null; }
    });
    internal void HideAfterWindowsStartup()
    {
        Dispatcher.VerifyAccess();
        if (tray?.IsAvailable == true && !busy && !quitting && !readyToClose && problem.Length == 0 &&
            session?.State is ExplorerPreviewState.Running or ExplorerPreviewState.Paused) Hide();
    }

    internal void ConfigureUpdateSchedule(ExplorerUpdateScheduleSettingsStore store, Func<DateTimeOffset> utcNow,
        TimeSpan jitter, bool runTimer = true)
    {
        Dispatcher.VerifyAccess();
        if (updates is null || presentation.Generated || updateSchedule is not null) throw new InvalidOperationException("Update schedule is unavailable.");
        updateSchedule = new ExplorerUpdateScheduleController(store, utcNow, jitter,
            () => new(session?.State is ExplorerPreviewState.Running or ExplorerPreviewState.Paused, busy, updateMaintenance, quitting || readyToClose),
            async token => {
                await RunUpdateAsync(install: false, token);
                token.ThrowIfCancellationRequested();
                if (!lastUpdateCheckSucceeded) throw new IOException("The scheduled update check did not complete.");
                return updateAvailable;
            },
            async token => {
                lastUpdateResult = null;
                await RunUpdateAsync(install: true, token);
                return lastUpdateResult ?? (updateHelperUncertain
                    ? new(ExeUpdateHandoffStatus.RecoveryBlocked, true) : new(ExeUpdateHandoffStatus.Busy, false));
            });
        if (runTimer) {
            updateScheduleTimer = new DispatcherTimer(DispatcherPriority.Background, Dispatcher) { Interval = TimeSpan.FromMinutes(1) };
            updateScheduleTimer.Tick += ScheduledUpdateTick;
            updateScheduleTimer.Start();
        }
        Refresh();
    }
    internal async Task TickUpdateScheduleAsync()
    {
        Dispatcher.VerifyAccess();
        if (updateSchedule is { } schedule) await schedule.TickAsync();
        Refresh();
    }
    private async void ScheduledUpdateTick(object? sender, EventArgs e) => await TickUpdateScheduleAsync();
    private async Task ChangeAutomaticUpdatesAsync()
    {
        if (refreshingSchedule || updateSchedule is null) return;
        await updateSchedule.SetEnabledAsync(AutomaticUpdatesCheckBox.IsChecked == true);
        Refresh();
    }

    internal Task CheckForUpdatesAsync() => RunUpdateAsync(install: false);
    internal Task InstallUpdateAsync() => RunUpdateAsync(install: true);
    private Task RunUpdateAsync(bool install, CancellationToken requestedCancellation = default)
    {
        Dispatcher.VerifyAccess();
        if (presentation.Generated || updates is null || busy || quitting || readyToClose || updateMaintenance || install && !updateAvailable)
            return Task.CompletedTask;
        busy = true; updateApplying = install; updateAvailable = false;
        if (!install) lastUpdateCheckSucceeded = false;
        if (install) { updateMaintenance = true; finalExitAttempted = false; sessionCheck?.Stop(); }
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(requestedCancellation); updateCancellation = cancellation;
        updateMessage = install ? "Stopping downloads and preparing the update…" : "Checking for updates…";
        Refresh(); operation = Run(); return operation;
        async Task Run()
        {
            try {
                if (!install) {
                    var result = await updates.CheckAsync(cancellation.Token); cancellation.Token.ThrowIfCancellationRequested();
                    if (result.CurrentVersion != updates.CurrentVersion || result.Status == WindowsAppReleaseStatus.Available &&
                        (result.Release is null || !VersionText(result.Release.Version) || Version.Parse(result.Release.Version) <= Version.Parse(updates.CurrentVersion)))
                        throw new InvalidOperationException();
                    updateAvailable = result.Status == WindowsAppReleaseStatus.Available;
                    lastUpdateCheckSucceeded = result.Status is WindowsAppReleaseStatus.Available or WindowsAppReleaseStatus.Current or WindowsAppReleaseStatus.NoRelease;
                    updateMessage = result.Status switch {
                        WindowsAppReleaseStatus.Available => "Version " + result.Release!.Version + " is available. Installing will stop downloads and restart this app.",
                        WindowsAppReleaseStatus.Current => "This version is current.",
                        WindowsAppReleaseStatus.NoRelease => "No approved update is available for this account.",
                        _ => "The update could not be checked. Try again."
                    };
                } else {
                    var result = await updates.InstallAsync(cancellation.Token);
                    lastUpdateResult = result;
                    updateHelperUncertain = result.Status is ExeUpdateHandoffStatus.RecoveryBlocked or ExeUpdateHandoffStatus.ExitUncertain or ExeUpdateHandoffStatus.ParentExitRequested;
                    updateMaintenance = updateHelperUncertain || updateDrainUncertain;
                    updateMessage = result.Status switch {
                        ExeUpdateHandoffStatus.NoUpdate => "No approved update is available.",
                        ExeUpdateHandoffStatus.Busy => "Another update or installation is already in progress.",
                        ExeUpdateHandoffStatus.Postponed => "Update postponed.",
                        ExeUpdateHandoffStatus.NeedsReconnect => "The update stopped. Reconnect your files to continue.",
                        ExeUpdateHandoffStatus.ExitRejected => "The app stayed open. Check for updates when you're ready.",
                        ExeUpdateHandoffStatus.RecoveryBlocked or ExeUpdateHandoffStatus.ExitUncertain => "The update needs review. Keep this app open.",
                        ExeUpdateHandoffStatus.ParentExitRequested => "Restarting for the update…",
                        ExeUpdateHandoffStatus.DrainFailed => "Downloads could not stop safely. Keep the app open and try again.",
                        _ => "The update could not be verified or started. Check your sign-in and try again."
                    };
                }
            } catch (OperationCanceledException) when (!install) { updateMessage = "Update check cancelled."; }
            catch {
                if (install) { updateHelperUncertain = true; updateMaintenance = true; }
                updateMessage = install ? "The update needs review. Keep this app open." : "The update could not be checked. Check your sign-in and try again.";
            } finally {
                updateApplying = false; busy = false;
                updateCancellation = null; cancellation.Dispose();
                if (!updateMaintenance && !quitting && !readyToClose) sessionCheck?.Start();
                Refresh();
                if (updateQuitRequested && !updateHelperUncertain) { updateQuitRequested = false; Quit(); }
            }
        }
    }

    internal Task<ConnectedExplorerUpdateBinding> GetVerifiedUpdateBindingAsync(CancellationToken token = default) => OnDispatcher(async () => {
        token.ThrowIfCancellationRequested();
        if (presentation.Generated || quitting || readyToClose || session is null) throw new LoginRequiredException();
        var result = await ReadBindingAsync(session, token); token.ThrowIfCancellationRequested(); return result;
    });
    private Task<ConnectedExplorerUpdateBinding> ReadBindingAsync(IExplorerPreviewSession owned, CancellationToken token = default) => readUpdateBindingForTests is { } read
        ? read(owned, token) : owned is ConnectedExplorerSession connected ? connected.GetUpdateBindingAsync(token) : throw new LoginRequiredException();

    internal Task DrainForUpdateAsync() => OnDispatcher(async () => {
        if (!updateApplying || !updateMaintenance || quitting || readyToClose || session is null) throw new InvalidOperationException("Update drain is unavailable.");
        var owned = session; drainedBinding = await ReadBindingAsync(owned, updateCancellation?.Token ?? default); drainedRoot = owned.RootPath;
        updateDrainUncertain = true;
        await DisposeOnWorkerAsync(owned);
        owned.Changed -= SessionChanged; session = null; updateDrainUncertain = false; Refresh();
    });

    internal Task<bool> RecoverForUpdateAsync(ConnectedExplorerUpdateBinding expected) => OnDispatcher(async () => {
        if ((!updateApplying && !busy) || quitting || readyToClose || updateQuitRequested || drainedBinding != expected) return false;
        IExplorerPreviewSession? replacement = null;
        try {
            if (session is { } old) { await DisposeOnWorkerAsync(old); old.Changed -= SessionChanged; session = null; updateDrainUncertain = false; }
            replacement = await createSession();
            if (quitting || updateQuitRequested || replacement is not ICachedExplorerReconnect { CanReconnectCached: true } cached) return false;
            await cached.ReconnectCachedAsync();
            if (replacement.State is not (ExplorerPreviewState.Running or ExplorerPreviewState.Paused) || await ReadBindingAsync(replacement) != expected || quitting || updateQuitRequested)
                return false;
            session = replacement; replacement.Changed += SessionChanged; replacement = null; Refresh(); return true;
        } catch { return false; }
        finally {
            if (replacement is not null) {
                try { await DisposeOnWorkerAsync(replacement); }
                catch { session = replacement; replacement.Changed += SessionChanged; updateDrainUncertain = true; }
            }
        }
    });

    internal Task<ExeUpdateParentExitDecision> RequestUpdateExitAsync(Func<Task> commitFinalExit) => OnDispatcher(async () => {
        if (!updateApplying || !updateMaintenance || quitting || readyToClose || updateQuitRequested || updateCancellation?.IsCancellationRequested != false ||
            session is not null || updateDrainUncertain || finalExitAttempted) return ExeUpdateParentExitDecision.Rejected;
        finalExitAttempted = true;
        try {
            await commitFinalExit();
            updateHelperUncertain = true; sessionCheck?.Stop();
            readyToClose = true; quitting = true; Close();
            if (closed) return ExeUpdateParentExitDecision.Accepted;
        } catch { /* The final intent may have crossed the process boundary; never label this rejection. */ }
        readyToClose = false; quitting = false; updateHelperUncertain = true; updateMaintenance = true;
        updateMessage = "The update needs review. Keep this app open."; Refresh();
        return ExeUpdateParentExitDecision.Uncertain;
    });

    private Task OnDispatcher(Func<Task> action) => Dispatcher.CheckAccess() ? action() : Dispatcher.InvokeAsync(action).Task.Unwrap();
    private Task<T> OnDispatcher<T>(Func<Task<T>> action) => Dispatcher.CheckAccess() ? action() : Dispatcher.InvokeAsync(action).Task.Unwrap();
    private static bool VersionText(string value) => value is { Length: >= 7 and <= 23 } && value.Split('.').Length == 4 && Version.TryParse(value, out var version) && version.ToString(4) == value &&
        value.Split('.').All(part => ushort.TryParse(part, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number) && number.ToString(System.Globalization.CultureInfo.InvariantCulture) == part);

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
        refreshingStartup = true;
        try {
            WindowsStartupCheckBox.IsChecked = startupState?.Enabled == true;
            WindowsStartupCheckBox.IsEnabled = startupState?.Availability == WindowsStartupAvailability.Available && !busy && !quitting && !readyToClose && !updateMaintenance;
            windowsStartupStatus.Text = startupState?.Availability switch {
                WindowsStartupAvailability.Available => startupState.Enabled
                    ? "Windows will reconnect " + (startupState.SourceAlias == "employee" ? "Company files" : "Client deliveries") + " using your saved sign-in."
                    : "Enable to reconnect this kind of files using your saved sign-in when you sign in to Windows.",
                WindowsStartupAvailability.Conflict => "Another startup value needs review. It has been kept unchanged.",
                WindowsStartupAvailability.Error => "Windows startup settings could not be verified. Try reopening Settings.",
                _ => "Startup is available in the installed Windows version."
            };
        } finally { refreshingStartup = false; }
        refreshingSchedule = true;
        try {
            var schedule = updateSchedule?.Status;
            AutomaticUpdatesCheckBox.IsChecked = schedule?.AutoUpdatesEnabled == true;
            AutomaticUpdatesCheckBox.IsEnabled = schedule is { Issue: null } && !busy && !quitting && !readyToClose && !updateMaintenance;
            automaticUpdateStatus.Text = schedule?.Issue ?? (schedule is null ? "Automatic updates are not configured in this build."
                : schedule.AutoUpdatesEnabled ? "Checks every six hours using your saved sign-in. Verified updates stop downloads and restart the app."
                : "Automatic updates are off. You can still check and install an approved update here.");
        } finally { refreshingSchedule = false; }
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
            status.Text = "Connected — saved file list is empty";
            detail.Text = "You're signed in, but this PC's saved file list is empty. Sign in and refresh the file list to check current sharing. If files are found, Explorer uses a new owned folder; the old folder and all local files are kept.";
        }
        var enabled = !busy && !quitting && !updateMaintenance;
        updateVersion.Text = "Version " + (updates?.CurrentVersion ?? typeof(ExplorerPreviewWindow).Assembly.GetName().Version?.ToString(4) ?? "unavailable");
        updateStatus.Text = updateMessage;
        CheckUpdatesButton.IsEnabled = !presentation.Generated && updates is not null && enabled;
        InstallUpdateButton.IsEnabled = !presentation.Generated && updates is not null && enabled && updateAvailable;
        var canReconnect = !presentation.Generated && (session is ICachedExplorerReconnect { CanReconnectCached: true } || session is null && drainedBinding is not null && !updateDrainUncertain);
        ReconnectButton.Visibility = canReconnect ? Visibility.Visible : Visibility.Collapsed;
        ReconnectButton.IsEnabled = enabled && canReconnect;
        var canRefreshEmpty = !presentation.Generated && session is ConnectedExplorerSession { CanRefreshEmptyInventory: true };
        if (!presentation.Generated) StartButton.Content = canRefreshEmpty ? "Sign in and refresh file list" : "Sign in and connect files";
        StartButton.IsEnabled = enabled && (canRefreshEmpty || state is ExplorerPreviewState.NotStarted or ExplorerPreviewState.Removed or ExplorerPreviewState.Failed);
        StartButton.Visibility = drainedBinding is null && (canRefreshEmpty || state is ExplorerPreviewState.NotStarted or ExplorerPreviewState.Removed or ExplorerPreviewState.Failed) ? Visibility.Visible : Visibility.Collapsed;
        OpenFolderButton.IsEnabled = !quitting && Directory.Exists(session?.RootPath ?? drainedRoot);
        PauseButton.IsEnabled = enabled && state == ExplorerPreviewState.Running;
        PauseButton.Visibility = state == ExplorerPreviewState.Running ? Visibility.Visible : Visibility.Collapsed;
        ResumeButton.IsEnabled = enabled && state == ExplorerPreviewState.Paused;
        ResumeButton.Visibility = state == ExplorerPreviewState.Paused ? Visibility.Visible : Visibility.Collapsed;
        RemoveButton.IsEnabled = enabled && (session is not null || drainedBinding is not null) && state != ExplorerPreviewState.Removed;
        location.Text = session?.RootPath ?? drainedRoot ?? "A dedicated local preview folder will be shown here after you start.";
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
        new("Open files folder", !quitting && Directory.Exists(session?.RootPath ?? drainedRoot), OpenFolder),
        new("Pause downloads", !busy && !quitting && !updateMaintenance && session?.State == ExplorerPreviewState.Running, () => _ = PausePreviewAsync()),
        new("Resume downloads", !busy && !quitting && !updateMaintenance && session?.State == ExplorerPreviewState.Paused, () => _ = ResumePreviewAsync()),
        new(""), new("Quit LedgeTop Files", true, Quit)
    ];

    private void OpenFolder()
    {
        var root = session?.RootPath ?? drainedRoot;
        if (quitting || root is null || !Directory.Exists(root)) return;
        try { folderLauncher.TryOpen(root, FolderLaunchFailed); }
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
        if (busy || quitting || readyToClose || updateMaintenance || session is not ConnectedExplorerSession connected ||
            connected.State is not (ExplorerPreviewState.Running or ExplorerPreviewState.Paused)) return;
        await OperateAsync(connected.RecheckSessionAsync);
    }

    internal void Quit()
    {
        if (quitting || readyToClose) return;
        startupCancellation?.Cancel();
        updateCancellation?.Cancel();
        if (updateApplying || updateHelperUncertain) {
            updateQuitRequested = updateApplying;
            updateMessage = updateHelperUncertain ? "The update needs review. Keep this app open." : "Waiting for the update to stop safely before quitting…";
            RestoreFromTray(); Refresh(); return;
        }
        quitting = true; RestoreFromTray(); Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        if (e.Cancel || readyToClose) return;
        e.Cancel = true;
        if (!quitting && tray?.IsAvailable == true) { Hide(); return; }
        if (updateApplying || updateHelperUncertain) { Quit(); return; }
        if (shutdown is not null) return;
        quitting = true; Refresh(); shutdown = FinishCloseAsync();
    }

    private async Task FinishCloseAsync()
    {
        // Let OnClosing publish its shutdown task before a synchronous service failure can clear it for retry.
        await Dispatcher.Yield(DispatcherPriority.Background);
        try {
            var stopSchedule = updateSchedule?.StopAsync();
            // Connected sessions cancel pending human login/catalog work before waiting for their
            // operation lock. Begin disposal now so Quit can cancel that work before draining it.
            var stoppingSession = session;
            var disconnect = stoppingSession is null ? null : DisposeOnWorkerAsync(stoppingSession);
            await operation;
            if (stopSchedule is not null) await stopSchedule;
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
        closed = true;
        readyToClose = true;
        folderLauncher.Dispose();
        if (updateScheduleTimer is { } scheduleTimer) { scheduleTimer.Stop(); scheduleTimer.Tick -= ScheduledUpdateTick; }
        if (sessionCheck is { } timer) { timer.Stop(); timer.Tick -= CheckSession; }
        if (session is not null) session.Changed -= SessionChanged;
        if (tray is not null) { tray.Activated -= RestoreFromTray; tray.Unavailable -= TrayUnavailable; tray.Dispose(); tray = null; }
        base.OnClosed(e);
    }
}
