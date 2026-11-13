using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LedgeTop.Files.Backends;
using Microsoft.Win32;

namespace LedgeTop.Files.Updates;

[SupportedOSPlatform("windows")]
internal static class ExeUpdateWindowsTrust
{
    internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot";
    internal static string ProductRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "LedgeTop Files Pilot");
    internal static string Target(string version) => Path.Combine(ProductRoot, "versions", version);
    internal static string StageRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", "pilot", "app-updates");
    internal static ReleaseProfile Profile()
    {
        var compiled = ReleaseProfiles.Compiled(typeof(ExeUpdateWindowsTrust).Assembly);
        if (!ExeUpdateWindowsPolicy.SupportedHost(OperatingSystem.IsWindows(), Environment.OSVersion.Version, Environment.Is64BitProcess) ||
            !compiled.Packaged || compiled.Channel != ReleaseChannel.Pilot) throw new IOException("Installed updates unavailable.");
        return ReleaseProfiles.For(ReleaseChannel.Pilot) is { CloudflaredSha256: not null } profile ? profile : throw new IOException("Installed updates unconfigured.");
    }
    internal static string ActiveVersion()
    {
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var key = user.OpenSubKey(UninstallKey, false) ?? throw new IOException("Installed update ownership unavailable.");
        if (key.GetValueKind("DisplayVersion") != RegistryValueKind.String || key.GetValueKind("InstallLocation") != RegistryValueKind.String)
            throw new IOException("Installed update ownership refused.");
        var version = key.GetValue("DisplayVersion", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        var root = key.GetValue("InstallLocation", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        if (version is null || !Regex.IsMatch(version, @"\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}\z") ||
            version.Split('.').Any(value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture) > ushort.MaxValue) ||
            root != Target(version)) throw new IOException("Installed update ownership refused.");
        ExeUpdateWindowsNative.NoAliases(root);
        return version;
    }

    internal static async Task<(ExeUpdateInstalledOwner Owner, VerifiedInstalledPayload Payload)> ReadCurrentAsync(ReleaseProfile profile, CancellationToken token)
    {
        var version = ActiveVersion(); var root = Target(version);
        if (Environment.ProcessPath != Path.Combine(root, "LedgeTop.Files.exe") || AppContext.BaseDirectory.TrimEnd('\\', '/') != root)
            throw new IOException("Updates require the active installed application.");
        if (typeof(ExeUpdateWindowsTrust).Assembly.GetName().Version?.ToString() != version)
            throw new IOException("The running installed version differs from activation.");
        var markerPath = Path.Combine(root, "installer-owned.ini"); ExeUpdateWindowsNative.NoAliases(markerPath);
        InstalledPayloadVerifier.InstalledPayloadMarker marker;
        using (var markerStream = new FileStream(markerPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (markerStream.Length is <= 0 or > 16384) throw new IOException("Installed marker refused.");
            var bytes = new byte[(int)markerStream.Length]; await markerStream.ReadExactlyAsync(bytes, token).ConfigureAwait(false);
            marker = InstalledPayloadVerifier.ParseMarker(bytes);
        }
        // This observes existing bootstrap ownership, not new installer authority. New payload verification
        // MUST use the anchor read from the SHA-verified NSIS, never this local marker as remote proof.
        var payload = await InstalledPayloadVerifier.VerifyAsync(root, version, marker.SourceCommit, marker.PayloadManifestSha256,
            profile.CloudflaredSha256!, token).ConfigureAwait(false);
        try {
            if (ActiveVersion() != version) throw new IOException("Installed activation changed.");
            VerifyManagedRelease(root, version);
            using var current = Process.GetCurrentProcess();
            var owner = new ExeUpdateInstalledOwner(ExeUpdateWindowsNative.CurrentSid(), current.SessionId, version, root,
                marker.Owner, payload.PayloadManifestSha256, payload.SourceCommit, payload.AppHostSha256, payload.ManagedAssemblySha256);
            return (owner, payload);
        } catch { await payload.DisposeAsync().ConfigureAwait(false); throw; }
    }

    internal static void CheckOwner(ExeUpdateInstalledOwner expected)
    {
        using var current = Process.GetCurrentProcess();
        if (expected.WindowsSid != ExeUpdateWindowsNative.CurrentSid() || expected.SessionId != current.SessionId ||
            ActiveVersion() != expected.Version || expected.InstallRoot != Target(expected.Version)) throw new IOException("Installed update owner changed.");
    }

    internal static async Task<Artifact> HoldArtifactAsync(ExeUpdateCandidate candidate, CancellationToken token)
    {
        ExeUpdateWindowsNative.NoAliases(candidate.InstallerPath);
        var root = Path.Combine(StageRoot, ".ledgetop-app-updates-v1");
        var basename = $"LedgeTop-Files-pilot-{candidate.Release.Version}-{candidate.Release.Sha256}.exe";
        if (candidate.Channel != "pilot" || candidate.InstallerPath != Path.Combine(root, basename))
            throw new IOException("Update installer is outside its fixed owned stage.");
        var fence = new VerifiedInstalledPayload(root);
        try {
            var ancestors = new Stack<string>();
            for (string? part = root; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
            while (ancestors.TryPop(out var path)) fence.HoldDirectory(path);
            var marker = fence.HoldFile("owner.json");
            // Match Core.WindowsAppReleaseClient's current exact byte owner marker. This hashes only
            // the public origin scope, never an account, credential or token-derived value.
            var expectedMarker = JsonSerializer.SerializeToUtf8Bytes(new { Schema = 1, Owner = "LedgeTop.WindowsAppReleaseStage/1", Channel = "pilot",
                OriginSha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(candidate.Origin.GetLeftPart(UriPartial.Authority)))) });
            if (marker.Length != expectedMarker.Length) throw new IOException("Update stage ownership changed.");
            var markerBytes = new byte[expectedMarker.Length]; await marker.ReadExactlyAsync(markerBytes, token).ConfigureAwait(false);
            if (!markerBytes.AsSpan().SequenceEqual(expectedMarker)) throw new IOException("Update stage ownership changed.");
            var stream = fence.HoldFile(basename);
            if (stream.Length != candidate.Release.SizeBytes ||
                Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, token).ConfigureAwait(false)) != candidate.Release.Sha256)
                throw new IOException("Update installer bytes changed.");
            stream.Position = 0;
            using (var pe = new PEReader(stream, PEStreamOptions.LeaveOpen))
                if (pe.HasMetadata || pe.PEHeaders.PEHeader is null ||
                    (pe.PEHeaders.CoffHeader.Characteristics & Characteristics.ExecutableImage) == 0 ||
                    (pe.PEHeaders.CoffHeader.Characteristics & Characteristics.Dll) != 0) throw new IOException("Update installer PE refused.");
            // Keep the held read-only file handle open through WinTrust and signer extraction.
            // The local SHA-256 binds this byte sequence to the offer; Authenticode additionally
            // proves Windows trust and the expected company publisher before the helper can run it.
            WindowsAuthenticodePublisher.RequireTrustedCompanyInstaller(candidate.InstallerPath);
            var info = FileVersionInfo.GetVersionInfo(candidate.InstallerPath);
            var anchor = ExeUpdateInstallerAnchor.Parse(info.Comments);
            if (info.FileVersion != candidate.Release.Version || anchor.SourceCommit != candidate.Release.SourceCommit)
                throw new IOException("Update installer source/version changed.");
            return new(fence, anchor);
        } catch { await fence.DisposeAsync().ConfigureAwait(false); throw; }
    }
    internal sealed class Artifact(VerifiedInstalledPayload fence, ExeUpdateInstallerAnchor anchor) : IAsyncDisposable
    {
        internal ExeUpdateInstallerAnchor Anchor { get; } = anchor;
        public ValueTask DisposeAsync() => fence.DisposeAsync();
    }

    internal static void VerifyManagedRelease(string root, string version)
    {
        using var stream = new FileStream(Path.Combine(root, "LedgeTop.Files.dll"), FileMode.Open, FileAccess.Read, FileShare.Read);
        using var pe = new PEReader(stream); if (!pe.HasMetadata) throw new IOException("Installed release metadata unavailable.");
        var reader = pe.GetMetadataReader();
        if (reader.GetAssemblyDefinition().Version != Version.Parse(version)) throw new IOException("Installed release version mismatch.");
        var channels = new List<string?>(); var maintenance = new List<string?>(); var developer = 0;
        foreach (var handle in reader.GetAssemblyDefinition().GetCustomAttributes()) {
            var attribute = reader.GetCustomAttribute(handle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference) continue;
            var member = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (member.Parent.Kind != HandleKind.TypeReference) continue;
            var type = reader.GetTypeReference((TypeReferenceHandle)member.Parent);
            if (reader.GetString(type.Namespace) != "System.Reflection" || reader.GetString(type.Name) != "AssemblyMetadataAttribute") continue;
            var data = reader.GetBlobReader(attribute.Value);
            if (data.ReadUInt16() != 1) throw new IOException("Installed release metadata refused.");
            var key = data.ReadSerializedString(); var value = data.ReadSerializedString();
            if (key == ReleaseProfiles.ChannelKey) channels.Add(value);
            if (key == ReleaseProfiles.BuildModeKey) developer++;
            if (key == "LedgeTop.InstallerMaintenanceProtocol") maintenance.Add(value);
        }
        if (channels.Count != 1 || channels[0] != "pilot" || developer != 0 || maintenance.Count != 1 || maintenance[0] != "1")
            throw new IOException("Installed release profile refused.");
    }
}
