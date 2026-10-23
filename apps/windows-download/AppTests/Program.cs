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
// no network, no sign-in, no installer. Optional first argument: a folder for rendered screenshots
// (otherwise they go to a new temporary folder, which is printed and kept as evidence).
var screenshots = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "ltfiles-screens-" + Guid.NewGuid().ToString("N"));
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
    ("a different sign-in closes the previous person's files, queue and late results", PersonSwitch),
    ("pause keeps the partial and resume finishes the same file", PauseResume),
    ("pause all stops the running download while sign-in checks are stuck", PauseAllOffline),
    ("resume all finishes every paused download, one at a time", ResumeAllInTurn),
    ("long folders and delivery lists continue with Show more", Paging),
    ("the setup file is read strictly and problems are explained", SettingsFile),
    ("packaged releases use only their compiled profile and their own channel folder", PackagedReleases),
    ("closing during startup or sign-in opens nothing and leaves no queue locked", CloseBeforeSignedIn),
    ("closing the window waits for downloads to stop and save, even with sign-in stuck", CloseWindow),
    ("closing while the previous person's downloads are still stopping waits for them and opens nothing new", CloseDuringSwitch),
    ("hostile listed names never reach the file system; safe names keep the overwrite check", HostileNames),
    ("closing waits for pause all to save waiting items as paused", PauseAllSavedBeforeClose),
    ("closing waits for a pause all that is still stopping, and every closer waits for the same shutdown", PauseAllStoppingBeforeClose),
    ("closing fences a start that was already past its list check", NoStartAfterClose),
    ("a resume after pause all wins over its late save", ResumeBeatsLatePauseSave),
    ("resume all after pause all wins over its late save", ResumeAllBeatsLatePauseSave),
    ("pause all wins over a start that was already chosen", PauseAllBeatsChosenStart),
    ("pause all wins over a start already shown as active but not yet begun", PauseAllBeatsPublishedStart),
    ("pause all wins over a resume still waiting its turn, and a later resume still works", PauseAllBeatsPendingResume),
    ("a repeated resume of the running download never frees its slot for a second source", RepeatedResumeKeepsOneActive),
    ("a late finish from an older start never frees a newer start's slot", StaleIdleKeepsOneActive),
    ("a throwing save observer still lets closing finish", ThrowingSaveObserverStillCloses),
    ("closing releases the backend once, after its queues", BackendReleased),
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
    await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 1), "download running");
    env.Backend.Expire(); now = now.AddHours(2);
    env.Model.Tick();
    Equal(Screen.SignIn, env.Model.Screen);
    Equal(Text.SessionExpired, env.Model.SignInStatus);
    // The worker must actually drain: nothing running, and the file never promoted.
    await Until(() => !env.Model.IsTransferring, "transfer drained after expiry");
    await Task.Delay(800); Pump();
    True(!File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "nothing promoted after expiry");
    // Signing in again shows the item stopped for sign-in, not running or done.
    env.Model.SignIn.Execute(null);
    await Until(() => env.Model.Screen == Screen.Files && env.Model.Transfers.Count == 1, "back after signing in");
    var state = env.Model.Transfers.Single().State;
    True(state is QueuedTransferState.LoginRequired or QueuedTransferState.Paused, "stopped for sign-in, was " + state);
    True(!File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "still not promoted");
}

async Task PersonSwitch()
{
    await using var env = Env.Create(signedIn: true, rate: 300_000);
    await env.Model.StartAsync();
    var alice = env.Backend.Principal;
    await env.OpenAsync("deliveries", "land-script");
    env.Check("ortho-full.tif");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 1), "Alice's download running");
    True(env.Model.Files.Count > 0 && env.Model.Sections.Count == 2, "Alice's lists shown");

    // A folder listing for Alice is still on its way when Bob signs in.
    var harbor = env.Model.Sections.Single(item => item.Node.Key == "deliveries").Children.Single(item => item.Node.Key == "harbor");
    var late = env.Model.SelectAsync(harbor);
    env.Backend.SwitchPerson();
    var bob = env.Backend.Principal;
    True(alice != bob, "different opaque people");
    await env.Model.CheckPersonAsync();
    await late;
    Pump();

    True(!env.Model.IsTransferring, "Alice's transfer drained");
    Equal(0, env.Model.Transfers.Count);
    Equal(0, env.Model.Files.Count);
    Equal("", env.Model.Location);
    Equal(1, env.Model.Sections.Count);
    True(env.Model.Banner.Contains("someone else"), "explains the switch");
    var deliveries = env.Model.Sections.Single();
    deliveries.IsExpanded = true;
    await Until(() => deliveries.Children.Any(child => child.Node.Key == "greenleaf"), "Bob's deliveries listed");
    True(deliveries.Children.All(child => child.Node.Key == "greenleaf"), "only Bob's deliveries");
    True(Directory.Exists(Path.Combine(env.Backend.StateDirectory, "portal", alice)) && Directory.Exists(Path.Combine(env.Backend.StateDirectory, "portal", bob)),
        "each person has their own queue folder");
    await Task.Delay(800); Pump();
    True(!File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "Alice's file not promoted for Bob");

    // A late selection of one of Alice's old folders can't bring back her breadcrumb or files.
    harbor.IsSelected = false; harbor.IsSelected = true;
    await env.Model.SelectAsync(harbor);
    await Task.Delay(400); Pump();
    Equal("", env.Model.Location);
    Equal(0, env.Model.Files.Count);

    // Bob's own download lives only in Bob's list.
    await env.OpenAsync("deliveries", "greenleaf");
    env.Check("volumes.csv");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Count == 1 && env.Model.Transfers[0].State == QueuedTransferState.Completed, "Bob's download completes");

    // Alice again: her paused download is back, Bob's is not.
    env.Backend.SwitchPerson(0);
    await env.Model.CheckPersonAsync();
    await Until(() => env.Model.Transfers.Count == 1, "Alice's list back");
    Equal("ortho-full.tif", env.Model.Transfers[0].Name);
    Equal(QueuedTransferState.Paused, env.Model.Transfers[0].State);
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

async Task PauseAllOffline()
{
    await using var env = Env.Create(signedIn: true, rate: 300_000);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("ortho-full.tif"); env.Check("report.pdf");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Count == 2 && env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 1), "one running, one waiting");
    var partial = Directory.EnumerateFiles(env.Downloads, "*.ltds-demo-partial", new EnumerationOptions { AttributesToSkip = 0 }).Single();

    env.Backend.BlockSessions();
    var stopping = env.Model.PauseAll.RunAsync();
    var finished = await Task.WhenAny(stopping, Task.Delay(TimeSpan.FromSeconds(5)));
    True(finished == stopping, "pause all returned while sign-in checks hang");
    True(!env.Model.IsTransferring, "nothing transferring");
    var size = new FileInfo(partial).Length;
    await Task.Delay(1000);
    Equal(size, new FileInfo(partial).Length);
    True(env.Backend.MostAtOnce == 1, "never two at once");

    env.Backend.ReleaseSessions();
    await env.Model.RefreshTransfersAsync();
    await Until(() => env.Model.Transfers.All(row => row.State == QueuedTransferState.Paused), "both paused");
    await Task.Delay(800); Pump();
    True(env.Model.Transfers.All(row => row.State == QueuedTransferState.Paused), "nothing restarted by itself");
}

async Task ResumeAllInTurn()
{
    await using var env = Env.Create(signedIn: true, rate: 3_000_000);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("report.pdf"); env.Check("ortho-full.tif");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Count == 2 && env.Model.Transfers.Any(row => row.IsRunning), "started");
    await env.Model.PauseAll.RunAsync();
    await env.Model.RefreshTransfersAsync();
    await Until(() => env.Model.Transfers.All(row => row.State == QueuedTransferState.Paused), "both paused");
    True(env.Model.ResumeAll.CanExecute(null), "resume all offered");

    await env.Model.ResumeAll.RunAsync();
    await Until(() => env.Model.Transfers.All(row => row.State == QueuedTransferState.Completed), "both completed", seconds: 90);
    Equal(1, env.Backend.MostAtOnce);
    foreach (var row in env.Model.Transfers) {
        var bytes = await File.ReadAllBytesAsync(row.OutputPath!);
        Equal(row.Item!.Job.Sha256, Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }
}

async Task Paging()
{
    await using var env = Env.Create(signedIn: true, pageSize: 2);
    await env.Model.StartAsync();
    var deliveries = env.Model.Sections.Single(item => item.Node.Key == "deliveries");
    deliveries.IsExpanded = true;
    await Until(() => deliveries.Children.Any(child => child.IsMore), "first page of deliveries");
    Equal(3, deliveries.Children.Count);
    deliveries.Children.Single(child => child.IsMore).IsSelected = true;
    await Until(() => deliveries.Children.Any(child => child.Node.Key == "harbor"), "next page of deliveries");
    True(!deliveries.Children.Any(child => child.IsMore), "no more after the last page");
    Equal(3, deliveries.Children.Count);

    await env.Model.SelectAsync(deliveries.Children.Single(child => child.Node.Key == "land-script"));
    Equal(2, env.Model.Files.Count);
    True(env.Model.HasMoreFiles, "more files offered");
    await env.Model.LoadMoreFiles.RunAsync();
    Equal(4, env.Model.Files.Count);
    True(!env.Model.HasMoreFiles, "all files shown");
    Equal(4, env.Model.Files.Select(file => file.Name).Distinct().Count());
}

Task SettingsFile()
{
    var folder = Path.Combine(Path.GetTempPath(), "ltfiles-settings-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(folder);
    try {
        var hash = new string('a', 64);
        string Write(string json) { var path = Path.Combine(folder, Guid.NewGuid().ToString("N") + ".json"); File.WriteAllText(path, json); return path; }
        var good = $$"""{"portalApplicationUrl":"https://portal.example.test/files/","staffApplicationUrl":null,"cloudflaredPath":"C:\\Program Files\\cloudflared\\cloudflared.exe","cloudflaredSha256":"{{hash}}"}""";
        var loaded = LiveSettings.Load(Write(good));
        True(loaded is { StaffApplicationUrl: null } && loaded.PortalApplicationUrl.Host == "portal.example.test", "valid setup loads");
        True(LiveSettings.Load(Path.Combine(folder, "missing.json")) is null, "missing file means not set up");
        foreach (var (bad, why) in new[] {
            (good.Replace("}", ",\"portalApplicationUrl\":\"https://other.example.test/\"}"), "duplicate key"),
            (good.Replace("}", ",\"token\":\"x\"}"), "unknown key"),
            (good.Replace("https://portal", "http://portal"), "plain http"),
            (good.Replace("example.test/files/", "example.test/"), "root URL instead of the app path"),
            (good.Replace(hash, "abc"), "short hash"),
            (good.Replace(@"C:\\Program Files", "relative"), "relative binary"),
            (good[..^1], "truncated"),
            ("[]", "not an object"),
            ("{\"portalApplicationUrl\":\"https://p.example.test/\"} // x", "trailing comment"),
            ("{" + new string(' ', 20_000) + "}", "oversized"),
        }) {
            try { LiveSettings.Load(Write(bad)); throw new Exception("accepted " + why); }
            catch (SettingsException error) { True(error.Message.Contains("setup file"), why + " explained"); }
        }

        // Building the real sources: every failure becomes a setup message, never an exception.
        var state = Path.Combine(folder, "queue");
        True(LiveBackend.Open(Path.Combine(folder, "missing.json"), state) == (null, null), "not set up");
        var root = LiveBackend.Open(Write(good.Replace("example.test/files/", "example.test/")), state);
        True(root.Backend is null && root.Problem!.Contains("setup file"), "root URL explained");
        var missing = LiveBackend.Open(Write(good), state);
        True(missing.Backend is null && missing.Problem!.Contains("sign-in helper"), "missing cloudflared explained");
        var binary = Path.Combine(folder, "cloudflared.exe");
        File.WriteAllBytes(binary, [1, 2, 3]);
        var changed = LiveBackend.Open(Write(good.Replace(@"C:\\Program Files\\cloudflared\\cloudflared.exe", binary.Replace(@"\", @"\\"))), state);
        True(changed.Backend is null && changed.Problem!.Contains("sign-in helper"), "changed cloudflared explained");
    } finally { Directory.Delete(folder, true); }
    return Task.CompletedTask;
}

async Task PackagedReleases()
{
    var root = Path.Combine(Path.GetTempPath(), "ltfiles-release-" + Guid.NewGuid().ToString("N"));
    var local = Path.Combine(root, "Local"); var user = Path.Combine(root, "User"); var install = Path.Combine(root, "Install");
    var helperBytes = new byte[] { 0x4d, 0x5a, 1, 2, 3, 4 };
    Directory.CreateDirectory(Path.Combine(install, "helper"));
    File.WriteAllBytes(Path.Combine(install, "helper", "cloudflared.exe"), helperBytes);
    var helperHash = Convert.ToHexStringLower(SHA256.HashData(helperBytes));
    ReleaseProfile Profile(ReleaseChannel channel, string? hash = null, string relative = @"helper\cloudflared.exe") =>
        new(channel, new Uri("https://portal.example.test/portal"), new Uri("https://ops.example.test/api/staff/files"), relative, hash ?? helperHash);
    StartupPlan Run((bool, ReleaseChannel?) compiled, Func<ReleaseChannel, ReleaseProfile?> profiles, params string[] args) =>
        Startup.Choose(compiled, args, local, user, install, profiles);
    (bool, ReleaseChannel?) pilot = (true, ReleaseChannel.Pilot);
    try {
        // The old shared records and a developer settings file already exist on this PC.
        var legacyQueue = Path.Combine(local, "LedgeTop", "Files", "queue", "portal", "odqp1_" + new string('a', 64));
        Directory.CreateDirectory(legacyQueue);
        File.WriteAllText(Path.Combine(legacyQueue, "queue.json"), "legacy");
        var overrideJson = $$"""{"portalApplicationUrl":"https://evil.example.test/portal","staffApplicationUrl":null,"cloudflaredPath":"C:\\evil\\cloudflared.exe","cloudflaredSha256":"{{new string('b', 64)}}"}""";
        File.WriteAllText(LiveSettings.PathUnder(local), overrideJson);
        Environment.SetEnvironmentVariable("LEDGETOP_FILES_PORTAL_URL", "https://evil.example.test/portal");

        // Packaged pilot: the compiled profile only, despite the settings file, arguments and environment.
        var plan = Run(pilot, channel => Profile(channel), "--demo", "--demo-signed-in", "--settings", LiveSettings.PathUnder(local));
        var live = plan.Backend as LiveBackend ?? throw new Exception("Expected the live backend, got " + plan.Backend?.GetType().Name + " / " + plan.Problem);
        Equal("https://portal.example.test/portal", live.Settings.PortalApplicationUrl.ToString());
        Equal(Path.Combine(install, "helper", "cloudflared.exe"), live.Settings.CloudflaredPath);
        Equal(helperHash, live.Settings.CloudflaredSha256);
        Equal(Path.Combine(local, "LedgeTop", "Files", "pilot", "queue"), live.StateDirectory);
        Equal("Pilot", plan.Tag);
        await live.DisposeAsync();

        // Stable has its own folder; neither reuses the developer or the old shared records.
        var stable = (LiveBackend)Run((true, ReleaseChannel.Stable), channel => Profile(channel)).Backend!;
        Equal(Path.Combine(local, "LedgeTop", "Files", "stable", "queue"), stable.StateDirectory);
        await stable.DisposeAsync();
        var roots = new[] { live.StateDirectory, stable.StateDirectory, Startup.StateRoot(local, "developer"), Path.Combine(local, "LedgeTop", "Files", "queue") };
        Equal(roots.Length, roots.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        foreach (var outer in roots) foreach (var inner in roots)
            True(outer == inner || !inner.StartsWith(outer + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "no channel folder nests in another");
        Equal("legacy", File.ReadAllText(Path.Combine(legacyQueue, "queue.json")));
        True(!Directory.Exists(roots[0]) && !Directory.Exists(roots[1]), "nothing is copied or migrated into a channel folder at startup");
        Equal(overrideJson, File.ReadAllText(LiveSettings.PathUnder(local)));

        // The real compiled table: pilot pins the qualified cloudflared build, so a different installed file is refused;
        // stable is unconfigured and refuses before looking for any helper.
        var compiledPilot = ReleaseProfiles.For(ReleaseChannel.Pilot)!;
        Equal("76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2", compiledPilot.CloudflaredSha256);
        Equal(@"helper\cloudflared.exe", compiledPilot.CloudflaredRelativePath);
        Equal(Startup.HelperProblem, Run(pilot, ReleaseProfiles.For).Problem);
        Equal(Startup.UnreviewedProblem, Run((true, ReleaseChannel.Stable), ReleaseProfiles.For).Problem);
        foreach (var uri in new[] { compiledPilot.PortalApplicationUrl, compiledPilot.StaffApplicationUrl! }) {
            True(uri.Scheme == "https" && uri.Host.EndsWith("-staging.ledgetopdroneservices.com") && uri.AbsolutePath != "/", uri + " is a path-scoped staging origin");
            True(!uri.Host.EndsWith(".app"), "no ledgetop.app before the domain migration");
        }
        True(ReleaseProfiles.For(ReleaseChannel.Stable) is null, "stable stays unconfigured");

        // Unknown or malformed profiles fail closed with a reason and never fall back to developer setup or demo.
        var unknown = Run((true, null), channel => Profile(channel), "--demo");
        True(unknown.Backend is null && unknown.Problem == Startup.UnknownReleaseProblem, "unknown release refused");
        foreach (var bad in new Func<ReleaseChannel, ReleaseProfile?>[] {
            _ => null,
            _ => Profile(ReleaseChannel.Stable),
            channel => Profile(channel) with { CloudflaredSha256 = null },
            channel => Profile(channel, relative: @"..\cloudflared.exe"),
            channel => Profile(channel, relative: @"helper\..\..\cloudflared.exe"),
            channel => Profile(channel, relative: @"C:\Windows\cloudflared.exe"),
            channel => Profile(channel, relative: @"\\server\share\cloudflared.exe"),
            channel => Profile(channel, relative: @"helper\cloudflared.exe:stream"),
            channel => Profile(channel, relative: ""),
        }) {
            var refused = Run(pilot, bad, "--demo");
            True(refused.Backend is null && refused.Problem == Startup.UnreviewedProblem, "malformed profile refused: " + refused.Problem);
        }
        // Wrong or missing helper.
        var wrong = Run(pilot, channel => Profile(channel, hash: new string('c', 64)));
        True(wrong.Backend is null && wrong.Problem == Startup.HelperProblem, "changed helper refused");
        var missing = Run(pilot, channel => Profile(channel, relative: @"helper\missing.exe"));
        True(missing.Backend is null && missing.Problem == Startup.HelperProblem, "missing helper refused");

        // Compiled channel parsing: exact lowercase values only; anything else is an unknown release.
        static System.Reflection.AssemblyMetadataAttribute M(string value) => new(ReleaseProfiles.ChannelKey, value);
        static System.Reflection.AssemblyMetadataAttribute D(string value) => new(ReleaseProfiles.BuildModeKey, value);
        Equal((true, (ReleaseChannel?)ReleaseChannel.Pilot), ReleaseProfiles.Compiled([M("pilot")]));
        Equal((true, (ReleaseChannel?)ReleaseChannel.Stable), ReleaseProfiles.Compiled([M("stable"), new System.Reflection.AssemblyMetadataAttribute("Other", "x")]));
        foreach (var odd in new System.Reflection.AssemblyMetadataAttribute[][] { [M("Pilot")], [M("beta")], [M("")], [M("pilot"), M("stable")], [M("pilot"), M("pilot")] })
            Equal((true, (ReleaseChannel?)null), ReleaseProfiles.Compiled(odd));
        // A build with neither a channel nor the explicit developer opt-in (a plain Release build) fails closed;
        // so do mixed and malformed developer markers. Only the exact opt-in alone is a developer build.
        Equal((false, (ReleaseChannel?)null), ReleaseProfiles.Compiled([D("developer")]));
        foreach (var odd in new System.Reflection.AssemblyMetadataAttribute[][] { [], [new("Other", "developer")], [D("Developer")], [D("true")], [D("")],
            [D("developer"), D("developer")], [D("developer"), M("pilot")], [M("pilot"), D("developer")] })
            Equal((true, (ReleaseChannel?)null), ReleaseProfiles.Compiled(odd));
        var plain = Run(ReleaseProfiles.Compiled([]), channel => Profile(channel), "--demo", "--demo-signed-in");
        True(plain.Backend is null && plain.Problem == Startup.UnknownReleaseProblem, "a plain Release build shows neither demo data nor developer setup");
        // This harness builds the app with the explicit opt-in.
        Equal((false, (ReleaseChannel?)null), ReleaseProfiles.Compiled(typeof(App).Assembly));

        // Developer builds keep explicit demo and the developer settings file, with their own folder.
        Equal("Demo data", Run((false, null), ReleaseProfiles.For, "--demo").Tag);
        var developer = Run((false, null), ReleaseProfiles.For);
        True(developer.Backend is null && developer.Problem == Startup.HelperProblem, "developer build uses its own settings file (whose helper is missing here)");
        File.Delete(LiveSettings.PathUnder(local));
        var unset = Run((false, null), ReleaseProfiles.For);
        True(unset.Backend is null && unset.Problem is null, "no developer settings means not set up");
    } finally {
        Environment.SetEnvironmentVariable("LEDGETOP_FILES_PORTAL_URL", null);
        try { Directory.Delete(root, true); } catch (IOException) { }
    }
}

async Task CloseBeforeSignedIn()
{
    // Startup's own session check is still waiting when the window closes.
    await using (var env = Env.Create(signedIn: true)) {
        env.Backend.BlockSessions();
        var start = env.Model.StartAsync();
        await env.Model.DisposeAsync();
        env.Backend.ReleaseSessions();
        await start;
        await Task.Delay(300); Pump();
        True(env.Model.Screen != Screen.Files && env.Model.Sections.Count == 0, "nothing opened after close");
        True(!Directory.Exists(env.Backend.StateDirectory), "no queue was created");
    }
    // The session answered, but the queue is still opening when the window closes.
    await using (var env = Env.Create(signedIn: true)) {
        env.Backend.BlockSources();
        var start = env.Model.StartAsync();
        await Task.Delay(200); Pump();
        var closing = env.Model.DisposeAsync().AsTask();
        await Task.Delay(200);
        True(!closing.IsCompleted, "closing waits for the queue that is still opening");
        env.Backend.ReleaseSources();
        await closing; await start;
        await Task.Delay(300); Pump();
        True(env.Model.Screen != Screen.Files && env.Model.Sections.Count == 0, "no files shown after close");
        True(Locks.Free(env.Backend.StateDirectory), "the late queue was released");
        Equal(0, env.Backend.Writing);
        // A second close returns the same finished shutdown.
        await env.Model.DisposeAsync();
    }
    // Two startups race: only one opens a queue at a time, and closing releases it (adapted from Codex's regression).
    await using (var env = Env.Create(signedIn: true)) {
        env.Backend.BlockSources();
        Task first, second, closing;
        // Release the held check even when an assertion fails, so a regression fails instead of hanging in dispose.
        try {
            first = env.Model.StartAsync();
            await Until(() => env.Backend.SourceChecks > 0, "first queue opening");
            second = env.Model.StartAsync();
            await Task.Delay(150); Pump();
            Equal(1, env.Backend.SourceChecks);
            closing = env.Model.DisposeAsync().AsTask();
            await Task.Delay(150); Pump();
            True(!closing.IsCompleted, "closing waits for the queue that is opening");
        } finally { env.Backend.ReleaseSources(); }
        await closing.WaitAsync(TimeSpan.FromSeconds(30)); await first.WaitAsync(TimeSpan.FromSeconds(30)); await second.WaitAsync(TimeSpan.FromSeconds(30));
        await Task.Delay(300); Pump();
        True(Locks.Free(env.Backend.StateDirectory), "no queue left locked");
        True(env.Model.Screen != Screen.Files && env.Model.Sections.Count == 0, "nothing shown after close");
        Equal(0, env.Backend.Writing);
    }
    // Sign-in finishes in the browser after the window closed.
    await using (var env = Env.Create(signedIn: false)) {
        await env.Model.StartAsync();
        env.Model.SignIn.Execute(null);
        await env.Model.DisposeAsync();
        await Until(() => env.Model.SignIn.CanExecute(null), "sign-in finished", seconds: 10);
        await Task.Delay(300); Pump();
        True(env.Model.Screen == Screen.SignIn && env.Model.Sections.Count == 0, "no files after a sign-in that finished after close");
        True(!Directory.Exists(env.Backend.StateDirectory) || Locks.Free(env.Backend.StateDirectory), "no queue left open");
    }
}

async Task CloseDuringSwitch()
{
    // Two ways a different person arrives: the app notices on its own, or someone signs in after the session ended.
    foreach (var viaSignIn in new[] { false, true }) {
        var now = DateTimeOffset.Now;
        await using var env = Env.Create(signedIn: true, rate: 400_000, clock: () => now);
        await env.Model.StartAsync();
        var alice = env.Backend.Principal;
        await env.OpenAsync("deliveries", "land-script");
        env.Check("ortho-full.tif");
        env.Model.DownloadSelected.Execute(null);
        await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 1), "Alice's download running");
        if (viaSignIn) {
            // The app's clock says the sign-in ended, but Alice's download is still running when Bob signs in.
            now = now.AddHours(2); env.Model.Tick();
            Equal(Screen.SignIn, env.Model.Screen);
        }
        env.Backend.HoldStops();
        env.Backend.SwitchPerson();
        var bob = env.Backend.Principal;
        Task switching;
        if (viaSignIn) { env.Model.SignIn.Execute(null); switching = Until(() => env.Model.SignIn.CanExecute(null), "sign-in finished", seconds: 30); }
        else switching = env.Model.CheckPersonAsync();
        // Alice's queue has been detached and is stopping; it can't finish until released.
        await Until(() => !env.Model.IsTransferring && env.Model.Sections.Count == 0, "Alice's queue detached", seconds: 10);
        var closing = env.Model.DisposeAsync().AsTask();
        await Task.Delay(400);
        True(!closing.IsCompleted, "closing waits for Alice's downloads to finish stopping");
        env.Backend.ReleaseStops();
        await closing; await switching;
        await Task.Delay(400); Pump();
        True(env.Model.Files.Count == 0 && env.Model.Transfers.Count == 0, "no files or downloads shown after close");
        Equal(0, env.Model.Sections.Count);
        True(!Directory.Exists(Path.Combine(env.Backend.StateDirectory, "portal", bob)), "Bob's queue was never opened");
        True(Directory.Exists(Path.Combine(env.Backend.StateDirectory, "portal", alice)), "Alice's records kept");
        True(Locks.Free(env.Backend.StateDirectory), "no queue left locked");
        Equal(0, env.Backend.Writing);
        True(!File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "nothing promoted");
    }
}

async Task CloseWindow()
{
    // Nothing to stop: signed out (no queue), and a model that was already shut down. Each closes exactly once.
    foreach (var alreadyClosed in new[] { false, true }) {
        await using var env = Env.Create(signedIn: alreadyClosed);
        var window = env.Window();
        var closedCount = 0; window.Closed += (_, _) => closedCount++;
        await env.Model.StartAsync();
        if (alreadyClosed) { await env.Model.DisposeAsync(); await env.Model.DisposeAsync(); }
        window.Close();
        await Until(() => closedCount == 1, alreadyClosed ? "already shut down window closes" : "signed-out window closes", seconds: 10);
        await Task.Delay(300); Pump();
        Equal(1, closedCount);
        True(!window.IsVisible, "window gone");
        True(Locks.Free(env.Backend.StateDirectory), "nothing left locked");
    }

    foreach (var stuck in new[] { false, true }) {
        await using var env = Env.Create(signedIn: true, rate: 600_000);
        var window = env.Window();
        window.ShutdownLimit = stuck ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(20);
        var closedCount = 0; window.Closed += (_, _) => closedCount++;
        await env.Model.StartAsync();
        await env.OpenAsync("deliveries", "land-script");
        env.Check("ortho-full.tif");
        env.Model.DownloadSelected.Execute(null);
        await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 1), "download running");
        if (stuck) env.Backend.BlockSessions();
        window.Close();
        window.Close();
        True(closedCount == 0 && window.IsVisible, "the first close waits for the shutdown");
        await Until(() => closedCount == 1, "window closes after downloads stop", seconds: 30);
        Equal(0, env.Backend.Writing);
        var partial = Directory.EnumerateFiles(env.Downloads, "*.ltds-demo-partial", new EnumerationOptions { AttributesToSkip = 0 }).Single();
        var size = new FileInfo(partial).Length;
        await Task.Delay(600);
        Equal(size, new FileInfo(partial).Length);
        True(!File.Exists(Path.Combine(env.Downloads, "ortho-full.tif")), "nothing promoted");
        if (stuck) env.Backend.ReleaseSessions();
        await Until(() => Locks.Free(env.Backend.StateDirectory), "queue released", seconds: 30);
        Equal(1, closedCount);
        if (!stuck) {
            // The stopped download was saved as paused, not left as running.
            var saved = Directory.EnumerateFiles(env.Backend.StateDirectory, "queue.json", SearchOption.AllDirectories).Select(File.ReadAllText).Single(text => text.Contains("ortho-full.tif"));
            True(saved.Contains("\"paused\"", StringComparison.OrdinalIgnoreCase), "saved as paused");
        }
    }
}

async Task Render()
{
    Directory.CreateDirectory(screenshots);
    await using (var env = Env.Create(signedIn: false)) {
        var window = env.Window();
        await env.Model.StartAsync();
        Snap(window, Path.Combine(screenshots, "sign-in.png"));
        window.Close();
    }
    await using (var env = Env.Create(signedIn: false)) {
        var window = env.Window();
        env.Model.ShowNotSetUp("The setup file on this PC is damaged or incomplete. Reinstall Ledge Top Files or ask your Ledge Top contact to check it.");
        Snap(window, Path.Combine(screenshots, "setup-problem.png"));
        window.Close();
    }
    await using (var env = Env.Create(signedIn: true, rate: 1_500_000, pageSize: 3)) {
        var window = env.Window();
        Directory.CreateDirectory(env.Downloads);
        await File.WriteAllTextAsync(Path.Combine(env.Downloads, "inspection.pdf"), "already here");
        await env.Model.StartAsync();
        await env.OpenAsync("deliveries", "land-script");
        env.Check("PIN-20261020113.kml"); env.Check("ortho-full.tif");
        env.Model.DownloadSelected.Execute(null);
        await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running && row.Percent > 20), "visible progress", seconds: 60);
        Snap(window, Path.Combine(screenshots, "files.png"));
        window.Close();
    }
    foreach (var name in new[] { "sign-in.png", "setup-problem.png", "files.png" }) {
        var info = new FileInfo(Path.Combine(screenshots, name));
        True(info.Exists && info.Length > 10_000, name + " rendered");
        using var stream = info.OpenRead();
        var frame = BitmapDecoder.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad).Frames[0];
        True(frame.PixelWidth >= 1000 && frame.PixelHeight >= 600, name + " full size");
    }
    Console.WriteLine("Screenshots: " + screenshots);
}

// ---------------------------------------------------------------------------------------------

async Task<(DemoBackend Backend, QueueHost Host, string Root, string Downloads, Func<string, Task<string>> Reference)> HostFixture(double rate = 40_000_000)
{
    var root = Path.Combine(Path.GetTempPath(), "ltfiles-host-" + Guid.NewGuid().ToString("N"));
    var downloads = Path.Combine(root, "Downloads"); Directory.CreateDirectory(downloads);
    var backend = new DemoBackend(Path.Combine(root, "queue"), signedIn: true, bytesPerSecond: rate);
    var deliveries = (await backend.Catalog.GetSectionsAsync()).Single(node => node.Key == "deliveries");
    var land = (await backend.Catalog.GetChildrenAsync(deliveries)).Nodes.Single(node => node.Key == "land-script");
    var files = (await backend.Catalog.ListAsync(land)).Files;
    async Task<string> Reference(string name) => await backend.Catalog.GetReferenceAsync(files.Single(file => file.Name == name));
    return (backend, await QueueHost.OpenAsync(backend.StateDirectory, backend.Sources), root, downloads, Reference);
}
static int SavedStates(string stateDirectory, string state) =>
    Directory.EnumerateFiles(stateDirectory, "queue.json", SearchOption.AllDirectories)
        .Sum(file => System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(file), "\"state\":\"" + state + "\"", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count);

async Task HostileNames()
{
    var (backend, host, root, downloads, reference) = await HostFixture();
    try {
        var report = await reference("report.pdf");
        var probed = new List<string>();
        // Fully synthetic observer: it records every probe and only ever touches the test's own downloads folder,
        // so even a regression that leaks a rooted or UNC name never reaches that path or the network.
        var owned = Path.TrimEndingDirectorySeparator(downloads) + Path.DirectorySeparatorChar;
        host.Hooks.Exists = path => {
            probed.Add(path);
            return path.StartsWith(owned, StringComparison.OrdinalIgnoreCase) && !path[owned.Length..].Contains(Path.DirectorySeparatorChar)
                && (File.Exists(path) || Directory.Exists(path));
        };
        var checks = backend.SourceChecks;
        foreach (var name in new[] { @"\attacker.example\share\report.pdf", @"\?\C:\Windows\win.ini",
            @"\\attacker.example\share\report.pdf", @"\\?\C:\Windows\win.ini", @"\\?\UNC\attacker.example\share\report.pdf", @"\\.\pipe\report", @"\\.\C:",
            "//attacker.example/share/report.pdf", @"C:\Windows\win.ini", @"C:report.pdf",
            @"..\outside.pdf", "sub/report.pdf", @"sub\report.pdf", "report.pdf:stream", "CON", "lpt1.txt", "COM¹.dat", "aux .txt",
            "invoice\u202Efdp.exe", "zero\u200Bwidth.pdf", "line\u2028break.pdf", "bad\0name.pdf", "bad\uD800name.pdf", "trailing.", "trailing ", "", ".", "..",
            new string('a', 151) }) {
            Equal(EnqueueOutcome.UnsafeName, await host.EnqueueAsync("portal", report, name, downloads));
        }
        Equal(0, probed.Count);
        Equal(checks, backend.SourceChecks);
        Equal(0, (await host.SnapshotAsync()).Count);
        // A plain name keeps the friendly overwrite refusal, probing exactly that name inside the chosen folder.
        await File.WriteAllTextAsync(Path.Combine(downloads, "report.pdf"), "keep me");
        Equal(EnqueueOutcome.NameTaken, await host.EnqueueAsync("portal", report, "report.pdf", downloads));
        Equal(Path.Combine(downloads, "report.pdf"), probed.Single());
        Equal("keep me", await File.ReadAllTextAsync(Path.Combine(downloads, "report.pdf")));
        foreach (var name in new[] { "café.pdf", "cafe\u0301.pdf", "測量図.pdf", "property-\U0001F3E1.pdf", "PIN-20261020113.kml", "a.b.c" })
            True(QueueHost.IsPlainFileName(name), name + " is a plain name");
    } finally { await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task PauseAllSavedBeforeClose()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    try {
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("ortho-full.tif"), "ortho-full.tif", downloads));
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
        await Until(() => host.IsBusy && backend.Writing == 1, "first download running");
        await host.SnapshotAsync();
        host.Hooks.BeforeHeldPersist = () => gate.Task;
        await host.PauseAllAsync();
        var closing = host.DisposeAsync().AsTask();
        await Task.Delay(400);
        True(!closing.IsCompleted, "closing waits while the held item is still being saved");
        gate.SetResult();
        await closing.WaitAsync(TimeSpan.FromSeconds(30));
        Equal(2, SavedStates(backend.StateDirectory, "paused"));
        Equal(0, SavedStates(backend.StateDirectory, "queued"));
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task PauseAllStoppingBeforeClose()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    try {
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("ortho-full.tif"), "ortho-full.tif", downloads));
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
        await Until(() => host.IsBusy && backend.Writing == 1, "first download running");
        await host.SnapshotAsync();
        // Pause all has taken its list but not yet stopped the running download or scheduled its save.
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.Hooks.BeforeRunningPause = () => { reached.TrySetResult(); return gate.Task; };
        var pausing = host.PauseAllAsync();
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var first = host.DisposeAsync().AsTask(); var second = host.DisposeAsync().AsTask();
        await Task.Delay(400);
        True(!first.IsCompleted && !second.IsCompleted, "every closer waits while pause all is still stopping");
        gate.SetResult();
        await Task.WhenAll(pausing, first, second).WaitAsync(TimeSpan.FromSeconds(30));
        Equal(2, SavedStates(backend.StateDirectory, "paused"));
        Equal(0, SavedStates(backend.StateDirectory, "queued"));
        // After closing, Pause all is a no-op rather than a late save against released queues.
        await host.PauseAllAsync();
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task<(DemoBackend Backend, QueueHost Host, string Root, string Downloads, TaskCompletionSource Gate, Task SaveSettled)> PausedWithLateSave()
{
    // Ortho is running and report waits; Pause all stops ortho and holds report, with its save gated.
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("ortho-full.tif"), "ortho-full.tif", downloads));
    Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
    await Until(() => host.IsBusy && backend.Writing == 1, "ortho running");
    await host.SnapshotAsync();
    host.Hooks.BeforeHeldPersist = () => gate.Task;
    var settled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    host.Hooks.HeldSaveSettled = () => settled.TrySetResult();
    await host.PauseAllAsync();
    await Until(() => !host.IsBusy && backend.Writing == 0, "ortho stopped");
    return (backend, host, root, downloads, gate, settled.Task);
}
static QueuedTransferState StateOf(IReadOnlyList<TransferItem> items, string name) => items.Single(item => item.Job.FileName == name).Job.State;

async Task ResumeBeatsLatePauseSave()
{
    var (backend, host, root, _, gate, saveSettled) = await PausedWithLateSave();
    try {
        var report = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "report.pdf");
        await host.ResumeAsync(report);
        await Until(() => backend.Writing == 1, "report resumed and writing");
        gate.SetResult();
        await saveSettled.WaitAsync(TimeSpan.FromSeconds(30)); // the late save has finished acting
        var items = await host.SnapshotAsync();
        Equal(QueuedTransferState.Running, StateOf(items, "report.pdf"));
        Equal(1, backend.Writing);
        // The resume's intent was kept: report is not held and nothing was saved paused for it.
        True(!host.IsHeld(items.Single(item => item.Job.FileName == "report.pdf").Job.JobId), "report is not held");
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task ResumeAllBeatsLatePauseSave()
{
    var (backend, host, root, downloads, gate, saveSettled) = await PausedWithLateSave();
    try {
        await host.ResumeAllAsync();
        await Until(() => backend.Writing == 1, "resume all restarted ortho");
        gate.SetResult();
        await saveSettled.WaitAsync(TimeSpan.FromSeconds(30)); // the late save has finished acting
        var items = await host.SnapshotAsync();
        Equal(QueuedTransferState.Running, StateOf(items, "ortho-full.tif"));
        Equal(QueuedTransferState.Queued, StateOf(items, "report.pdf"));
        True(!host.IsHeld(items.Single(item => item.Job.FileName == "report.pdf").Job.JobId), "report is not held");
        // Resume all's intent survives: report is still waiting its turn, so when ortho stops it starts by itself.
        True(host.IsWanted(items.Single(item => item.Job.FileName == "report.pdf").Job.JobId), "report still wanted");
        await host.PauseAsync(items.Single(item => item.Job.FileName == "ortho-full.tif"));
        await Until(() => host.IsBusy && backend.Writing == 1, "report started in turn");
        Equal(QueuedTransferState.Running, StateOf(await host.SnapshotAsync(), "report.pdf"));
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task PauseAllBeatsChosenStart()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    host.Hooks.StartSettled = id => started.TrySetResult();
    try {
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var once = 0;
        host.Hooks.BeforeStart = () => Interlocked.Exchange(ref once, 1) == 0 ? Gate() : Task.CompletedTask;
        Task Gate() { reached.TrySetResult(); return gate.Task; }
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // The pump has chosen report; Pause all now holds it before it starts.
        await host.SnapshotAsync();
        await host.PauseAllAsync();
        gate.SetResult();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30)); // the older start has been decided
        Equal(0, backend.Writing);
        True(!host.IsBusy, "nothing started");
        await Until(() => SavedStates(backend.StateDirectory, "paused") == 1, "report saved paused");
        True(!File.Exists(Path.Combine(downloads, "report.pdf")), "nothing downloaded");
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task PauseAllBeatsPublishedStart()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    host.Hooks.StartSettled = id => started.TrySetResult();
    try {
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var once = 0;
        host.Hooks.AfterStartPublished = () => Interlocked.Exchange(ref once, 1) == 0 ? Gate() : Task.CompletedTask;
        Task Gate() { reached.TrySetResult(); return gate.Task; }
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        True(host.IsBusy, "the start is published as active");
        await host.SnapshotAsync();
        await host.PauseAllAsync();
        gate.SetResult();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30)); // the older start has been decided
        Equal(0, backend.Writing);
        True(!host.IsBusy, "the older start never began");
        Equal(QueuedTransferState.Paused, StateOf(await host.SnapshotAsync(), "report.pdf"));
        True(!File.Exists(Path.Combine(downloads, "report.pdf")), "nothing downloaded");
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task PauseAllBeatsPendingResume()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    try {
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
        await Until(() => backend.Writing == 1, "report running");
        var report = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "report.pdf");
        await host.PauseAsync(report);
        await Until(() => !host.IsBusy && backend.Writing == 0, "report paused");
        report = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "report.pdf");
        Equal(QueuedTransferState.Paused, report.Job.State);
        // A resume is requested but still waiting before it starts; Pause all happens meanwhile.
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var once = 0;
        host.Hooks.BeforeStart = () => Interlocked.Exchange(ref once, 1) == 0 ? Gate() : Task.CompletedTask;
        Task Gate() { reached.TrySetResult(); return gate.Task; }
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.Hooks.StartSettled = id => started.TrySetResult();
        var resuming = host.ResumeAsync(report);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await host.SnapshotAsync();
        await host.PauseAllAsync();
        gate.SetResult();
        await resuming.WaitAsync(TimeSpan.FromSeconds(10)); // superseded quietly, not reported as a failure
        await started.Task.WaitAsync(TimeSpan.FromSeconds(30)); // the older start has been decided
        Equal(0, backend.Writing);
        True(!host.IsBusy, "the older resume never began");
        Equal(QueuedTransferState.Paused, StateOf(await host.SnapshotAsync(), "report.pdf"));
        // A resume requested after Pause all is the newest intent and works.
        await host.ResumeAsync((await host.SnapshotAsync()).Single(item => item.Job.FileName == "report.pdf"));
        await Until(() => host.IsBusy && backend.Writing == 1, "a later resume starts");
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task<string> EmployeeReference(DemoBackend backend, string name)
{
    async Task<CatalogFile?> Find(CatalogNode node)
    {
        var listing = await backend.Catalog.ListAsync(node);
        if (listing.Files.FirstOrDefault(file => file.Name == name) is { } found) return found;
        foreach (var child in (await backend.Catalog.GetChildrenAsync(node)).Nodes) if (await Find(child) is { } deeper) return deeper;
        return null;
    }
    var server = (await backend.Catalog.GetSectionsAsync()).Single(node => node.SourceAlias == "employee");
    foreach (var child in (await backend.Catalog.GetChildrenAsync(server)).Nodes)
        if (await Find(child) is { } file) return await backend.Catalog.GetReferenceAsync(file);
    throw new Exception("Employee demo file not found: " + name);
}

async Task RepeatedResumeKeepsOneActive()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    try {
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("ortho-full.tif"), "ortho-full.tif", downloads));
        await Until(() => host.IsBusy && backend.Writing == 1, "ortho running");
        var ortho = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "ortho-full.tif");
        await host.ResumeAsync(ortho); // a repeated or stale Resume of what is already running
        await host.ResumeAsync(ortho);
        True(host.IsBusy, "the running download still owns the slot");
        Equal(1, backend.Writing);
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("employee", await EmployeeReference(backend, "site-plan.dwg"), "site-plan.dwg", downloads));
        await Task.Delay(300);
        Equal(1, backend.Writing);
        var site = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "site-plan.dwg");
        await host.ResumeAsync(site); // stops ortho first, then starts the other source
        // ResumeAsync returns once the site plan's start has been admitted, so read the queues right away.
        var items = await host.SnapshotAsync();
        Equal(QueuedTransferState.Running, StateOf(items, "site-plan.dwg"));
        Equal(QueuedTransferState.Paused, StateOf(items, "ortho-full.tif"));
        Equal(1, backend.MostAtOnce);
    } finally { await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task StaleIdleKeepsOneActive()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    try {
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("ortho-full.tif"), "ortho-full.tif", downloads));
        await Until(() => host.IsBusy && backend.Writing == 1, "ortho running");
        // The first start's finish callback is held back until after a newer start of the same item.
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var once = 0;
        host.Hooks.BeforeIdleRelease = () => Interlocked.Exchange(ref once, 1) == 0 ? Held() : Task.CompletedTask;
        Task Held() { reached.TrySetResult(); return gate.Task; }
        var ortho = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "ortho-full.tif");
        await host.PauseAsync(ortho);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await host.ResumeAsync((await host.SnapshotAsync()).Single(item => item.Job.FileName == "ortho-full.tif"));
        await Until(() => host.IsBusy && backend.Writing == 1, "ortho resumed");
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.Changed += () => released.TrySetResult();
        gate.SetResult();
        await released.Task.WaitAsync(TimeSpan.FromSeconds(10)); // the old callback has run its release
        True(host.IsBusy, "the newer start still owns the slot");
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("employee", await EmployeeReference(backend, "site-plan.dwg"), "site-plan.dwg", downloads));
        var site = (await host.SnapshotAsync()).Single(item => item.Job.FileName == "site-plan.dwg");
        await host.ResumeAsync(site);
        var items = await host.SnapshotAsync();
        Equal(QueuedTransferState.Running, StateOf(items, "site-plan.dwg"));
        Equal(QueuedTransferState.Paused, StateOf(items, "ortho-full.tif"));
        Equal(1, backend.MostAtOnce);
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task ThrowingSaveObserverStillCloses()
{
    var (backend, host, root, downloads, reference) = await HostFixture(rate: 300_000);
    try {
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("ortho-full.tif"), "ortho-full.tif", downloads));
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", await reference("report.pdf"), "report.pdf", downloads));
        await Until(() => host.IsBusy && backend.Writing == 1, "ortho running");
        await host.SnapshotAsync();
        host.Hooks.HeldSaveSettled = () => throw new InvalidOperationException("observer failure");
        await host.PauseAllAsync();
        await host.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(30));
        Equal(2, SavedStates(backend.StateDirectory, "paused"));
    } finally { await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task NoStartAfterClose()
{
    var (backend, host, root, downloads, reference) = await HostFixture();
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    try {
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        host.Hooks.AfterSnapshot = () => { reached.TrySetResult(); return gate.Task; };
        var starts = 0; host.Hooks.Starting = _ => Interlocked.Increment(ref starts);
        var report = await reference("report.pdf");
        Equal(EnqueueOutcome.Added, await host.EnqueueAsync("portal", report, "report.pdf", downloads));
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await host.DisposeAsync();
        var checks = backend.SourceChecks;
        gate.SetResult();
        await Task.Delay(500);
        Equal(0, Volatile.Read(ref starts));
        Equal(checks, backend.SourceChecks);
        Equal(0, backend.Writing);
        Equal(1, SavedStates(backend.StateDirectory, "queued"));
        True(!File.Exists(Path.Combine(downloads, "report.pdf")), "nothing downloaded after closing");
    } finally { gate.TrySetResult(); await host.DisposeAsync(); try { Directory.Delete(root, true); } catch (IOException) { } }
}

async Task BackendReleased()
{
    await using var env = Env.Create(signedIn: true, rate: 600_000);
    await env.Model.StartAsync();
    await env.OpenAsync("deliveries", "land-script");
    env.Check("ortho-full.tif");
    env.Model.DownloadSelected.Execute(null);
    await Until(() => env.Model.Transfers.Any(row => row.State == QueuedTransferState.Running), "download running");
    Equal(0, env.Backend.Disposals);
    await env.Model.DisposeAsync();
    Equal(1, env.Backend.Disposals);
    Equal(0, env.Backend.Writing);
    True(Locks.Free(env.Backend.StateDirectory), "queues released before the backend");
    await env.Model.DisposeAsync();
    Equal(1, env.Backend.Disposals);
}

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

    public static Env Create(bool signedIn, double rate = 40_000_000, Func<DateTimeOffset>? clock = null, int pageSize = 200)
    {
        var root = Path.Combine(Path.GetTempPath(), "ltfiles-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return new Env(root, new DemoBackend(Path.Combine(root, "queue"), signedIn, bytesPerSecond: rate, pageSize: pageSize), clock);
    }

    /// <summary>Attaches the real window so rendering uses the production XAML.</summary>
    public MainWindow Window()
    {
        window = new MainWindow { Width = 1180, Height = 780, ShowInTaskbar = false, WindowStartupLocation = WindowStartupLocation.Manual, Left = -20000, Top = -20000 };
        Model = new MainViewModel(Backend, window, Downloads);
        window.Attach(Model, "Demo data");
        window.Show();
        return window;
    }

    public async Task OpenAsync(string section, string folder)
    {
        var node = Model.Sections.Single(item => item.Node.Key == section);
        node.IsExpanded = true;
        await Wait.Until(() => node.Children.Any(child => child.Node.Key == folder), "folder listed");
        await Task.Delay(50);
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

static class Locks
{
    /// <summary>True when no queue under the folder is still held open by this process.</summary>
    public static bool Free(string root)
    {
        if (!Directory.Exists(root)) return true;
        foreach (var file in Directory.EnumerateFiles(root, ".queue.lock", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })) {
            try { using var held = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { return false; }
        }
        return true;
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
