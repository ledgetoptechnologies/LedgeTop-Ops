#if LEDGETOP_VELOPACK_SPIKE
using Velopack;
using Velopack.Sources;

namespace LedgeTop.Files;

/// <summary>
/// LOCAL-ONLY Velopack spike (off by default; -p:LedgeTopVelopackSpike=true). Not a release updater.
/// Shows where Velopack would take over packaging/delta/apply and where the existing WinVerifyTrust
/// publisher/EKU pin must stay. Packaged builds refuse this define (see the csproj).
/// </summary>
internal static class VelopackSpike
{
    /// <summary>Velopack requires its hooks to run first in Main, before WPF starts.</summary>
    [STAThread]
    public static void Main(string[] args)
    {
        VelopackApp.Build()
            // Install/uninstall hooks run with no UI and a 30 s budget; the process is killed if it overruns.
            // A real port would unregister this user's sync root here via the existing ownership-checked removal.
            // The spike deliberately does NOT perform any destructive unregister.
            .OnBeforeUninstallFastCallback(version => SpikeLog("before-uninstall " + version))
            .OnAfterInstallFastCallback(version => SpikeLog("after-install " + version))
            .OnAfterUpdateFastCallback(version => SpikeLog("after-update " + version))
            .Run();
        var app = new App();
        app.InitializeComponent();
        app.Run();
    }

    private static void SpikeLog(string message)
    {
        try {
            var dir = Path.Combine(Path.GetTempPath(), "ledgetop-velopack-spike");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "hooks.log"), DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine);
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// <summary>
    /// Where an update check would sit. A local folder feed only (no R2, no Access, no publication).
    /// The existing publisher pin is applied to the downloaded package BEFORE ApplyUpdatesAndRestart, because
    /// Velopack itself only verifies the feed's SHA-256 (no Authenticode/publisher check on Windows).
    /// </summary>
    internal static async Task<string> CheckLocalFeedAsync(string folder, Func<string, bool> publisherPinAccepts, CancellationToken token)
    {
        var manager = new UpdateManager(new SimpleFileSource(new DirectoryInfo(folder)),
            new UpdateOptions { AllowVersionDowngrade = false });
        if (!manager.IsInstalled) return "not-installed: Velopack updates only apply to a Velopack-installed app";
        var update = await manager.CheckForUpdatesAsync().ConfigureAwait(false);
        if (update is null) return "up-to-date";
        await manager.DownloadUpdatesAsync(update, cancelToken: token).ConfigureAwait(false);
        // Velopack stages the downloaded full package under its packages directory; the pin must open and verify
        // the main executable inside it (WinVerifyTrust + CN + profile EKU) before applying. A spike stub only:
        var staged = Path.Combine(manager.AppId is null ? "" : Path.GetDirectoryName(Environment.ProcessPath) ?? "", "..", "packages", update.TargetFullRelease.FileName);
        if (!publisherPinAccepts(Path.GetFullPath(staged))) return "refused: publisher pin rejected the staged package";
        return "verified-not-applied: spike never calls ApplyUpdatesAndRestart";
    }
}
#endif
