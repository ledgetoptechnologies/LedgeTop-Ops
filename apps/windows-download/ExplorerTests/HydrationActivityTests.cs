using LedgeTop.Files.Explorer;

internal static class HydrationActivityTests
{
    internal static async Task<int> RunAsync()
    {
        var notices = new List<string>();
        var pending = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var tracked = HydrationActivity.TrackFetchAsync("photo.jpg", () => pending.Task, notices.Add);
        if (!notices.SequenceEqual(new[] { "Downloading photo.jpg" })) throw new IOException("Fetch was reported complete before it finished.");
        pending.SetResult(); await tracked;
        if (!notices.SequenceEqual(new[] { "Downloading photo.jpg", "Downloaded data for: photo.jpg" }))
            throw new IOException("Fetch activity did not report its completed data accurately.");
        notices.Clear();
        try { await HydrationActivity.TrackFetchAsync("photo.jpg", () => Task.FromException(new IOException("synthetic")), notices.Add); throw new InvalidOperationException("Fetch failure was suppressed."); }
        catch (IOException) { }
        if (!notices.SequenceEqual(new[] { "Downloading photo.jpg" })) throw new IOException("Failed fetch was reported complete.");
        Console.WriteLine("PASS fetch activity waits for completion and never claims whole-file availability."); return 0;
    }
}
