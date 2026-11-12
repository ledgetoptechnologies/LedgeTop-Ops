using System.Runtime.InteropServices;
using System.Formats.Asn1;
using System.Security.Cryptography.X509Certificates;

namespace LedgeTop.Files.Updates;

/// <summary>
/// Verifies an embedded Authenticode signature using Windows trust policy, then binds the
/// signer to the company identity used for this product. Call while holding a read handle
/// that denies write and delete sharing so the verified path cannot be swapped before use.
/// </summary>
internal static class WindowsAuthenticodePublisher
{
    internal const string ExpectedCommonName = "Ledge Top Technologies LLC";
    private static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
    private const uint UiNone = 2;
    private const uint RevokeWholeChain = 1;
    private const uint ChoiceFile = 1;
    private const uint StateVerify = 1;
    private const uint StateClose = 2;
    private const uint RevocationCheckChainExcludeRoot = 0x00000080;

    internal static void RequireTrustedCompanyInstaller(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new IOException("Windows signature verification is unavailable.");

        var filePath = Marshal.StringToCoTaskMemUni(path);
        var fileInfo = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        try {
            Marshal.StructureToPtr(new WinTrustFileInfo {
                Size = (uint)Marshal.SizeOf<WinTrustFileInfo>(),
                FilePath = filePath,
                FileHandle = IntPtr.Zero,
                KnownSubject = IntPtr.Zero
            }, fileInfo, false);

            var data = new WinTrustData {
                Size = (uint)Marshal.SizeOf<WinTrustData>(),
                UiChoice = UiNone,
                RevocationChecks = RevokeWholeChain,
                UnionChoice = ChoiceFile,
                FileInfo = fileInfo,
                StateAction = StateVerify,
                ProviderFlags = RevocationCheckChainExcludeRoot
            };
            var action = GenericVerifyV2;
            var status = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            try {
                if (status != 0) throw new IOException("The installer signature or certificate chain is not trusted.");
#pragma warning disable SYSLIB0057 // WinTrust verifies the PE first; this API is currently the framework PE Authenticode signer extractor.
                using var extracted = X509Certificate.CreateFromSignedFile(path);
                using var certificate = new X509Certificate2(extracted);
#pragma warning restore SYSLIB0057
                if (!HasExpectedCommonName(certificate.SubjectName.RawData))
                    throw new IOException("The installer publisher does not match Ledge Top Technologies LLC.");
            } finally {
                data.StateAction = StateClose;
                _ = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            }
        } catch (IOException) {
            throw;
        } catch (Exception) {
            throw new IOException("The installer publisher could not be verified.");
        } finally {
            Marshal.FreeHGlobal(fileInfo);
            Marshal.FreeCoTaskMem(filePath);
        }
    }

    internal static bool MatchesExpectedCommonName(string? commonName) =>
        string.Equals(commonName, ExpectedCommonName, StringComparison.Ordinal);

    // SimpleName can fall back to an organizational unit when CN is missing. Parse the
    // subject DN itself and require exactly one CN, rejecting ambiguous or malformed DNs.
    internal static bool HasExpectedCommonName(byte[] subject)
    {
        try {
            var reader = new AsnReader(subject, AsnEncodingRules.DER);
            var name = reader.ReadSequence();
            string? commonName = null;
            while (name.HasData) {
                var set = name.ReadSetOf();
                while (set.HasData) {
                    var attribute = set.ReadSequence();
                    var oid = attribute.ReadObjectIdentifier();
                    if (oid == "2.5.4.3") {
                        if (commonName is not null) return false;
                        var tag = attribute.PeekTag();
                        if (tag.TagClass != TagClass.Universal || tag.TagValue is not (12 or 19 or 30)) return false;
                        commonName = attribute.ReadCharacterString((UniversalTagNumber)tag.TagValue);
                    } else attribute.ReadEncodedValue();
                    attribute.ThrowIfNotEmpty();
                }
            }
            reader.ThrowIfNotEmpty();
            return MatchesExpectedCommonName(commonName);
        } catch (Exception error) when (error is AsnContentException or ArgumentException) { return false; }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        internal uint Size;
        internal IntPtr FilePath;
        internal IntPtr FileHandle;
        internal IntPtr KnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        internal uint Size;
        internal IntPtr PolicyCallbackData;
        internal IntPtr SipClientData;
        internal uint UiChoice;
        internal uint RevocationChecks;
        internal uint UnionChoice;
        internal IntPtr FileInfo;
        internal uint StateAction;
        internal IntPtr StateData;
        internal IntPtr UrlReference;
        internal uint ProviderFlags;
        internal uint UiContext;
    }

    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true, SetLastError = false)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref WinTrustData data);
}
