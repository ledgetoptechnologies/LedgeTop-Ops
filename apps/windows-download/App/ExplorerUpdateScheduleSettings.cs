using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Updates;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files;

internal sealed record ExplorerUpdateScheduleSettings(bool AutoUpdatesEnabled, DateTimeOffset? NextDueUtc);
internal sealed record ExplorerUpdateScheduleLoad(ExplorerUpdateScheduleSettings Settings, string? Issue);

// A local preference, never authority to install. No account, source, release handle or credential is saved.
internal sealed class ExplorerUpdateScheduleSettingsStore
{
    internal const string Leaf = "automatic-update-settings-v1.json";
    private const string Owner = "LedgeTop.Files.UpdateSchedule/1";
    private readonly string directory;
    private readonly object gate = new();
    private bool blocked;
    private ExplorerUpdateScheduleSettingsStore(string directory) => this.directory = Path.GetFullPath(directory);

    internal static ExplorerUpdateScheduleSettingsStore CreatePilot(string stateBase)
    {
        var expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", "pilot");
        if (!Path.IsPathFullyQualified(stateBase) || !string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(stateBase)), expected, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Update settings location refused.");
        return new(expected);
    }
    internal static ExplorerUpdateScheduleSettingsStore CreateForTests(string directory)
    {
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Test settings path refused.");
        return new(directory);
    }

    internal ExplorerUpdateScheduleLoad Load()
    {
        lock (gate) {
            try {
                using var ancestry = HoldExistingAncestry();
                var bytes = ReadExisting();
                return new(bytes is null ? new(true, null) : Decode(bytes), null);
            } catch {
                blocked = true;
                return new(new(false, null), "Automatic update settings need review. Automatic updates are paused.");
            }
        }
    }

    internal void Save(ExplorerUpdateScheduleSettings settings)
    {
        lock (gate) {
            if (blocked) throw new IOException("Update settings need review.");
            var bytes = Encode(settings);
            using var ancestry = HoldExistingAncestry();
            EnsureDirectory();
            using var directoryFence = ExeUpdateWindowsNative.HoldDirectoryChain(directory);
            // OPEN_ALWAYS and no sharing serialize cooperating writers. Existing locks must be
            // current-user-owned, regular, one-link, empty files; their bytes are never changed.
            var lockPath = Path.Combine(directory, Leaf + ".lock");
            using var lockHandle = CreateOwnedFile(lockPath, 4, 0x00200000);
            using var writeLock = new FileStream(lockHandle, FileAccess.ReadWrite);
            Verify(writeLock.SafeFileHandle, lockPath);
            if (writeLock.Length != 0) throw new IOException("Update settings writer refused.");
            VerifyOwner(lockPath);
            var before = ReadExisting();
            if (before is not null) _ = Decode(before);
            var temporary = Path.Combine(directory, Leaf + "." + Guid.NewGuid().ToString("N") + ".tmp");
            // The only temporary file we create is an owned, exact leaf; no directory cleanup is performed.
            // A failed publication retains this leaf for ownership review. The controller visibly pauses
            // after a save failure rather than automatically retrying and accumulating temporary files.
            using (var handle = CreateOwnedFile(temporary, 1, 0x80200000))
            using (var stream = new FileStream(handle, FileAccess.ReadWrite, 4096)) {
                Verify(stream.SafeFileHandle, temporary); VerifyOwner(temporary);
                stream.Write(bytes); stream.Flush(flushToDisk: true);
            }
            var current = ReadExisting();
            if ((before is null) != (current is null) || before is not null && !before.AsSpan().SequenceEqual(current))
                throw new IOException("Update settings changed.");
            var target = Path.Combine(directory, Leaf);
            if (!MoveFileExW(temporary, target, (before is null ? 0u : 1u) | 8u)) throw new IOException("Update settings could not be saved.");
            var saved = ReadExisting();
            if (saved is null || !saved.AsSpan().SequenceEqual(bytes)) throw new IOException("Update settings readback failed.");
        }
    }

    private byte[]? ReadExisting()
    {
        var path = Path.Combine(directory, Leaf);
        var handle = CreateFileW(path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (handle.IsInvalid) {
            var error = Marshal.GetLastWin32Error(); handle.Dispose();
            if (error is 2 or 3) return null;
            throw new IOException("Update settings are unavailable.");
        }
        using var stream = new FileStream(handle, FileAccess.Read);
        Verify(handle, path); VerifyOwner(path);
        if (stream.Length is < 2 or > 1024) throw new IOException("Update settings size refused.");
        var bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes);
        Verify(handle, path); return bytes;
    }

    private IDisposable HoldExistingAncestry()
    {
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith("\\\\", StringComparison.Ordinal) || directory.AsSpan(2).Contains(':'))
            throw new IOException("Update settings location refused.");
        var ancestor = directory;
        while (true) {
            try { _ = File.GetAttributes(ancestor); break; }
            catch (DirectoryNotFoundException) { }
            catch (FileNotFoundException) { }
            ancestor = Path.GetDirectoryName(ancestor) ?? throw new IOException("Update settings ancestor missing.");
        }
        if ((File.GetAttributes(ancestor) & FileAttributes.Directory) == 0) throw new IOException("Update settings ancestor refused.");
        return ExeUpdateWindowsNative.HoldDirectoryChain(ancestor);
    }
    private void EnsureDirectory()
    {
        var missing = new Stack<string>();
        for (var part = directory; !Directory.Exists(part); part = Path.GetDirectoryName(part) ?? throw new IOException()) missing.Push(part);
        while (missing.TryPop(out var part)) {
            Directory.CreateDirectory(part);
            ExeUpdateWindowsNative.NoAliases(part);
        }
    }
    private static void VerifyOwner(string path)
    {
        var owner = new FileInfo(path).GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier));
        using var identity = WindowsIdentity.GetCurrent();
        if (!Equals(owner, identity.User)) throw new IOException("Update settings owner refused.");
    }
    private static SafeFileHandle CreateOwnedFile(string path, uint disposition, uint flags)
    {
        // An elevated token may otherwise default a new file's owner to Administrators. Specify
        // our actual user SID at creation, never take ownership of an existing file. OPEN_ALWAYS
        // ignores this descriptor for existing files, whose original owner is still verified above.
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User ?? throw new IOException("Update settings identity unavailable.");
        var security = new FileSecurity();
        security.SetOwner(sid);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        var descriptor = security.GetSecurityDescriptorBinaryForm();
        var address = Marshal.AllocHGlobal(descriptor.Length);
        try {
            Marshal.Copy(descriptor, 0, address, descriptor.Length);
            var attributes = new SecurityAttributes { Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Descriptor = address, InheritHandle = 0 };
            var handle = CreateFileWithSecurityW(path, 0xC0000000, 0, ref attributes, disposition, flags, IntPtr.Zero);
            if (!handle.IsInvalid) return handle;
            handle.Dispose(); throw new IOException("Update settings owned file unavailable.");
        } finally { Marshal.FreeHGlobal(address); }
    }
    private static byte[] Encode(ExplorerUpdateScheduleSettings settings)
    {
        if (settings.NextDueUtc is { } due && (due.Offset != TimeSpan.Zero || due < DateTimeOffset.UnixEpoch)) throw new IOException("Update schedule time refused.");
        return JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, owner = Owner, autoUpdatesEnabled = settings.AutoUpdatesEnabled,
            nextDueUtc = settings.NextDueUtc?.ToString("O", CultureInfo.InvariantCulture) });
    }
    private static ExplorerUpdateScheduleSettings Decode(byte[] bytes)
    {
        using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 2 });
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new IOException();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject()) if (!keys.Add(property.Name) || property.Name is not ("schemaVersion" or "owner" or "autoUpdatesEnabled" or "nextDueUtc")) throw new IOException();
        if (keys.Count != 4 || root.GetProperty("schemaVersion").GetInt32() != 1 || root.GetProperty("owner").GetString() != Owner ||
            root.GetProperty("autoUpdatesEnabled").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new IOException();
        var time = root.GetProperty("nextDueUtc"); DateTimeOffset? due = null;
        if (time.ValueKind != JsonValueKind.Null) {
            var text = time.GetString();
            if (!DateTimeOffset.TryParseExact(text, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed) || parsed.Offset != TimeSpan.Zero || parsed < DateTimeOffset.UnixEpoch || parsed.ToString("O", CultureInfo.InvariantCulture) != text) throw new IOException();
            due = parsed;
        }
        return new(root.GetProperty("autoUpdatesEnabled").GetBoolean(), due);
    }
    private static void Verify(SafeFileHandle handle, string path)
    {
        if (!GetFileInformationByHandle(handle, out var info) || GetFileType(handle) != 1 || (info.Attributes & (0x400 | 0x10)) != 0 || info.Links != 1)
            throw new IOException("Update settings file refused.");
        var final = new StringBuilder(32768);
        var count = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
        if (count is 0 or >= 32768 || !string.Equals(final.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase)) throw new IOException("Update settings alias refused.");
    }
    [StructLayout(LayoutKind.Sequential)] private struct HandleInfo
    { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, High, Low, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal uint Length; internal IntPtr Descriptor; internal int InheritHandle; }
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFileWithSecurityW(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool MoveFileExW(string source, string destination, uint flags);
}
