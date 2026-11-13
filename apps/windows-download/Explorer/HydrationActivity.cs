namespace LedgeTop.Files.Explorer;

internal static class HydrationActivity
{
    // FETCH_DATA may request only a portion of a file. A completed callback does
    // not establish that the entire file is available without a connection.
    internal static async Task TrackFetchAsync(string name, Func<Task> fetch, Action<string> notice)
    {
        notice("Downloading " + name);
        await fetch().ConfigureAwait(false);
        notice("Downloaded data for: " + name);
    }
}
