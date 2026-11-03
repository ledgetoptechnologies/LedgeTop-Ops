#if LEDGETOP_CACHE_RACE_TEST
using System.Text;

namespace LedgeTop.WindowsDownload;

// Synthetic experiment: existing markers only. No production coordinator uses this.
// The caller must hold a live root admission lease while using this object.
internal sealed class ExperimentalRootMarkerOwner : IDisposable
{
    private sealed record Marker(string Path, FileStream File, ExperimentalOwnedStream.Identity Id, byte[] Expected, List<ExperimentalOwnedStream.DirectoryPin> Pins);
    private readonly object gate = new();
    private readonly string root;
    private readonly Dictionary<string, Marker> markers = new(StringComparer.OrdinalIgnoreCase);
    private bool disposed;
    internal static Action? BeforeCloseTestHook;
    internal bool InjectedCloseFailure { get; private set; }
    internal ExperimentalRootMarkerOwner(string root) { this.root = Path.GetFullPath(root); }
    internal void ValidateExisting(string directory, string markerName, byte[] expected)
    {
        lock (gate) {
            ObjectDisposedException.ThrowIf(disposed, this);
            var dir = Path.GetFullPath(directory);
            if ((!dir.Equals(root, StringComparison.OrdinalIgnoreCase) && !dir.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) ||
                markerName != ".verified-hydration-owner" || expected.Length is 0 or > 128)
                throw new IOException("Experimental marker scope invalid.");
            var path = Path.Combine(dir, markerName);
            if (!markers.TryGetValue(path, out var marker)) {
                var pins = new List<ExperimentalOwnedStream.DirectoryPin>(); FileStream? file = null;
                try {
                    ExperimentalOwnedStream.PinDirectories(dir, pins);
                    ExperimentalOwnedStream.VerifyPins(pins);
                    var handle = ExperimentalOwnedStream.Open(path, 0x80000080, 1, 3, 0x00200000);
                    try { file = new FileStream(handle, FileAccess.Read); } catch { handle.Dispose(); throw; }
                    ExperimentalOwnedStream.RequireRegularKind(file.SafeFileHandle, directory: false);
                    ExperimentalOwnedStream.RequireSingleLink(file.SafeFileHandle);
                    marker = new(path, file, ExperimentalOwnedStream.GetIdentity(file.SafeFileHandle), expected.ToArray(), pins);
                    Verify(marker);
                    markers.Add(path, marker); file = null; pins = [];
                } finally { file?.Dispose(); foreach (var pin in pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); }
            } else {
                if (!marker.Expected.AsSpan().SequenceEqual(expected)) throw new IOException("Experimental marker expectation changed.");
                Verify(marker);
            }
        }
    }
    private static void Verify(Marker marker)
    {
        ExperimentalOwnedStream.VerifyPins(marker.Pins);
        if (ExperimentalOwnedStream.GetIdentity(marker.File.SafeFileHandle) != marker.Id ||
            !string.Equals(ExperimentalOwnedStream.FinalPath(marker.File.SafeFileHandle), marker.Path, StringComparison.OrdinalIgnoreCase) ||
            marker.File.Length != marker.Expected.Length) throw new IOException("Experimental marker binding changed.");
        marker.File.Position = 0; var bytes = new byte[marker.Expected.Length]; marker.File.ReadExactly(bytes);
        if (!bytes.AsSpan().SequenceEqual(marker.Expected)) throw new IOException("Experimental marker contents changed.");
    }
    public void Dispose()
    {
        lock (gate) {
            if (disposed) return;
            try { BeforeCloseTestHook?.Invoke(); } catch { InjectedCloseFailure = true; throw; }
            InjectedCloseFailure = false; disposed = true;
            foreach (var marker in markers.Values) { marker.File.Dispose(); foreach (var pin in marker.Pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); }
            markers.Clear();
        }
    }
}
#endif
