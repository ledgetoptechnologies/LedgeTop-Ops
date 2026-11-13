using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Explorer;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files;

// Experimental building block, deliberately not connected to provider startup. The
// caller must separately establish root/profile ownership and keep this lease alive
// until all provider callbacks and workers have drained. No authority is established
// by this class over pre-existing writable mappings or arbitrary directory metadata.
internal sealed class FreshGenerationSelectorLease : IDisposable
{
    private readonly CandidateDirectoryFence directories;
    private readonly string[] ancestors;
    private readonly FileStream current, backup;
    private readonly string currentPath, backupPath;
    private readonly byte[] currentBytes, backupBytes;
    private readonly FileIdentity currentId, backupId;
    private readonly object sync = new();
    private bool disposed;

    private FreshGenerationSelectorLease(CandidateDirectoryFence directories, string[] ancestors,
        string currentPath, string backupPath, FileStream current, FileStream backup,
        byte[] currentBytes, byte[] backupBytes, FileIdentity currentId, FileIdentity backupId)
    {
        this.directories = directories; this.ancestors = ancestors;
        this.currentPath = currentPath; this.backupPath = backupPath;
        this.current = current; this.backup = backup; this.currentBytes = currentBytes;
        this.backupBytes = backupBytes; this.currentId = currentId; this.backupId = backupId;
    }

    internal static FreshGenerationSelectorLease Acquire(string directory, FreshGenerationIndexCodec.Index expected)
    {
        ArgumentNullException.ThrowIfNull(expected);
        if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\", StringComparison.Ordinal) ||
            !string.Equals(Path.GetFullPath(directory), directory, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Selector directory must be a canonical local Windows path.");
        if (expected.State.Phase != FreshGenerationPlan.Phase.Published || expected.State.Removal is not null ||
            expected.State.New is null || expected.ActiveGeneration != expected.State.New.Id)
            throw new IOException("Only a published, active selector may be retained.");
        string currentPath = Path.Combine(directory, FreshGenerationIndexStore.Current);
        string backupPath = Path.Combine(directory, FreshGenerationIndexStore.LegacyBackup);
        var dirs = new CandidateDirectoryFence(); FileStream? current = null, backup = null;
        try {
            dirs.HoldAncestors(directory);
            var paths = new List<string>();
            for (string? path = directory; path is not null; path = Path.GetDirectoryName(path)) paths.Add(path);
            current = Open(currentPath); backup = Open(backupPath);
            var currentId = Identity(current, currentPath); var backupId = Identity(backup, backupPath);
            VerifyNtfs(current, currentId.Volume); VerifyNtfs(backup, backupId.Volume);
            if (currentId.Volume != backupId.Volume || currentId == backupId || dirs.Recheck(directory).Volume != currentId.Volume)
                throw new IOException("Selector identities or volumes differ.");
            var currentBytes = Read(current); var backupBytes = Read(backup);
            if (FreshGenerationIndexCodec.Decode(currentBytes) != expected ||
                Convert.ToHexStringLower(SHA256.HashData(backupBytes)) != expected.LegacyBackupSha256)
                throw new IOException("Selector or retained legacy backup differs.");
            var lease = new FreshGenerationSelectorLease(dirs, paths.ToArray(), currentPath, backupPath, current, backup,
                currentBytes, backupBytes, currentId, backupId);
            lease.VerifyHeld(); return lease;
        } catch { backup?.Dispose(); current?.Dispose(); dirs.Dispose(); throw; }
    }

    internal void VerifyHeld()
    {
        lock (sync) {
            ObjectDisposedException.ThrowIf(disposed, this);
            foreach (var path in ancestors) _ = directories.Recheck(path);
            if (Identity(current, currentPath) != currentId || Identity(backup, backupPath) != backupId ||
                !Read(current).AsSpan().SequenceEqual(currentBytes) || !Read(backup).AsSpan().SequenceEqual(backupBytes))
                throw new IOException("Held selector evidence changed.");
        }
    }

    public void Dispose()
    {
        lock (sync) {
            if (disposed) return;
            disposed = true;
            try { backup.Dispose(); } finally { try { current.Dispose(); } finally { directories.Dispose(); } }
        }
    }
    private static FileStream Open(string path)
    {
        // OPEN_REPARSE_POINT ensures the final component is inspected, not followed.
        var handle = CreateFileW(path, 0x80000000, 1, 0, 3, 0x00200000, 0);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Selector cannot be pinned."); }
        try { return new FileStream(handle, FileAccess.Read); } catch { handle.Dispose(); throw; }
    }
    private static void VerifyNtfs(FileStream stream, uint expectedVolume)
    {
        var name = new StringBuilder(261);
        bool ok = GetVolumeInformationByHandleW(stream.SafeFileHandle, null, 0, out var volume, 0, 0, name, (uint)name.Capacity);
        CheckVolume(ok, name.ToString(), volume, expectedVolume);
    }
    internal static void CheckVolume(bool observed, string name, uint volume, uint expectedVolume)
    {
        if (!observed || !string.Equals(name, "NTFS", StringComparison.OrdinalIgnoreCase) || volume == 0 || volume != expectedVolume)
            throw new IOException("Selector filesystem is not verified NTFS on the pinned volume.");
    }
    private static byte[] Read(FileStream stream)
    {
        if (stream.Length is < 1 or > 16384) throw new IOException("Selector size is invalid.");
        stream.Position = 0; var bytes = new byte[checked((int)stream.Length)]; stream.ReadExactly(bytes); return bytes;
    }
    private readonly record struct FileIdentity(uint Volume, ulong Id);
    private static FileIdentity Identity(FileStream stream, string path)
    {
        var handle = stream.SafeFileHandle;
        if (handle.IsClosed || handle.IsInvalid || GetFileType(handle) != 1 || !GetFileInformationByHandle(handle, out var info) ||
            (info.Attributes & (0x400 | 0x10)) != 0 || info.Links != 1)
            throw new IOException("Selector file identity is invalid.");
        var final = new StringBuilder(32768); var n = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        ulong id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        if (n is 0 or >= 32768 || !string.Equals(final.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase) || info.Volume == 0 || id == 0)
            throw new IOException("Selector file path or identity differs.");
        return new(info.Volume, id);
    }
    [StructLayout(LayoutKind.Sequential)] private struct HandleInfo
    { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, High, Low, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll")] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, StringBuilder? volumeName, uint volumeNameSize,
        out uint volumeSerial, nint maximumComponentLength, nint flags, StringBuilder fileSystemName, uint fileSystemNameSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}
