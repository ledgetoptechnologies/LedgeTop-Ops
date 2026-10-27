using System.Text.RegularExpressions;
using System.Text;

namespace LedgeTop.Files;

internal enum WindowsStartupAvailability { Available, Unavailable, Conflict, Error }
// Enabled/SourceAlias describe our recognized setting only when Availability is Available.
internal sealed record WindowsStartupState(WindowsStartupAvailability Availability, bool Enabled = false, string? SourceAlias = null);
internal enum WindowsStartupValueKind { String, Other }
internal sealed record WindowsStartupRunValue(WindowsStartupValueKind Kind, string? Text);

internal interface IWindowsStartupOwnership : IAsyncDisposable
{
    string ExecutablePath { get; }
    Task VerifyStillCurrentAsync(CancellationToken token);
}
internal interface IWindowsStartupOwnershipReader
{
    Task<IWindowsStartupOwnership> ReadAsync(CancellationToken token);
}
internal interface IWindowsStartupRunStore
{
    WindowsStartupRunValue? Read();
    // Serializes cooperating clients and rechecks the exact expected value immediately before writing.
    // Registry has no external-writer CAS: arbitrary same-user external writes are not made atomic.
    bool TryReplace(WindowsStartupRunValue? expected, WindowsStartupRunValue? replacement);
}
internal sealed class WindowsStartupOwnershipUnavailableException() : Exception("Installed startup ownership is unavailable.");

internal static class WindowsStartupPolicy
{
    internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    internal const string RunValueName = "LedgeTopFilesPilot";
    internal const string StartupSavedSourceArgument = "--startup-saved-source-v1";
    internal static WindowsStartupRunValue DecodeRunValue(uint type, ReadOnlySpan<byte> bytes)
    {
        // REG_SZ only, max260 UTF16 code units plus exactly one terminal NUL. Do not normalize
        // malformed data into an owned command or interpret expandable strings as literal text.
        if (type != 1 || bytes.Length is < 2 or > 522 || bytes.Length % 2 != 0 || bytes[^1] != 0 || bytes[^2] != 0)
            return new(WindowsStartupValueKind.Other, null);
        try {
            var text = new UnicodeEncoding(false, false, true).GetString(bytes[..^2]);
            return text.Contains('\0') ? new(WindowsStartupValueKind.Other, null) : new(WindowsStartupValueKind.String, text);
        } catch (DecoderFallbackException) { return new(WindowsStartupValueKind.Other, null); }
    }

    internal static bool RecognizedCommandShape(WindowsStartupRunValue? value)
    {
        if (value?.Kind != WindowsStartupValueKind.String || value.Text is null || !value.Text.StartsWith('"')) return false;
        var quote = value.Text.IndexOf('"', 1);
        if (quote <= 1) return false;
        var executable = value.Text[1..quote];
        try { return new[] { "portal", "employee" }.Any(alias => value.Text == Command(executable, alias)); }
        catch (WindowsStartupOwnershipUnavailableException) { return false; }
    }

    internal static string Command(string executablePath, string sourceAlias)
    {
        if (sourceAlias is not ("portal" or "employee") || !ExecutableShape(executablePath))
            throw new WindowsStartupOwnershipUnavailableException();
        var command = '"' + executablePath + "\" " + StartupSavedSourceArgument + " " + sourceAlias;
        if (command.Length > 260) throw new WindowsStartupOwnershipUnavailableException();
        return command;
    }
    internal static WindowsStartupState State(string executablePath, WindowsStartupRunValue? value)
    {
        // Always validate the proof-provided path, including an absent setting.
        _ = Command(executablePath, "portal");
        if (value is null) return new(WindowsStartupAvailability.Available);
        if (value.Kind == WindowsStartupValueKind.String)
            foreach (var alias in new[] { "portal", "employee" })
                if (value.Text == Command(executablePath, alias)) return new(WindowsStartupAvailability.Available, true, alias);
        return new(WindowsStartupAvailability.Conflict);
    }
    private static bool ExecutableShape(string? path)
    {
        if (path is null || path.Length is < 4 or > 1024 || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
        try { _ = new UnicodeEncoding(false, false, true).GetByteCount(path); }
        catch (EncoderFallbackException) { return false; }
        var parts = path.Split('\\');
        if (parts.Length < 6 || parts[^5] != "Programs" || parts[^4] != "LedgeTop Files Pilot" || parts[^3] != "versions" || parts[^1] != "LedgeTop.Files.exe" ||
            parts.Skip(1).Any(part => part is "" or "." or ".." || part.EndsWith('.') || part.EndsWith(' ') || part.Any(ch => char.IsControl(ch) || "<>:\"/|?*%".Contains(ch)))) return false;
        var version = parts[^2];
        return Regex.IsMatch(version, @"\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}\z") &&
            version.Split('.').All(part => int.Parse(part, System.Globalization.CultureInfo.InvariantCulture) <= ushort.MaxValue);
    }
}
