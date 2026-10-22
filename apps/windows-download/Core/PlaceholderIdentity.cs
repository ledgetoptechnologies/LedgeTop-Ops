using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

/// <summary>Non-authorizing immutable placeholder pins. Never contains a byte URL or credential.</summary>
public sealed record PlaceholderIdentity(string Channel, string SourceAlias, string Origin, string PrincipalId,
    string ResourceReference, string LogicalFileId, string RemoteVersion, string FileName, long Length, string ETag, string Sha256)
{
    public void Validate()
    {
        if (Channel is not ("pilot" or "stable") || !Regex.IsMatch(SourceAlias ?? "", "\\A[a-z0-9][a-z0-9_-]{0,63}\\z")
            || !Uri.TryCreate(Origin, UriKind.Absolute, out var origin) || origin.Scheme != "https"
            || origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0
            || origin.AbsolutePath != "/" || origin.GetLeftPart(UriPartial.Authority) != Origin
            || !Regex.IsMatch(PrincipalId ?? "", "\\Aodqp1_[a-f0-9]{64}\\z")
            || !Regex.IsMatch(ResourceReference ?? "", "\\Aodqr1_[A-Za-z0-9_-]{1,16378}\\z")
            || !Regex.IsMatch(LogicalFileId ?? "", "\\A(?:oef1|ondf1)_[a-f0-9]{64}\\z")
            || string.IsNullOrEmpty(RemoteVersion) || RemoteVersion.Length > 256 || RemoteVersion.Any(char.IsControl)
            || Length < 0 || Length > (1L << 40) || !Regex.IsMatch(Sha256 ?? "", "\\A[a-f0-9]{64}\\z")
            || ETag is null || ETag.Length > 512 || !EntityTagHeaderValue.TryParse(ETag, out var tag) || tag.IsWeak || tag.Tag == "*" || tag.ToString() != ETag)
            throw new TransferException("Placeholder identity is invalid.");
        Downloader.SafeFileName(FileName);
    }
    public byte[] Encode()
    {
        Validate(); var bytes = JsonSerializer.SerializeToUtf8Bytes(new Envelope(1, this));
        if (bytes.Length > 4096) throw new TransferException("Placeholder identity is too large."); return bytes;
    }
    public static PlaceholderIdentity Decode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length > 4096) throw new TransferException("Placeholder identity is too large.");
        try {
            using var doc = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = 4 });
            Unique(doc.RootElement);
            Exact(doc.RootElement, ["Version", "Identity"]);
            Exact(doc.RootElement.GetProperty("Identity"), ["Channel", "SourceAlias", "Origin", "PrincipalId", "ResourceReference", "LogicalFileId", "RemoteVersion", "FileName", "Length", "ETag", "Sha256"]);
            var value = JsonSerializer.Deserialize<Envelope>(bytes, new JsonSerializerOptions { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow })
                ?? throw new JsonException();
            if (value.Version != 1 || value.Identity is null) throw new JsonException(); value.Identity.Validate(); return value.Identity;
        } catch (Exception e) when (e is JsonException or InvalidOperationException or ArgumentException) { throw new TransferException("Placeholder identity is invalid."); }
    }
    private static void Exact(JsonElement value, string[] names) {
        if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(names.Order())) throw new JsonException();
    }
    private static void Unique(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return;
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in element.EnumerateObject()) { if (!names.Add(p.Name)) throw new JsonException(); Unique(p.Value); }
    }
    internal string CacheKey => Convert.ToHexStringLower(SHA256.HashData(Encode()));
    internal string ScopeKey => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { Channel, SourceAlias, Origin, PrincipalId }))));
    private sealed record Envelope(int Version, PlaceholderIdentity Identity);
}
