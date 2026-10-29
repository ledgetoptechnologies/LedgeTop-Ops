using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace LedgeTop.Files.Updates;

// Private in-memory IPC ONLY. The account is a server-verified selected-session pseudonym, not a
// token-derived digest and not an authorization grant. Never persist/log these frames or this binding.
internal sealed record ExeUpdateAccountBinding(string PrincipalId, string SourceAlias);
internal sealed record ExeUpdateHelperOffer(ExeUpdateHandoff Handoff, ExeUpdateAccountBinding Account);
internal enum ExeUpdateIpcKind { Prepare, Ready, CommitExit, Armed, ExitNow, ExitCommitted, Disarm, Stopped }
internal sealed record ExeUpdateIpcFrame(int ProtocolVersion, ExeUpdateIpcKind Kind, Guid HandoffId,
    ExeUpdateHelperOffer? Offer = null);

internal interface IExeUpdateIpc
{
    Task<ExeUpdateIpcFrame> ReadAsync(CancellationToken token);
    Task WriteAsync(ExeUpdateIpcFrame frame, CancellationToken token);
}

/// <summary>Length-prefixed strict codec; callers must authenticate BOTH OS pipe peers before use.
/// This codec does not turn arbitrary streams, pipe names or nonce equality into trusted peers.</summary>
internal sealed class ExeUpdateIpc(Stream stream) : IExeUpdateIpc
{
    internal const int MaximumFrameBytes = 16 * 1024;
    private static readonly JsonSerializerOptions json = Options();
    private static JsonSerializerOptions Options()
    {
        var options = new JsonSerializerOptions {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            MaxDepth = 12, PropertyNameCaseInsensitive = false
        };
        options.Converters.Add(new JsonStringEnumConverter<ExeUpdateIpcKind>(allowIntegerValues: false));
        return options;
    }

    public async Task WriteAsync(ExeUpdateIpcFrame frame, CancellationToken token)
    {
        if (!Valid(frame)) throw new ExeUpdateProtocolException();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame, json);
        if (bytes.Length is <= 0 or > MaximumFrameBytes) throw new ExeUpdateProtocolException();
        var prefix = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(prefix, bytes.Length);
        await stream.WriteAsync(prefix, token).ConfigureAwait(false);
        await stream.WriteAsync(bytes, token).ConfigureAwait(false);
        await stream.FlushAsync(token).ConfigureAwait(false);
    }

    public async Task<ExeUpdateIpcFrame> ReadAsync(CancellationToken token)
    {
        var frameStarted = false;
        try {
            var prefix = new byte[4];
            var first = await stream.ReadAsync(prefix, token).ConfigureAwait(false);
            if (first == 0) throw new ExeUpdatePeerClosedException();
            frameStarted = true;
            if (first < prefix.Length) await stream.ReadExactlyAsync(prefix.AsMemory(first), token).ConfigureAwait(false);
            var length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
            if (length is <= 0 or > MaximumFrameBytes) throw new ExeUpdateProtocolException();
            var bytes = new byte[length]; await stream.ReadExactlyAsync(bytes, token).ConfigureAwait(false);
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 12 });
            Unique(document.RootElement);
            var frame = JsonSerializer.Deserialize<ExeUpdateIpcFrame>(bytes, json);
            if (!Valid(frame) || document.RootElement.GetProperty("protocolVersion").GetRawText() != "1" ||
                document.RootElement.GetProperty("kind").GetString() != frame!.Kind.ToString()) throw new ExeUpdateProtocolException();
            return frame!;
        }
        catch (OperationCanceledException) when (!frameStarted) { throw; }
        catch (ExeUpdatePeerClosedException) { throw; }
        catch { throw new ExeUpdateProtocolException(); }
    }

    internal static bool Valid(ExeUpdateIpcFrame? frame)
    {
        if (frame is null || frame.ProtocolVersion != 1 || frame.HandoffId == Guid.Empty || !Enum.IsDefined(frame.Kind)) return false;
        if (frame.Kind != ExeUpdateIpcKind.Prepare) return frame.Offer is null;
        var offer = frame.Offer;
        return offer?.Handoff is { } handoff && handoff.Id == frame.HandoffId &&
            ExeUpdateHandoffCoordinator.Valid(handoff.Candidate) && offer.Account is { } account &&
            Regex.IsMatch(account.PrincipalId ?? "", @"\Aodqp1_[a-f0-9]{64}\z") &&
            (account.SourceAlias == "employee" && handoff.Candidate.ApiBase == "/api/app" ||
             account.SourceAlias == "portal" && handoff.Candidate.ApiBase == "/api/client/app");
    }

    private static void Unique(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object) {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject()) {
                if (!names.Add(property.Name)) throw new ExeUpdateProtocolException();
                Unique(property.Value);
            }
        } else if (element.ValueKind == JsonValueKind.Array) foreach (var item in element.EnumerateArray()) Unique(item);
    }
}

internal sealed class ExeUpdateProtocolException() : Exception("The update handoff protocol was refused.");
internal sealed class ExeUpdatePeerClosedException() : IOException("The update peer closed its channel.");
