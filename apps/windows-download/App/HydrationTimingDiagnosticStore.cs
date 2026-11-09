using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

// Closed, numeric-only last observation; never an authorization, heartbeat or live-state proof.
internal static class HydrationTimingDiagnosticStore
{
    internal sealed record Observation(string Outcome, string Cache, long[] Values);
    internal const string Leaf = "last-hydration-timing.json";
    private const string Temp = ".last-hydration-timing.write.tmp", Owner = "LedgeTop.Files.HydrationTiming/1";
    private static readonly object Writes = new();
    private static readonly string[] Names = ["totalMs", "contextMs", "queueMs", "authBeforeMs", "cachePrepareMs", "downloadMs", "cacheVerifyMs", "authAfterMs", "nativeTransferMs", "authBeforeTokenMs", "authBeforeHeadersMs", "authAfterTokenMs", "authAfterHeadersMs", "authBeforeTokenCount", "authBeforeHeadersCount", "authAfterTokenCount", "authAfterHeadersCount"];
    private static readonly string[] DownloadNames = ["downloadHeadersMs", "downloadBodyMs", "downloadFlushMs", "downloadHashMs"];
    private static readonly string[] CacheNames = ["cacheQuotaWaitMs", "cacheQuotaHeldMs", "cacheWalkMs", "reservationScanMs"];
    internal static Observation? Parse(string? text)
    {
        if (text is null || text.Length > 2048) return null;
        var parts = text.Split("; ", StringSplitOptions.None);
        if (parts.Length < 19 || parts.Length > 28 || !parts[0].StartsWith("Hydration timing: outcome=", StringComparison.Ordinal) || !parts[1].StartsWith("cache=", StringComparison.Ordinal)) return null;
        var outcome = parts[0]["Hydration timing: outcome=".Length..]; var cache = parts[1]["cache=".Length..];
        if (outcome is not ("Completed" or "Cancelled" or "Failed") || cache is not ("Unknown" or "Hit" or "Miss")) return null;
        var values = new long[Names.Length];
        for (var i = 0; i < Names.Length; i++) {
            var prefix = Names[i] + "="; if (!parts[i + 2].StartsWith(prefix, StringComparison.Ordinal)) return null;
            var value = parts[i + 2][prefix.Length..];
            if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < 0 || n > (i < 13 ? 86_400_000 : 1000) || n.ToString(CultureInfo.InvariantCulture) != value) return null;
            values[i] = n;
        }
        // Extra measurements stay Activity-only. Parse the closed suffix so the primary
        // observation remains byte-compatible with older builds and rollback behavior.
        var cursor = Names.Length + 2;
        if (parts.Length - cursor >= DownloadNames.Length && parts[cursor].StartsWith(DownloadNames[0] + "=", StringComparison.Ordinal)) {
            if (!ValidateSuffix(parts, ref cursor, DownloadNames)) return null;
        }
        if (parts.Length - cursor >= CacheNames.Length && parts[cursor].StartsWith(CacheNames[0] + "=", StringComparison.Ordinal)) {
            if (!ValidateSuffix(parts, ref cursor, CacheNames)) return null;
        }
        if (cursor < parts.Length) {
            var protocol = parts[cursor++].AsSpan();
            if (protocol.Length < 21 || protocol[0] != 'c' || protocol[1] != 'o' || protocol[2] != 'n' || protocol[3] != 't' ||
                protocol[4] != 'e' || protocol[5] != 'n' || protocol[6] != 't' || protocol[7] != 'P' || protocol[8] != 'r' ||
                protocol[9] != 'o' || protocol[10] != 't' || protocol[11] != 'o' || protocol[12] != 'c' || protocol[13] != 'o' ||
                protocol[14] != 'l' || protocol[15] != '=') return null;
            protocol = protocol[16..];
            var supported = protocol.Length switch {
                8 => protocol[0] == 'H' && protocol[1] == 'T' && protocol[2] == 'T' && protocol[3] == 'P' && protocol[4] == '/' &&
                    protocol[5] == '1' && protocol[6] == '.' && (protocol[7] == '0' || protocol[7] == '1'),
                6 => protocol[0] == 'H' && protocol[1] == 'T' && protocol[2] == 'T' && protocol[3] == 'P' && protocol[4] == '/' &&
                    (protocol[5] == '2' || protocol[5] == '3'),
                5 => protocol[0] == 'O' && protocol[1] == 't' && protocol[2] == 'h' && protocol[3] == 'e' && protocol[4] == 'r',
                _ => false,
            };
            if (!supported) return null;
        }
        if (cursor != parts.Length) return null;
        if (values[13..].All(v => v == 0)) return null;
        return new(outcome, cache, values);
    }
    private static bool ValidateSuffix(string[] parts, ref int cursor, string[] names)
    {
        if (parts.Length - cursor < names.Length) return false;
        for (var i = 0; i < names.Length; i++) {
            var prefix = names[i] + "="; var part = parts[cursor++];
            if (!part.StartsWith(prefix, StringComparison.Ordinal)) return false;
            var textValue = part[prefix.Length..];
            if (!long.TryParse(textValue, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < 0 || n > 86_400_000 || n.ToString(CultureInfo.InvariantCulture) != textValue) return false;
        }
        return true;
    }
    internal static void TrySave(string directory, Func<bool> owned, Observation value, DateTimeOffset utc)
    {
        try {
            if (!Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\", StringComparison.Ordinal) || Path.GetFullPath(directory) != directory ||
                Path.GetFileName(directory) != "connected-explorer-pilot-employee" || utc.Offset != TimeSpan.Zero || value.Values.Length != Names.Length ||
                value.Outcome is not ("Completed" or "Cancelled" or "Failed") || value.Cache is not ("Unknown" or "Hit" or "Miss") ||
                value.Values.Where((n, i) => n < 0 || n > (i < 13 ? 86_400_000 : 1000)).Any()) return;
            if (Path.Combine(directory,Leaf).Length > 240 || Path.Combine(directory,Temp).Length > 240) return;
            using var process = Process.GetCurrentProcess();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, owner = Owner, observedAtUtc = utc.ToString("O"), processId = process.Id,
                processStartUtcTicks = process.StartTime.ToUniversalTime().Ticks, outcome = value.Outcome, cache = value.Cache, values = value.Values });
            if (bytes.Length > 2048) return;
            lock (Writes) {
                if (!owned()) return;
                var fence = new VerifiedInstalledPayload(directory);
                try {
                    var ancestors = new Stack<string>(); for (string? part = directory; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
                    while (ancestors.TryPop(out var part)) fence.HoldDirectory(part);
                    var previous = ReadRaw(directory, Leaf); if (previous is not null && Decode(previous) > utc) return;
                    var temporary = Path.Combine(directory, Temp); var created = false;
                    try {
                        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { created = true; stream.Write(bytes); stream.Flush(true); }
                        if (!owned()) return;
                        var current = ReadRaw(directory, Leaf); if (current is not null) _ = Decode(current);
                        if (previous is null ? current is not null : current is null || !previous.AsSpan().SequenceEqual(current)) return;
                        File.Move(temporary, Path.Combine(directory, Leaf), overwrite: previous is not null); created = false;
                    } finally { if (created) try { var own = ReadRaw(directory, Temp); if (own is not null && own.AsSpan().SequenceEqual(bytes)) File.Delete(temporary); } catch { } }
                } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
            }
        } catch { /* Optional local observation never affects transfers or connection lifecycle. */ }
    }
    private static byte[]? ReadRaw(string directory, string leaf)
    {
        try { _ = File.GetAttributes(Path.Combine(directory, leaf)); } catch (FileNotFoundException) { return null; } catch (DirectoryNotFoundException) { return null; }
        var fence = new VerifiedInstalledPayload(directory);
        try { var stream = fence.HoldFile(leaf); if (stream.Length is < 2 or > 2048) throw new IOException(); var bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes); return bytes; }
        finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
    }
    private static DateTimeOffset Decode(byte[] bytes)
    {
        using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 3 }); var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new IOException(); var fields = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject()) if (!fields.Add(field.Name) || field.Name is not ("schemaVersion" or "owner" or "observedAtUtc" or "processId" or "processStartUtcTicks" or "outcome" or "cache" or "values")) throw new IOException();
        if (fields.Count != 8 || root.GetProperty("schemaVersion").GetInt32() != 1 || root.GetProperty("owner").GetString() != Owner ||
            root.GetProperty("processId").GetInt32() <= 0 || root.GetProperty("processStartUtcTicks").GetInt64() <= 0 ||
            root.GetProperty("outcome").GetString() is not ("Completed" or "Cancelled" or "Failed") || root.GetProperty("cache").GetString() is not ("Unknown" or "Hit" or "Miss") ||
            !DateTimeOffset.TryParseExact(root.GetProperty("observedAtUtc").GetString(), "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var utc) || utc.Offset != TimeSpan.Zero) throw new IOException();
        var values = root.GetProperty("values"); if (values.ValueKind != JsonValueKind.Array || values.GetArrayLength() != Names.Length) throw new IOException();
        var i = 0; foreach (var value in values.EnumerateArray()) { if (!value.TryGetInt64(out var n) || n < 0 || n > (i++ < 13 ? 86_400_000 : 1000)) throw new IOException(); }
        return utc;
    }
}
