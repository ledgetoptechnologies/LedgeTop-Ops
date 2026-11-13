using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Explorer;

/// <summary>
/// Native-only Cloud Files registration for an isolated synthetic preview. It does not register a branded
/// Explorer navigation node. All mutations require an exact owner readback; no failed call is retried.
/// </summary>
public sealed class NativeRootRegistration : IPreviewRootRegistration
{
    public const string ProviderName = "LedgeTop Files Preview";
    public const string ProviderVersion = "0.1.0";
    private const int NotUnderSyncRoot = unchecked((int)0x80070186); // ERROR_CLOUD_FILE_NOT_UNDER_SYNC_ROOT (390)
    private const int IdentityOffset = 1056, MaximumIdentity = 65536, StandardCapacity = IdentityOffset + MaximumIdentity;
    private const uint InSyncPolicy = 1023;
    private static readonly object changes = new();
    private static readonly Dictionary<string, NativeRootRegistration> owned = new(StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<string> attemptedRoots = new(StringComparer.OrdinalIgnoreCase);
    private readonly byte[] context;
    private readonly long rootFileId;
    private bool unregisterAttempted;

    private NativeRootRegistration(string root, byte[] context, long rootFileId)
    {
        Root = root; this.context = context.ToArray(); this.rootFileId = rootFileId;
    }

    public string Root { get; }

    /// <summary>One registration attempt, only on a new empty local NTFS root with no existing native ancestor root.</summary>
    public static NativeRootRegistration Register(string root, byte[] context)
    {
        AssertAbi(); ValidateContext(context);
        context = context.ToArray();
        lock (changes)
        {
            var canonical = ValidateRoot(root, requireEmpty: true);
            if (owned.ContainsKey(canonical) || attemptedRoots.Contains(canonical))
                throw new InvalidOperationException("This process already attempted to register this preview root; reconcile it before any new attempt.");
            var before = Read(canonical);
            if (before.Status != NotUnderSyncRoot)
                throw new IOException("The preview root is already registered, lies beneath a registration, or its native state is unavailable.");
            attemptedRoots.Add(canonical);
            nint name = 0, version = 0, identity = 0;
            try
            {
                name = Marshal.StringToHGlobalUni(ProviderName);
                version = Marshal.StringToHGlobalUni(ProviderVersion);
                identity = Marshal.AllocHGlobal(context.Length);
                Marshal.Copy(context, 0, identity, context.Length);
                var registration = new SyncRegistration
                {
                    StructSize = 72, ProviderName = name, ProviderVersion = version,
                    RootIdentity = identity, RootIdentityLength = (uint)context.Length,
                    ProviderId = ShellRegistration.ProviderId
                };
                var policies = new SyncPolicies
                {
                    StructSize = 24, Hydration = new() { Primary = 2 },
                    Population = new() { Primary = 3 }, InSync = InSyncPolicy
                };
                // https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfregistersyncroot
                // FLAG_MARK_IN_SYNC_ON_ROOT=4. No UPDATE flag; never adopt or replace an existing registration.
                var result = Native.CfRegisterSyncRoot(canonical, ref registration, ref policies, 4);
                if (result != 0) throw new IOException("Native root registration did not report success; reconcile the owned root before continuing.");
                var after = Read(canonical);
                VerifySnapshot(canonical, after, context, expectedFileId: null);
                var receipt = new NativeRootRegistration(canonical, context, after.FileId);
                owned.Add(canonical, receipt);
                return receipt;
            }
            finally
            {
                if (name != 0) Marshal.FreeHGlobal(name);
                if (version != 0) Marshal.FreeHGlobal(version);
                if (identity != 0) Marshal.FreeHGlobal(identity);
            }
        }
    }

    /// <summary>Read-only recovery of a previously persisted path and exact nonsecret ownership context.</summary>
    public static NativeRootRegistration OpenOwned(string root, byte[] context)
    {
        AssertAbi(); ValidateContext(context);
        context = context.ToArray();
        lock (changes)
        {
            var canonical = ValidateRoot(root, requireEmpty: false);
            var snapshot = Read(canonical);
            VerifySnapshot(canonical, snapshot, context, expectedFileId: null);
            if (owned.TryGetValue(canonical, out var current))
            {
                if (!CryptographicOperations.FixedTimeEquals(current.context, context) || current.rootFileId != snapshot.FileId)
                    throw new InvalidOperationException("A different ownership receipt already exists for this root.");
                return current;
            }
            var receipt = new NativeRootRegistration(canonical, context, snapshot.FileId);
            owned.Add(canonical, receipt);
            return receipt;
        }
    }

    public void VerifyOwned()
    {
        lock (changes) VerifyOwnedCore();
    }

    private void VerifyOwnedCore()
    {
        if (!owned.TryGetValue(Root, out var current) || !ReferenceEquals(current, this) || unregisterAttempted)
            throw new InvalidOperationException("This native registration receipt is no longer current.");
        ValidateRoot(Root, requireEmpty: false);
        VerifySnapshot(Root, Read(Root), context, rootFileId);
    }

    public void Unregister()
    {
        lock (changes)
        {
            VerifyOwnedCore();
            unregisterAttempted = true; // Record the attempt before the side effect; this handle will never replay it.
            var result = Native.CfUnregisterSyncRoot(Root);
            var after = Read(Root);
            if (result != 0 || after.Status != NotUnderSyncRoot)
                throw new IOException("Native root removal needs read-only reconciliation; it was not retried.");
            owned.Remove(Root);
        }
    }

    /// <summary>Read-only, bounded diagnostic; does not return another provider's arbitrary identity bytes.</summary>
    public static NativeRootObservation Inspect(string root, byte[] expectedContext)
    {
        AssertAbi(); ValidateContext(expectedContext);
        expectedContext = expectedContext.ToArray();
        var canonical = ValidateRoot(root, requireEmpty: false);
        var snapshot = Read(canonical);
        return new(snapshot.Status, snapshot.FileId, snapshot.Context is not null &&
            CryptographicOperations.FixedTimeEquals(snapshot.Context, expectedContext),
            snapshot.Name == ProviderName, snapshot.Version == ProviderVersion,
            snapshot.HydrationPrimary, snapshot.HydrationModifier, snapshot.PopulationPrimary,
            snapshot.PopulationModifier, snapshot.InSync, snapshot.Hardlink);
    }

    private sealed record Snapshot(int Status, long FileId = 0, string? Name = null, string? Version = null,
        byte[]? Context = null, ushort HydrationPrimary = 0, ushort HydrationModifier = 0,
        ushort PopulationPrimary = 0, ushort PopulationModifier = 0, uint InSync = 0, uint Hardlink = 0);

    private static Snapshot Read(string root)
    {
        // STANDARD's variable identity starts at1056, NOT at the padded sizeof(struct with BYTE[1]).
        // BASIC contains only one 8-byte file ID; it is insufficient for ownership verification.
        // https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_sync_root_standard_info
        var buffer = new byte[StandardCapacity];
        var status = Native.CfGetSyncRootInfoByPath(root, 1, buffer, (uint)buffer.Length, out var returned);
        if (status != 0) return new(status);
        if (returned < IdentityOffset || returned > buffer.Length)
            throw new IOException("Native root readback returned an invalid length.");
        var identityLength = BitConverter.ToUInt32(buffer, 1052);
        if (identityLength > MaximumIdentity || IdentityOffset + identityLength > returned)
            throw new IOException("Native root identity readback is invalid.");
        return new(status, BitConverter.ToInt64(buffer, 0), FixedString(buffer, 28), FixedString(buffer, 540),
            buffer.AsSpan(IdentityOffset, (int)identityLength).ToArray(),
            BitConverter.ToUInt16(buffer, 8), BitConverter.ToUInt16(buffer, 10),
            BitConverter.ToUInt16(buffer, 12), BitConverter.ToUInt16(buffer, 14),
            BitConverter.ToUInt32(buffer, 16), BitConverter.ToUInt32(buffer, 20));
    }

    private static string FixedString(byte[] buffer, int offset)
    {
        var value = Encoding.Unicode.GetString(buffer, offset, 512);
        var end = value.IndexOf('\0');
        if (end < 0) throw new IOException("Native provider metadata was not terminated.");
        return value[..end];
    }

    private static void VerifySnapshot(string root, Snapshot actual, byte[] context, long? expectedFileId)
    {
        if (actual.Status != 0 || actual.Context is null || actual.Name != ProviderName || actual.Version != ProviderVersion ||
            !CryptographicOperations.FixedTimeEquals(actual.Context, context) || actual.FileId == 0 ||
            (expectedFileId is { } pinned && actual.FileId != pinned) || actual.HydrationPrimary != 2 ||
            actual.HydrationModifier != 0 || actual.PopulationPrimary != 3 || actual.PopulationModifier != 0 ||
            actual.InSync != InSyncPolicy || actual.Hardlink != 0 || ActualRootFileId(root) != actual.FileId)
            throw new IOException("The native registration does not match this preview's exact root, identity and policies.");
        // ProviderId GUID is deliberately not claimed: supported CfGetSyncRootInfo classes do not return it.
    }

    private static void ValidateContext(byte[] context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (context.Length is < 16 or > MaximumIdentity)
            throw new ArgumentException("A bounded durable nonsecret owner identity is required.", nameof(context));
    }

    private static string ValidateRoot(string root, bool requireEmpty)
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            throw new PlatformNotSupportedException("The native preview requires Windows x64.");
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        if (!Path.IsPathFullyQualified(root) || root.StartsWith("\\\\", StringComparison.Ordinal))
            throw new ArgumentException("A fully qualified local NTFS preview directory is required.", nameof(root));
        using var visibility = PlaceholderVisibility.Expose();
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var drive = new DriveInfo(Path.GetPathRoot(full)!);
        if (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase) ||
            full.Equals(Path.TrimEndingDirectorySeparator(drive.RootDirectory.FullName), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Use a dedicated directory on a fixed NTFS drive.", nameof(root));
        for (string? part = full; part is not null; part = Path.GetDirectoryName(part))
        {
            // Directory.Exists can return false for a registered Cloud Files
            // reparse root even when GetFileAttributes confirms that the exact
            // path is an existing directory. Use one attribute read for both
            // existence/type validation and the reparse policy.
            FileAttributes attributes;
            try { attributes = File.GetAttributes(part); }
            catch (FileNotFoundException error) { throw new IOException("The preview root or an ancestor does not exist.", error); }
            catch (DirectoryNotFoundException error) { throw new IOException("The preview root or an ancestor does not exist.", error); }
            if ((attributes & FileAttributes.Directory) == 0)
                throw new IOException("The preview root or an ancestor is not a directory.");
            if ((attributes & FileAttributes.ReparsePoint) != 0 &&
                (requireEmpty || part != full || !IsExactCloudRoot(full)))
                throw new IOException("The preview path contains an unsupported reparse point.");
        }
        if (requireEmpty && Directory.EnumerateFileSystemEntries(full).Any()) throw new IOException("The new preview root must be empty.");
        return full;
    }

    /// <summary>Read-only exact physical identity check for a retained removed-root receipt.</summary>
    internal static bool HasExactRootFileId(string root, long expectedFileId)
    {
        AssertAbi();
        if (expectedFileId == 0) return false;
        var canonical = ValidateRoot(root, requireEmpty: false);
        return ActualRootFileId(canonical) == expectedFileId;
    }

    private static long ActualRootFileId(string root)
    {
        using var handle = Native.CreateFileW(root, 0x80, 7, 0, 3, 0x02200000, 0);
        if (handle.IsInvalid || !Native.GetFileInformationByHandle(handle, out var info))
            throw new IOException("The exact preview root file ID is unavailable.");
        return unchecked((long)(((ulong)info.FileIndexHigh << 32) | info.FileIndexLow));
    }

    private static bool IsExactCloudRoot(string root)
    {
        using var visibility = PlaceholderVisibility.Expose();
        using var handle = Native.CreateFileW(root, 0x80, 7, 0, 3, 0x02200000, 0);
        if (handle.IsInvalid || !Native.GetFileInformationByHandleEx(handle, 9, out var info, 8)) return false;
        if ((info.Attributes & 0x400) == 0 || (info.Tag & 0xFFFF0FFF) != 0x9000001A) return false;
        var state = Native.CfGetPlaceholderStateFromAttributeTag(info.Attributes, info.Tag);
        if (state == uint.MaxValue || (state & 1) == 0) return false;
        // Attribute/tag state is advisory during registration propagation. A standard native root
        // readback plus no-follow file ID proves that THIS directory is the root, not a descendant.
        // The caller next verifies exact persisted context, provider metadata and policies.
        var snapshot = Read(root);
        return snapshot.Status == 0 && snapshot.FileId != 0 && ActualRootFileId(root) == snapshot.FileId;
    }

    private static void AssertAbi()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<SyncRegistration>() != 72 || Marshal.SizeOf<SyncPolicies>() != 24 ||
            Marshal.OffsetOf<SyncRegistration>(nameof(SyncRegistration.RootIdentity)).ToInt32() != 24 ||
            Marshal.OffsetOf<SyncRegistration>(nameof(SyncRegistration.RootIdentityLength)).ToInt32() != 32 ||
            Marshal.OffsetOf<SyncRegistration>(nameof(SyncRegistration.FileIdentity)).ToInt32() != 40 ||
            Marshal.OffsetOf<SyncRegistration>(nameof(SyncRegistration.ProviderId)).ToInt32() != 52 ||
            Marshal.SizeOf<FileInformation>() != 52)
            throw new PlatformNotSupportedException("Native Cloud Files registration ABI is unsupported.");
    }

    [StructLayout(LayoutKind.Sequential)] private struct Policy { internal ushort Primary, Modifier; }
    [StructLayout(LayoutKind.Sequential)] private struct SyncPolicies
    { internal uint StructSize; internal Policy Hydration, Population; internal uint InSync, Hardlink, Management; }
    [StructLayout(LayoutKind.Sequential)] private struct SyncRegistration
    {
        internal uint StructSize; internal nint ProviderName, ProviderVersion, RootIdentity; internal uint RootIdentityLength;
        internal nint FileIdentity; internal uint FileIdentityLength; internal Guid ProviderId;
    }
    [StructLayout(LayoutKind.Sequential)] private struct AttributeTag { internal uint Attributes, Tag; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        internal uint VolumeSerial, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }
    private static class Native
    {
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfRegisterSyncRoot(string root, ref SyncRegistration registration, ref SyncPolicies policies, uint flags);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfUnregisterSyncRoot(string root);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfGetSyncRootInfoByPath(string root, int infoClass, [Out] byte[] buffer, uint length, out uint returned);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes, uint tag);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, out AttributeTag info, uint size);
    }
}

public sealed record NativeRootObservation(int Hresult, long RootFileId, bool ExpectedContextMatches,
    bool ExpectedNameMatches, bool ExpectedVersionMatches, ushort HydrationPrimary, ushort HydrationModifier,
    ushort PopulationPrimary, ushort PopulationModifier, uint InSyncPolicy, uint HardlinkPolicy);
