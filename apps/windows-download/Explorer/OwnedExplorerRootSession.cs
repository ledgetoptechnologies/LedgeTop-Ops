using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

/// <summary>
/// Shared owned-root lifecycle for generated and connected Explorer sessions. No browser or catalog capture API.
/// Connected generations persist an immutable, credentialless manifest before any native registration.
/// </summary>
public sealed class OwnedExplorerRootSession : IExplorerPreviewSession
{
    private const string GeneratedOwner = "LedgeTop.Files.ExplorerPreview/1";
    private const string ConnectedOwner = "LedgeTop.Files.ConnectedExplorer/1";
    private string Owner => generated ? GeneratedOwner : ConnectedOwner;
    private readonly bool generated;
    private readonly ExplorerRootScope scope;
    private readonly Func<ExplorerSourceGate> sourceFactory;
    private ExplorerRootManifest? manifest;
    public ExplorerRootManifest? FrozenManifest { get { lock (view) return manifest; } }
    /// <summary>Read-only ownership evidence. A missing receipt never proves that Windows integration is absent.</summary>
    public bool HasOwnershipReceipt
    {
        get {
            if (!Directory.Exists(directory)) {
                if (File.Exists(directory)) throw new IOException("The owned profile directory changed type.");
                return false;
            }
            _ = ReadProfile();
            return true;
        }
    }
    private static readonly JsonSerializerOptions json = new()
    {
        WriteIndented = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        Converters = { new JsonStringEnumConverter() }
    };
    private enum Phase
    {
        Prepared, RootCreateIntent, RootCreated, NativeRegisterIntent, NativeReady,
        PopulateIntent, Populated, NavigationRegisterIntent, Ready,
        NavigationRemoveIntent, NavigationRemoved, NativeRemoveIntent, Removed
    }
    private sealed record Profile(int Schema, string Owner, string Sid, Guid Identity, string Root, string Context,
        string Icon, long RootFileId, Phase Phase, bool Paused, long Revision, Guid NamespaceClsid = default,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ManifestBinding? Binding = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DisplayName = null);
    private sealed record ManifestBinding(ExplorerRootScope Scope, string File, string Digest);

    private readonly string directory, profilePath, preferredRoot, sid;
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly object view = new();
    private readonly List<string> activity = [];
    private FileStream? lease;
    private Profile? profile;
    private ShellRegistration? registration;
    private NativePlaceholderProvider? provider;
    private ExplorerSourceGate? source;
    private ExplorerPreviewState state;
    private string rootPath;
    private bool disposed;

    /// <summary>Live source composition. Null inventory reopens only an existing persisted frozen manifest.</summary>
    public OwnedExplorerRootSession(string profileDirectory, string preferredRoot, IQueuedDownloadSource source,
        ExplorerRootScope scope, ExplorerRootManifest? initialManifest = null)
        : this(profileDirectory, preferredRoot, false, scope, initialManifest,
            LiveFactory(source, scope)) { }

    private static Func<ExplorerSourceGate> LiveFactory(IQueuedDownloadSource source, ExplorerRootScope scope)
    {
        ArgumentNullException.ThrowIfNull(source); ArgumentNullException.ThrowIfNull(scope); scope.Validate();
        return () => new ExplorerSourceGate(source, scope);
    }

    internal static OwnedExplorerRootSession Generated(string profileDirectory, string preferredRoot)
    {
        using var sample = new ExplorerDemoSource(signedIn: false);
        var scope = new ExplorerRootScope(sample.Channel, sample.Alias, sample.Origin.GetLeftPart(UriPartial.Authority), sample.PrincipalId);
        var inventory = new ExplorerRootManifest(scope, sample.Entries.ToDictionary(
            entry => entry.RelativePath.Replace('/', '\\'), entry => entry.Identity, StringComparer.OrdinalIgnoreCase));
        return new(profileDirectory, preferredRoot, true, scope, inventory, () => {
            var generatedSource = new ExplorerDemoSource(signedIn: false);
            return new ExplorerSourceGate(generatedSource, scope, generatedSource.SignIn, generatedSource.Revoke, generatedSource.Dispose);
        });
    }

    private OwnedExplorerRootSession(string profileDirectory, string preferredRoot, bool generated, ExplorerRootScope scope,
        ExplorerRootManifest? initialManifest, Func<ExplorerSourceGate> sourceFactory)
    {
        scope.Validate();
        if (initialManifest is not null && initialManifest.Scope != scope) throw new IOException("The Explorer inventory source scope differs.");
        this.generated = generated; this.scope = scope; this.manifest = initialManifest; this.sourceFactory = sourceFactory;
        directory = CanonicalLocal(profileDirectory); this.preferredRoot = CanonicalLocal(preferredRoot);
        profilePath = Path.Combine(directory, "profile.json"); rootPath = this.preferredRoot;
        using var identity = WindowsIdentity.GetCurrent();
        sid = identity.User?.Value ?? throw new IOException("The current Windows user identity is unavailable.");
        try
        {
            if (Directory.Exists(directory))
            {
                profile = ReadProfile();
                rootPath = profile.Root;
                if (!generated && profile.Phase == Phase.Ready) LoadFrozenManifest(profile);
                if (profile.Phase == Phase.Removed) state = ExplorerPreviewState.Removed;
                else if (profile.Phase != Phase.Ready) state = ExplorerPreviewState.Failed;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            state = ExplorerPreviewState.Failed;
            Add("The saved preview needs ownership review. No files or Windows registrations were changed.");
        }
    }

    public string RootPath { get { lock (view) return rootPath; } }
    public ExplorerPreviewState State { get { lock (view) return state; } }
    public IReadOnlyList<string> Activity { get { lock (view) return activity.ToArray(); } }
    public event EventHandler? Changed;

    public Task StartAsync() => OperateAsync(StartCoreAsync);
    public Task PauseAsync() => OperateAsync(() =>
    {
        if (provider is null || profile?.Phase != Phase.Ready) throw new InvalidOperationException("Start the preview before pausing it.");
        Save(profile with { Paused = true });
        source!.Pause();
        SetState(ExplorerPreviewState.Paused);
        Add(generated ? "New generated-file downloads are paused. Files already on this device remain available." : "New file downloads are paused. Files already on this device remain available.");
        return Task.CompletedTask;
    });
    public Task ResumeAsync() => OperateAsync(async () =>
    {
        if (provider is null || profile?.Phase != Phase.Ready) throw new InvalidOperationException("Start the preview before resuming it.");
        await source!.ResumeAsync();
        Save(profile with { Paused = false });
        SetState(ExplorerPreviewState.Running);
        Add(generated ? "Generated-file downloads resumed. This does not sign in to a real account." : "Downloads resumed using the current signed-in account.");
    });
    public Task RemoveAsync() => OperateAsync(RemoveCoreAsync);

    /// <summary>Read-only generated-preview retry proof. A Removed journal alone is not absence.
    /// Uses the original strict receipt parser and exact physical/native/namespace identities;
    /// never starts, reconnects, unregisters, or changes the saved removal journal.</summary>
    public bool VerifyRecordedRemovedAbsence()
    {
        if (!operations.Wait(0)) return false; // Never block a UI caller behind an async session operation.
        try {
            if (disposed || !generated) return false;
            var p = ReadProfile();
            if (p.Phase != Phase.Removed || p.RootFileId == 0 || p.NamespaceClsid == Guid.Empty ||
                !NativeRootRegistration.HasExactRootFileId(p.Root, p.RootFileId)) return false;
            var absent = ShellRegistration.Inspect(p.Root, ShellRegistration.CreateId(p.Identity), Context(p),
                p.NamespaceClsid, p.Icon, ProfileDisplayName(p)).CompleteAbsenceVerified;
            // Recheck the physical pin after namespace/native observations as well. This is a
            // bounded read-only snapshot, not permission to clean up any newly appearing root.
            return absent && NativeRootRegistration.HasExactRootFileId(p.Root, p.RootFileId);
        } finally { operations.Release(); }
    }

    private async Task OperateAsync(Func<Task> operation)
    {
        await operations.WaitAsync();
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            await Task.Run(operation);
        }
        catch
        {
            source?.Pause();
            if (provider is not null)
            {
                try { await provider.DisposeAsync(); provider = null; }
                catch { Add("Provider shutdown could not be confirmed. Its owned registration was retained for review."); }
            }
            SetState(ExplorerPreviewState.Failed);
            Add("The preview stopped at a safety check. An interrupted Windows change may need ownership review.");
            throw;
        }
        finally { operations.Release(); }
    }

    private async Task StartCoreAsync()
    {
        if (provider is not null && State is ExplorerPreviewState.Running or ExplorerPreviewState.Paused) return;
        SetState(ExplorerPreviewState.Starting);
        if (!generated) {
            if (manifest is null && !File.Exists(profilePath)) throw new IOException("A new Explorer root requires a captured immutable inventory.");
        }
        AcquireLease(allowCreate: true);
        profile = File.Exists(profilePath) ? ReadProfile() : null;
        if (profile is not null && profile.Phase is not (Phase.Ready or Phase.Removed))
            throw new IOException("A previous preview setup is incomplete. Remove or reconcile that exact preview before starting again.");
        var reconnect = profile?.Phase == Phase.Ready;
        if (!reconnect)
        {
            if (profile is { Phase: Phase.Removed } previous) Archive(previous);
            var id = Guid.NewGuid();
            var selectedRoot = NewRoot();
            var binding = generated ? null : new ManifestBinding(scope, "manifest-" + id.ToString("N") + ".json",
                (manifest ?? throw new IOException("The frozen Explorer inventory is unavailable.")).Digest);
            profile = new(generated ? 2 : 4, Owner, sid, id, selectedRoot, Owner + ":" + id.ToString("N"), ExplorerBrandIcon.EnsureResource(), 0, Phase.Prepared, false, 0, Binding: binding, DisplayName: generated ? null : ExplorerRootDisplayName.ForConnectedAlias(scope.Alias));
            Save(profile, createOnly: !File.Exists(profilePath));
            if (!generated) PublishFrozenManifest(profile);
            // Even a cancelled/expired cached session leaves positive Prepared ownership evidence.
            // No root or Windows registration has been attempted at this phase.
            if (!generated) {
                source ??= sourceFactory();
                await source.CheckCurrentAsync();
            }
            SetRoot(selectedRoot);
            ValidateAncestors(selectedRoot, includeLeaf: false);
            if (Directory.Exists(selectedRoot) || File.Exists(selectedRoot))
                throw new IOException("The preview folder already exists without this new generation's ownership receipt. It was not adopted.");
            Save(profile with { Phase = Phase.RootCreateIntent });
            Directory.CreateDirectory(selectedRoot);
            ValidateAncestors(selectedRoot, includeLeaf: true);
            Save(profile with { Phase = Phase.RootCreated });
        }
        else {
            if (!generated) {
                LoadFrozenManifest(profile!);
                source ??= sourceFactory();
                await source.CheckCurrentAsync(); // Cached only; no browser sign-in.
            }
            SetRoot(profile!.Root);
        }

        var p = profile!;
        if (p.Icon == ExplorerBrandIcon.Resource) _ = ExplorerBrandIcon.EnsureResource();
        var cache = EnsureCache(p);
        if (!generated) LoadFrozenManifest(p);
        source ??= sourceFactory();
        if (!p.Paused) await source.ResumeAsync();
        else source.Pause();
        if (reconnect)
        {
            registration = ShellRegistration.OpenOwned(p.Root, ShellRegistration.CreateId(p.Identity), Context(p), p.Icon, p.NamespaceClsid, p.RootFileId, ProfileDisplayName(p));
            VerifyPinnedRoot(p, registration);
            provider = CreateProvider(registration, source, cache);
            await provider.ConnectExistingAsync();
            Add(generated ? "Reconnected the existing generated preview without replacing its files." : "Reconnected the frozen Explorer inventory without replacing its files.");
        }
        else
        {
            Save(profile! with { Phase = Phase.NativeRegisterIntent });
            try
            {
                registration = await ShellRegistration.RegisterAsync(p.Root, ShellRegistration.CreateId(p.Identity), p.Icon, Context(p), ProfileDisplayName(p));
            }
            catch (ShellRegistrationException error)
            {
                // Preserve positively observed OS-generated identities even when registration readback
                // did not finish. Never retry Register or infer absence from a negative WinRT lookup.
                registration = error.OwnedPartial;
                if (registration.NamespaceClsid != Guid.Empty || registration.RootFileId != 0)
                    Save(profile! with { NamespaceClsid = registration.NamespaceClsid, RootFileId = registration.RootFileId });
                Add("Windows registration did not finish its ownership checks. Its recorded outcome was retained; registration was not retried.");
                throw;
            }
            Save(profile! with { Phase = Phase.NativeReady, RootFileId = registration.RootFileId, NamespaceClsid = registration.NamespaceClsid });
            provider = CreateProvider(registration, source, cache);
            Save(profile! with { Phase = Phase.PopulateIntent });
            await provider.ConnectAndPopulateAsync();
            Save(profile! with { Phase = Phase.Populated });
            Save(profile! with { Phase = Phase.Ready });
            Add(generated ? "The generated preview is available in File Explorer. Open a sample to download it on demand." : "Your authorized files are available in File Explorer. Open an online-only file to download it.");
        }
        SetState(profile!.Paused ? ExplorerPreviewState.Paused : ExplorerPreviewState.Running);
        if (profile.Paused) Add("The preview remains paused. Existing local files are still available.");
    }

    private NativePlaceholderProvider CreateProvider(IPreviewRootRegistration native, ExplorerSourceGate boundSource, string cache)
    {
        var inventory = manifest ?? throw new IOException("The frozen Explorer inventory is unavailable.");
        var result = new NativePlaceholderProvider(native, cache, boundSource, scope.Channel, scope.PrincipalId, inventory.Files, inventory.Directories);
        result.Activity += Add;
        return result;
    }

    private async Task RemoveCoreAsync()
    {
        if (!Directory.Exists(directory)) { SetState(ExplorerPreviewState.Removed); return; }
        AcquireLease(allowCreate: false);
        profile = ReadProfile();
        var p = profile;
        SetRoot(p.Root);
        if (p.Phase == Phase.Removed) { SetState(ExplorerPreviewState.Removed); return; }

        source?.Pause();
        if (provider is not null)
        {
            await provider.DisposeAsync();
            provider = null; // Never detach persistent resources after an uncertain disconnect.
        }
        if (p.Phase <= Phase.RootCreated)
        {
            // No registration intent was ever persisted, so no Windows integration was attempted.
            // Even a pre-existing conflicting local folder is left completely unchanged.
            Save(p with { Phase = Phase.Removed }); SetState(ExplorerPreviewState.Removed);
            Add("The unused preview setup was removed. Existing local files and folders were kept."); return;
        }
        if (!Directory.Exists(p.Root))
        {
            if (p.Phase is Phase.Prepared or Phase.RootCreateIntent)
            {
                Save(p with { Phase = Phase.Removed }); SetState(ExplorerPreviewState.Removed); return;
            }
            throw new IOException("The previously registered preview root is missing; exact reconciliation is required.");
        }
        var shellId = ShellRegistration.CreateId(p.Identity);
        if (ShellRegistration.IsAbsent(shellId, p.Root, Context(p), p.NamespaceClsid == Guid.Empty ? null : p.NamespaceClsid, p.Icon, ProfileDisplayName(p)))
        {
            // Early setup did not reach native registration, or a previously journaled removal completed.
            if (p.Phase <= Phase.NativeRegisterIntent || p.Phase == Phase.NativeRemoveIntent)
            {
                Save(p with { Phase = Phase.Removed }); SetState(ExplorerPreviewState.Removed);
                Add("The preview integration was removed. Online-only items may no longer be present in the local folder."); return;
            }
            throw new IOException("The native registration disappeared outside the recorded removal sequence; it was not recreated.");
        }
        if (p.Phase == Phase.NativeRemoveIntent)
        {
            Add("Windows removal has an incomplete recorded outcome. The preview needs ownership review; removal was not repeated.");
            throw new IOException("The recorded Windows removal is incomplete. Inspect the exact saved registration before any further change.");
        }
        registration ??= ShellRegistration.OpenOwned(p.Root, shellId, Context(p), p.Icon,
            p.NamespaceClsid == Guid.Empty ? null : p.NamespaceClsid, p.RootFileId == 0 ? null : p.RootFileId, ProfileDisplayName(p));
        VerifyPinnedRoot(p, registration, allowUnrecordedId: p.Phase == Phase.NativeRegisterIntent);
        if (profile!.NamespaceClsid == Guid.Empty)
            Save(profile with { NamespaceClsid = registration.NamespaceClsid, RootFileId = registration.RootFileId });
        if (!generated) LoadFrozenManifest(p);
        source ??= sourceFactory();
        var cache = EnsureCache(p);
        await using (var verifier = CreateProvider(registration, source, cache)) verifier.ValidateForRemoval();

        Save(profile! with { Phase = Phase.NativeRemoveIntent });
        registration.Unregister(); registration = null;
        Save(profile! with { Phase = Phase.Removed });
        source.Dispose(); source = null;
        SetState(ExplorerPreviewState.Removed);
        Add("The preview integration was removed. Check the previous folder for local files; online-only items may no longer be present.");
    }

    private void VerifyPinnedRoot(Profile p, ShellRegistration native, bool allowUnrecordedId = false)
    {
        native.VerifyOwned();
        if ((p.RootFileId == 0 ? !allowUnrecordedId : native.RootFileId != p.RootFileId) ||
            (p.NamespaceClsid != Guid.Empty && native.NamespaceClsid != p.NamespaceClsid))
            throw new IOException("The current native root no longer matches the saved preview file identity.");
    }

    private string EnsureCache(Profile p)
    {
        var cache = Path.Combine(directory, "cache", p.Identity.ToString("N"));
        ValidateAncestors(cache, includeLeaf: true, allowMissing: true);
        Directory.CreateDirectory(cache);
        ValidateAncestors(cache, includeLeaf: true);
        return cache;
    }

    private void AcquireLease(bool allowCreate)
    {
        if (lease is not null) return;
        var exists = Directory.Exists(directory);
        if (exists) _ = ReadProfile(); // Refuse a pre-existing unowned profile directory.
        else
        {
            if (!allowCreate) throw new IOException("There is no owned preview profile to remove.");
            ValidateAncestors(directory, includeLeaf: true, allowMissing: true);
            Directory.CreateDirectory(directory);
        }
        ValidateAncestors(directory, includeLeaf: true);
        var lockPath = Path.Combine(directory, "session.lock");
        if (File.Exists(lockPath) && (File.GetAttributes(lockPath) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The preview session lock is an unsupported alias.");
        lease = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        if (exists) profile = ReadProfile(); // A different process may have changed it before the lease.
    }

    private Profile ReadProfile()
    {
        ValidateAncestors(directory, includeLeaf: true);
        var info = new FileInfo(profilePath);
        if (!info.Exists || info.Length is < 1 or > 65536 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The preview profile ownership marker is missing or invalid.");
        var profileBytes = File.ReadAllBytes(profilePath);
        using var document = JsonDocument.Parse(profileBytes);
        _ = ExplorerRootDisplayName.ResolveProfileJson(document.RootElement, generated, scope.Alias);
        var p = JsonSerializer.Deserialize<Profile>(profileBytes, json)
            ?? throw new IOException("The preview profile is invalid.");
        if (p.Owner != Owner || p.Sid != sid || p.Identity == Guid.Empty || p.Revision < 1 ||
            !Enum.IsDefined(p.Phase) || p.Context != Owner + ":" + p.Identity.ToString("N") || !ExplorerBrandIcon.IsKnownResource(p.Icon) ||
            !IsRootVariant(p.Root))
            throw new IOException("The profile does not belong to this Windows user and preview location.");
        if (p.Phase is Phase.NativeReady or Phase.PopulateIntent or Phase.Populated or Phase.Ready or Phase.NativeRemoveIntent &&
            (p.RootFileId == 0 || p.NamespaceClsid == Guid.Empty))
            throw new IOException("The saved Shell preview is missing its pinned registration identities.");
        if (generated ? p.Binding is not null :
            p.Binding is null || p.Binding.Scope != scope || p.Binding.File != "manifest-" + p.Identity.ToString("N") + ".json" ||
            !System.Text.RegularExpressions.Regex.IsMatch(p.Binding.Digest ?? "", "\\A[a-f0-9]{64}\\z"))
            throw new IOException("The frozen inventory binding does not match this source and root generation.");
        ValidateAncestors(p.Root, includeLeaf: false);
        return p;
    }

    private void Save(Profile next, bool createOnly = false)
    {
        if (lease is null) throw new InvalidOperationException("The preview profile lease is required before saving.");
        ValidateAncestors(directory, includeLeaf: true);
        if (File.Exists(profilePath) && (File.GetAttributes(profilePath) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The preview profile was replaced by an alias.");
        next = next with { Revision = checked(next.Revision + 1) };
        var temporary = Path.Combine(directory, ".profile-write-" + Guid.NewGuid().ToString("N") + ".json");
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            JsonSerializer.Serialize(stream, next, json); stream.Flush(flushToDisk: true);
        }
        File.Move(temporary, profilePath, overwrite: !createOnly);
        profile = next;
    }

    private void PublishFrozenManifest(Profile p)
    {
        if (lease is null || p.Binding is not { } binding || manifest is null ||
            binding.Scope != scope || manifest.Scope != scope || binding.Digest != manifest.Digest)
            throw new IOException("A leased, source-bound inventory is required before root creation.");
        ValidateAncestors(directory, includeLeaf: true);
        var path = Path.Combine(directory, binding.File);
        if (File.Exists(path) || Directory.Exists(path))
            throw new IOException("An existing frozen-inventory file was not adopted or replaced.");
        var temporary = Path.Combine(directory, ".manifest-write-" + Guid.NewGuid().ToString("N") + ".json");
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
            stream.Write(manifest.Encode()); stream.Flush(flushToDisk: true);
        }
        File.Move(temporary, path, overwrite: false);
    }

    private void LoadFrozenManifest(Profile p)
    {
        if (p.Binding is not { } binding || binding.Scope != scope) throw new IOException("The frozen inventory source binding is missing.");
        var path = Path.Combine(directory, binding.File);
        ValidateAncestors(directory, includeLeaf: true);
        var info = new FileInfo(path);
        if (!info.Exists || info.Length is < 1 or > ExplorerRootManifest.MaximumBytes || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The frozen inventory file is missing, too large or was replaced by an alias.");
        byte[] bytes;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length != info.Length) throw new IOException("The frozen inventory changed while opening it.");
            bytes = new byte[stream.Length]; stream.ReadExactly(bytes);
        }
        if (Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)) != binding.Digest)
            throw new IOException("The frozen inventory digest differs from its owned profile.");
        var loaded = ExplorerRootManifest.Decode(bytes);
        if (loaded.Scope != scope || loaded.Digest != binding.Digest || manifest is not null && manifest.Digest != loaded.Digest)
            throw new IOException("The saved inventory differs from the selected source or requested frozen versions.");
        lock (view) manifest = loaded;
    }

    private void Archive(Profile previous)
    {
        var path = Path.Combine(directory, "removed-" + previous.Identity.ToString("N") + ".json");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(previous, json);
        if (File.Exists(path))
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || !File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes))
                throw new IOException("The retained removed-preview receipt differs; it was not overwritten.");
            return;
        }
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        stream.Write(bytes); stream.Flush(flushToDisk: true);
    }

    private string ProfileDisplayName(Profile p) => ExplorerRootDisplayName.ResolveProfile(generated, p.Schema, scope.Alias, p.DisplayName is not null, p.DisplayName);
    private static byte[] Context(Profile p) => Encoding.UTF8.GetBytes(p.Context);
    private string NewRoot()
    {
        for (var index = 1; index <= 9999; index++) {
            var candidate = index == 1 ? preferredRoot : preferredRoot + " (" + index.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")";
            if (!Directory.Exists(candidate) && !File.Exists(candidate)) return candidate;
        }
        throw new IOException("A new unused preview folder could not be selected.");
    }
    private bool IsRootVariant(string path)
    {
        if (path == preferredRoot) return true;
        if (!path.StartsWith(preferredRoot + " (", StringComparison.Ordinal) || !path.EndsWith(')')) return false;
        var number = path[(preferredRoot.Length + 2)..^1];
        return int.TryParse(number, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value)
            && value is >= 2 and <= 9999 && number == value.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    private static string CanonicalLocal(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (!Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal) || path.IndexOfAny(['\0', '%']) >= 0)
            throw new ArgumentException("A canonical local preview path is required.", nameof(path));
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var drive = new DriveInfo(Path.GetPathRoot(full)!);
        if (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase) ||
            full.Equals(Path.TrimEndingDirectorySeparator(drive.RootDirectory.FullName), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The preview requires dedicated directories on a fixed NTFS drive.", nameof(path));
        return full;
    }

    private static void ValidateAncestors(string path, bool includeLeaf, bool allowMissing = false)
    {
        PlaceholderVisibility.Run(() =>
        {
            for (var part = includeLeaf ? path : Path.GetDirectoryName(path); part is not null; part = Path.GetDirectoryName(part))
            {
                if (!Directory.Exists(part))
                {
                    if (allowMissing && !File.Exists(part)) continue;
                    throw new IOException("A required preview directory is missing.");
                }
                if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("The preview profile or root ancestor is an unsupported alias.");
            }
        });
    }

    public async ValueTask DisposeAsync()
    {
        await operations.WaitAsync();
        try
        {
            if (disposed) return;
            source?.Pause();
            if (provider is not null) { await provider.DisposeAsync(); provider = null; }
            source?.Dispose(); source = null;
            lease?.Dispose(); lease = null;
            disposed = true;
            if (State != ExplorerPreviewState.Removed) SetState(ExplorerPreviewState.NotStarted);
            // Native registration, namespace entry, durable profile and all local files intentionally remain.
        }
        catch
        {
            SetState(ExplorerPreviewState.Failed);
            Add("The preview could not confirm shutdown. Its integration needs ownership review.");
            throw;
        }
        finally { operations.Release(); }
    }

    private void SetRoot(string value) { lock (view) rootPath = value; Notify(); }
    private void SetState(ExplorerPreviewState value) { lock (view) state = value; Notify(); }
    private void Add(string text)
    {
        lock (view) { activity.Add(text); if (activity.Count > 100) activity.RemoveAt(0); }
        Notify();
    }
    private void Notify() { try { Changed?.Invoke(this, EventArgs.Empty); } catch { } }
}
