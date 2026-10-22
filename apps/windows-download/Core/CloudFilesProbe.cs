using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.WindowsDownload;

public enum CloudFilesProbeStatus { Supported, Unsupported, Error }

[Flags]
public enum CloudPlaceholderState : uint {
    None = 0, Placeholder = 1, SyncRoot = 2, EssentialPropertyPresent = 4,
    InSync = 8, Partial = 16, PartiallyOnDisk = 32,
}

public sealed record CloudFilesPlatformInfo(uint BuildNumber, uint RevisionNumber, uint IntegrationNumber);
public sealed record CloudFilesPlatformResult(CloudFilesProbeStatus Status, string Code,
    CloudFilesPlatformInfo? Platform = null, int? NativeError = null);
public sealed record CloudFilesStateResult(CloudFilesProbeStatus Status, string Code,
    CloudPlaceholderState? State = null, uint? FileAttributes = null, uint? ReparseTag = null, int? NativeError = null) {
    public bool? IsPlaceholder => State is { } state ? state.HasFlag(CloudPlaceholderState.Placeholder) : null;
}

public readonly record struct NativeCloudPlatform(int HResult, CloudFilesPlatformInfo Platform);
public readonly record struct NativeFileAttributeTag(bool Success, uint Attributes, uint ReparseTag, int Error);

/// <summary>Read-only native seam. No provider registration or file data operation is exposed.</summary>
public interface ICloudFilesNative {
    NativeCloudPlatform GetPlatformInfo();
    NativeFileAttributeTag ReadAttributeTag(string exactLocalFilePath);
    uint GetPlaceholderState(uint attributes, uint reparseTag);
}

/// <summary>Capability and exact-file metadata inspection only; not offline/pinning support.</summary>
public sealed class CloudFilesProbe(ICloudFilesNative? nativeBoundary = null) {
    private readonly ICloudFilesNative native = nativeBoundary ?? new WindowsCloudFilesNative();
    private const uint KnownStates = 0x3f;

    public CloudFilesPlatformResult GetPlatformInfo() {
        try {
            var reply = native.GetPlatformInfo();
            if (reply.HResult != 0) return new(IsUnsupported(reply.HResult) ? CloudFilesProbeStatus.Unsupported : CloudFilesProbeStatus.Error,
                "platform-hresult", NativeError: reply.HResult);
            if (reply.Platform is null || reply.Platform.BuildNumber == 0)
                return new(CloudFilesProbeStatus.Error, "invalid-platform-info");
            return new(CloudFilesProbeStatus.Supported, "platform-api-available", reply.Platform);
        } catch (Exception error) when (Unavailable(error)) {
            return new(CloudFilesProbeStatus.Unsupported, "native-api-unavailable");
        } catch (Exception) {
            return new(CloudFilesProbeStatus.Error, "native-platform-probe-failed");
        }
    }

    public CloudFilesStateResult InspectExistingFile(string exactLocalFilePath) {
        // Only a literal drive-qualified local file. No UNC/device namespace,
        // wildcard expansion, ADS or path normalization. The native boundary
        // separately checks drive mapping and each ancestor's metadata.
        if (!LiteralFilePath(exactLocalFilePath)) return new(CloudFilesProbeStatus.Error, "literal-local-file-required");
        var platform = GetPlatformInfo();
        if (platform.Status != CloudFilesProbeStatus.Supported)
            return new(platform.Status, platform.Code, NativeError: platform.NativeError);
        try {
            var metadata = native.ReadAttributeTag(exactLocalFilePath);
            if (!metadata.Success) return new(metadata.Error == 50 ? CloudFilesProbeStatus.Unsupported : CloudFilesProbeStatus.Error,
                metadata.Error == 50 ? "metadata-path-not-supported" : "file-metadata-unavailable", NativeError: metadata.Error);
            if (metadata.Attributes == uint.MaxValue || (metadata.Attributes & 0x10) != 0)
                return new(CloudFilesProbeStatus.Error, "existing-file-required");
            var state = native.GetPlaceholderState(metadata.Attributes, metadata.ReparseTag);
            if (state == uint.MaxValue || (state & ~KnownStates) != 0)
                return new(CloudFilesProbeStatus.Error, "unrecognized-placeholder-state");
            if ((state != 0 && (state & 1) == 0) || ((state & 32) != 0 && (state & 16) == 0))
                return new(CloudFilesProbeStatus.Error, "inconsistent-placeholder-state");
            return new(CloudFilesProbeStatus.Supported, state == 0 ? "not-a-cloud-placeholder" : "placeholder-metadata",
                (CloudPlaceholderState)state, metadata.Attributes, metadata.ReparseTag);
        } catch (Exception error) when (Unavailable(error)) {
            return new(CloudFilesProbeStatus.Unsupported, "native-api-unavailable");
        } catch (Exception) {
            return new(CloudFilesProbeStatus.Error, "native-metadata-probe-failed");
        }
    }

    private static bool IsUnsupported(int hr) => hr is unchecked((int)0x80070032) or unchecked((int)0x80004001);
    private static bool Unavailable(Exception error) => error is PlatformNotSupportedException or DllNotFoundException or EntryPointNotFoundException or BadImageFormatException;
    private static bool LiteralFilePath(string? value) {
        if (string.IsNullOrEmpty(value) || value.Length >= 260 || value.Length < 4 || !char.IsAsciiLetter(value[0]) || value[1] != ':' || value[2] != '\\') return false;
        foreach (var segment in value[3..].Split('\\')) {
            if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith('.') || segment.EndsWith(' ')) return false;
            if (segment.Any(c => char.IsControl(c) || "<>:\"/|?*".Contains(c))) return false;
            var basename = segment.Split('.')[0].ToUpperInvariant();
            if (basename is "CON" or "PRN" or "AUX" or "NUL" ||
                (basename.Length == 4 && (basename.StartsWith("COM", StringComparison.Ordinal) || basename.StartsWith("LPT", StringComparison.Ordinal)) && basename[3] is >= '1' and <= '9')) return false;
        }
        return true;
    }
}

internal sealed class WindowsCloudFilesNative : ICloudFilesNative {
    public NativeCloudPlatform GetPlatformInfo() {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var result = Native.CfGetPlatformInfo(out var platform);
        return new(result, new(platform.BuildNumber, platform.RevisionNumber, platform.IntegrationNumber));
    }

    public NativeFileAttributeTag ReadAttributeTag(string exactLocalFilePath) {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var drive = exactLocalFilePath[..3];
        // Conservative first slice: physical fixed-volume drive mappings only.
        // Reject mapped/SUBST/device roots before looking up the selected entry.
        if (Native.GetDriveTypeW(drive) != 3) return new(false, 0, 0, 50);
        var target = new char[1024];
        var length = Native.QueryDosDeviceW(exactLocalFilePath[..2], target, (uint)target.Length);
        if (length == 0) return new(false, 0, 0, 50);
        var mapping = new string(target).Split('\0')[0];
        const string physicalVolume = @"\Device\HarddiskVolume";
        if (!mapping.StartsWith(physicalVolume, StringComparison.Ordinal) || mapping.Length == physicalVolume.Length ||
            !mapping[physicalVolume.Length..].All(char.IsAsciiDigit)) return new(false, 0, 0, 50);
        var segments = exactLocalFilePath[3..].Split('\\');
        var ancestor = drive.TrimEnd('\\');
        foreach (var segment in segments[..^1]) {
            ancestor += "\\" + segment;
            var attributes = Native.GetFileAttributesW(ancestor);
            if (attributes == uint.MaxValue) return new(false, 0, 0, Marshal.GetLastPInvokeError());
            // GetFileAttributes reports the link itself. Do not continue into
            // a junction, symlink, mount point or cloud reparse ancestor.
            if ((attributes & 0x400) != 0) return new(false, 0, 0, 50);
        }
        // One literal metadata lookup. No FindNextFile, CreateFile, data
        // stream, backup traversal, sync registration or hydration operation.
        using var handle = Native.FindFirstFileW(exactLocalFilePath, out var data);
        if (handle.IsInvalid) return new(false, 0, 0, Marshal.GetLastPInvokeError());
        return new(true, data.Attributes, data.Reserved0, 0);
    }

    public uint GetPlaceholderState(uint attributes, uint reparseTag) => Native.CfGetPlaceholderStateFromAttributeTag(attributes, reparseTag);

    private static class Native {
        [StructLayout(LayoutKind.Sequential)]
        internal struct PlatformInfo { internal uint BuildNumber, RevisionNumber, IntegrationNumber; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct FindData {
            internal uint Attributes;
            internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
            internal uint FileSizeHigh, FileSizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string FileName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] internal string AlternateFileName;
        }
        internal sealed class FindHandle : SafeHandleZeroOrMinusOneIsInvalid {
            public FindHandle() : base(true) { }
            protected override bool ReleaseHandle() => FindClose(handle);
        }
        [DllImport("CldApi.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfGetPlatformInfo(out PlatformInfo platform);
        [DllImport("CldApi.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes, uint reparseTag);
        [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern FindHandle FindFirstFileW(string name, out FindData data);
        [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern uint GetDriveTypeW(string rootPath);
        [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern uint QueryDosDeviceW(string device, [Out] char[] target, uint maximum);
        [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindClose(nint handle);
    }
}
