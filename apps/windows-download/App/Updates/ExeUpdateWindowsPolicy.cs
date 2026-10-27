using System.Text.RegularExpressions;

namespace LedgeTop.Files.Updates;

internal sealed record ExeUpdateInstallerAnchor(string PayloadManifestSha256, string SourceCommit)
{
    internal static ExeUpdateInstallerAnchor Parse(string? comments)
    {
        var match = Regex.Match(comments ?? "", @"\ALedgeTop\.Files\.Payload/1:([a-f0-9]{64}):([a-f0-9]{40})\z");
        if (!match.Success) throw new IOException("Update installer anchor refused.");
        return new(match.Groups[1].Value, match.Groups[2].Value);
    }
}

internal sealed record ExeUpdateProcessObservation(int ProcessId, long StartTimeUtcTicks, string Sid, int SessionId, string ImagePath);
internal static class ExeUpdateWindowsPolicy
{
    // Match the installer's AtLeastWin11 admission. The SDK reference target22621 is not a
    // runtime requirement for these Win32 process/pipe/event/registry/file updater operations.
    internal const int MinimumWindowsBuild = 22000;
    private static readonly Version minimumWindows = new(10, 0, MinimumWindowsBuild);
    internal static bool SupportedHost(bool isWindows, Version? version, bool is64BitProcess) =>
        isWindows && is64BitProcess && version is not null && version >= minimumWindows;

    // Observations must come from retained OS handles, not IPC declarations. This pure comparison is
    // shared by the real adapter and offline tests; only native acceptance can prove API observations.
    internal static bool SamePeer(ExeUpdateProcessObservation observed, ExeUpdateParentIdentity expected, ExeUpdateInstalledOwner owner) =>
        observed.ProcessId == expected.ProcessId && observed.StartTimeUtcTicks == expected.StartTimeUtcTicks &&
        observed.Sid == owner.WindowsSid && observed.SessionId == owner.SessionId &&
        string.Equals(observed.ImagePath, Path.Combine(owner.InstallRoot, "LedgeTop.Files.exe"), StringComparison.OrdinalIgnoreCase);
}

internal static class ExeUpdateExitCommit
{
    internal static async Task<ExeUpdateParentExitDecision> InvokeAsync(ExeUpdateExitHook hook, Func<Task> arm,
        Func<Task> finalCommit, Func<Task> disarmAndWait)
    {
        var attempted = false; var acknowledged = false;
        try {
            await arm().ConfigureAwait(false);
            var decision = await hook(async () => {
                if (attempted) throw new IOException("Final update exit intent is one-shot.");
                attempted = true;
                await finalCommit().ConfigureAwait(false);
                acknowledged = true;
            }).ConfigureAwait(false);
            if (acknowledged) return decision == ExeUpdateParentExitDecision.Accepted ? decision : ExeUpdateParentExitDecision.Uncertain;
            if (decision == ExeUpdateParentExitDecision.Uncertain) return decision;
            await disarmAndWait().ConfigureAwait(false);
            return ExeUpdateParentExitDecision.Rejected;
        } catch {
            if (acknowledged) return ExeUpdateParentExitDecision.Uncertain;
            try { await disarmAndWait().ConfigureAwait(false); return ExeUpdateParentExitDecision.Rejected; }
            catch { return ExeUpdateParentExitDecision.Uncertain; }
        }
    }
}

internal interface IExeUpdateInstallerProcess
{
    Task<bool> WaitAsync(TimeSpan timeout);
    // Must not return or fault while termination is unknown; retain the actual kernel handle/owner.
    Task WaitUntilConfirmedExitAsync();
    uint ExitCode { get; }
}
internal static class ExeUpdateInstallerWait
{
    internal static async Task<ExeUpdateInstallResult> ObserveAsync(IExeUpdateInstallerProcess process)
    {
        bool ended;
        try { ended = await process.WaitAsync(TimeSpan.FromMinutes(10)).ConfigureAwait(false); }
        catch { ended = false; }
        if (!ended) {
            // Caller still owns real process handle + gate for this entire join. No cancellation,
            // helper exit, recovery, second install or reclassification of late code0 as success.
            await process.WaitUntilConfirmedExitAsync().ConfigureAwait(false);
            return ExeUpdateInstallResult.Uncertain;
        }
        try { return process.ExitCode == 0 ? ExeUpdateInstallResult.Succeeded : ExeUpdateInstallResult.Failed; }
        catch { return ExeUpdateInstallResult.Uncertain; }
    }
}
