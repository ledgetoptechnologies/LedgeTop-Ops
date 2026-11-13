using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

public sealed record ExplorerRootScope(string Channel, string Alias, string Origin, string PrincipalId)
{
    internal void Validate()
    {
        if (Channel is not ("pilot" or "stable") || !Regex.IsMatch(Alias ?? "", "\\A[a-z0-9][a-z0-9_-]{0,63}\\z") ||
            !Regex.IsMatch(PrincipalId ?? "", "\\Aodqp1_[a-f0-9]{64}\\z") ||
            !Uri.TryCreate(Origin, UriKind.Absolute, out var origin) || origin.Scheme != "https" ||
            origin.UserInfo.Length != 0 || origin.Query.Length != 0 || origin.Fragment.Length != 0 ||
            origin.AbsolutePath != "/" || origin.GetLeftPart(UriPartial.Authority) != Origin)
            throw new TransferException("Explorer source scope is invalid.");
    }
}

/// <summary>Immutable, credentialless inventory. Its canonical digest binds a root generation to exact file versions.</summary>
public sealed class ExplorerRootManifest
{
    internal const int MaximumBytes = 8 * 1024 * 1024;
    private static readonly JsonSerializerOptions json = new() { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private sealed record Entry(string Path, PlaceholderIdentity Identity);
    private sealed record Envelope(int Schema, ExplorerRootScope Scope, Entry[] Files, string[] Directories);
    private readonly byte[] bytes;
    public ExplorerRootScope Scope { get; }
    public IReadOnlyDictionary<string, PlaceholderIdentity> Files { get; }
    public IReadOnlyList<string> Directories { get; }
    public string Digest { get; }

    public ExplorerRootManifest(ExplorerRootScope scope, IReadOnlyDictionary<string, PlaceholderIdentity> files,
        IEnumerable<string>? directories = null)
    {
        ArgumentNullException.ThrowIfNull(scope); ArgumentNullException.ThrowIfNull(files); scope.Validate();
        Scope = scope;
        var copied = new Dictionary<string, PlaceholderIdentity>(StringComparer.OrdinalIgnoreCase);
        var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in files) {
            Relative(pair.Key); ArgumentNullException.ThrowIfNull(pair.Value); pair.Value.Encode();
            var id = pair.Value;
            if (id.Length > (64L << 30) || id.Channel != scope.Channel || id.SourceAlias != scope.Alias || id.Origin != scope.Origin ||
                id.PrincipalId != scope.PrincipalId || id.FileName != Path.GetFileName(pair.Key) || !copied.TryAdd(pair.Key, id))
                throw new TransferException("Explorer inventory does not match its bound source or has duplicate paths.");
            Parents(pair.Key);
            Limit();
        }
        // Bound raw items as well as unique paths: a duplicate-only enumerable must not run forever.
        var directoryItems = 0;
        foreach (var directory in directories ?? []) {
            if (++directoryItems > 1000) throw new TransferException("The Explorer inventory exceeds the supported entry limit.");
            Relative(directory); folders.Add(directory); Parents(directory); Limit();
        }
        if (folders.Any(copied.ContainsKey)) throw new TransferException("An Explorer path cannot be both a file and a directory.");
        var ordered = copied.OrderBy(pair => pair.Key, StringComparer.Ordinal).ToArray();
        var orderedFolders = folders.Order(StringComparer.Ordinal).ToArray();
        Files = new ReadOnlyDictionary<string, PlaceholderIdentity>(ordered.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase));
        Directories = Array.AsReadOnly(orderedFolders);
        bytes = JsonSerializer.SerializeToUtf8Bytes(new Envelope(1, scope, ordered.Select(pair => new Entry(pair.Key, pair.Value)).ToArray(), orderedFolders), json);
        if (bytes.Length > MaximumBytes) throw new TransferException("The frozen Explorer manifest is too large.");
        Digest = Convert.ToHexStringLower(SHA256.HashData(bytes));

        void Parents(string relative) {
            for (var parent = Path.GetDirectoryName(relative); !string.IsNullOrEmpty(parent); parent = Path.GetDirectoryName(parent)) {
                folders.Add(parent); Limit();
            }
        }
        void Limit() { if (copied.Count + folders.Count > 1000) throw new TransferException("The Explorer inventory exceeds the supported entry limit."); }
    }

    internal byte[] Encode() => bytes.ToArray();
    internal static ExplorerRootManifest Decode(byte[] bytes)
    {
        if (bytes.Length is < 1 or > MaximumBytes) throw new IOException("The frozen Explorer inventory is unavailable.");
        try {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
            Unique(document.RootElement);
            var envelope = JsonSerializer.Deserialize<Envelope>(bytes, json) ?? throw new JsonException();
            if (envelope.Schema != 1 || envelope.Scope is null || envelope.Files is null || envelope.Directories is null)
                throw new JsonException();
            var entries = new Dictionary<string, PlaceholderIdentity>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in envelope.Files) {
                if (item is null || item.Path is null || item.Identity is null || !entries.TryAdd(item.Path, item.Identity)) throw new JsonException();
            }
            var result = new ExplorerRootManifest(envelope.Scope, entries, envelope.Directories);
            if (!result.bytes.AsSpan().SequenceEqual(bytes)) throw new JsonException();
            return result;
        } catch (Exception error) when (error is JsonException or ArgumentException or InvalidOperationException or TransferException) {
            throw new IOException("The frozen Explorer inventory is invalid.", error);
        }
    }

    private static void Relative(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 180 || Path.IsPathRooted(path) || path.Contains('/') || path.Split('\\').Length > 32)
            throw new TransferException("An Explorer inventory path is invalid.");
        foreach (var segment in path.Split('\\')) Downloader.SafeFileName(segment);
    }
    private static void Unique(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object) {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject()) {
                if (!names.Add(property.Name)) throw new JsonException(); Unique(property.Value);
            }
        } else if (element.ValueKind == JsonValueKind.Array) foreach (var item in element.EnumerateArray()) Unique(item);
    }
}
