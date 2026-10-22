using System.Security.Cryptography;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

// Synthetic UI acceptance for Ledge Top Files: real TransferQueue on temporary folders, demo sources,
// no network, no sign-in, no installer. Optional first argument: a folder for rendered screenshots.
var screenshots = args.Length > 0 ? args[0] : null;
var passed = 0; var failed = 0;
var groups = new (string Name, Func<Task> Run)[] {
    ("file type labels and sizes read like the Operations badges", TextLabels),
    ("every transfer state has a plain status and next step", StateTexts),
    ("unsafe download folders are refused with a reason", Destinations),
    ("a cached session opens files directly; no session shows sign-in without opening a browser", StartScreens),
    ("selected files download one at a time into the folder with verified bytes", Downloads),
    ("a file already in the folder is never overwritten or queued", NameTaken),
    ("files that can't be verified can't be selected and are reported", Unverifiable),
    ("an expired sign-in pauses work and asks to sign in again", Expiry),
    ("another person's downloads are hidden after a different sign-in", PersonSwitch),
    ("pause keeps the partial and resume finishes the same file", PauseResume),
    ("the window renders sign-in and files screens", Render),
};
foreach (var group in groups) {
    try { await Sta(group.Run); passed++; Console.WriteLine("PASS " + group.Name); }
    catch (Exception error) { failed++; Console.Error.WriteLine("FAIL " + group.Name + ": " + error.GetType().Name + " " + error.Message); }
}
Console.WriteLine($"{passed}/{groups.Length} app groups passed. Demo data only; no network.");
return failed == 0 ? 0 : 1;

// ---------------------------------------------------------------------------------------------

Task TextLabels()
{
    Equal("KML", Text.FileType("PIN-20261020113.kml"));
    Equal("TIF", Text.FileType("ortho.tif"));
    Equal("File", Text.FileType("README"));
    Equal("File", Text.FileType("archive.toolongextension"));
    Equal("—", Text.Size(-1));
    Equal("15.0 KB", Text.Size(15_360).Replace(',', '.'));
    return Task.CompletedTask;
}

Task StateTexts()
{
    var job = new QueuedTransfer(Guid.NewGuid(), "odqr1_x", @"C:\x", "ondf1_" + new string('a', 64), "v1", "a.tif", 10, "\"v1\"", new string('a', 64), false, QueuedTransferState.Queued, null);
    foreach (var state in Enum.GetValues<QueuedTransferState>()) True(Text.State(job with { State = state }).Length > 0, state + " has a status");
    True(Text.Detail(job with { State = QueuedTransferState.VersionChanged }).Contains("Select it again"), "changed version asks to select again");
    True(Text.Detail(job with { State = QueuedTransferState.LoginRequired }).Contains("Sign in"), "login required says sign in");
    True(Text.Detail(job with { State = QueuedTransferState.Failed, ErrorCode = "existing-content-mismatch" }).Contains("left untouched"), "existing file left untouched");
    Equal("Needs checking", Text.State(job with { State = QueuedTransferState.Paused, RecoveryRequired = true }));
    return Task.CompletedTask;
}

Task Destinations()
{
    True(Text.DestinationProblem(@"\\server\share") is not null, "network share refused");
    True(Text.DestinationProblem(@"C:\Users\x\OneDrive\Files") is not null, "OneDrive refused");
    True(Text.DestinationProblem("relative") is not null, "relative refused");
    True(Text.DestinationProblem(Path.GetTempPath()) is null, "temp folder allowed");
    return Task.CompletedTask;
}

async Task StartScreens()
{
    await using (var signedOut = Env.Create(signedIn: false)) {
        await signedOut.Model.StartAsync();
        Equal(Screen.SignIn, signedOut.Model.Screen);
        signedOut.Model.SignIn.Execute(null);
        await Until(() => signedOut.Model.Screen == Screen.Files, "sign-in completes after the explicit button");
    }
    await using var signedIn = Env.Create(signedIn: true);
    await signedIn.Model.StartAsync();
    Equal(Screen.Files, signedIn.Model.Screen);
    True(signedIn.Model.SessionText.StartsWith("Signed in until"), "session time shown");
    Equal(2, signedIn.Model.Sections.Count);
}

async Task Downloads()
{
    await using var env = Env.Create(signedIn: true);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("PIN-20261020113.kml"); env.Check("report.pdf");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Count == 2 && env.Model.Transfers.All(row => row.State == QueuedTransferState.Completed), "both complete");
    foreach (var name in new[] { "PIN-20261020113.kml", "report.pdf" }) {
        var path = Path.Combine(env.Downloads, name);
        True(File.Exists(path), name + " saved");
        True(env.Model.Transfers.Single(row => row.Name == name).OutputPath == path, name + " output path");
    }
    Equal("", env.Model.Notice);
}

async Task NameTaken()
{
    await using var env = Env.Create(signedIn: true);
    Directory.CreateDirectory(env.Downloads);
    var existing = Path.Combine(env.Downloads, "report.pdf");
    await File.WriteAllTextAsync(existing, "keep me");
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("report.pdf");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Notice.Contains("already in this folder"), "name clash explained");
    Equal(0, env.Model.Transfers.Count);
    Equal("keep me", await File.ReadAllTextAsync(existing));
}

async Task Unverifiable()
{
    await using var env = Env.Create(signedIn: true);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    var zip = env.Model.Files.Single(file => file.Name == "site-photos.zip");
    True(!zip.CanDownload, "zip not downloadable");
    Equal(Text.ChecksumUnavailable, zip.Status);
    zip.IsChecked = true;
    True(!env.Model.DownloadSelected.CanExecute(null), "download disabled with only an unverifiable file");
}

async Task Expiry()
{
    var now = DateTimeOffset.Now;
    await using var env = Env.Create(signedIn: true, rate: 400_000, clock: () => now);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("ortho-full.tif");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running), "download running");
    env.Backend.Expire(); now = now.AddHours(2);
    env.Model.Tick();
    Equal(Screen.SignIn, env.Model.Screen);
    Equal(Text.SessionExpired, env.Model.SignInStatus);
    await Until(() => !File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "nothing promoted after expiry");
}

async Task PersonSwitch()
{
    await using var env = Env.Create(signedIn: true);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "greenleaf");
    env.Check("volumes.csv");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Count == 1, "queued");
    env.Backend.SwitchPerson();
    await env.Model.RefreshTransfersAsync();
    Equal(0, env.Model.Transfers.Count);
    True(env.Model.Banner.Contains("someone else"), "explains hidden downloads");
}

async Task PauseResume()
{
    await using var env = Env.Create(signedIn: true, rate: 2_000_000);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("ortho-full.tif");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 3), "progress shown");
    var row = env.Model.Transfers.Single();
    row.Pause.Execute(null);
    await Until(() => row.State == QueuedTransferState.Paused, "paused");
    True(Directory.EnumerateFiles(env.Downloads, "*.ltds-demo-partial", new EnumerationOptions { AttributesToSkip = 0 }).Any(), "partial kept");
    True(!File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "not complete while paused");
    env.Backend.Faster();
    row.Resume.Execute(null);
    await Until(() => row.State == QueuedTransferState.Completed, "completed after resume", seconds: 60);
    var bytes = await File.ReadAllBytesAsync(Path.Combine(env.Downloads, "ortho-full.tif"));
    Equal(48_000_000, bytes.Length);
    Equal(row.Item!.Job.Sha256, Convert.ToHexStringLower(SHA256.HashData(bytes)));
}

async Task Render()
{
    if (screenshots is null) return;
    Directory.CreateDirectory(screenshots);
    await using (var env = Env.Create(signedIn: false)) {
        var window = env.Window();
        await env.Model.StartAsync();
        Snap(window, Path.Combine(screenshots, "sign-in.png"));
        window.Close();
    }
    await using (var env = Env.Create(signedIn: true, rate: 1_500_000)) {
        var window = env.Window();
        Directory.CreateDirectory(env.Downloads);
        await File.WriteAllTextAsync(Path.Combine(env.Downloads, "inspection.pdf"), "already here");
        await env.Model.StartAsync();
        await env.OpenAsync("deliveries", "land-script");
        env.Check("PIN-20261020113.kml"); env.Check("ortho-full.tif"); env.Check("report.pdf");
        env.Model.DownloadSelected.Execute(null);
        await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 20), "visible progress", seconds: 60);
        Snap(window, Path.Combine(screenshots, "files.png"));
        window.Close();
    }
}

// ---------------------------------------------------------------------------------------------

static void Snap(Window window, string path)
{
    window.UpdateLayout(); Pump();
    var visual = (FrameworkElement)window.Content;
    var bitmap = new RenderTargetBitmap((int)visual.ActualWidth, (int)visual.ActualHeight, 96, 96, PixelFormats.Pbgra32);
    var drawing = new DrawingVisual();
    using (var context = drawing.RenderOpen()) {
        context.DrawRectangle((Brush)window.FindResource("Page"), null, new Rect(0, 0, visual.ActualWidth, visual.ActualHeight));
        // Draw at actual size: a stretched brush would distort text whenever content bounds differ.
        context.DrawRectangle(new VisualBrush(visual) { Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top,
            ViewboxUnits = BrushMappingMode.Absolute, Viewbox = new Rect(0, 0, visual.ActualWidth, visual.ActualHeight) },
            null, new Rect(0, 0, visual.ActualWidth, visual.ActualHeight));
    }
    bitmap.Render(drawing);
    var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
    using var file = File.Create(path); encoder.Save(file);
}

static void Pump() => Wait.Pump();
static Task Until(Func<bool> condition, string what, int seconds = 30) => Wait.Until(condition, what, seconds);

static void Equal<T>(T expected, T actual) { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}"); }
static void True(bool value, string what) { if (!value) throw new Exception("Expected: " + what); }

/// <summary>Runs a test on an STA thread with a WPF dispatcher, as the real window does.</summary>
static Task Sta(Func<Task> test)
{
    var done = new TaskCompletionSource();
    var thread = new Thread(() => {
        var dispatcher = Dispatcher.CurrentDispatcher;
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(dispatcher));
        if (Application.Current is null) {
            var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            app.Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("pack://application:,,,/LedgeTop.Files;component/Theme.xaml") });
        }
        dispatcher.BeginInvoke(async () => {
            try { await test(); done.SetResult(); }
            catch (Exception error) { done.SetException(error); }
            finally { dispatcher.BeginInvokeShutdown(DispatcherPriority.Background); }
        });
        Dispatcher.Run();
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    return done.Task;
}

/// <summary>A fresh demo backend, view model and folders for one test.</summary>
sealed class Env : IAsyncDisposable, IShell
{
    private readonly string root;
    private readonly Dispatcher ui = Dispatcher.CurrentDispatcher;
    private MainWindow? window;
    private Env(string root, DemoBackend backend, Func<DateTimeOffset>? clock)
    {
        this.root = root; Backend = backend; Downloads = Path.Combine(root, "Downloads");
        Model = new MainViewModel(backend, this, Downloads, clock);
    }

    public DemoBackend Backend { get; }
    public MainViewModel Model { get; private set; }
    public string Downloads { get; }

    public static Env Create(bool signedIn, double rate = 40_000_000, Func<DateTimeOffset>? clock = null)
    {
        var root = Path.Combine(Path.GetTempPath(), "ltfiles-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return new Env(root, new DemoBackend(Path.Combine(root, "queue"), signedIn, bytesPerSecond: rate), clock);
    }

    /// <summary>Attaches the real window so rendering uses the production XAML.</summary>
    public MainWindow Window()
    {
        window = new MainWindow { Width = 1180, Height = 780, ShowInTaskbar = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -20000, Top = -20000 };
        Model = new MainViewModel(Backend, window, Downloads);
        window.Attach(Model, demo: true);
        window.Show();
        return window;
    }

    public async Task OpenAsync(string section, string folder)
    {
        var node = Model.Sections.Single(item => item.Node.Key == section);
        node.IsExpanded = true;
        await Wait.Until(() => node.Children.Any(child => child.Node.Key == folder), "folder listed");
        var child = node.Children.Single(item => item.Node.Key == folder);
        await Model.SelectAsync(child);
    }

    public void Check(string name) => Model.Files.Single(file => file.Name == name).IsChecked = true;

    public void OnUi(Action action) => ui.BeginInvoke(action);
    public string? PickFolder(string current) => null;
    public void OpenFile(string path) { }
    public void ShowInFolder(string path) { }

    public async ValueTask DisposeAsync()
    {
        await Model.DisposeAsync();
        try { Directory.Delete(root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

static class Wait
{
    public static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, () => frame.Continue = false);
        Dispatcher.PushFrame(frame);
    }

    public static async Task Until(Func<bool> condition, string what, int seconds = 30)
    {
        var stop = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition()) {
            if (DateTime.UtcNow > stop) throw new Exception("Timed out waiting: " + what);
            await Task.Delay(50); Pump();
        }
    }
}
