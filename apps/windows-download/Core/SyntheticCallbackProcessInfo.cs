#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

// Only invoked for the isolated synthetic fixture. The pointer is an OS-owned
// callback allocation and is valid only synchronously during the callback.
// Never retain it or read any image, package, command-line, or path fields.
internal static class SyntheticCallbackProcessInfo
{
    internal enum Status : byte { Missing = 1, TooShort = 2, Present = 3 }
    internal readonly record struct Observation(Status Status, uint ProcessId);
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(new string('x', 100_000))));
    internal static bool Eligible(byte[]? copiedIdentity) {
        if (Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") != "1" ||
            Environment.GetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO") != "1" || copiedIdentity is null) return false;
        try {
            var identity = PlaceholderIdentity.Decode(copiedIdentity);
            return identity.Channel == "pilot" && identity.SourceAlias == "synthetic" && identity.Origin == "https://source.example.invalid" &&
                identity.PrincipalId == "odqp1_" + new string('f', 64) && identity.Length == 100_000 && identity.Sha256 == Sha &&
                Regex.IsMatch(identity.FileName, "\\Asample-[0-3]\\.bin\\z");
        } catch (TransferException) { return false; }
    }
    internal static Observation CopyPrefix(nint processInfo) {
        if (processInfo == 0) return new(Status.Missing, 0);
        // CF_PROCESS_INFO begins DWORD StructSize, DWORD ProcessId. Reading
        // a forged arbitrary pointer is not made safe by managed exceptions;
        // tests must supply valid, owned unmanaged allocations.
        var size = unchecked((uint)Marshal.ReadInt32(processInfo, 0));
        if (size < 8) return new(Status.TooShort, 0);
        return new(Status.Present, unchecked((uint)Marshal.ReadInt32(processInfo, 4)));
    }
}
#endif
