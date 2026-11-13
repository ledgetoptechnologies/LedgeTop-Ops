using LedgeTop.Files.Updates;

// Invoke only in a staging-qualified test image. Invalid inputs ensure that a
// different failure would reveal the guard did not run before other work.
internal static class StagingUpdateGuardTests
{
    internal static async Task RunAsync()
    {
        var platform = new ExeUpdateWindowsPlatform("invalid", "invalid", () => throw new Exception("drain called"),
            () => throw new Exception("reconnect called"), _ => throw new Exception("exit called"));
        await Refuses(() => ExeUpdateWindowsPlatform.CheckAvailableAsync(null!, CancellationToken.None));
        await Refuses(async () => { _ = await platform.TryEnterMaintenanceAsync(CancellationToken.None); });
        await Refuses(async () => { _ = await platform.PrepareFreshAsync(CancellationToken.None); });
    }
    private static async Task Refuses(Func<Task> action)
    {
        try { await action(); throw new Exception("Staging update was not refused."); }
        catch (IOException error) when (error.Message == "Updates are unavailable in this staging build.") { }
    }
}
