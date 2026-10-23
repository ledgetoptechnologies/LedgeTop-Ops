namespace LedgeTop.Files.Backends;

/// <summary>
/// Remembers which kind of files this person last chose on this PC, per release channel. It is a convenience only:
/// it never grants access, the server still checks every request, and anything unexpected means "ask again".
/// </summary>
public sealed class AccessPreference(string path)
{
    private const string ClientText = "{\"mode\":\"client\"}", EmployeeText = "{\"mode\":\"employee\"}";

    public string Path { get; } = path;

    /// <summary>The preference file for one channel folder ("pilot", "stable" or "developer").</summary>
    public static AccessPreference For(string localAppData, string channelFolder) =>
        new(System.IO.Path.Combine(localAppData, "LedgeTop", "Files", channelFolder, "access-mode.json"));

    /// <summary>The remembered mode, or null when there is none or the file isn't exactly one this app wrote.</summary>
    public AccessMode? Read()
    {
        try {
            var file = new FileInfo(Path);
            if (!file.Exists || (file.Attributes & FileAttributes.ReparsePoint) != 0) return null;
            // One handle, read at most one byte past the limit, so a file replaced after the check still can't be large.
            using var stream = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[65]; var total = 0;
            while (total < buffer.Length) { var read = stream.Read(buffer, total, buffer.Length - total); if (read == 0) break; total += read; }
            if (total > 64) return null;
            var text = new System.Text.UTF8Encoding(false, true).GetString(buffer, 0, total);
            return text switch { ClientText => AccessMode.Client, EmployeeText => AccessMode.Employee, _ => null };
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.DecoderFallbackException) { return null; }
    }

    /// <summary>Saves the choice; a failure only means the person is asked again next time.</summary>
    public void Save(AccessMode mode)
    {
        AccessModes.Validate(mode);
        var pending = Path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            File.WriteAllText(pending, mode == AccessMode.Client ? ClientText : EmployeeText);
            File.Move(pending, Path, overwrite: true);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
            try { File.Delete(pending); } catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException) { }
        }
    }
}
