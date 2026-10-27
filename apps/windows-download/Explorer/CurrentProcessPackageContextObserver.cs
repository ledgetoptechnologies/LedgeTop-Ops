using System.Runtime.InteropServices;

namespace LedgeTop.Files.Explorer;

public enum CurrentProcessPackageContextKind { Unknown, NoPackage, HasPackage }

/// <summary>Redacted metadata about exactly the calling process. No parent, other app or historical inference.</summary>
public sealed record CurrentProcessPackageContextObservation(CurrentProcessPackageContextKind Kind, int? QueryStatus, int? ReadStatus);

/// <summary>Read-only current-process package identity observation; never returns the package name.
/// https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getcurrentpackagefullname
/// https://learn.microsoft.com/en-us/windows/win32/appxpkg/identity-constants </summary>
public static class CurrentProcessPackageContextObserver
{
    private const int NoPackage = 15700, InsufficientBuffer = 122;
    private const uint MinimumCharacters = 31, MaximumCharacters = 128; // Includes the terminating NUL.

    public static CurrentProcessPackageContextObservation Observe()
    {
        if (!OperatingSystem.IsWindows()) return new(CurrentProcessPackageContextKind.Unknown, null, null);
        int? queryStatus = null, readStatus = null;
        nint memory = 0; char[]? characters = null;
        try {
            uint required = 0;
            queryStatus = Native.GetCurrentPackageFullName(ref required, 0);
            if (queryStatus != InsufficientBuffer || !Bounded(required)) return Classify(queryStatus.Value, required);
            memory = Marshal.AllocHGlobal(checked((int)required * sizeof(char)));
            characters = new char[required];
            Array.Fill(characters, '\uFFFF'); // A positive result must contain a terminator actually written by the API.
            Marshal.Copy(characters, 0, memory, characters.Length);
            uint returned = required;
            readStatus = Native.GetCurrentPackageFullName(ref returned, memory);
            if (readStatus != 0 || !Bounded(returned) || returned > required)
                return Classify(queryStatus.Value, required, readStatus, returned);
            Marshal.Copy(memory, characters, 0, characters.Length);
            return Classify(queryStatus.Value, required, readStatus, returned, characters);
        } catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException or ArgumentException or OverflowException) {
            return new(CurrentProcessPackageContextKind.Unknown, queryStatus, readStatus);
        } finally {
            if (characters is not null) {
                Array.Clear(characters);
                if (memory != 0) Marshal.Copy(characters, 0, memory, characters.Length);
            }
            if (memory != 0) Marshal.FreeHGlobal(memory);
        }
    }

    private static bool Bounded(uint characters) => characters is >= MinimumCharacters and <= MaximumCharacters;

    // Pure classification seam. Tests never call Observe, allocate native buffers, or query identity.
    internal static CurrentProcessPackageContextObservation Classify(int query, uint required, int? read = null,
        uint returned = 0, char[]? characters = null)
    {
        if (query == NoPackage && read is null) return new(CurrentProcessPackageContextKind.NoPackage, query, null);
        if (query != InsufficientBuffer || !Bounded(required) || read != 0 || !Bounded(returned) ||
            returned > required || characters is null || characters.Length != required || characters[returned - 1] != '\0')
            return new(CurrentProcessPackageContextKind.Unknown, query, read);
        for (var n = 0; n < returned - 1; n++) {
            // Identity fields are ASCII identifiers/version/architecture with underscore separators.
            // Control, NUL, whitespace, surrogate or path/authority text cannot become a positive result.
            var c = characters[n];
            if (!(c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '.' or '-' or '_'))
                return new(CurrentProcessPackageContextKind.Unknown, query, read);
        }
        return new(CurrentProcessPackageContextKind.HasPackage, query, read);
    }

    private static class Native
    {
        [DllImport("kernel32.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int GetCurrentPackageFullName(ref uint packageFullNameLength, nint packageFullName);
    }
}
