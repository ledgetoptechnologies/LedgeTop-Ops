using System.Security.Cryptography;

namespace LedgeTop.Files.Explorer;

/// <summary>Approved Operations favicon, retained at a stable per-user, digest-addressed path.
/// Shell registration outlives portable downloads and installed package versions. Never overwrite
/// unexpected bytes or follow directory/file aliases. This public branding asset grants no root ownership.</summary>
internal static class ExplorerBrandIcon
{
    internal const string Digest = "4475e1abc388373b2e6c77b91e229e55e65b4efa1435e5aa816056873ad30e36";
    internal static string LegacyResource => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3";
    internal static string DirectoryPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTopFiles", "Branding");
    internal static string Resource => Path.Combine(DirectoryPath, "explorer-" + Digest + ".ico") + ",0";
    internal static bool IsKnownResource(string value) => value == LegacyResource || value == Resource;

    internal static string EnsureResource() => EnsureInDirectory(DirectoryPath);

    // Directory override is internal and used only by isolated file-policy tests, never by profile data.
    internal static string EnsureInDirectory(string directory)
    {
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\", StringComparison.Ordinal) ||
            Path.GetFullPath(directory) != directory) throw new IOException("The icon directory must be canonical and local.");
        ValidateAncestors(directory);
        Directory.CreateDirectory(directory);
        ValidateAncestors(directory);
        var path = Path.Combine(directory, "explorer-" + Digest + ".ico");
        if (Directory.Exists(path)) throw new IOException("The durable Explorer icon changed into a directory; it was not replaced.");
        using var resource = typeof(ExplorerBrandIcon).Assembly.GetManifestResourceStream("LedgeTop.Files.Explorer.Brand.ico")
            ?? throw new IOException("The approved Explorer branding resource is unavailable.");
        using var contents = new MemoryStream(); resource.CopyTo(contents);
        var bytes = contents.ToArray();
        if (bytes.Length != 1889 || Convert.ToHexStringLower(SHA256.HashData(bytes)) != Digest ||
            !bytes.AsSpan(0, 4).SequenceEqual(new byte[] { 0, 0, 1, 0 }))
            throw new IOException("The embedded Explorer branding resource differs from the approved icon.");
        if (!File.Exists(path))
        {
            // CreateNew preserves a racing/unknown existing object, including dangling reparse points.
            using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
            output.Write(bytes); output.Flush(flushToDisk: true);
        }
        ValidateAncestors(directory);
        var info = new FileInfo(path);
        if (!info.Exists || info.Length != bytes.Length || (info.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
            throw new IOException("The durable Explorer icon changed type or size; it was not replaced.");
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (Convert.ToHexStringLower(SHA256.HashData(input)) != Digest)
            throw new IOException("The durable Explorer icon bytes changed; they were not overwritten.");
        return path + ",0";
    }

    private static void ValidateAncestors(string directory)
    {
        for (var current = new DirectoryInfo(directory); current is not null; current = current.Parent)
        {
            if (File.Exists(current.FullName)) throw new IOException("An icon directory changed type.");
            // Attributes also observes existing directory junctions; do not traverse them.
            if (current.LinkTarget is not null || current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("An icon directory is an unsupported alias.");
        }
    }
}
