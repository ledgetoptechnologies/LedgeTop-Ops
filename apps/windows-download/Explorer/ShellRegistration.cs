using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32;
using Windows.Security.Cryptography;
using Windows.Storage;
using Windows.Storage.Provider;

namespace LedgeTop.Files.Explorer;

/// <summary>Supported brokered shell/native registration. Actual metadata and native identity prove ownership;
/// negative GetCurrentSyncRoots/GetSyncRootInformationForId results do not prove registration absence.</summary>
public sealed class ShellRegistration : IPreviewRootRegistration
{
    // Telemetry only, retained for the separate native-only helper. Never claimed as a readable ownership pin.
    public static readonly Guid ProviderId = new("d8bd85d7-7acd-41fb-b332-8c5285c258c1");
    public const string DisplayName = "LedgeTop Files Preview";
    private const string MachineParent = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager\";
    private const int NotUnderSyncRoot = unchecked((int)0x80070186);
    private static readonly SemaphoreSlim changes = new(1, 1);
    private static readonly Dictionary<string, ShellRegistration> owned = new(StringComparer.Ordinal);
    private static readonly HashSet<string> attempted = new(StringComparer.Ordinal);
    private readonly byte[] context;
    private readonly string sid, icon, displayName;
    private long rootFileId;
    private Guid namespaceClsid;
    private bool removalAttempted, removed;

    private ShellRegistration(string root, string id, string icon, byte[] context, Guid expectedNamespace = default, long expectedRootFileId = 0, string displayName = DisplayName)
    {
        Root = root; Id = id; this.icon = icon; this.context = context.ToArray();
        this.displayName = displayName; sid = CurrentSid(); namespaceClsid = expectedNamespace; rootFileId = expectedRootFileId;
    }

    public string Root { get; }
    public string Id { get; }
    public string IconResource => icon;
    public string RegisteredDisplayName => displayName;
    public long RootFileId => rootFileId;
    public Guid NamespaceClsid => namespaceClsid;

    public static string CreateId(Guid previewId)
    {
        if (previewId == Guid.Empty) throw new ArgumentException("A preview identity is required.", nameof(previewId));
        return NativeRootRegistration.ProviderName + "!" + CurrentSid() + "!" + previewId.ToString("N");
    }

    /// <summary>One Register attempt on a new empty root. Persist Id/context before calling. Failure retains
    /// an OwnedPartial receipt; nothing retries, directly writes HKLM, or automatically unregisters.</summary>
    public static async Task<ShellRegistration> RegisterAsync(string root, string id, string iconResource, byte[] context, string displayName = DisplayName)
    {
        ValidateId(id); ValidateContext(context); ValidateIcon(iconResource); ExplorerRootDisplayName.ValidateRegistration(displayName);
        context = context.ToArray();
        var canonical = ValidateRoot(root, true);
        if (!StorageProviderSyncRootManager.IsSupported()) throw new NotSupportedException("Windows Cloud Files registration is unavailable.");
        await changes.WaitAsync();
        try
        {
            if (attempted.Contains(id) || owned.ContainsKey(id)) throw new IOException("This shell identity already has an attempt; reconcile it before continuing.");
            using (var machine = Machine())
            using (var existing = machine.OpenSubKey(MachineParent + id, false))
                if (existing is not null) throw new IOException("The exact shell ID already exists; it was not changed.");
            if (NativeRootRegistration.Inspect(canonical, context).Hresult != NotUnderSyncRoot)
                throw new ShellRegistrationPreflightRefusedException("The root overlaps a native registration or its state is unavailable.");
            var folder = await StorageFolder.GetFolderFromPathAsync(canonical);
            ValidateRoot(canonical, true);
            // The folder lookup awaited external OS work; recheck both ownership surfaces before the one write.
            using (var machine = Machine())
            using (var existing = machine.OpenSubKey(MachineParent + id, false))
                if (existing is not null) throw new IOException("The exact shell ID appeared during preparation; it was not changed.");
            if (NativeRootRegistration.Inspect(canonical, context).Hresult != NotUnderSyncRoot)
                throw new ShellRegistrationPreflightRefusedException("Native registration changed during preparation; no registration was attempted.");
            var receipt = new ShellRegistration(canonical, id, iconResource, context, displayName: displayName);
            attempted.Add(id); owned.Add(id, receipt); // Retain before the side effect.
            try
            {
                // https://learn.microsoft.com/en-us/uwp/api/windows.storage.provider.storageprovidersyncrootmanager.register
                // Microsoft CloudMirror uses this supported broker and omits optional telemetry ProviderId.
                StorageProviderSyncRootManager.Register(new StorageProviderSyncRootInfo
                {
                    Id = id, Path = folder, DisplayNameResource = displayName, IconResource = iconResource,
                    Version = NativeRootRegistration.ProviderVersion, AllowPinning = true, ShowSiblingsAsGroup = false,
                    HydrationPolicy = StorageProviderHydrationPolicy.Full,
                    HydrationPolicyModifier = StorageProviderHydrationPolicyModifier.None,
                    PopulationPolicy = StorageProviderPopulationPolicy.AlwaysFull,
                    HardlinkPolicy = StorageProviderHardlinkPolicy.None,
                    InSyncPolicy = (StorageProviderInSyncPolicy)1023,
                    Context = CryptographicBuffer.CreateFromByteArray(context)
                });
                receipt.VerifyIdentity(true, false);
                return receipt;
            }
            catch (Exception error)
            {
                try { receipt.VerifyIdentity(false, false); } catch { } // Read-only partial-outcome capture.
                throw new ShellRegistrationException("Shell registration needs exact outcome reconciliation; no retry was performed.", receipt, error);
            }
        }
        finally { changes.Release(); }
    }

    public static ShellRegistration OpenOwned(string root, string id, byte[] context, string? iconResource = null,
        Guid? expectedNamespaceClsid = null, long? expectedRootFileId = null, string displayName = DisplayName) =>
        Open(root, id, context, iconResource, expectedNamespaceClsid, expectedRootFileId, forRemoval: false, displayName);

    /// <summary>Explicit read-only recovery for removal. A durable namespace GUID is mandatory when native
    /// registration is absent or linked entries are partially removed.</summary>
    public static ShellRegistration OpenForRemoval(string root, string id, byte[] context, Guid expectedNamespaceClsid,
        long expectedRootFileId, string? iconResource = null, string displayName = DisplayName)
    {
        if (expectedNamespaceClsid == Guid.Empty) throw new ArgumentException("The saved namespace identity is required.", nameof(expectedNamespaceClsid));
        return Open(root, id, context, iconResource, expectedNamespaceClsid, expectedRootFileId, forRemoval: true, displayName);
    }

    private static ShellRegistration Open(string root, string id, byte[] context, string? iconResource,
        Guid? expectedNamespaceClsid, long? expectedRootFileId, bool forRemoval, string displayName)
    {
        ValidateId(id); ValidateContext(context); ExplorerRootDisplayName.ValidateRegistration(displayName);
        var canonical = ValidateRoot(root, false);
        changes.Wait();
        try
        {
            if (owned.TryGetValue(id, out var current))
            {
                if (current.displayName != displayName || current.removed || current.removalAttempted || !SameRoot(current.Root, canonical) ||
                    !CryptographicOperations.FixedTimeEquals(current.context, context) ||
                    iconResource is not null && !SameIcon(current.icon, iconResource) ||
                    expectedNamespaceClsid is { } ns && current.namespaceClsid != Guid.Empty && ns != current.namespaceClsid ||
                    expectedRootFileId is { } fileId && current.rootFileId != 0 && fileId != current.rootFileId)
                    throw new IOException("The current shell receipt differs from the saved preview; no mutation was performed.");
                if (current.namespaceClsid == Guid.Empty && expectedNamespaceClsid is { } expectedNs) current.namespaceClsid = expectedNs;
                if (current.rootFileId == 0 && expectedRootFileId is { } expectedFileId) current.rootFileId = expectedFileId;
                current.VerifyIdentity(!forRemoval, forRemoval);
                return current;
            }
            var icon = iconResource ?? DefaultIcon(); ValidateIcon(icon, requireExistingResource: false);
            var receipt = new ShellRegistration(canonical, id, icon, context, expectedNamespaceClsid ?? Guid.Empty, expectedRootFileId ?? 0, displayName);
            receipt.VerifyIdentity(!forRemoval, forRemoval);
            owned.Add(id, receipt);
            return receipt;
        }
        finally { changes.Release(); }
    }

    public void VerifyOwned()
    {
        changes.Wait();
        try { RequireCurrent(); VerifyIdentity(true, false); }
        finally { changes.Release(); }
    }

    public void Unregister()
    {
        changes.Wait();
        try
        {
            RequireCurrent(); VerifyIdentity(false, namespaceClsid != Guid.Empty);
            if (namespaceClsid == Guid.Empty) throw new IOException("The owned namespace identity is unavailable; no removal was attempted.");
            removalAttempted = true; // Caller journals intent first. Never replay this receipt.
            StorageProviderSyncRootManager.Unregister(Id);
            if (!ObserveCore().CompleteAbsenceVerified) throw new IOException("Shell removal needs read-only reconciliation; it was not replayed.");
            removed = true; // Retain the small receipt so IsAbsent can still use its generated namespace GUID.
        }
        finally { changes.Release(); }
    }

    public static void Unregister(string id)
    {
        ShellRegistration receipt;
        changes.Wait();
        try { receipt = owned.TryGetValue(id, out var value) ? value : throw new IOException("No owned shell receipt is available."); }
        finally { changes.Release(); }
        receipt.Unregister();
    }

    /// <summary>Complete absence needs a persisted or process-retained generated namespace GUID.
    /// Unknown GUID means false: negative WinRT lookup never substitutes for actual absence readback.</summary>
    public static bool IsAbsent(string id, string root, byte[] context, Guid? expectedNamespaceClsid = null, string? iconResource = null, string displayName = DisplayName) =>
        Inspect(root, id, context, expectedNamespaceClsid, iconResource, displayName).CompleteAbsenceVerified;

    public static ShellRegistrationObservation Inspect(string root, string id, byte[] context,
        Guid? expectedNamespaceClsid = null, string? iconResource = null, string displayName = DisplayName)
    {
        ValidateId(id); ValidateContext(context); ExplorerRootDisplayName.ValidateRegistration(displayName);
        var canonical = ValidateRoot(root, false);
        changes.Wait();
        try
        {
            var icon = iconResource ?? DefaultIcon(); ValidateIcon(icon, requireExistingResource: false);
            if (owned.TryGetValue(id, out var current))
            {
                if (current.displayName != displayName || !SameRoot(current.Root, canonical) || !CryptographicOperations.FixedTimeEquals(current.context, context) ||
                    !SameIcon(current.icon, icon) || expectedNamespaceClsid is { } ns && ns != current.namespaceClsid)
                    throw new IOException("The requested shell observation differs from the retained receipt.");
                return current.ObserveCore();
            }
            return new ShellRegistration(canonical, id, icon, context, expectedNamespaceClsid ?? Guid.Empty, displayName: displayName).ObserveCore();
        }
        finally { changes.Release(); }
    }

    private void RequireCurrent()
    {
        if (!owned.TryGetValue(Id, out var current) || !ReferenceEquals(current, this) || removalAttempted || removed)
            throw new InvalidOperationException("The shell receipt is no longer current; it will not replay a mutation.");
    }

    private void VerifyIdentity(bool requireNative, bool allowMissingLinks)
    {
        ValidateRoot(Root, false);
        var native = NativeRootRegistration.Inspect(Root, context);
        VerifyObservedIdentity(native, requireNative, () =>
            ShellMetadata.Read(Id, sid, Root, icon, namespaceClsid, allowMissingLinks, displayName)?.NamespaceClsid
            ?? throw new IOException("Exact shell provider metadata is absent; no WinRT lookup was treated as absence proof."));
    }

    // This only retains an already-matching native observation. It does not confer
    // permission to remove or mutate a registration; those paths verify ownership again.
    internal void VerifyObservedIdentity(NativeRootObservation native, bool requireNative, Func<Guid> readNamespace)
    {
        if (native.Hresult == 0)
        {
            if (!MatchesNative(native) || rootFileId != 0 && rootFileId != native.RootFileId)
                throw new IOException("The actual native identity or policies differ from this shell preview.");
            if (rootFileId == 0) rootFileId = native.RootFileId;
        }
        else if (requireNative || native.Hresult != NotUnderSyncRoot)
            throw new IOException("Native registration is absent or unavailable; it was not recreated.");
        var observedNamespace = readNamespace();
        if (namespaceClsid == Guid.Empty) namespaceClsid = observedNamespace;
    }

    private ShellRegistrationObservation ObserveCore()
    {
        var native = NativeRootRegistration.Inspect(Root, context);
        if (native.Hresult != 0 && native.Hresult != NotUnderSyncRoot) throw new IOException("Native registration observation is unavailable.");
        if (native.Hresult == 0 && (!MatchesNative(native) || rootFileId != 0 && rootFileId != native.RootFileId))
            throw new IOException("Native registration ownership changed.");
        var metadata = ShellMetadata.Read(Id, sid, Root, icon, namespaceClsid, true, displayName);
        var ns = namespaceClsid != Guid.Empty ? namespaceClsid : metadata?.NamespaceClsid ?? Guid.Empty;
        var linksAbsent = ns != Guid.Empty && ShellMetadata.LinkedEntriesAbsent(ns);
        return new(native.Hresult, native.RootFileId, native.Hresult == 0 && MatchesNative(native),
            metadata is not null, metadata is null, ns, linksAbsent,
            native.Hresult == NotUnderSyncRoot && metadata is null && linksAbsent);
    }

    private static bool MatchesNative(NativeRootObservation value) => value.ExpectedContextMatches && value.ExpectedNameMatches &&
        value.ExpectedVersionMatches && value.RootFileId != 0 && value.HydrationPrimary == 2 && value.HydrationModifier == 0 &&
        value.PopulationPrimary == 3 && value.PopulationModifier == 0 && value.InSyncPolicy == 1023 && value.HardlinkPolicy == 0;
    private static void ValidateId(string id)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        var prefix = NativeRootRegistration.ProviderName + "!" + CurrentSid() + "!";
        if (!id.StartsWith(prefix, StringComparison.Ordinal) || !Guid.TryParseExact(id[prefix.Length..], "N", out var value) || value == Guid.Empty)
            throw new ArgumentException("The shell preview ID must belong to the current Windows user.", nameof(id));
    }
    private static string CurrentSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User?.Value ?? throw new IOException("The current Windows identity is unavailable.");
    }
    private static void ValidateContext(byte[] context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (context.Length is < 16 or > 65536) throw new ArgumentException("A bounded durable nonsecret context is required.", nameof(context));
    }
    private static string ValidateRoot(string root, bool empty)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        if (!Path.IsPathFullyQualified(root) || root.StartsWith(@"\\", StringComparison.Ordinal) || root.IndexOfAny(['\0', '%']) >= 0)
            throw new ArgumentException("A canonical local NTFS root is required.", nameof(root));
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var drive = new DriveInfo(Path.GetPathRoot(full)!);
        if (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase) ||
            SameRoot(full, drive.RootDirectory.FullName)) throw new IOException("A dedicated fixed NTFS directory is required.");
        PlaceholderVisibility.Run(() => {
            for (string? part = full; part is not null; part = Path.GetDirectoryName(part)) {
                if (!Directory.Exists(part)) throw new IOException("The preview directory and its ancestors must exist.");
                if ((File.GetAttributes(part) & System.IO.FileAttributes.ReparsePoint) != 0 && (empty || !SameRoot(part, full)))
                    throw new IOException("The preview path contains an unsupported alias.");
            }
            if (empty && Directory.EnumerateFileSystemEntries(full).Any()) throw new IOException("The new preview root must be empty.");
        });
        // Native Inspect additionally verifies the final cloud reparse tag and no-follow root ID.
        return full;
    }
    internal static void ValidateIcon(string icon, bool requireExistingResource = true)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(icon);
        var comma = icon.LastIndexOf(',');
        if (comma <= 0 || !int.TryParse(icon[(comma + 1)..], out _) || !Path.IsPathFullyQualified(icon[..comma]) ||
            icon[..comma].StartsWith(@"\\", StringComparison.Ordinal) ||
            (!File.Exists(icon[..comma]) && (requireExistingResource || icon != ExplorerBrandIcon.Resource)))
            throw new ArgumentException("An existing absolute local icon resource and index are required.", nameof(icon));
        // The exact durable branding path is an ownership metadata VALUE, not ownership evidence by itself.
        // Recovery/removal still verifies root/context/namespace/file ID and exact registered IconResource.
        // A missing/tampered public icon must not prevent removal or require rewriting it during cleanup.
    }
    private static bool SameRoot(string a, string b) => string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(a)),
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(b)), StringComparison.OrdinalIgnoreCase);
    private static bool SameIcon(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private static string DefaultIcon() => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3";
    private static RegistryKey Machine() => RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
}

public sealed record ShellRegistrationObservation(int NativeHresult, long RootFileId, bool ExpectedNativeIdentityMatches,
    bool ExactShellMetadataPresent, bool ExactShellMetadataAbsent, Guid NamespaceClsid, bool LinkedNamespaceAbsent,
    bool CompleteAbsenceVerified);

// Constructed only at the explicit checks before the broker call. Any exception after
// entering the broker call is wrapped in ShellRegistrationException instead.
internal sealed class ShellRegistrationPreflightRefusedException(string message) : IOException(message);

public sealed class ShellRegistrationException(string message, ShellRegistration ownedPartial, Exception inner) : IOException(message, inner)
{
    public ShellRegistration OwnedPartial { get; } = ownedPartial;
}
