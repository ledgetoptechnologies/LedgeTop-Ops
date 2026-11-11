using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Formats.Asn1;

namespace LedgeTop.Files.Updates;

/// <summary>
/// Verifies an embedded Authenticode signature using Windows trust policy, then binds the
/// signer to the company identity used for this product. Call while holding a read handle
/// that denies write and delete sharing so the verified path cannot be swapped before use.
/// </summary>
internal static class WindowsAuthenticodePublisher
{
    internal const string ExpectedCommonName = "Ledge Top Technologies LLC";
    // Set only from an independently reviewed Artifact Signing certificate profile.
    // An empty value disables installed EXE updates rather than trusting a CN alone.
    internal const string ExpectedArtifactSigningProfileEku = "";
    private const string CodeSigningEku = "1.3.6.1.5.5.7.3.3";
    private const string ArtifactSigningPublicTrustEku = "1.3.6.1.4.1.311.97.1.0";
    private static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
    private const uint UiNone = 2;
    private const uint RevokeWholeChain = 1;
    private const uint ChoiceFile = 1;
    private const uint StateVerify = 1;
    private const uint StateClose = 2;
    private const uint RevocationCheckChainExcludeRoot = 0x00000080;

    internal static void RequireTrustedCompanyInstaller(string path) => RequireTrustedCompanyInstaller(path, ExpectedArtifactSigningProfileEku);

    // Test-only callers may use a synthetic profile OID; a production call
    // always uses the single reviewed, compiled profile pin above.
    internal static void RequireTrustedCompanyInstallerForTest(string path, string profileEku) => RequireTrustedCompanyInstaller(path, profileEku);

    private static void RequireTrustedCompanyInstaller(string path, string profileEku)
    {
        if (!OperatingSystem.IsWindows()) throw new IOException("Windows signature verification is unavailable.");
        if (!ValidProfileEku(profileEku)) throw new IOException("The approved signing profile is not configured.");

        var filePath = Marshal.StringToCoTaskMemUni(path);
        var fileInfo = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
        var signatureSettings = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustSignatureSettings>());
        try {
            Marshal.StructureToPtr(new WinTrustFileInfo {
                Size = (uint)Marshal.SizeOf<WinTrustFileInfo>(),
                FilePath = filePath,
                FileHandle = IntPtr.Zero,
                KnownSubject = IntPtr.Zero
            }, fileInfo, false);
            // Verify exactly the primary signature, then extract the certificate
            // from THAT WinTrust state, not a separately parsed PE signature.
            Marshal.StructureToPtr(new WinTrustSignatureSettings {
                Size = (uint)Marshal.SizeOf<WinTrustSignatureSettings>(), Index = 0, Flags = 1
            }, signatureSettings, false);

            var data = new WinTrustData {
                Size = (uint)Marshal.SizeOf<WinTrustData>(),
                UiChoice = UiNone,
                RevocationChecks = RevokeWholeChain,
                UnionChoice = ChoiceFile,
                FileInfo = fileInfo,
                StateAction = StateVerify,
                ProviderFlags = RevocationCheckChainExcludeRoot,
                SignatureSettings = signatureSettings
            };
            var action = GenericVerifyV2;
            var status = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            try {
                if (status != 0) throw new IOException("The installer signature or certificate chain is not trusted.");
                if (Marshal.PtrToStructure<WinTrustSignatureSettings>(signatureSettings).VerifiedIndex != 0)
                    throw new IOException("Windows verified an unexpected signature.");
                using var certificate = TrustedPrimarySigner(data.StateData);
                if (!HasExactCommonName(certificate))
                    throw new IOException("The installer publisher does not match Ledge Top Technologies LLC.");
                if (!HasRequiredArtifactSigningEkus(certificate, profileEku))
                    throw new IOException("The installer signing profile does not match this release.");
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
            Marshal.FreeHGlobal(signatureSettings);
            Marshal.FreeCoTaskMem(filePath);
        }
    }

    internal static bool MatchesExpectedCommonName(string? commonName) =>
        string.Equals(commonName, ExpectedCommonName, StringComparison.Ordinal);

    internal static bool HasExactCommonName(X509Certificate2 certificate) => HasExactCommonNameEncoded(certificate.SubjectName.RawData);

    internal static bool HasExactCommonNameEncoded(ReadOnlyMemory<byte> subject) {
        try {
            var reader = new AsnReader(subject, AsnEncodingRules.DER);
            var name = reader.ReadSequence(); var count = 0; string? commonName = null;
            while (name.HasData) {
                var set = name.ReadSetOf();
                while (set.HasData) {
                    var attribute = set.ReadSequence(); var oid = attribute.ReadObjectIdentifier();
                    if (oid == "2.5.4.3") {
                        count++;
                        var tag = attribute.PeekTag();
                        if (tag.TagClass != TagClass.Universal || tag.IsConstructed ||
                            (tag.TagValue != (int)UniversalTagNumber.UTF8String && tag.TagValue != (int)UniversalTagNumber.PrintableString)) return false;
                        commonName = attribute.ReadCharacterString((UniversalTagNumber)tag.TagValue);
                    } else _ = attribute.ReadEncodedValue();
                    attribute.ThrowIfNotEmpty();
                }
            }
            reader.ThrowIfNotEmpty();
            return count == 1 && MatchesExpectedCommonName(commonName);
        } catch (Exception error) when (error is AsnContentException or CryptographicException or ArgumentException) { return false; }
    }

    internal static bool HasExpectedX64Abi() => IntPtr.Size == 8 &&
        Marshal.SizeOf<WinTrustData>() == 88 && Marshal.OffsetOf<WinTrustData>(nameof(WinTrustData.SignatureSettings)).ToInt32() == 80 &&
        Marshal.SizeOf<WinTrustSignatureSettings>() == 32 && Marshal.SizeOf<ProviderCertificatePrefix>() == 16 &&
        Marshal.SizeOf<CertificateContext>() == 40;

    internal static bool ValidProfileEku(string? value) {
        const string prefix = "1.3.6.1.4.1.311.97.";
        if (value is null || !value.StartsWith(prefix, StringComparison.Ordinal) || value.Length > 200) return false;
        var parts = value[prefix.Length..].Split('.');
        // The generic Public Trust marker is not a profile identity. Require a
        // canonical multi-arc profile-specific suffix, not just the prefix.
        return parts.Length >= 3 && parts.All(part => part.Length is > 0 and <= 10 &&
            (part.Length == 1 || part[0] != '0') && part.All(c => c is >= '0' and <= '9'));
    }

    internal static bool HasRequiredArtifactSigningEkus(X509Certificate2 certificate, string? profileEku) {
        if (!ValidProfileEku(profileEku)) return false;
        try {
            var matches = certificate.Extensions.Cast<X509Extension>().Where(x => x.Oid?.Value == "2.5.29.37").ToArray();
            if (matches.Length != 1) return false;
            var extension = new X509EnhancedKeyUsageExtension(matches[0], matches[0].Critical);
            var values = extension.EnhancedKeyUsages.Cast<Oid>().Select(x => x.Value).ToArray();
            return values.Contains(CodeSigningEku, StringComparer.Ordinal) &&
                values.Contains(ArtifactSigningPublicTrustEku, StringComparer.Ordinal) &&
                values.Contains(profileEku, StringComparer.Ordinal);
        } catch (CryptographicException) { return false; }
    }

    private static X509Certificate2 TrustedPrimarySigner(IntPtr state) {
        if (state == IntPtr.Zero) throw new IOException("Windows did not return signature state.");
        var data = WTHelperProvDataFromStateData(state);
        if (data != IntPtr.Zero && WTHelperGetProvSignerFromChain(data, 1, false, 0) != IntPtr.Zero)
            throw new IOException("Multiple signer records require separate review.");
        var signer = data == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvSignerFromChain(data, 0, false, 0);
        var providerCert = signer == IntPtr.Zero ? IntPtr.Zero : WTHelperGetProvCertFromChain(signer, 0);
        if (providerCert == IntPtr.Zero) throw new IOException("The verified signer is unavailable.");
        var contextPointer = Marshal.PtrToStructure<ProviderCertificatePrefix>(providerCert).Certificate;
        if (contextPointer == IntPtr.Zero) throw new IOException("The verified signer certificate is unavailable.");
        var context = Marshal.PtrToStructure<CertificateContext>(contextPointer);
        if (context.Encoded == IntPtr.Zero || context.Length is 0 or > 1_048_576) throw new IOException("The verified signer certificate is invalid.");
        var bytes = new byte[context.Length]; Marshal.Copy(context.Encoded, bytes, 0, bytes.Length);
        return X509CertificateLoader.LoadCertificate(bytes);
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
        internal IntPtr SignatureSettings;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustSignatureSettings { internal uint Size, Index, Flags, SecondarySignatures, VerifiedIndex; internal IntPtr CryptoPolicy; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProviderCertificatePrefix { internal uint Size; internal IntPtr Certificate; }
    [StructLayout(LayoutKind.Sequential)]
    private struct CertificateContext { internal uint Encoding; internal IntPtr Encoded; internal uint Length; internal IntPtr Info, Store; }

    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true, SetLastError = false)]
    private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref WinTrustData data);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr data, uint signer, [MarshalAs(UnmanagedType.Bool)] bool counterSigner, uint counter);
    [DllImport("wintrust.dll", ExactSpelling = true)] private static extern IntPtr WTHelperGetProvCertFromChain(IntPtr signer, uint certificate);
}
