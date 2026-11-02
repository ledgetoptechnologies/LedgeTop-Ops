using System.Security.Cryptography;
using System.Text.Json;

namespace LedgeTop.Files;

// Read-only startup recognition. It never starts a provider, adopts roots, authenticates,
// rewrites an index or authorizes removal; same-user races remain a HOLD, not proof.
internal static class FreshGenerationStartup
{
    internal static FreshGenerationIndexCodec.Index? Observe(string currentPath, string backupPath,
        string sid, string channel, string source, string originHash)
    {
        var current = ReadBounded(currentPath);
        using var document = JsonDocument.Parse(current, new JsonDocumentOptions { MaxDepth = 8 });
        if (document.RootElement.ValueKind != JsonValueKind.Object || !document.RootElement.TryGetProperty("Schema", out var schema) ||
            !schema.TryGetInt32(out var number) || number != 2) return null;
        var index = FreshGenerationIndexCodec.Decode(current);
        if (index.Sid != sid || index.Channel != channel || index.Source != source || index.OriginSha256 != originHash ||
            !System.Text.RegularExpressions.Regex.IsMatch(index.Principal ?? "", "\\Aodqp1_[a-f0-9]{64}\\z"))
            throw new IOException("The fresh-generation selector does not match this account and source.");
        var backup = ReadBounded(backupPath);
        if (Convert.ToHexStringLower(SHA256.HashData(backup)) != index.LegacyBackupSha256 ||
            !ReadBounded(currentPath).AsSpan().SequenceEqual(current))
            throw new IOException("The fresh-generation selector or retained legacy index changed.");
        return index;
    }
    private static byte[] ReadBounded(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is < 1 or > 16384 || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new IOException("The fresh-generation selector is missing or invalid.");
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length != info.Length) throw new IOException("The fresh-generation selector changed while opening.");
        var bytes = new byte[(int)input.Length]; input.ReadExactly(bytes); return bytes;
    }
}
