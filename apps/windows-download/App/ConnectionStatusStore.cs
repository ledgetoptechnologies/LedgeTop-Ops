using System.Diagnostics;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

internal enum FreshActionObservation { Unknown, Preparing, Completed, Failed, NeedsReview }

// Best-effort, last-observed status only; never an authorization or current-liveness proof.
// Contains no account identifiers, paths, file names, credentials, or server responses.
internal static class ConnectionStatusStore
{
    internal const string Leaf = "last-connection-status.json";
    private const string Temporary = ".last-connection-status.write.tmp";
    private const string Owner = "LedgeTop.Files.ConnectionStatus/1";
    private static readonly object Writes = new();
    // True only means this write was read back while ownership was still held.
    // It is diagnostic evidence, not a durable transaction or lifecycle authority.
    internal static bool TrySave(string directory, Func<bool> owned, ExplorerPreviewState state, bool fresh, DateTimeOffset utc,
        FreshActionObservation action = FreshActionObservation.Unknown, DateTimeOffset? actionAtUtc = null)
    {
        try {
            if (!Enum.IsDefined(state) || !Enum.IsDefined(action) || (action == FreshActionObservation.Unknown) != (actionAtUtc is null) ||
                actionAtUtc is { } actionTime && (actionTime.Offset != TimeSpan.Zero || actionTime < DateTimeOffset.UnixEpoch) ||
                utc.Offset != TimeSpan.Zero || utc < DateTimeOffset.UnixEpoch ||
                !Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\", StringComparison.Ordinal) ||
                Path.GetFullPath(directory) != directory || Path.GetFileName(directory) != "connected-explorer-pilot-employee") return false;
            if (Path.Combine(directory,Leaf).Length > 240 || Path.Combine(directory,Temporary).Length > 240) return false;
            using var process = Process.GetCurrentProcess();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 2, owner = Owner, observedAtUtc = utc.ToString("O"),
                appVersion = typeof(ConnectionStatusStore).Assembly.GetName().Version?.ToString(4) ?? "0.0.0.0",
                processId = process.Id, processStartUtcTicks = process.StartTime.ToUniversalTime().Ticks,
                state = state.ToString(), freshReadOnly = fresh, freshAction = action.ToString(), freshActionAtUtc = actionAtUtc?.ToString("O") });
            if (bytes.Length > 1024) return false;
            lock (Writes) {
                if (!owned()) return false;
                var fence = new VerifiedInstalledPayload(directory);
                try {
                    var ancestors = new Stack<string>(); for (string? part = directory; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
                    while (ancestors.TryPop(out var part)) fence.HoldDirectory(part);
                    var previous = ReadRaw(directory, Leaf);
                    if (previous is not null && Decode(previous) > utc) return false;
                    var temporary = Path.Combine(directory, Temporary); var created = false;
                    try {
                        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                            created = true; stream.Write(bytes); stream.Flush(true);
                        }
                        if (!owned()) return false;
                        var current = ReadRaw(directory, Leaf);
                        if (current is not null) _ = Decode(current);
                        if (previous is null ? current is not null : current is null || !previous.AsSpan().SequenceEqual(current)) return false;
                        File.Move(temporary, Path.Combine(directory, Leaf), overwrite: previous is not null); created = false;
                        var published = ReadRaw(directory, Leaf);
                        if (!owned() || published is null || !published.AsSpan().SequenceEqual(bytes)) return false;
                    } finally {
                        if (created) try { var own = ReadRaw(directory, Temporary); if (own is not null && own.AsSpan().SequenceEqual(bytes)) File.Delete(temporary); } catch { }
                    }
                } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
            }
            return true;
        } catch { return false; /* Diagnostics never change connection lifecycle. */ }
    }
    private static byte[]? ReadRaw(string directory, string leaf)
    {
        try { _ = File.GetAttributes(Path.Combine(directory, leaf)); } catch (FileNotFoundException) { return null; } catch (DirectoryNotFoundException) { return null; }
        var fence = new VerifiedInstalledPayload(directory);
        try { var stream = fence.HoldFile(leaf); if (stream.Length is < 2 or > 1024) throw new IOException(); var b = new byte[(int)stream.Length]; stream.ReadExactly(b); return b; }
        finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
    }
    private static DateTimeOffset Decode(byte[] bytes)
    {
        using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 2 }); var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new IOException();
        var fields = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject()) if (!fields.Add(field.Name) || field.Name is not ("schemaVersion" or "owner" or "observedAtUtc" or "appVersion" or "processId" or "processStartUtcTicks" or "state" or "freshReadOnly" or "freshAction" or "freshActionAtUtc")) throw new IOException();
        var schema = root.GetProperty("schemaVersion").GetInt32();
        if ((schema == 1 && fields.Count != 8) || (schema == 2 && fields.Count != 10) || schema is not (1 or 2) || root.GetProperty("owner").GetString() != Owner ||
            !Version.TryParse(root.GetProperty("appVersion").GetString(), out var v) || v.Revision < 0 ||
            root.GetProperty("processId").GetInt32() <= 0 || root.GetProperty("processStartUtcTicks").GetInt64() <= 0 ||
            !Enum.TryParse<ExplorerPreviewState>(root.GetProperty("state").GetString(), false, out var s) || !Enum.IsDefined(s) || root.GetProperty("state").GetString() != s.ToString() ||
            root.GetProperty("freshReadOnly").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !DateTimeOffset.TryParseExact(root.GetProperty("observedAtUtc").GetString(), "O", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var utc) || utc.Offset != TimeSpan.Zero)
            throw new IOException();
        if (schema == 2) {
            var actionText = root.GetProperty("freshAction").GetString(); var actionTime = root.GetProperty("freshActionAtUtc");
            if (!Enum.TryParse<FreshActionObservation>(actionText, false, out var action) || !Enum.IsDefined(action) || actionText != action.ToString() ||
                (action == FreshActionObservation.Unknown ? actionTime.ValueKind != JsonValueKind.Null :
                    !DateTimeOffset.TryParseExact(actionTime.GetString(), "O", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var parsed) || parsed.Offset != TimeSpan.Zero)) throw new IOException();
        }
        return utc;
    }
}
