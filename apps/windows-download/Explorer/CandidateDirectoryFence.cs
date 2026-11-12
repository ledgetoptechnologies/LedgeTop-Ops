using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Explorer;

// Candidate-only directory handles, retained until session disposal. LIST_DIRECTORY is
// deliberately requested; an attribute-only handle did not block a rename in one generated
// NTFS control. The held handle pins identity, not arbitrary metadata or reparse immutability.
internal sealed class CandidateDirectoryFence : IDisposable
{
    internal readonly record struct DirectoryIdentity(uint Volume, ulong FileId);
    private readonly List<SafeFileHandle> handles = [];
    private readonly Dictionary<string, SafeFileHandle> held = new(StringComparer.OrdinalIgnoreCase);
    internal void HoldAncestors(string leaf)
    {
        var parents = new Stack<string>();
        for (string? path = leaf; path is not null; path = Path.GetDirectoryName(path)) parents.Push(path);
        while (parents.TryPop(out var path)) {
            if (held.ContainsKey(path)) continue;
            var handle = CreateFileW(path, 0x81, 3, 0, 3, 0x02200000, 0);
            try { _ = Identify(handle, path); held.Add(path, handle); handles.Add(handle); }
            catch { handle.Dispose(); throw; }
        }
    }
    // The parent was already retained and validated. NtCreateFile returns the actual created
    // directory handle atomically, eliminating CreateDirectoryW's create/open substitution gap.
    internal DirectoryIdentity CreateExclusiveDirectory(string path)
    {
        var parentPath = Path.GetDirectoryName(path) ?? throw new IOException("Candidate parent missing.");
        var leaf = Path.GetFileName(path);
        if (!held.TryGetValue(parentPath, out var parent) || string.IsNullOrEmpty(leaf) || leaf is "." or ".." ||
            leaf.Contains('\\') || leaf.Contains('/')) throw new IOException("Candidate parent is not retained.");
        var parentId = Identify(parent, parentPath);
        var opened = OpenNative(@"\??\" + parentPath, 0, 0x00100085, 1);
        using var nativeParent = opened.Handle;
        if (opened.Status != 0 || opened.Information != 1 || Identify(nativeParent, parentPath) != parentId)
            throw new IOException("Candidate parent native identity differs.");
        var created = OpenNative(leaf, nativeParent.DangerousGetHandle(), 0x00100081, 2);
        var child = created.Handle;
        try {
            if (created.Status != 0 || created.Information != 2) throw new IOException("Candidate directory is not newly owned.");
            var childId = Identify(child, path);
            if (childId.Volume != parentId.Volume || Identify(parent, parentPath) != parentId)
                throw new IOException("Candidate directory volume or parent differs.");
            held.Add(path, child); handles.Add(child); return childId;
        } catch { child?.Dispose(); throw; }
    }
    internal DirectoryIdentity Recheck(string path)
    {
        if (!held.TryGetValue(path, out var handle)) throw new IOException("Candidate directory is not retained.");
        return Identify(handle, path);
    }
    // Momentary, no-follow file identity observation. The caller must additionally
    // hold the parent/session fences; this is not a compare-and-swap.
    internal static DirectoryIdentity ObserveFile(string path)
    {
        using var handle = CreateFileW(path, 0x80000000, 7, 0, 3, 0x00200000, 0);
        return IdentifyFile(handle, path);
    }
    // Identify the same held handle used for I/O, rather than a second path lookup.
    internal static DirectoryIdentity IdentifyFile(SafeFileHandle handle, string path)
    {
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) ||
            (info.Attributes & (0x400 | 0x10)) != 0 || info.Links != 1)
            throw new IOException("Candidate profile file is invalid.");
        var final = new StringBuilder(32768);
        var n = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        var id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        if (n == 0 || n >= final.Capacity || !string.Equals(final.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase) || info.Volume == 0 || id == 0)
            throw new IOException("Candidate profile file identity differs.");
        return new(info.Volume, id);
    }
    private static DirectoryIdentity Identify(SafeFileHandle handle, string path)
    {
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) ||
            (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0)
            throw new IOException("Candidate directory is unavailable or an alias.");
        var final = new StringBuilder(32768);
        var n = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        if (n == 0 || n >= final.Capacity || !string.Equals(final.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Candidate directory identity differs from its path.");
        var fileId = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        if (info.Volume == 0 || fileId == 0) throw new IOException("Candidate directory identity is unavailable.");
        return new(info.Volume, fileId);
    }
    private static (int Status, SafeFileHandle Handle, nint Information) OpenNative(string name, nint parent, uint access, uint disposition)
    {
        var raw = Marshal.StringToHGlobalUni(name); var unicode = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
        try {
            var text = new UnicodeString { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2 + 2)), Buffer = raw };
            Marshal.StructureToPtr(text, unicode, false);
            var attributes = new ObjectAttributes { Length = Marshal.SizeOf<ObjectAttributes>(), RootDirectory = parent, ObjectName = unicode, Attributes = 0x40 };
            var status = NtCreateFile(out var handle, access, ref attributes, out var io, 0, 0, 3, disposition, 0x21, 0, 0);
            return (status, handle, io.Information);
        } finally { Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(raw); }
    }
    public void Dispose() { for (var i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); handles.Clear(); held.Clear(); }
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { internal ushort Length, MaximumLength; internal nint Buffer; }
    [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes { internal int Length; internal nint RootDirectory, ObjectName; internal uint Attributes; internal nint SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] private struct IoStatus { internal nint Status, Information; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("ntdll.dll")] private static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status, nint allocationSize, uint fileAttributes, uint share, uint disposition, uint options, nint ea, uint eaLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder value, uint length, uint flags);
}
