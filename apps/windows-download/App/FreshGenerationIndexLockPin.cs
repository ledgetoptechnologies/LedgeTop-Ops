using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files;

// A same-handle observation only. This does not qualify ancestor replacement or
// selector publication against an uncooperative process.
internal sealed class FreshGenerationIndexLockPin
{
    private readonly FileStream? stream;
    private readonly SelectorIndexOwnership? owner;
    private readonly string path;
    private readonly uint volume, high, low;
    internal FreshGenerationIndexLockPin(FileStream stream, string path)
    {
        this.stream = stream; this.path = Path.GetFullPath(path);
        var info = Observe(); volume = info.Volume; high = info.IndexHigh; low = info.IndexLow;
    }
    internal FreshGenerationIndexLockPin(SelectorIndexOwnership owner, string path)
    {
        this.owner = owner; this.path = Path.GetFullPath(path);
        if (!owner.MatchesPath(this.path)) throw new IOException("Index lock owner path differs.");
        owner.VerifyHeld();
    }
    internal bool StillHeld(SelectorIndexOwnership? candidate) => ReferenceEquals(owner, candidate) && owner is not null && owner.IsHeld;
    internal bool StillHeld(FileStream? candidate)
    {
        if (!ReferenceEquals(stream, candidate)) return false;
        try { var info = Observe(); return info.Volume == volume && info.IndexHigh == high && info.IndexLow == low; }
        catch (IOException) { return false; }
        catch (ObjectDisposedException) { return false; }
    }
    private HandleInfo Observe()
    {
        var handle = (stream ?? throw new IOException("Index lock stream is unavailable.")).SafeFileHandle;
        if (handle.IsClosed || handle.IsInvalid || GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out var info) ||
            (info.Attributes & (0x400 | 0x10)) != 0 || info.Links != 1 || (info.IndexHigh == 0 && info.IndexLow == 0))
            throw new IOException("Index lock ownership could not be confirmed.");
        var final = new StringBuilder(32768);
        var size = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        if (size is 0 or >= 32768 || !string.Equals(final.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Index lock path changed.");
        return info;
    }
    [StructLayout(LayoutKind.Sequential)] private struct HandleInfo
    { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, High, Low, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll")] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}
