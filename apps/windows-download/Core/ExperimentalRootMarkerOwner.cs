#if LEDGETOP_CACHE_RACE_TEST
using System.Text;

namespace LedgeTop.WindowsDownload;

// Synthetic experiment only. No production coordinator uses this.
// The caller must hold a live root admission lease while using this object.
internal sealed class ExperimentalRootMarkerOwner : IDisposable
{
    private sealed record Marker(string Path, FileStream File, ExperimentalOwnedStream.Identity Id, byte[] Expected, List<ExperimentalOwnedStream.DirectoryPin> Pins);
    private readonly object gate = new();
    private readonly string root;
    private readonly Dictionary<string, Marker> markers = new(StringComparer.OrdinalIgnoreCase);
    private bool disposed;
    internal static Action? BeforeCloseTestHook, AfterCreateTestHook;
    private FileStream? uncertainFile;
    private Microsoft.Win32.SafeHandles.SafeFileHandle? uncertainHandle;
    private List<ExperimentalOwnedStream.DirectoryPin>? uncertainPins;
    private ExperimentalOwnedStream.Identity uncertainId;
    private bool uncertain, injectedCreateFailure;
    internal bool InjectedCloseFailure { get; private set; }
    internal ExperimentalRootMarkerOwner(string root) { this.root = Path.GetFullPath(root); }
    internal void ValidateExisting(string directory, string markerName, byte[] expected)
    {
        lock (gate) {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (uncertain) throw new IOException("Experimental marker creation is uncertain.");
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
    internal long AccountMarker(string path)
    {
        var full = Path.GetFullPath(path);
        if (Path.GetFileName(full) != ".verified-hydration-owner") throw new IOException("Experimental marker name invalid.");
        var directory = Path.GetDirectoryName(full) ?? throw new IOException("Experimental marker directory invalid.");
        var expected = System.Text.Encoding.UTF8.GetBytes("LedgeTop.VerifiedHydration/1\n");
        ValidateExisting(directory, ".verified-hydration-owner", expected);
        return expected.Length;
    }
    internal void CreateNew(string directory)
    {
        lock (gate) {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (uncertain) throw new IOException("Experimental marker creation is uncertain.");
            var dir = Path.GetFullPath(directory);
            if (!dir.Equals(root, StringComparison.OrdinalIgnoreCase) && !dir.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental marker scope invalid.");
            var path = Path.Combine(dir, ".verified-hydration-owner");
            if (markers.ContainsKey(path)) throw new IOException("Experimental marker already owned.");
            var pins = new List<ExperimentalOwnedStream.DirectoryPin>();
            try {
                ExperimentalOwnedStream.PinDirectories(dir, pins); ExperimentalOwnedStream.VerifyPins(pins);
                var handle = ExperimentalOwnedStream.Open(path, 0xC0000080, 1, 1, 0x00200000);
                uncertainHandle = handle; uncertainPins = pins; pins = []; uncertain = true;
                uncertainFile = new FileStream(handle, FileAccess.ReadWrite); uncertainHandle = null;
                ExperimentalOwnedStream.RequireRegularKind(uncertainFile.SafeFileHandle, directory: false);
                ExperimentalOwnedStream.RequireSingleLink(uncertainFile.SafeFileHandle);
                uncertainId = ExperimentalOwnedStream.GetIdentity(uncertainFile.SafeFileHandle);
                try { AfterCreateTestHook?.Invoke(); } catch { injectedCreateFailure = true; throw; }
                var expected = System.Text.Encoding.UTF8.GetBytes("LedgeTop.VerifiedHydration/1\n");
                uncertainFile.Write(expected); uncertainFile.Flush(true);
                var marker = new Marker(path, uncertainFile, uncertainId, expected, uncertainPins);
                Verify(marker); markers.Add(path, marker);
                uncertainFile = null; uncertainPins = null; uncertain = false;
            } finally { foreach (var pin in pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); }
        }
    }
    internal void SettleInjectedCreateFailureForTest()
    {
        lock (gate) {
            if (!uncertain || !injectedCreateFailure || AfterCreateTestHook is not null || uncertainFile is null || uncertainPins is null ||
                uncertainFile.Length != 0 || ExperimentalOwnedStream.GetIdentity(uncertainFile.SafeFileHandle) != uncertainId)
                throw new IOException("Experimental creation cannot be settled.");
            ExperimentalOwnedStream.VerifyPins(uncertainPins);
            uncertainFile.Dispose(); foreach (var pin in uncertainPins.AsEnumerable().Reverse()) pin.Handle.Dispose();
            uncertainFile = null; uncertainPins = null; uncertain = false; injectedCreateFailure = false;
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
            if (uncertain) throw new IOException("Experimental marker creation remains uncertain.");
            try { BeforeCloseTestHook?.Invoke(); } catch { InjectedCloseFailure = true; throw; }
            InjectedCloseFailure = false; disposed = true;
            foreach (var marker in markers.Values) { marker.File.Dispose(); foreach (var pin in marker.Pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); }
            markers.Clear();
        }
    }
}
#endif
