using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace LedgeTop.Files;

// Schema-2 selector codec, deliberately unwired. It is data validation, not a trusted
// ownership receipt or a filesystem lease; callers must verify real roots and durable CAS.
internal static class FreshGenerationIndexCodec
{
    internal const string Owner = "LedgeTop.Files.ConnectedExplorer.Generations/1";
    internal sealed record Index(int Schema, string Owner, string Sid, string Channel, string Source,
        string OriginSha256, string Principal, string LegacyBackupSha256, long Revision, FreshGenerationPlan.State State, Guid ActiveGeneration);
    private static readonly JsonSerializerOptions Json = new() { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, MaxDepth = 8 };
    internal static byte[] Encode(Index index)
    {
        Validate(index); var bytes = JsonSerializer.SerializeToUtf8Bytes(index, Json);
        if (bytes.Length is < 1 or > 16384) throw new IOException("Fresh generation index exceeds its bound.");
        return bytes;
    }
    internal static Index Decode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is < 1 or > 16384) throw new IOException("Fresh generation index size is invalid.");
        using var document = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = 8 });
        NoDuplicateProperties(document.RootElement);
        var index = JsonSerializer.Deserialize<Index>(bytes, Json) ?? throw new IOException("Fresh generation index is missing.");
        Validate(index); return index;
    }
    private static void NoDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object) {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in element.EnumerateObject()) {
                if (!names.Add(p.Name)) throw new IOException("Duplicate selector property.");
                NoDuplicateProperties(p.Value);
            }
        } else if (element.ValueKind == JsonValueKind.Array) {
            foreach (var value in element.EnumerateArray()) NoDuplicateProperties(value);
        }
    }
    private static bool IsSha(string? value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static void Validate(Index index)
    {
        if (index.Schema != 2 || index.Owner != Owner || string.IsNullOrWhiteSpace(index.Sid) || index.Revision < 1 ||
            !IsSha(index.OriginSha256) || !IsSha(index.LegacyBackupSha256) ||
            index.State is null || index.State.Old is null || index.State.New is null)
            throw new IOException("Fresh generation index is invalid.");
        var old = index.State.Old; var next = index.State.New;
        if (old.Scope is null || next.Scope is null || string.IsNullOrWhiteSpace(old.Scope.Origin) ||
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(old.Scope.Origin))) != index.OriginSha256)
            throw new IOException("Fresh generation origin mismatch.");
        var scope = new FreshGenerationPlan.Scope(index.Channel, index.Source, old.Scope.Origin, index.Principal);
        // The owning coordinator must independently recheck the authenticated principal and trusted origin.
        if (old.Scope != scope || next.Scope != scope) throw new IOException("Fresh generation scope mismatch.");
        var clean = new FreshGenerationPlan.State(old, null, FreshGenerationPlan.Phase.OldActive);
        var prepared = FreshGenerationPlan.Prepare(clean, next, scope, true, true);
        var expected = index.State.Phase switch {
            FreshGenerationPlan.Phase.Prepared => prepared,
            FreshGenerationPlan.Phase.OldDrained => FreshGenerationPlan.Drained(prepared, true),
            FreshGenerationPlan.Phase.NewReady => FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope, next.Id, next.ManifestDigest, next.RootPath, index.State.ReadyRoot!, true),
            FreshGenerationPlan.Phase.Published => FreshGenerationPlan.Publish(FreshGenerationPlan.Ready(FreshGenerationPlan.Drained(prepared, true), scope, next.Id, next.ManifestDigest, next.RootPath, index.State.ReadyRoot!, true), true),
            _ => throw new IOException("Unknown fresh-generation phase.")
        };
        if (index.State != expected || index.ActiveGeneration != (index.State.Phase == FreshGenerationPlan.Phase.Published ? next.Id : old.Id))
            throw new IOException("Fresh generation selector and phase disagree.");
    }
}
