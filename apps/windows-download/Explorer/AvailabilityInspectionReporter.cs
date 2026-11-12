using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

// Called by the single frozen-manifest scanner. Remember only paths already in
// that bounded manifest, and report one message until every failure recovers.
internal sealed class AvailabilityInspectionReporter
{
    private readonly HashSet<string> failing = new(StringComparer.OrdinalIgnoreCase);

    internal void Inspect(string relative, Action inspect, Action<string> notice, CancellationToken stopping)
    {
        try {
            inspect();
            failing.Remove(relative);
        } catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or TransferException) {
            var first = failing.Count == 0;
            failing.Add(relative);
            if (first) {
                var diagnostic = LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect, error);
                notice("Could not check local availability. The app will try again automatically; if this continues, contact LedgeTop support. Support code: availability/" + diagnostic.Stage + "/" + diagnostic.Kind);
            }
        }
    }
}
