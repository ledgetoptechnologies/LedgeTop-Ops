using System.Globalization;
using System.Text.Json;
using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files;

/// <summary>Optional local support evidence only. Caller must already own the employee index lease
/// and prove its current index before publication. No directory creation, auth or lifecycle decision.</summary>
internal static class ConnectionDiagnosticStore
{
    internal const string Leaf = "latest-connection-failure.json";
    internal const string Owner = "LedgeTop.Files.ConnectionDiagnostic/1";
    private const string Temporary = ".latest-connection-failure.write.tmp";
    private const string Prefix = "Connection action failed. Support code: ";
    private const int Limit = 1024;
    private static readonly object Writes = new();

    internal static void TrySaveLatest(string existingOwnedEmployeeIndexDirectory, Func<bool> ownershipStillCurrent,
        string supportCode, Version appVersion, DateTimeOffset utc)
    {
        // Diagnostics must never turn a failure into a second failure or alter auth/recovery.
        try {
            if (!IsSafeSupportCode(supportCode) || !ValidVersion(appVersion.ToString()) || utc.Offset != TimeSpan.Zero || utc < DateTimeOffset.UnixEpoch) return;
            var directory = Path.TrimEndingDirectorySeparator(existingOwnedEmployeeIndexDirectory);
            if (!Path.IsPathFullyQualified(directory) || directory.StartsWith("\\\\", StringComparison.Ordinal) ||
                Path.GetFullPath(directory) != directory || Path.GetFileName(directory) != "connected-explorer-pilot-employee") return;
            // The handle-bound reader used for both preflight and cleanup refuses longer
            // paths. Refuse before CreateNew so a cancelled publish cannot leave a temp.
            if (Path.Combine(directory, Leaf).Length > 240 || Path.Combine(directory, Temporary).Length > 240) return;
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, owner = Owner,
                atUtc = utc.ToString("O", CultureInfo.InvariantCulture), appVersion = appVersion.ToString(4), supportCode });
            if (bytes.Length > Limit) return;
            lock (Writes) {
                if (!ownershipStillCurrent()) return;
                var directoryFence = new VerifiedInstalledPayload(directory);
                try {
                    var ancestors = new Stack<string>();
                    for (string? part = directory; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
                    while (ancestors.TryPop(out var part)) directoryFence.HoldDirectory(part);
                    var previous = ReadRaw(directory, Leaf);
                    if (previous is not null && Decode(previous) > utc) return;
                    var temporary = Path.Combine(directory, Temporary); var created = false;
                    try {
                        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                            created = true; stream.Write(bytes); stream.Flush(flushToDisk: true);
                        }
                        if (!ownershipStillCurrent()) return;
                        var current = ReadRaw(directory, Leaf);
                        if (current is not null) _ = Decode(current);
                        if (previous is null ? current is not null : current is null || !previous.AsSpan().SequenceEqual(current)) return;
                        // Existing index lease serializes cooperating writers. Like current-index publication,
                        // this is atomic replacement, not CAS against an arbitrary same-user external writer.
                        File.Move(temporary, Path.Combine(directory, Leaf), overwrite: previous is not null);
                        created = false;
                    } finally {
                        if (created) {
                            // One fixed pending slot bounds even failed cleanup. Never prune an unknown file.
                            try { var own = ReadRaw(directory, Temporary); if (own is not null && own.AsSpan().SequenceEqual(bytes)) File.Delete(temporary); } catch { }
                        }
                    }
                } finally { directoryFence.DisposeAsync().GetAwaiter().GetResult(); }
            }
        } catch { /* Best effort only; no exception or user/source data is logged here. */ }
    }

    private static byte[]? ReadRaw(string directory, string leaf)
    {
        var path = Path.Combine(directory, leaf);
        try { _ = File.GetAttributes(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        var fence = new VerifiedInstalledPayload(directory);
        try {
            // Existing helper checks handle type, canonical path, no reparse and exactly one link.
            var stream = fence.HoldFile(leaf);
            if (stream.Length is < 2 or > Limit) throw new IOException();
            var bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes); return bytes;
        } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
    }
    private static DateTimeOffset Decode(byte[] bytes)
    {
        using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 2 }); var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new IOException();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject())
            if (!keys.Add(field.Name) || field.Name is not ("schemaVersion" or "owner" or "atUtc" or "appVersion" or "supportCode")) throw new IOException();
        if (keys.Count != 5 || root.GetProperty("schemaVersion").GetRawText() != "1" || root.GetProperty("owner").GetString() != Owner ||
            !ValidVersion(root.GetProperty("appVersion").GetString()) || !IsSafeSupportCode(root.GetProperty("supportCode").GetString())) throw new IOException();
        var text = root.GetProperty("atUtc").GetString();
        if (!DateTimeOffset.TryParseExact(text, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var utc) ||
            utc.Offset != TimeSpan.Zero || utc < DateTimeOffset.UnixEpoch || utc.ToString("O", CultureInfo.InvariantCulture) != text) throw new IOException();
        return utc;
    }
    private static bool ValidVersion(string? value) => Version.TryParse(value, out var version) && version.Revision >= 0 &&
        version.Major <= ushort.MaxValue && version.Minor <= ushort.MaxValue && version.Build <= ushort.MaxValue && version.Revision <= ushort.MaxValue && version.ToString(4) == value;
    private static bool Named<T>(string value, out T parsed) where T : struct, Enum =>
        Enum.TryParse(value, ignoreCase: false, out parsed) && Enum.IsDefined(parsed) && parsed.ToString() == value;
    internal static bool IsSafeSupportCode(string? value)
    {
        if (value is null || value.Length > 512 || !value.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        var pieces = value[Prefix.Length..].Split("; ", StringSplitOptions.None); var fields = pieces[0].Split('/');
        if (fields.Length != 5 || fields[0] is not ("connection" or "settings") ||
            !Named<ConnectionAction>(fields[1], out _) || !Named<ConnectionPhase>(fields[2], out _) ||
            !Named<ConnectionFailureKind>(fields[3], out var kind) || !Named<TransferFailureReason>(fields[4], out var reason)) return false;
        if (kind == ConnectionFailureKind.Transfer) {
            if (reason != TransferFailureReason.UnexpectedHttpStatus) return pieces.Length == 1;
            return pieces.Length == 2 && pieces[1].StartsWith("HTTP ", StringComparison.Ordinal) &&
                int.TryParse(pieces[1].AsSpan(5), NumberStyles.None, CultureInfo.InvariantCulture, out var status) && status is >= 100 and <= 599 &&
                pieces[1] == "HTTP " + status.ToString(CultureInfo.InvariantCulture);
        }
        if (reason != TransferFailureReason.Unknown) return false;
        if (kind != ConnectionFailureKind.LoginRequired) return pieces.Length == 1;
        if (pieces.Length is < 2 or > 3 || !pieces[1].StartsWith("auth=", StringComparison.Ordinal)) return false;
        var auth = pieces[1][5..].Split('/');
        if (auth.Length != 2 || !Named<LoginFailureOperation>(auth[0], out _) || !Named<LoginFailureReason>(auth[1], out var login)) return false;
        return login == LoginFailureReason.HttpUnauthorized ? pieces.Length == 3 && pieces[2] == "HTTP 401" : pieces.Length == 2;
    }
}
