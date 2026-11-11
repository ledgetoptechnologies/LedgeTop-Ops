using System.Globalization;
using System.Diagnostics;
using System.Text.Json;
using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

// Optional local staging evidence, never authority. No exception text, account,
// filename, URL, path, token, or arbitrary native status is persisted.
internal static class HydrationFailureDiagnosticStore
{
    internal sealed record Observation(HydrationStage Stage, HydrationFailureCategory Category, TransferFailureReason Reason, int? HttpStatus,
        LoginFailureOperation? LoginOperation = null, LoginFailureReason? LoginReason = null, AccessDenialReason? AccessReason = null,
        DenialOperation? DenialOperation = null, DenialMediaType? DenialMediaType = null);
    internal const string Leaf = "latest-hydration-failure.json";
    private const string Temp = ".latest-hydration-failure.write.tmp", Owner = "LedgeTop.Files.HydrationFailure/1";
    private static readonly object Writes = new();
    internal static Observation FromDiagnostic(HydrationFailureDiagnostic value) => new(value.Stage,value.Category,value.Reason,
        value.HttpStatus ?? (value.LoginReason == LoginFailureReason.HttpUnauthorized ? 401 : null), value.LoginOperation,value.LoginReason,value.AccessReason,value.DenialOperation,value.DenialMediaType);
    private static bool Valid(Observation value) => Enum.IsDefined(value.Stage) && Enum.IsDefined(value.Category) && Enum.IsDefined(value.Reason) &&
        value.LoginOperation.HasValue == value.LoginReason.HasValue &&
        (value.AccessReason is not { } denial || Enum.IsDefined(denial) && value.Category == HydrationFailureCategory.AccessDenied) &&
        value.DenialOperation.HasValue == value.DenialMediaType.HasValue &&
        (value.DenialOperation is not { } denialOp || Enum.IsDefined(denialOp) && value.AccessReason == AccessDenialReason.HttpForbidden) &&
        (value.DenialMediaType is not { } media || Enum.IsDefined(media)) &&
        (value.LoginOperation is not { } operation || Enum.IsDefined(operation) && value.Category == HydrationFailureCategory.LoginRequired) &&
        (value.LoginReason is not { } login || Enum.IsDefined(login) && value.Category == HydrationFailureCategory.LoginRequired) &&
        (value.LoginReason != LoginFailureReason.HttpUnauthorized || value.HttpStatus == 401) &&
        (value.Reason == TransferFailureReason.UnexpectedHttpStatus ? value.HttpStatus is >= 100 and <= 599 :
            value.LoginReason == LoginFailureReason.HttpUnauthorized ? value.HttpStatus == 401 : value.HttpStatus is null);
    internal static void TrySave(string directory, Func<bool> owned, Observation value, DateTimeOffset utc)
    {
        try {
            // V1 readers predating ServiceBusy require a known reason and matching status.
            // Activity retains the precise in-memory reason; persisted evidence stays legacy-readable.
            if (value.Reason == TransferFailureReason.LocalCacheReview) {
                if (value.Category != HydrationFailureCategory.Transfer || value.HttpStatus is not null) return;
                // V1 readers must continue to accept the persisted record; precise guidance remains in memory.
                value = value with { Reason = TransferFailureReason.Unknown };
            }
            if (value.Reason == TransferFailureReason.ServiceBusy) {
                if (value.Category != HydrationFailureCategory.Transfer || value.HttpStatus is not null) return;
                value = value with { Reason = TransferFailureReason.UnexpectedHttpStatus, HttpStatus = 503 };
            }
            if (!Valid(value) || utc.Offset != TimeSpan.Zero || utc < DateTimeOffset.UnixEpoch || !Path.IsPathFullyQualified(directory) ||
                directory.StartsWith(@"\\",StringComparison.Ordinal) || Path.GetFullPath(directory) != directory ||
                Path.GetFileName(directory) != "connected-explorer-pilot-employee") return;
            if (Path.Combine(directory,Leaf).Length > 240 || Path.Combine(directory,Temp).Length > 240) return;
            using var process=Process.GetCurrentProcess();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion=1,owner=Owner,observedAtUtc=utc.ToString("O",CultureInfo.InvariantCulture),
                processId=process.Id,processStartUtcTicks=process.StartTime.ToUniversalTime().Ticks,
                stage=value.Stage.ToString(),category=value.Category.ToString(),reason=value.Reason.ToString(),httpStatus=value.HttpStatus,
                loginOperation=value.LoginOperation?.ToString(),loginReason=value.LoginReason?.ToString(),accessReason=value.AccessReason?.ToString(),
                denialOperation=value.DenialOperation?.ToString(),denialMediaType=value.DenialMediaType?.ToString() });
            if (bytes.Length > 1024) return;
            lock (Writes) {
                if (!owned()) return;
                var fence=new VerifiedInstalledPayload(directory);
                try {
                    var ancestors=new Stack<string>(); for (string? part=directory;part is not null;part=Path.GetDirectoryName(part)) ancestors.Push(part);
                    while (ancestors.TryPop(out var part)) fence.HoldDirectory(part);
                    var previous=ReadRaw(directory,Leaf); if (previous is not null && Decode(previous)>utc) return;
                    var temporary=Path.Combine(directory,Temp); var created=false;
                    try {
                        using (var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough)) { created=true; stream.Write(bytes); stream.Flush(true); }
                        if (!owned()) return;
                        var current=ReadRaw(directory,Leaf); if (current is not null) _=Decode(current);
                        if (previous is null ? current is not null : current is null || !previous.AsSpan().SequenceEqual(current)) return;
                        File.Move(temporary,Path.Combine(directory,Leaf),overwrite:previous is not null); created=false;
                    } finally { if (created) try { var own=ReadRaw(directory,Temp); if (own is not null && own.AsSpan().SequenceEqual(bytes)) File.Delete(temporary); } catch { } }
                } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
            }
        } catch { /* Failure evidence is optional and never changes transfer behavior. */ }
    }
    private static byte[]? ReadRaw(string directory,string leaf)
    {
        try { _=File.GetAttributes(Path.Combine(directory,leaf)); } catch (FileNotFoundException) { return null; } catch (DirectoryNotFoundException) { return null; }
        var fence=new VerifiedInstalledPayload(directory);
        try { var stream=fence.HoldFile(leaf); if (stream.Length is < 2 or > 1024) throw new IOException(); var bytes=new byte[(int)stream.Length]; stream.ReadExactly(bytes); return bytes; }
        finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
    }
    private static DateTimeOffset Decode(byte[] bytes)
    {
        using var doc=JsonDocument.Parse(bytes,new JsonDocumentOptions { MaxDepth=2 }); var root=doc.RootElement;
        if (root.ValueKind!=JsonValueKind.Object) throw new IOException(); var keys=new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in root.EnumerateObject()) if (!keys.Add(field.Name) || field.Name is not ("schemaVersion" or "owner" or "observedAtUtc" or "processId" or "processStartUtcTicks" or "stage" or "category" or "reason" or "httpStatus" or "loginOperation" or "loginReason" or "accessReason" or "denialOperation" or "denialMediaType")) throw new IOException();
        var optionalShape = (keys.Contains("accessReason"), keys.Contains("denialOperation"), keys.Contains("denialMediaType"));
        if ((keys.Count, optionalShape) is not ((11, (false, false, false)) or (12, (true, false, false)) or (14, (true, true, true))) || root.GetProperty("schemaVersion").GetRawText()!="1" || root.GetProperty("owner").GetString()!=Owner ||
            root.GetProperty("processId").GetInt32()<=0 || root.GetProperty("processStartUtcTicks").GetInt64()<=0 ||
            !Named(root.GetProperty("stage").GetString(),out HydrationStage stage) || !Named(root.GetProperty("category").GetString(),out HydrationFailureCategory category) ||
            !Named(root.GetProperty("reason").GetString(),out TransferFailureReason reason)) throw new IOException();
        var status=root.GetProperty("httpStatus"); int? http=status.ValueKind==JsonValueKind.Null ? null : status.GetInt32();
        var opValue=root.GetProperty("loginOperation"); var reasonValue=root.GetProperty("loginReason");
        LoginFailureOperation? op=null; LoginFailureReason? login=null;
        if (opValue.ValueKind!=JsonValueKind.Null) { if (!Named(opValue.GetString(),out LoginFailureOperation parsed)) throw new IOException(); op=parsed; }
        if (reasonValue.ValueKind!=JsonValueKind.Null) { if (!Named(reasonValue.GetString(),out LoginFailureReason parsed)) throw new IOException(); login=parsed; }
        AccessDenialReason? denial=null;
        if (root.TryGetProperty("accessReason",out var denialValue) && denialValue.ValueKind!=JsonValueKind.Null) { if (!Named(denialValue.GetString(),out AccessDenialReason parsed)) throw new IOException(); denial=parsed; }
        DenialOperation? denialOp=null; DenialMediaType? denialMedia=null;
        if (root.TryGetProperty("denialOperation",out var denialOpValue) && denialOpValue.ValueKind!=JsonValueKind.Null) { if (!Named(denialOpValue.GetString(),out DenialOperation parsed)) throw new IOException(); denialOp=parsed; }
        if (root.TryGetProperty("denialMediaType",out var denialMediaValue) && denialMediaValue.ValueKind!=JsonValueKind.Null) { if (!Named(denialMediaValue.GetString(),out DenialMediaType parsed)) throw new IOException(); denialMedia=parsed; }
        if (!Valid(new(stage,category,reason,http,op,login,denial,denialOp,denialMedia)) || !DateTimeOffset.TryParseExact(root.GetProperty("observedAtUtc").GetString(),"O",CultureInfo.InvariantCulture,DateTimeStyles.None,out var utc) ||
            utc.Offset!=TimeSpan.Zero || utc<DateTimeOffset.UnixEpoch) throw new IOException();
        return utc;
    }
    private static bool Named<T>(string? text,out T value) where T:struct,Enum =>
        Enum.TryParse(text,false,out value) && Enum.IsDefined(value) && value.ToString()==text;
}
