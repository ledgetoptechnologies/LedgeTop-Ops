using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Updates;

// Anchor values come from the caller's held, SHA-verified installer, never the installed sidecar.
internal static class InstalledPayloadVerifier
{
    internal const string InventoryName = "installed-payload-inventory.json";
    internal const string MarkerName = "installer-owned.ini";
    internal const string Owner = "LedgeTop.Files.UnsignedPilotInstaller/1";
    internal const string HelperName = "helper/cloudflared.exe";
    private const int MaximumManifestBytes = 8 * 1024 * 1024;
    private static readonly Regex Sha = new("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Commit = new("\\A[0-9a-f]{40}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Device = new("\\A(?:CON|PRN|AUX|NUL|CONIN\\$|CONOUT\\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    internal sealed record Entry(string Path, long Bytes, string Sha256);
    internal sealed record InstalledPayloadMarker(string Owner, string Version, string PayloadManifestSha256, string SourceCommit);

    internal static async Task<VerifiedInstalledPayload> VerifyAsync(string root, string expectedVersion,
        string expectedSourceCommit, string expectedManifestSha256, string expectedHelperSha256, CancellationToken cancellationToken)
    {
        Require(OperatingSystem.IsWindows() && Commit.IsMatch(expectedSourceCommit) && Sha.IsMatch(expectedManifestSha256) && Sha.IsMatch(expectedHelperSha256));
        var version = expectedVersion.Split('.');
        Require(version.Length == 4 && version.All(part => ushort.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value.ToString(CultureInfo.InvariantCulture) == part));
        var full = CanonicalRoot(root);
        var lease = new VerifiedInstalledPayload(full);
        try {
            // Retain every ancestor for a bounded identity/sharing check. Other metadata
            // writes and adversarial path races are not excluded by these handles.
            var ancestors = new Stack<string>();
            for (var directory = new DirectoryInfo(full); directory is not null; directory = directory.Parent) ancestors.Push(directory.FullName);
            while (ancestors.TryPop(out var directory)) lease.HoldDirectory(directory);
            var inventory = lease.HoldFile(InventoryName);
            var raw = await ReadBoundedAsync(inventory, MaximumManifestBytes, cancellationToken);
            Require(Hash(raw) == expectedManifestSha256);
            var entries = ParseInventory(raw);
            var dirs = ParentDirectories(entries.Select(entry => entry.Path));
            foreach (var directory in dirs.OrderBy(path => path.Count(c => c == '/'))) lease.HoldDirectory(Path.Combine(full, directory.Replace('/', '\\')));
            var marker = lease.HoldFile(MarkerName);
            var owner = ParseMarker(await ReadBoundedAsync(marker, 16 * 1024, cancellationToken));
            Require(owner.Owner == Owner && owner.Version == expectedVersion && owner.SourceCommit == expectedSourceCommit && owner.PayloadManifestSha256 == expectedManifestSha256);
            lease.Version = expectedVersion; lease.SourceCommit = expectedSourceCommit; lease.PayloadManifestSha256 = expectedManifestSha256;
            // The uninstaller is an explicit metadata exception, not an anchored payload byte claim.
            lease.HoldFile("uninstall.exe");
            var hashes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in entries) {
                cancellationToken.ThrowIfCancellationRequested();
                var stream = lease.HoldFile(entry.Path);
                Require(stream.Length == entry.Bytes);
                var hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, cancellationToken));
                Require(hash == entry.Sha256 && stream.Length == entry.Bytes);
                hashes.Add(entry.Path, hash);
            }
            Require(hashes.ContainsKey("LedgeTop.Files.exe") && hashes.ContainsKey("LedgeTop.Files.dll") &&
                hashes.TryGetValue(HelperName, out var helper) && helper == expectedHelperSha256);
            lease.AppHostSha256 = hashes["LedgeTop.Files.exe"];
            lease.ManagedAssemblySha256 = hashes["LedgeTop.Files.dll"];
            lease.HelperSha256 = hashes[HelperName];
            lease.SetExpectedTree(entries.Select(entry => entry.Path).Concat([InventoryName, MarkerName, "uninstall.exe"]), dirs);
            await lease.RevalidateAsync(cancellationToken);
            return lease;
        } catch {
            await lease.DisposeAsync();
            throw;
        }
    }

    internal static IReadOnlyList<Entry> ParseInventory(ReadOnlyMemory<byte> raw)
    {
        Require(raw.Length is > 0 and <= MaximumManifestBytes);
        var bytes = raw.Span;
        var offset = bytes.StartsWith(new byte[] { 239, 187, 191 }) ? 3 : 0;
        // Strict UTF-8 validation; hash always covered original bytes including BOM/whitespace.
        var text = new UTF8Encoding(false, true).GetString(bytes[offset..]);
        using var doc = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
        Require(doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() is >= 1 and <= 4096);
        var entries = new List<Entry>();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var row in doc.RootElement.EnumerateArray()) {
            Require(row.ValueKind == JsonValueKind.Object);
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in row.EnumerateObject()) Require(keys.Add(property.Name));
            Require(keys.SetEquals(["path", "bytes", "sha256"]));
            Require(row.GetProperty("path").ValueKind == JsonValueKind.String && row.GetProperty("sha256").ValueKind == JsonValueKind.String);
            var path = row.GetProperty("path").GetString()!;
            ValidateRelativePath(path);
            Require(paths.Add(path));
            var size = row.GetProperty("bytes");
            Require(size.ValueKind == JsonValueKind.Number && size.TryGetInt64(out var length) && length is >= 0 and <= 2147483648L);
            // Reading the value after the guard avoids any numeric conversion/rounding acceptance.
            var count = size.GetInt64();
            total = checked(total + count); Require(total <= 1073741824L);
            var hash = row.GetProperty("sha256").GetString()!; Require(Sha.IsMatch(hash));
            entries.Add(new Entry(path, count, hash));
        }
        var dirs = ParentDirectories(paths);
        Require(!dirs.Overlaps(paths));
        var spelling = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries) {
            var parts = entry.Path.Split('/'); var prefix = "";
            foreach (var part in parts) {
                prefix = prefix.Length == 0 ? part : prefix + "/" + part;
                Require(!spelling.TryGetValue(prefix, out var earlier) || earlier == prefix);
                spelling[prefix] = prefix;
            }
        }
        return entries;
    }

    internal static void ValidateRelativePath(string path)
    {
        Require(!string.IsNullOrWhiteSpace(path) && path.Length <= 240 && !path.Contains('\\') && !Path.IsPathRooted(path) &&
            path.IndexOfAny(['$', '"', '`', '!']) < 0);
        foreach (var part in path.Split('/')) ValidateLeaf(part);
        var first = path.Split('/')[0];
        Require(!new[] { MarkerName, "uninstall.exe", InventoryName }.Contains(first, StringComparer.OrdinalIgnoreCase));
    }

    private static void ValidateLeaf(string part)
    {
        Require(!string.IsNullOrWhiteSpace(part) && part.Length <= 150 && part is not "." and not ".." && !part.EndsWith('.') && !part.EndsWith(' ') &&
            !Device.IsMatch(part) && !part.Any(c => c < 32 || "<>:\"/\\|?*".Contains(c) || char.GetUnicodeCategory(c) is UnicodeCategory.Format or UnicodeCategory.Surrogate));
    }

    private static string CanonicalRoot(string root)
    {
        Require(Path.IsPathFullyQualified(root) && !root.StartsWith("\\\\", StringComparison.Ordinal) && !root.EndsWith('\\') && !root.EndsWith('/'));
        var full = Path.GetFullPath(root);
        Require(string.Equals(full, root, StringComparison.Ordinal) && full.Length <= 240 && new DriveInfo(Path.GetPathRoot(full)!).DriveType == DriveType.Fixed);
        var drive = Path.GetPathRoot(full)!; Require(full.Length > drive.Length);
        foreach (var part in full[drive.Length..].Split('\\')) ValidateLeaf(part);
        return full;
    }

    private static HashSet<string> ParentDirectories(IEnumerable<string> paths)
    {
        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in paths) {
            for (var slash = path.LastIndexOf('/'); slash >= 0; slash = path.LastIndexOf('/', slash - 1)) {
                dirs.Add(path[..slash]);
                if (slash == 0) break;
            }
        }
        return dirs;
    }

    private static async Task<byte[]> ReadBoundedAsync(FileStream stream, int maximum, CancellationToken cancellationToken)
    {
        Require(stream.Length is > 0 && stream.Length <= maximum);
        var raw = new byte[checked((int)stream.Length)];
        stream.Position = 0; await stream.ReadExactlyAsync(raw, cancellationToken);
        Require(stream.Position == stream.Length); return raw;
    }

    internal static InstalledPayloadMarker ParseMarker(ReadOnlyMemory<byte> bytes)
    {
        Require(bytes.Length is > 0 and <= 16 * 1024); var raw = bytes.ToArray();
        string text;
        if (raw.AsSpan().StartsWith(new byte[] { 255, 254 })) text = new UnicodeEncoding(false, true, true).GetString(raw, 2, raw.Length - 2);
        else {
            var offset = raw.AsSpan().StartsWith(new byte[] { 239, 187, 191 }) ? 3 : 0;
            text = new UTF8Encoding(false, true).GetString(raw, offset, raw.Length - offset);
        }
        var values = new Dictionary<string, string>(StringComparer.Ordinal); var section = false;
        foreach (var line in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n')) {
            if (line.Length == 0) continue;
            Require(!line.Contains('\r') && !line.Contains('\0'));
            if (!section) { Require(line == "[Installer]"); section = true; continue; }
            var equals = line.IndexOf('='); Require(equals > 0 && line.IndexOf('=', equals + 1) < 0);
            Require(values.TryAdd(line[..equals], line[(equals + 1)..]));
        }
        Require(section && values.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(["Owner", "Version", "PayloadManifestSha256", "SourceCommit"]));
        Require(values["Owner"] == Owner && Sha.IsMatch(values["PayloadManifestSha256"]) && Commit.IsMatch(values["SourceCommit"]));
        var parts = values["Version"].Split('.');
        Require(parts.Length == 4 && parts.All(part => ushort.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value.ToString(CultureInfo.InvariantCulture) == part));
        return new InstalledPayloadMarker(values["Owner"], values["Version"], values["PayloadManifestSha256"], values["SourceCommit"]);
    }

    private static string Hash(byte[] value) => Convert.ToHexStringLower(SHA256.HashData(value));
    internal static void Require(bool valid) { if (!valid) throw new InvalidDataException("Installed payload verification refused."); }
}

// Owns local read handles only. Dispose after the caller's relaunch handoff boundary.
internal sealed class VerifiedInstalledPayload(string root) : IAsyncDisposable
{
    private readonly List<IDisposable> handles = [];
    private readonly List<(string Path, FileStream Stream)> files = [];
    private readonly List<(string Path, SafeFileHandle Handle)> directories = [];
    private HashSet<string> expectedFiles = new(StringComparer.OrdinalIgnoreCase), expectedDirectories = new(StringComparer.OrdinalIgnoreCase);
    private bool disposed;
    internal string InstallRoot { get; } = root;
    internal string AppHostSha256 { get; set; } = "";
    internal string ManagedAssemblySha256 { get; set; } = "";
    internal string HelperSha256 { get; set; } = "";
    internal string Version { get; set; } = "";
    internal string SourceCommit { get; set; } = "";
    internal string PayloadManifestSha256 { get; set; } = "";
    internal void HoldDirectory(string path)
    {
        var handle = Open(path, true); handles.Add(handle); directories.Add((path, handle));
    }
    internal FileStream HoldFile(string relative)
    {
        var full = Path.Combine(InstallRoot, relative.Replace('/', '\\'));
        InstalledPayloadVerifier.Require(full.Length <= 240);
        var handle = Open(full, false);
        try {
            var stream = new FileStream(handle, FileAccess.Read, 64 * 1024, false);
            handles.Add(stream); files.Add((full, stream)); return stream;
        } catch { handle.Dispose(); throw; }
    }
    internal void SetExpectedTree(IEnumerable<string> payload, HashSet<string> directories)
    {
        expectedFiles = new HashSet<string>(payload, StringComparer.OrdinalIgnoreCase); expectedDirectories = directories;
    }
    // Recheck directly before handoff; held payload handles deny writes/deletion.
    // Directory handles deny rename/deletion; this does not claim to block new sibling creation.
    internal Task RevalidateAsync(CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        foreach (var directory in directories) VerifyHandle(directory.Handle, directory.Path, true);
        var actualFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var actualDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Stack<string>(); pending.Push(InstallRoot);
        while (pending.TryPop(out var directory)) {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var path in Directory.EnumerateFileSystemEntries(directory)) {
                var relative = Path.GetRelativePath(InstallRoot, path).Replace('\\', '/');
                var attrs = File.GetAttributes(path);
                InstalledPayloadVerifier.Require((attrs & FileAttributes.ReparsePoint) == 0);
                if ((attrs & FileAttributes.Directory) != 0) {
                    InstalledPayloadVerifier.Require(expectedDirectories.Contains(relative) && actualDirs.Add(relative)); pending.Push(path);
                } else InstalledPayloadVerifier.Require(expectedFiles.Contains(relative) && actualFiles.Add(relative));
            }
        }
        InstalledPayloadVerifier.Require(actualFiles.SetEquals(expectedFiles) && actualDirs.SetEquals(expectedDirectories));
        foreach (var file in files) VerifyHandle(file.Stream.SafeFileHandle, file.Path, false);
        foreach (var directory in directories) VerifyHandle(directory.Handle, directory.Path, true);
        return Task.CompletedTask;
    }
    public ValueTask DisposeAsync()
    {
        if (!disposed) { disposed = true; for (var index = handles.Count - 1; index >= 0; index--) handles[index].Dispose(); handles.Clear(); }
        return ValueTask.CompletedTask;
    }
    private static SafeFileHandle Open(string path, bool directory)
    {
        // Directory LIST_DIRECTORY + READ_ATTRIBUTES engages read sharing rather
        // than an attributes-only open, which did not prevent rename in a local
        // NTFS control. Deny DELETE sharing while allowing normal sibling writes.
        // This is not a fence against all metadata/reparse races or path ABA.
        var handle = CreateFileW(path, directory ? 0x81u : 0x80000000u, directory ? 3u : 1u, IntPtr.Zero, 3, 0x00200000u | (directory ? 0x02000000u : 0u), IntPtr.Zero);
        try { InstalledPayloadVerifier.Require(!handle.IsInvalid); VerifyHandle(handle, path, directory); return handle; }
        catch { handle.Dispose(); throw; }
    }
    private static void VerifyHandle(SafeFileHandle handle, string path, bool directory)
    {
        InstalledPayloadVerifier.Require(GetFileInformationByHandle(handle, out var info) && GetFileType(handle) == 1 &&
            (info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory && (directory || info.Links == 1));
        var result = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, result, (uint)result.Capacity, 0);
        InstalledPayloadVerifier.Require(length is > 0 and < 32768 && string.Equals(result.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase));
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo
    {
        internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}
