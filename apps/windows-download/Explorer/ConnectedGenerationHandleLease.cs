using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Explorer;

/// <summary>Retained physical handles for a read-only observation. This does not hold the session.lock
/// after the owning session disposes, prevent every metadata mutation, or authorize a generation switch.</summary>
public sealed class ConnectedGenerationHandleLease : IDisposable
{
    private readonly CandidateDirectoryFence directories;
    private readonly FileStream profile, manifest;
    private readonly SafeFileHandle root;
    private readonly string profilePath, manifestPath, rootPath;
    private bool disposed;
    public uint RootVolume { get; }
    public ulong RootFileId { get; }
    public uint ProfileVolume { get; }
    public ulong ProfileFileId { get; }
    public uint ProfileDirectoryVolume { get; }
    public ulong ProfileDirectoryFileId { get; }
    public uint ManifestVolume { get; }
    public ulong ManifestFileId { get; }
    private ConnectedGenerationHandleLease(CandidateDirectoryFence dirs, FileStream profileFile, FileStream manifestFile,
        SafeFileHandle rootHandle, string profileName, string manifestName, string rootName)
    {
        directories = dirs; profile = profileFile; manifest = manifestFile; root = rootHandle;
        profilePath = profileName; manifestPath = manifestName; rootPath = rootName;
        var profileDirectory = dirs.Recheck(Path.GetDirectoryName(profilePath) ?? throw new IOException("Profile directory missing."));
        ProfileDirectoryVolume = profileDirectory.Volume; ProfileDirectoryFileId = profileDirectory.FileId;
        (ProfileVolume, ProfileFileId) = Identify(profile.SafeFileHandle, profilePath, false);
        (ManifestVolume, ManifestFileId) = Identify(manifest.SafeFileHandle, manifestPath, false);
        (RootVolume, RootFileId) = Identify(root, rootPath, true);
    }
    internal static ConnectedGenerationHandleLease Open(string directory, string manifestLeaf, string rootPath)
    {
        if (Path.GetFileName(manifestLeaf) != manifestLeaf || string.IsNullOrWhiteSpace(manifestLeaf) ||
            manifestLeaf.Equals("profile.json", StringComparison.OrdinalIgnoreCase)) throw new IOException("Invalid manifest leaf.");
        var profilePath = Path.Combine(directory, "profile.json"); var manifestPath = Path.Combine(directory, manifestLeaf);
        var dirs = new CandidateDirectoryFence(); FileStream? profile = null; FileStream? manifest = null; SafeFileHandle? root = null;
        try {
            dirs.HoldAncestors(directory);
            dirs.HoldAncestors(Path.GetDirectoryName(rootPath) ?? throw new IOException("Root parent missing."));
            profile = OpenFile(profilePath); manifest = OpenFile(manifestPath);
            using (PlaceholderVisibility.Expose()) root = CreateFileW(rootPath, 0x81, 3, 0, 3, 0x02200000, 0);
            if (root.IsInvalid) throw new IOException("Root handle unavailable.");
            return new(dirs, profile, manifest, root, profilePath, manifestPath, rootPath);
        } catch { root?.Dispose(); manifest?.Dispose(); profile?.Dispose(); dirs.Dispose(); throw; }
    }
    internal void VerifySessionLock(FileStream sessionLock, string path)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var identity = Identify(sessionLock.SafeFileHandle, path, false);
        if (identity.Volume != ProfileVolume) throw new IOException("Session lock volume differs from its profile.");
    }
    internal byte[] ReadProfile() => ReadBounded(profile, 65536);
    internal byte[] ReadManifest() => ReadBounded(manifest, ExplorerRootManifest.MaximumBytes);
    public void Recheck()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        var directory = directories.Recheck(Path.GetDirectoryName(profilePath) ?? throw new IOException("Profile directory missing."));
        if (directory.Volume != ProfileDirectoryVolume || directory.FileId != ProfileDirectoryFileId ||
            Identify(profile.SafeFileHandle, profilePath, false) != (ProfileVolume, ProfileFileId) ||
            Identify(manifest.SafeFileHandle, manifestPath, false) != (ManifestVolume, ManifestFileId) ||
            Identify(root, rootPath, true) != (RootVolume, RootFileId))
            throw new IOException("A retained generation handle changed identity.");
    }
    private static byte[] ReadBounded(FileStream input, int max)
    {
        if (input.Length is < 1 || input.Length > max) throw new IOException("Generation file size is invalid.");
        input.Position = 0; var bytes = new byte[(int)input.Length]; input.ReadExactly(bytes); return bytes;
    }
    private static FileStream OpenFile(string path)
    {
        // IdentifyCore already requires the same canonical, local DOS path when comparing
        // the handle's final name. Use its extended form for Win32 long-path support.
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) ||
            !string.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Generation file path is not a canonical local path.");
        var handle = CreateFileW(@"\\?\" + path, 0x80000000, 1, 0, 3, 0x00200000, 0);
        var error = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        try { if (handle.IsInvalid) throw new IOException($"Generation file unavailable (Windows error {error})."); _ = Identify(handle, path, false); return new FileStream(handle, FileAccess.Read); }
        catch { handle.Dispose(); throw; }
    }
    private static (uint Volume, ulong FileId) Identify(SafeFileHandle handle, string path, bool directory)
    {
        if (directory) return PlaceholderVisibility.Run(() => IdentifyCore(handle, path, true));
        return IdentifyCore(handle, path, false);
    }
    private static (uint Volume, ulong FileId) IdentifyCore(SafeFileHandle handle, string path, bool directory)
    {
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) || ((info.Attributes & 0x10) != 0) != directory ||
            (!directory && ((info.Attributes & 0x400) != 0 || info.Links != 1))) throw new IOException("Generation handle type differs.");
        if (directory && (info.Attributes & 0x400) != 0) {
            if (!GetFileInformationByHandleEx(handle, 9, out var tag, 8) || (tag.Tag & 0xffff0fff) != 0x9000001a)
                throw new IOException("Root is not an exact cloud placeholder.");
            var state = CfGetPlaceholderStateFromAttributeTag(tag.Attributes, tag.Tag);
            if (state == uint.MaxValue || (state & 1) == 0) throw new IOException("Root placeholder state is unavailable.");
        }
        var name = new StringBuilder(32768); var n = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);
        if (n == 0 || n >= name.Capacity || !string.Equals(name.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Generation handle path changed.");
        var id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        if (id == 0 || info.Volume == 0) throw new IOException("Generation handle identity unavailable.");
        return (info.Volume, id);
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        root.Dispose(); manifest.Dispose(); profile.Dispose(); directories.Dispose();
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct AttributeTag { internal uint Attributes, Tag; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, out AttributeTag tag, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder value, uint length, uint flags);
    [DllImport("cldapi.dll")] private static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes, uint tag);
}
