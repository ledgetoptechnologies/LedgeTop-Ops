using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

internal sealed record OwnedExplorerRemovalBinding(Guid Identity, ExplorerRootScope Scope, string ProfileDirectory,
    string RootPath, string ManifestDigest, uint ProfileDirectoryVolume, ulong ProfileDirectoryFileId, long ProfileRevision,
    uint ProfileDocumentVolume, ulong ProfileDocumentFileId, uint RootVolume, ulong RootFileId, Guid NamespaceClsid);
internal sealed record OwnedExplorerRemovalEvidence(Guid Identity, uint ProfileVolume, ulong ProfileFileId, long ProfileRevision);
// Supplied only by a future same-helper confirmation flow. The callback holds and rechecks
// the exact root and Shell/native surfaces; it is not an atomic lock on other processes.
internal sealed record GeneratedRemovalBinding(Guid Identity, string Sid, string ProfileDirectory, string RootPath,
    string Icon, long RootFileId, Guid NamespaceClsid, long ProfileRevision,
    CandidateDirectoryFence.DirectoryIdentity ProfileFileIdentity);

/// <summary>
/// Shared owned-root lifecycle for generated and connected Explorer sessions. No browser or catalog capture API.
/// Connected generations persist an immutable, credentialless manifest before any native registration.
/// </summary>
public sealed class OwnedExplorerRootSession : IExplorerPreviewSession, IAvailabilityRetry, IOrderedActivitySource
{
    private const string GeneratedOwner = "LedgeTop.Files.ExplorerPreview/1";
    private const string ConnectedOwner = "LedgeTop.Files.ConnectedExplorer/1";
    private string Owner => generated ? GeneratedOwner : ConnectedOwner;
    private readonly bool generated;
    private readonly ExplorerRootScope scope;
    private readonly Func<ExplorerSourceGate> sourceFactory;
    private readonly Func<string> candidateIcon;
    private readonly Action<string>? candidateTestHook;
    private readonly Func<PreparedConnectedGeneration, bool>? candidateJournalProof;
    private Func<PreparedConnectedGeneration, bool>? activeCandidateJournalProof;
    private readonly Func<ConnectedGenerationHeldObservation, bool>? priorTestVerify;
    private readonly Func<CancellationToken, Task>? priorTestDrain;
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
    private readonly OrderedActivity activity = new();
    private FileStream? lease;
    private SessionLeaseTransfer? pendingFreshLeaseTransfer;
    private ConnectedGenerationHeldObservation? pendingPriorObservation;
    private bool priorLeaseTransferred;
    private bool restartLeaseReview;
    private ConnectedGenerationHeldObservation? restartObservation;
    private ConnectedGenerationHeldObservation? reclaimedPriorObservation;
    private CandidateDirectoryFence? candidateFence;
    private CandidateDirectoryFence.DirectoryIdentity? candidateProfilePin;
    private CandidateDirectoryFence.DirectoryIdentity? candidateRootPin;
    private Profile? reservedCandidate;
    private PreparedConnectedGeneration? preparedCandidate;
    private Profile? profile;
    internal OwnedExplorerRemovalEvidence? RemovedGenerationEvidence { get; private set; }
    private ShellRegistration? registration;
    private NativePlaceholderProvider? provider;
    private ExplorerSourceGate? source;
    private FencedRestartReceipt? fencedRestart;
    internal sealed class FencedRestartReceipt
    {
        private FencedRestartReceipt() { }
        internal static FencedRestartReceipt Create() => new();
    }
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
    private SyntheticFencedConnectHooks? syntheticFencedHooks;
    private bool syntheticFencedAttemptOwned;
    private Action? syntheticAfterFencedCommit;
    internal sealed record SyntheticFencedConnectHooks(Func<Task> Connect, Func<Task> Drain);
    internal void SetSyntheticFencedConnectHooksForTest(SyntheticFencedConnectHooks hooks)
    {
        if (!IsSyntheticFixtureForTest || syntheticFencedHooks is not null) throw new InvalidOperationException();
        syntheticFencedHooks = hooks;
    }
    internal bool SyntheticFencedAttemptOwnedForTest => syntheticFencedAttemptOwned;
    internal void SetSyntheticAfterFencedCommitForTest(Action action) { if (!IsSyntheticFixtureForTest) throw new InvalidOperationException(); syntheticAfterFencedCommit = action; }
    internal Task<QueuedDownloadSession> ReadSyntheticFencedSourceForTest() => IsSyntheticFixtureForTest && source is not null ? source.GetSessionAsync() : throw new InvalidOperationException();
    internal async Task DrainSyntheticFencedAttemptForTestAsync()
    {
        if (!IsSyntheticFixtureForTest || syntheticFencedHooks is null || !syntheticFencedAttemptOwned) throw new InvalidOperationException();
        await syntheticFencedHooks.Drain().ConfigureAwait(false); syntheticFencedAttemptOwned = false;
    }
#endif
    private ExplorerPreviewState state;
    private string rootPath;
    private bool disposed;
    private Func<ConnectedGenerationHeldObservation>? syntheticObservationFactory;
    internal bool IsSyntheticFixtureForTest => priorTestVerify is not null && priorTestDrain is not null;

    /// <summary>Live source composition. Null inventory reopens only an existing persisted frozen manifest.</summary>
    public OwnedExplorerRootSession(string profileDirectory, string preferredRoot, IQueuedDownloadSource source,
        ExplorerRootScope scope, ExplorerRootManifest? initialManifest = null)
        : this(profileDirectory, preferredRoot, false, scope, initialManifest,
            LiveFactory(source, scope)) { }

    internal static OwnedExplorerRootSession CandidateForTest(string profileDirectory, string preferredRoot,
        IQueuedDownloadSource source, ExplorerRootScope scope, ExplorerRootManifest manifest, Action<string>? hook = null,
        bool journalConfirmed = true, Func<ConnectedGenerationHeldObservation, bool>? priorVerify = null,
        Func<CancellationToken, Task>? priorDrain = null) =>
        new(profileDirectory, preferredRoot, false, scope, manifest, LiveFactory(source, scope),
            () => ExplorerBrandIcon.LegacyResource, hook, _ => journalConfirmed, priorVerify, priorDrain);

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

    /// <summary>
    /// Rebuilds a missing generated-preview receipt only after the caller positively identified the
    /// exact old Windows registration. The receipt uses the original deterministic owner/context so
    /// the normal removal path can revalidate the native and shell identities before unregistering.
    /// No user files or Windows registrations are changed here.
    /// </summary>
    internal static bool WriteRecoveredGeneratedProfile(string profileDirectory, string root, Guid identity,
        string icon, long rootFileId, Guid namespaceClsid)
    {
        if (identity == Guid.Empty || rootFileId == 0 || namespaceClsid == Guid.Empty ||
            !ExplorerBrandIcon.IsKnownResource(icon)) return false;
        var directory = CanonicalLocal(profileDirectory);
        var canonicalRoot = CanonicalLocal(root);
        var preferredRoot = CanonicalLocal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "LedgeTop Files Preview"));
        if (!IsLegacyGeneratedRootVariant(canonicalRoot, preferredRoot)) return false;
        var context = Encoding.UTF8.GetBytes(GeneratedOwner + ":" + identity.ToString("N"));
        var native = NativeRootRegistration.Inspect(canonicalRoot, context);
        if (native.Hresult != 0 || native.RootFileId != rootFileId || !native.ExpectedContextMatches ||
            !native.ExpectedNameMatches || !native.ExpectedVersionMatches || native.HydrationPrimary != 2 ||
            native.HydrationModifier != 0 || native.PopulationPrimary != 3 || native.PopulationModifier != 0 ||
            native.InSyncPolicy != 1023 || native.HardlinkPolicy != 0) return false;
        var registration = ShellRegistration.Inspect(canonicalRoot, ShellRegistration.CreateId(identity), context,
            namespaceClsid, icon, ExplorerRootDisplayName.Legacy);
        if (!registration.ExactShellMetadataPresent || registration.NamespaceClsid != namespaceClsid ||
            registration.RootFileId != rootFileId) return false;

        ValidateAncestors(directory, includeLeaf: true, allowMissing: true);
        if (File.Exists(directory)) return false;
        if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
        ValidateAncestors(directory, includeLeaf: true);
        if (Directory.EnumerateFileSystemEntries(directory).Any()) return false;
        var profilePath = Path.Combine(directory, "profile.json");
        if (File.Exists(profilePath) || Directory.Exists(profilePath)) return false;
        var sid = CurrentSid();
        var profile = new Profile(2, GeneratedOwner, sid, identity, canonicalRoot,
            GeneratedOwner + ":" + identity.ToString("N"), icon, rootFileId, Phase.Ready, false, 1,
            NamespaceClsid: namespaceClsid);
        using var stream = new FileStream(profilePath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        JsonSerializer.Serialize(stream, profile, json);
        stream.Flush(flushToDisk: true);
        return true;
    }

    private static bool IsLegacyGeneratedRootVariant(string candidate, string preferred)
    {
        if (string.Equals(candidate, preferred, StringComparison.OrdinalIgnoreCase)) return true;
        var prefix = preferred + " (";
        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !candidate.EndsWith(')')) return false;
        var suffix = candidate[prefix.Length..^1];
        return int.TryParse(suffix, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number) &&
            number is >= 2 and <= 9999 && suffix == number.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string CurrentSid()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return identity.User?.Value ?? throw new IOException("The current Windows identity is unavailable.");
    }

    private OwnedExplorerRootSession(string profileDirectory, string preferredRoot, bool generated, ExplorerRootScope scope,
        ExplorerRootManifest? initialManifest, Func<ExplorerSourceGate> sourceFactory,
        Func<string>? candidateIcon = null, Action<string>? candidateTestHook = null,
        Func<PreparedConnectedGeneration, bool>? candidateJournalProof = null,
        Func<ConnectedGenerationHeldObservation, bool>? priorTestVerify = null, Func<CancellationToken, Task>? priorTestDrain = null)
    {
        scope.Validate();
        if (initialManifest is not null && initialManifest.Scope != scope) throw new IOException("The Explorer inventory source scope differs.");
        this.generated = generated; this.scope = scope; this.manifest = initialManifest; this.sourceFactory = sourceFactory;
        this.candidateIcon = candidateIcon ?? ExplorerBrandIcon.EnsureResource; this.candidateTestHook = candidateTestHook;
        this.candidateJournalProof = candidateJournalProof; this.priorTestVerify = priorTestVerify; this.priorTestDrain = priorTestDrain;
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
    public IReadOnlyList<ActivityEntry> ActivityEntries => activity.Snapshot();
    public IReadOnlyList<string> Activity => ActivityEntries.Select(entry => entry.Text).ToArray();
    public event EventHandler? Changed;
    public bool CanRetryAvailability => State == ExplorerPreviewState.Running;
    public Task RetryAvailabilityAsync() => OperateAsync(() => {
        if (State != ExplorerPreviewState.Running || provider is null || !provider.RetryFailedAvailability())
            throw new InvalidOperationException("File availability retry is unavailable.");
        Add("Will check for pending Keep or Free actions. Access problems may still need attention.");
        return Task.CompletedTask;
    });

    public Task StartAsync() => OperateAsync(StartCoreAsync);
    // Internal generation coordinator only. The supplied proof must re-read the exact leased
    // selector/intent and held candidate pins. No production caller is enabled yet.
    internal Task StartReservedCandidateAsync(Func<PreparedConnectedGeneration, bool> journalProof) => OperateAsync(async () => {
        ArgumentNullException.ThrowIfNull(journalProof);
        if (preparedCandidate is not { } prepared || CandidateDirectoryFence.ObserveFile(Path.Combine(directory, "profile.json")) !=
            new CandidateDirectoryFence.DirectoryIdentity(prepared.ProfileDocumentVolume, prepared.ProfileDocumentFileId))
            throw new IOException("Prepared profile document identity changed.");
        if (activeCandidateJournalProof is not null) throw new IOException("Candidate proof is already active.");
        activeCandidateJournalProof = journalProof;
        try { await StartCoreAsync().ConfigureAwait(false); }
        finally { activeCandidateJournalProof = null; }
    });
    public Task PauseAsync() => OperateAsync(() =>
    {
        if (provider is null || profile?.Phase != Phase.Ready) throw new InvalidOperationException("Start the preview before pausing it.");
        Save(profile with { Paused = true });
        source!.Pause();
        SetState(ExplorerPreviewState.Paused);
        Add(generated ? "New generated-file downloads are paused. Files already on this device remain available." : "New file downloads are paused. Files already on this device remain available.");
        return Task.CompletedTask;
    });
    public Task ResumeAsync()
    {
        var inPreflight = false;
        return OperateAsync(async () => {
            if (provider is null || profile?.Phase != Phase.Ready || source is null) throw new InvalidOperationException("Start the preview before resuming it.");
            if (State != ExplorerPreviewState.Paused || !profile.Paused || !source.IsPaused)
                throw new IOException("The paused provider could not be confirmed.");
            inPreflight = true;
            await source.ResumeAsync();
            inPreflight = false;
            Save(profile with { Paused = false });
            SetState(ExplorerPreviewState.Running);
            Add(generated ? "Generated-file downloads resumed. This does not sign in to a real account." : "Downloads resumed using the current signed-in account.");
        }, error => CanRetainPausedResume(error, !generated && inPreflight && provider is not null &&
            profile is { Phase: Phase.Ready, Paused: true } && State == ExplorerPreviewState.Paused && source?.IsPaused == true));
    }
    internal static bool CanRetainPausedResume(Exception error, bool pausedPreflightConfirmed) => pausedPreflightConfirmed && error is TransferException transfer &&
        (transfer.Reason is TransferFailureReason.Network or TransferFailureReason.Timeout ||
         transfer.Reason == TransferFailureReason.UnexpectedHttpStatus && transfer.HttpStatus is 502 or 503 or 504);
    public Task RemoveAsync() => OperateAsync(() => RemoveCoreAsync());
    internal Task RemoveConfirmedGeneratedAsync(GeneratedRemovalBinding binding, Func<bool> heldIdentityProof, Action nativeAttemptStarted) =>
        OperateAsync(() => RemoveCoreAsync(generatedBinding: binding, generatedProof: heldIdentityProof, nativeAttemptStarted: nativeAttemptStarted));
    // Read-only snapshot for the same-helper confirmation flow. Physical and semantic identity
    // must remain identical after confirmation and again under the removal lease.
    internal GeneratedRemovalBinding CaptureGeneratedConfirmationBinding()
    {
        if (!generated || !operations.Wait(0)) throw new IOException("Generated preview observation is unavailable.");
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            var firstFile = CandidateDirectoryFence.ObserveFile(profilePath);
            var first = ReadProfile();
            if (first.Phase != Phase.Ready || first.RootFileId == 0 || first.NamespaceClsid == Guid.Empty ||
                first.Identity == Guid.Empty || first.Owner != GeneratedOwner || first.Sid != sid ||
                CandidateDirectoryFence.ObserveFile(profilePath) != firstFile || ReadProfile() != first)
                throw new IOException("Generated preview receipt is incomplete or changed.");
            return new(first.Identity, first.Sid, directory, first.Root, first.Icon, first.RootFileId,
                first.NamespaceClsid, first.Revision, firstFile);
        } finally { operations.Release(); }
    }
    internal Task RemoveFreshGenerationAsync(OwnedExplorerRemovalBinding expected, Func<bool> selectorProof) =>
        OperateAsync(() => RemoveCoreAsync(expected, selectorProof));

    /// <summary>
    /// Reserve a new connected candidate in a previously absent profile directory, without
    /// creating its root, registering Windows integration, starting a provider or authenticating.
    /// Caller must already have captured an authorized immutable manifest and must separately
    /// journal the returned identity before calling StartAsync. A crash or failed reservation
    /// leaves its exact profile and files for reconciliation; it is never automatically retried.
    /// </summary>
    public async Task<PreparedConnectedGeneration> PrepareFreshConnectedCandidateAsync()
    {
        PreparedConnectedGeneration? result = null;
        await OperateAsync(() => {
            if (generated || manifest is null || profile is not null || lease is not null || candidateFence is not null ||
                Directory.Exists(directory) || File.Exists(directory))
                throw new IOException("A fresh, absent connected candidate profile is required.");
            var profileParent = Path.GetDirectoryName(directory) ?? throw new IOException("Candidate profile parent is unavailable.");
            var rootParent = Path.GetDirectoryName(preferredRoot) ?? throw new IOException("Candidate root parent is unavailable.");
            candidateFence = new CandidateDirectoryFence();
            candidateFence.HoldAncestors(profileParent);
            candidateFence.HoldAncestors(rootParent);
            var selected = NewRoot();
            if (File.Exists(selected) || Directory.Exists(selected)) throw new IOException("Candidate root is not absent.");
            candidateProfilePin = candidateFence.CreateExclusiveDirectory(directory);
            candidateTestHook?.Invoke("profile-directory-created");
            if (candidateFence.Recheck(directory) != candidateProfilePin) throw new IOException("Candidate profile directory changed.");
            lease = new FileStream(Path.Combine(directory, "session.lock"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var id = Guid.NewGuid();
            var binding = new ManifestBinding(scope, "manifest-" + id.ToString("N") + ".json", manifest.Digest);
            var created = new Profile(4, Owner, sid, id, selected, Owner + ":" + id.ToString("N"),
                candidateIcon(), 0, Phase.Prepared, false, 0, Binding: binding,
                DisplayName: ExplorerRootDisplayName.ForConnectedAlias(scope.Alias));
            Save(created, createOnly: true);
            if (candidateFence.Recheck(directory) != candidateProfilePin) throw new IOException("Candidate profile directory changed.");
            candidateTestHook?.Invoke("prepared-profile-persisted");
            PublishFrozenManifest(profile!);
            candidateTestHook?.Invoke("manifest-persisted");
            var reread = ReadProfile();
            if (candidateFence.Recheck(directory) != candidateProfilePin || reread != profile || reread.Binding?.Digest != manifest.Digest || File.Exists(selected) || Directory.Exists(selected))
                throw new IOException("Candidate reservation could not be verified.");
            LoadFrozenManifest(reread);
            reservedCandidate = reread; SetRoot(selected);
            var documentPin = CandidateDirectoryFence.ObserveFile(Path.Combine(directory, "profile.json"));
            result = new(reread.Identity, directory, selected, manifest.Digest, scope, reread.Revision,
                candidateProfilePin.Value.Volume, candidateProfilePin.Value.FileId, documentPin.Volume, documentPin.FileId);
            preparedCandidate = result;
            return Task.CompletedTask;
        });
        return result ?? throw new IOException("Candidate reservation did not complete.");
    }

    /// <summary>
    /// Read-only connected-generation observation for a future opt-in fresh connection.
    /// This snapshot is not an index lease, authorization, or permission to unregister.
    /// It never starts a provider or changes files or Windows registrations.
    /// </summary>
    public ConnectedGenerationSnapshot ObserveConnectedGeneration()
    {
        if (!operations.Wait(0)) throw new IOException("The connected generation is busy.");
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (generated) throw new IOException("A generated preview is not a connected generation.");
            var before = ReadProfile();
            if (before.Phase != Phase.Ready || before.RootFileId == 0 || before.NamespaceClsid == Guid.Empty || before.Binding is null)
                throw new IOException("The connected generation is not ready for a read-only ownership observation.");
            var current = ReadFrozenManifestFile(before);
            if (current.Digest != before.Binding.Digest || current.Scope != scope ||
                !NativeRootRegistration.HasExactRootFileId(before.Root, before.RootFileId))
                throw new IOException("The connected generation identity changed.");
            var observed = ShellRegistration.Inspect(before.Root, ShellRegistration.CreateId(before.Identity), Context(before),
                before.NamespaceClsid, before.Icon, ProfileDisplayName(before));
            ValidateConnectedObservation(observed, before.RootFileId, before.NamespaceClsid);
            if (ReadProfile() != before || !NativeRootRegistration.HasExactRootFileId(before.Root, before.RootFileId))
                throw new IOException("The connected generation changed while observing it.");
            return new(before.Identity, directory, before.Root, before.RootFileId, before.NamespaceClsid,
                current.Digest, scope, before.Revision);
        } finally { operations.Release(); }
    }
    /// <summary>
    /// Acquires retained profile, manifest and root handles for a connected Ready generation.
    /// The caller owns the returned handle lease. This is read-only, not authorization or
    /// a cross-process session-lock transfer; index and session lifecycle need separate fencing.
    /// </summary>
    public ConnectedGenerationHeldObservation AcquireConnectedGenerationHandles()
    {
        if (!operations.Wait(0)) throw new IOException("The connected generation is busy.");
        try {
            if (syntheticObservationFactory is not null) {
                if (!IsSyntheticFixtureForTest || lease is null || disposed) throw new IOException("Synthetic observation is unavailable.");
                return syntheticObservationFactory();
            }
            return AcquireConnectedGenerationHandlesCore();
        }
        finally { operations.Release(); }
    }

    private ConnectedGenerationHeldObservation AcquireConnectedGenerationHandlesCore()
    {
        ConnectedGenerationHandleLease? held = null;
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (generated || lease is null) throw new IOException("The connected session lease is not held.");
            var before = ReadProfile();
            if (before.Phase != Phase.Ready || before.RootFileId == 0 || before.NamespaceClsid == Guid.Empty || before.Binding is null)
                throw new IOException("The connected generation is not ready.");
            held = ConnectedGenerationHandleLease.Open(directory, before.Binding.File, before.Root);
            // Path parsing is bracketed by handles that deny profile/manifest writes and deletion.
            var heldProfileBytes = held.ReadProfile();
            if (!ProfileBytesMatch(heldProfileBytes) ||
                ReadProfile() != before || unchecked((long)held.RootFileId) != before.RootFileId)
                throw new IOException("The connected profile or root changed before observation.");
            var manifestBytes = held.ReadManifest();
            if (Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(manifestBytes)) != before.Binding.Digest)
                throw new IOException("Held generation manifest differs from its profile.");
            var current = ExplorerRootManifest.Decode(manifestBytes);
            if (current.Scope != scope || current.Digest != before.Binding.Digest)
                throw new IOException("Held generation manifest scope differs.");
            var observed = ShellRegistration.Inspect(before.Root, ShellRegistration.CreateId(before.Identity), Context(before),
                before.NamespaceClsid, before.Icon, ProfileDisplayName(before));
            ValidateConnectedObservation(observed, before.RootFileId, before.NamespaceClsid);
            held.Recheck();
            if (!ProfileBytesMatch(heldProfileBytes) ||
                ReadProfile() != before || unchecked((long)held.RootFileId) != observed.RootFileId)
                throw new IOException("The connected generation changed while observing it.");
            var snapshot = new ConnectedGenerationSnapshot(before.Identity, directory, before.Root, before.RootFileId,
                before.NamespaceClsid, current.Digest, scope, before.Revision);
            var result = new ConnectedGenerationHeldObservation(snapshot, held); held = null; return result;
        } finally { held?.Dispose(); }
    }

    // Disabled restart primitive: opens only an existing lock and never creates a
    // root, cache, registration or provider. Caller must retain this session and
    // the returned observation across all later verification and startup.
    internal RestartGenerationEvidence AcquireExistingRestartObservation()
    {
        if (!operations.Wait(0)) throw new IOException("The connected generation is busy.");
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (generated || lease is not null || provider is not null || pendingFreshLeaseTransfer is not null || priorLeaseTransferred)
                throw new IOException("The connected generation cannot acquire a restart lease.");
            ValidateAncestors(directory, includeLeaf: true);
            var before = ReadProfile();
            if (before.Phase != Phase.Ready || before.Binding is null) throw new IOException("The connected generation is not ready.");
            var lockPath = Path.Combine(directory, "session.lock");
            if (!File.Exists(lockPath) || (File.GetAttributes(lockPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new IOException("The existing generation lock is unavailable.");
            lease = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            restartLeaseReview = true; // Never silently release an uncertain restart lease.
            if (ReadProfile() != before) throw new IOException("The profile changed while its restart lock was acquired.");
            var observation = AcquireConnectedGenerationHandlesCore();
            try {
                observation.Handles.VerifySessionLock(lease, lockPath);
                restartObservation = observation; return RestartEvidence(observation);
            }
            catch { observation.Dispose(); throw; }
        } finally { operations.Release(); }
    }
    internal RestartGenerationEvidence RecheckExistingRestartObservation()
    {
        if (!operations.Wait(0)) throw new IOException("The connected generation is busy.");
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!restartLeaseReview || lease is null || restartObservation is null) throw new IOException("Restart ownership is not retained.");
            restartObservation.Handles.VerifySessionLock(lease, Path.Combine(directory, "session.lock"));
            VerifyHeldPrior(restartObservation); return RestartEvidence(restartObservation);
        } finally { operations.Release(); }
    }
    // Installer read-only observation cleanup: never starts or stops a provider,
    // unregisters a root, or relies on proof surviving a failed read. Only the
    // file handles and session lease acquired by the observation are released.
    internal void ReleaseReadOnlyRestartObservation()
    {
        if (!operations.Wait(0)) throw new IOException("The connected generation is busy.");
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (provider is not null || pendingFreshLeaseTransfer is not null || priorLeaseTransferred)
                throw new IOException("A read-only observation cannot release an active provider.");
            if (!restartLeaseReview && (lease is not null || restartObservation is not null))
                throw new IOException("The lease is not a read-only restart observation.");
            restartObservation?.Dispose(); restartObservation = null;
            lease?.Dispose(); lease = null; restartLeaseReview = false;
        } finally { operations.Release(); }
    }
    // Unwired restart seam. A matching selector and fresh authentication must be
    // proven by the caller before and after this operation. A failure leaves the
    // exact lease, observation and any partially started provider retained.
    internal async Task<RestartGenerationEvidence> StartHeldRestartProviderAsync(Func<RestartGenerationEvidence, bool> proof)
    {
        ArgumentNullException.ThrowIfNull(proof);
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!restartLeaseReview || lease is null || restartObservation is null || provider is not null)
                throw new IOException("Restart ownership is not retained.");
            restartObservation.Handles.VerifySessionLock(lease, Path.Combine(directory, "session.lock"));
            VerifyHeldPrior(restartObservation);
            if (!proof(RestartEvidence(restartObservation))) throw new IOException("Restart selector proof is unavailable.");
            await StartCoreAsync().ConfigureAwait(false);
            VerifyHeldPrior(restartObservation);
            var evidence = RestartEvidence(restartObservation);
            if (!proof(evidence)) throw new IOException("Restart selector proof changed after provider startup.");
            return evidence;
        } finally { operations.Release(); }
    }
    // Not wired to application recovery. Connect an already-owned Ready root
    // without Save, registration creation, source enablement or publication of
    // Running. A partial/failed connect retains the exact provider and lease.
    internal async Task<FencedRestartReceipt> ConnectHeldRestartFencedAsync(
        Func<RestartGenerationEvidence, bool> proof, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(proof);
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (generated || !restartLeaseReview || lease is null || restartObservation is null ||
                provider is not null || registration is not null || fencedRestart is not null)
                throw new IOException("Restart ownership is not retained or provider is already present.");
            bool ReadyAndOwned() {
                restartObservation.Handles.VerifySessionLock(lease, Path.Combine(directory, "session.lock"));
                VerifyHeldPrior(restartObservation);
                var current = ReadProfile();
                return current.Phase == Phase.Ready && current.Binding is not null && proof(RestartEvidence(restartObservation));
            }
            if (!ReadyAndOwned()) throw new IOException("The Ready generation or selector could not be confirmed.");
            var pinnedProfile = ReadProfile();
            LoadFrozenManifest(pinnedProfile);
            source ??= sourceFactory();
            var boundSource = source;
            ShellRegistration? attemptRegistration = null;
            NativePlaceholderProvider? attemptProvider = null;
            await ConnectFencedReadyAsync(boundSource, () => ReadyAndOwned() && ReadProfile() == pinnedProfile, async () => {
                SetRoot(pinnedProfile.Root);
                var cache = EnsureCache(pinnedProfile);
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
                if (syntheticFencedHooks is { } hooks) {
                    if (!IsSyntheticFixtureForTest) throw new InvalidOperationException();
                    syntheticFencedAttemptOwned = true;
                    await hooks.Connect().ConfigureAwait(false);
                    return;
                }
#endif
                registration = attemptRegistration = ShellRegistration.OpenOwned(pinnedProfile.Root, ShellRegistration.CreateId(pinnedProfile.Identity),
                    Context(pinnedProfile), pinnedProfile.Icon, pinnedProfile.NamespaceClsid, pinnedProfile.RootFileId, ProfileDisplayName(pinnedProfile));
                VerifyPinnedRoot(pinnedProfile, registration);
                provider = attemptProvider = CreateProvider(registration, boundSource, cache);
                await provider.ConnectExistingAsync().ConfigureAwait(false);
            }, async () => {
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
                if (syntheticFencedHooks is { } hooks && syntheticFencedAttemptOwned) {
                    await hooks.Drain().ConfigureAwait(false);
                    return;
                }
#endif
                // Cleanup owns only objects created by this attempt; never recheck
                // the selector or unregister the durable shell/root integration.
                if (!ReferenceEquals(provider, attemptProvider) || !ReferenceEquals(registration, attemptRegistration))
                    throw new IOException("Fenced restart cleanup ownership changed.");
                if (attemptProvider is not null) await attemptProvider.DisposeAsync().ConfigureAwait(false);
            }, () => {
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
                if (syntheticFencedHooks is not null) syntheticFencedAttemptOwned = false;
#endif
                if (!ReferenceEquals(provider, attemptProvider) || !ReferenceEquals(registration, attemptRegistration))
                    throw new IOException("Fenced restart cleanup ownership changed.");
                provider = null; registration = null;
            }, token).ConfigureAwait(false);
            // This is a held intermediate state, never a usable Running facade.
            var receipt = FencedRestartReceipt.Create(); fencedRestart = receipt;
            SetState(ExplorerPreviewState.Paused);
            return receipt;
        } catch { SetState(ExplorerPreviewState.Failed); throw; }
        finally { operations.Release(); }
    }
    // A successful fenced connect can be aborted even if the selector/account
    // changed afterwards. The exact in-memory receipt, not a path or selector,
    // authorizes only pause and provider drain; never unregister or delete.
    internal async Task AbortFencedHeldRestartAsync(FencedRestartReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            if (!ReferenceEquals(receipt, fencedRestart) || !restartLeaseReview || lease is null || restartObservation is null || source is null)
                throw new IOException("Fenced restart receipt is unavailable.");
            var ownedSource = source; var ownedProvider = provider; var ownedRegistration = registration;
            Exception? pauseFailure = null, drainFailure = null;
            try { ownedSource.Pause(); } catch (Exception error) { pauseFailure = error; }
            try {
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
                if (syntheticFencedAttemptOwned && syntheticFencedHooks is { } hooks) await hooks.Drain().ConfigureAwait(false);
                else
#endif
                if (ownedProvider is not null) await ownedProvider.DisposeAsync().ConfigureAwait(false);
            } catch (Exception error) { drainFailure = error; }
            if (pauseFailure is not null || drainFailure is not null || !ReferenceEquals(source, ownedSource) ||
                !ReferenceEquals(provider, ownedProvider) || !ReferenceEquals(registration, ownedRegistration) || !ReferenceEquals(fencedRestart, receipt))
                throw new IOException("Fenced restart drain is uncertain; ownership remains retained.", drainFailure ?? pauseFailure);
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
            syntheticFencedAttemptOwned = false;
#endif
            provider = null; registration = null; fencedRestart = null;
            SetState(ExplorerPreviewState.Failed);
        } finally { operations.Release(); }
    }
    // Unwired commit seam. The exact receipt and held generation remain owned;
    // the parent must still verify its selector and prior generation in proof.
    internal async Task CommitHeldFencedAsync(FencedRestartReceipt receipt, CancellationToken owner,
        Func<bool> parentProof, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(receipt); ArgumentNullException.ThrowIfNull(parentProof);
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            if (!ReferenceEquals(receipt, fencedRestart) || !restartLeaseReview || lease is null || restartObservation is null ||
                source is null || State != ExplorerPreviewState.Paused || !source.IsPaused)
                throw new IOException("Fenced restart commit is unavailable.");
            void Verify() {
                token.ThrowIfCancellationRequested(); owner.ThrowIfCancellationRequested();
                restartObservation.Handles.VerifySessionLock(lease, Path.Combine(directory, "session.lock"));
                VerifyHeldPrior(restartObservation);
                if (!ReferenceEquals(receipt, fencedRestart) || !parentProof()) throw new IOException("Fenced restart ownership changed.");
            }
            Verify();
            await source.CheckCurrentAsync(token).ConfigureAwait(false);
            Verify();
            source.CommitFenced(() => { Verify(); return true; }, owner);
            try {
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
                if (IsSyntheticFixtureForTest) syntheticAfterFencedCommit?.Invoke();
#endif
                Verify();
            }
            catch { source.Pause(); throw; }
            // Parent owns postcommit checks and publication. Do not claim Running here.
        } finally { operations.Release(); }
    }
    // Connect is deliberately a separate boundary so the real caller and
    // synthetic tests use the same pre/post fence checks. Caller owns lifecycle.
    internal static async Task ConnectFencedReadyAsync(ExplorerSourceGate gate, Func<bool> readyAndOwned,
        Func<Task> connect, Func<Task> drainAttempt, Action clearDrainedAttempt, CancellationToken token)
    {
        try {
            token.ThrowIfCancellationRequested();
            if (!gate.IsPaused || !readyAndOwned()) throw new IOException("Fenced Ready generation is unavailable.");
            await gate.CheckCurrentAsync(token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!gate.IsPaused || !readyAndOwned()) throw new IOException("Fenced Ready generation changed before connect.");
            // Never abandon a partially connected provider task on cancellation.
            await connect().ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!gate.IsPaused || !readyAndOwned()) throw new IOException("Fenced Ready generation changed during connect.");
            await gate.CheckCurrentAsync(token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!gate.IsPaused || !readyAndOwned()) throw new IOException("Fenced Ready generation changed after authentication.");
        } catch (Exception original) {
            Exception? pauseFailure = null, drainFailure = null;
            try { gate.Pause(); } catch (Exception error) { pauseFailure = error; }
            try { await drainAttempt().ConfigureAwait(false); } catch (Exception error) { drainFailure = error; }
            if (pauseFailure is not null || drainFailure is not null)
                throw new AggregateException("Fenced restart shutdown is uncertain; ownership remains retained.",
                    new[] { original, pauseFailure, drainFailure }.OfType<Exception>());
            clearDrainedAttempt();
            throw;
        }
    }
    // Only disconnects a positively drained provider; it never unregisters either
    // root or removes files. Failure retains the lease and observations for review.
    internal async Task StopHeldRestartProviderAsync(Func<RestartGenerationEvidence, bool> proof)
    {
        ArgumentNullException.ThrowIfNull(proof);
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!restartLeaseReview || lease is null || restartObservation is null)
                throw new IOException("Restart ownership is not retained.");
            if (fencedRestart is not null) throw new IOException("A fenced restart receipt still owns its provider.");
#if DEBUG && LEDGETOP_NATIVE_DIAGNOSTICS
            if (syntheticFencedAttemptOwned) throw new IOException("Synthetic reconnect still owns its provider.");
#endif
            restartObservation.Handles.VerifySessionLock(lease, Path.Combine(directory, "session.lock"));
            VerifyHeldPrior(restartObservation);
            if (!proof(RestartEvidence(restartObservation))) throw new IOException("Restart selector proof is unavailable.");
            source?.Pause();
            if (provider is not null) { await provider.DisposeAsync().ConfigureAwait(false); provider = null; }
            VerifyHeldPrior(restartObservation);
            if (!proof(RestartEvidence(restartObservation))) throw new IOException("Restart selector proof changed during shutdown.");
            source?.Dispose(); source = null;
            restartObservation.Dispose(); restartObservation = null;
            lease.Dispose(); lease = null; restartLeaseReview = false;
            SetState(ExplorerPreviewState.NotStarted);
        } finally { operations.Release(); }
    }
    private static RestartGenerationEvidence RestartEvidence(ConnectedGenerationHeldObservation observation)
    {
        var h = observation.Handles;
        return new(observation.Snapshot, h.ProfileDirectoryVolume, h.ProfileDirectoryFileId,
            h.ProfileVolume, h.ProfileFileId, h.RootVolume, h.RootFileId);
    }

    // Internal and currently unwired. Caller holds the index lease and the supplied
    // handle observation, and must retain both the returned receipt and observation.
    // A failed/cancelled drain leaves the transfer object and exact session.lock handle here;
    // ordinary operations and Dispose fail closed rather than silently release it.
    internal async Task<RetainedPriorGeneration> DrainAndTransferPriorLeaseAsync(
        ConnectedGenerationHeldObservation observed, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(observed);
        await operations.WaitAsync(token).ConfigureAwait(false);
        ConnectedGenerationHeldObservation? owned = null;
        var retained = false;
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (generated || pendingFreshLeaseTransfer is not null || priorLeaseTransferred || lease is null)
                throw new IOException("The prior generation session lease is unavailable.");
            // Atomically invalidate the caller's observation before inspecting it or awaiting drain.
            owned = observed.TakeOwnership();
            owned.Handles.VerifySessionLock(lease, Path.Combine(directory, "session.lock"));
            VerifyHeldPrior(owned);
            var transfer = SessionLeaseTransfer.Take(ref lease);
            pendingFreshLeaseTransfer = transfer; pendingPriorObservation = owned;
            retained = true; // Session owns both exact objects until receipt handoff or review.
            var retainedObservation = owned;
            var receipt = await transfer.DrainAndTransferAsync(async cancellation => {
                cancellation.ThrowIfCancellationRequested();
                if (priorTestDrain is not null) await priorTestDrain(cancellation).ConfigureAwait(false);
                source?.Pause();
                if (provider is not null) { await provider.DisposeAsync().ConfigureAwait(false); provider = null; }
                source?.Dispose(); source = null;
                VerifyHeldPrior(retainedObservation);
                return true;
            }, token).ConfigureAwait(false);
            if (receipt is null) throw new IOException("The prior provider drain was not confirmed.");
            var result = new RetainedPriorGeneration(this, receipt, owned);
            priorLeaseTransferred = true;
            pendingFreshLeaseTransfer = null; pendingPriorObservation = null;
            retained = false; owned = null; // ownership transferred to result
            return result;
        } finally { try { if (!retained) owned?.Dispose(); } finally { operations.Release(); } }
    }
    // Restores the exact successful transfer to this same session; it never unregisters.
    // Unknown/failed transfers cannot be reclaimed and remain held for review.
    internal async Task ReclaimPriorLeaseAsync(RetainedPriorGeneration retained, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(retained);
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!priorLeaseTransferred || pendingFreshLeaseTransfer is not null || pendingPriorObservation is not null ||
                reclaimedPriorObservation is not null || lease is not null) throw new IOException("No successful prior lease to reclaim.");
            token.ThrowIfCancellationRequested();
            var restored = retained.Reclaim(this, (stream, observation) => {
                observation.Handles.VerifySessionLock(stream, Path.Combine(directory, "session.lock"));
                VerifyHeldPrior(observation);
                // Cancellation before this point leaves the receipt owning both handles.
                // After this check, moving them back is the synchronous commit point.
                token.ThrowIfCancellationRequested();
            });
            lease = restored.Stream; reclaimedPriorObservation = restored.Observation; priorLeaseTransferred = false;
        } finally { operations.Release(); }
    }

    private void VerifyHeldPrior(ConnectedGenerationHeldObservation held)
    {
        held.Handles.Recheck();
        if (priorTestVerify is not null) {
            if (!priorTestVerify(held)) throw new IOException("Synthetic prior verification failed.");
            return;
        }
        var profileBytes = held.Handles.ReadProfile();
        if (!ProfileBytesMatch(profileBytes)) throw new IOException("The held profile path differs.");
        var current = ReadProfile(); var snapshot = held.Snapshot;
        if (current.Phase != Phase.Ready || current.Binding is null || current.Identity != snapshot.Identity ||
            current.Root != snapshot.RootPath || directory != snapshot.ProfileDirectory || current.RootFileId != snapshot.RootFileId ||
            current.NamespaceClsid != snapshot.NamespaceClsid || current.Revision != snapshot.ProfileRevision ||
            current.Binding.Digest != snapshot.ManifestDigest || current.Binding.Scope != snapshot.Scope || scope != snapshot.Scope ||
            unchecked((long)held.Handles.RootFileId) != current.RootFileId ||
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(held.Handles.ReadManifest())) != current.Binding.Digest)
            throw new IOException("The retained prior-generation observation changed.");
        var observed = ShellRegistration.Inspect(current.Root, ShellRegistration.CreateId(current.Identity), Context(current),
            current.NamespaceClsid, current.Icon, ProfileDisplayName(current));
        ValidateConnectedObservation(observed, current.RootFileId, current.NamespaceClsid);
        held.Handles.Recheck();
        if (!ProfileBytesMatch(profileBytes) || ReadProfile() != current)
            throw new IOException("The prior-generation profile changed during verification.");
    }

    // Test-only seams: the only factory that supplies these hooks is internal and generated-fixture tests
    // must own the stream and observation. Production construction cannot install either hook.
    internal void AttachSyntheticPriorLeaseForTest(FileStream stream)
    {
        if (priorTestVerify is null || priorTestDrain is null || !operations.Wait(0)) throw new InvalidOperationException();
        try {
            if (lease is not null || pendingFreshLeaseTransfer is not null || disposed) throw new InvalidOperationException();
            lease = stream;
        } finally { operations.Release(); }
    }
    internal void ConfigureSyntheticPriorForTest(Func<ConnectedGenerationHeldObservation> observe, string syntheticRoot)
    {
        if (!IsSyntheticFixtureForTest || !operations.Wait(0)) throw new InvalidOperationException();
        try {
            if (lease is null || provider is not null || disposed || syntheticObservationFactory is not null) throw new InvalidOperationException();
            syntheticObservationFactory = observe; SetRoot(syntheticRoot); SetState(ExplorerPreviewState.Running);
        } finally { operations.Release(); }
    }
    internal void MarkSyntheticFreshRunningForTest()
    {
        if (!IsSyntheticFixtureForTest || !operations.Wait(0)) throw new InvalidOperationException();
        try {
            if (preparedCandidate is null || lease is null || provider is not null || disposed) throw new InvalidOperationException();
            SetRoot(preparedCandidate.RootPath); SetState(ExplorerPreviewState.Running);
        } finally { operations.Release(); }
    }
    internal void AttachSyntheticRestartForTest(FileStream stream, ConnectedGenerationHeldObservation observation)
    {
        if (priorTestVerify is null || priorTestDrain is null || !operations.Wait(0)) throw new InvalidOperationException();
        try {
            if (lease is not null || restartLeaseReview || restartObservation is not null || disposed) throw new InvalidOperationException();
            var owned = observation.TakeOwnership();
            try { owned.Handles.VerifySessionLock(stream, Path.Combine(directory, "session.lock")); }
            catch { owned.Dispose(); throw; }
            lease = stream; restartObservation = owned; restartLeaseReview = true;
        } finally { operations.Release(); }
    }
    internal void MarkSyntheticRestartRunningForTest()
    {
        if (priorTestVerify is null || priorTestDrain is null || !operations.Wait(0)) throw new InvalidOperationException();
        try {
            if (!restartLeaseReview || restartObservation is null || lease is null || provider is not null || disposed)
                throw new InvalidOperationException();
            SetRoot(restartObservation.Snapshot.RootPath); SetState(ExplorerPreviewState.Running);
        } finally { operations.Release(); }
    }
#if DEBUG
    // Only synthetic generated-fixture sessions can attach this provider.
    // No native root is registered by this test seam.
    internal void AttachSyntheticAvailabilityProviderForTest(NativePlaceholderProvider value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (!IsSyntheticFixtureForTest || !operations.Wait(0)) throw new InvalidOperationException();
        try {
            if (disposed || State != ExplorerPreviewState.Running || provider is not null || lease is null ||
                !string.Equals(value.SyntheticRootForTest, rootPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Synthetic held provider does not match this session.");
            provider = value;
        } finally { operations.Release(); }
    }
#endif
    internal async Task ReleaseFailedSyntheticTransferForTestAsync()
    {
        if (priorTestVerify is null || priorTestDrain is null) throw new InvalidOperationException();
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            if (pendingFreshLeaseTransfer is null) throw new InvalidOperationException();
            await pendingFreshLeaseTransfer.DisposeAsync().ConfigureAwait(false);
            pendingFreshLeaseTransfer = null; pendingPriorObservation?.Dispose(); pendingPriorObservation = null;
        } finally { operations.Release(); }
    }

    internal static void ValidateConnectedObservation(ShellRegistrationObservation observed, long rootFileId, Guid namespaceId)
    {
        if (rootFileId == 0 || namespaceId == Guid.Empty || observed.NativeHresult != 0 ||
            !observed.ExpectedNativeIdentityMatches || !observed.ExactShellMetadataPresent ||
            observed.RootFileId != rootFileId || observed.NamespaceClsid != namespaceId)
            throw new IOException("The connected generation Windows ownership could not be verified.");
    }

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

    private async Task OperateAsync(Func<Task> operation, Func<Exception, bool>? retainPaused = null)
    {
        await operations.WaitAsync();
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (pendingFreshLeaseTransfer is not null || pendingPriorObservation is not null || priorLeaseTransferred || reclaimedPriorObservation is not null || restartLeaseReview)
                throw new IOException("The prior generation lease is retained for fresh-connection review.");
            await Task.Run(operation);
        }
        catch (Exception error) when (retainPaused?.Invoke(error) == true) { throw; }
        catch
        {
            if (pendingFreshLeaseTransfer is not null || pendingPriorObservation is not null || priorLeaseTransferred || reclaimedPriorObservation is not null || restartLeaseReview) {
                SetState(ExplorerPreviewState.Failed);
                Add("The prior generation lease is held for ownership review.");
                throw;
            }
            // Pause closes the source gate before cancelling in-flight work. A callback
            // may throw during cancellation; still drain the provider and preserve the
            // original operation failure for the caller.
            try { source?.Pause(); }
            catch { Add("Download cancellation reported an error. The provider shutdown is continuing."); }
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
        var reserved = reservedCandidate is not null && profile == reservedCandidate && profile?.Phase == Phase.Prepared;
        if (reserved && (candidateFence is null || candidateProfilePin is null || candidateFence.Recheck(directory) != candidateProfilePin))
            throw new IOException("Reserved candidate directory identity changed.");
        // No production adapter supplies this proof yet; a prepared profile alone never
        // authorizes root creation or registration. Tests may inject a synthetic proof.
        var reservation = reserved ? preparedCandidate : null;
        if (reserved) RequireCandidateJournal(reservation);
        if (profile is not null && profile.Phase is not (Phase.Ready or Phase.Removed) && !reserved)
            throw new IOException("A previous preview setup is incomplete. Remove or reconcile that exact preview before starting again.");
        var reconnect = profile?.Phase == Phase.Ready;
        if (!reconnect)
        {
            if (!reserved) {
            if (profile is { Phase: Phase.Removed } previous) Archive(previous);
            var id = Guid.NewGuid();
            var proposedRoot = NewRoot();
            var binding = generated ? null : new ManifestBinding(scope, "manifest-" + id.ToString("N") + ".json",
                (manifest ?? throw new IOException("The frozen Explorer inventory is unavailable.")).Digest);
            profile = new(generated ? 2 : 4, Owner, sid, id, proposedRoot, Owner + ":" + id.ToString("N"), ExplorerBrandIcon.EnsureResource(), 0, Phase.Prepared, false, 0, Binding: binding, DisplayName: generated ? null : ExplorerRootDisplayName.ForConnectedAlias(scope.Alias));
            Save(profile, createOnly: !File.Exists(profilePath));
            if (!generated) PublishFrozenManifest(profile);
            } else LoadFrozenManifest(profile!);
            // Even a cancelled/expired cached session leaves positive Prepared ownership evidence.
            // No root or Windows registration has been attempted at this phase.
            if (!generated) {
                source ??= sourceFactory();
                await source.CheckCurrentAsync();
            }
            if (reserved) RequireCandidateJournal(reservation);
            var selectedRoot = profile!.Root;
            SetRoot(selectedRoot);
            ValidateAncestors(selectedRoot, includeLeaf: false);
            if (Directory.Exists(selectedRoot) || File.Exists(selectedRoot))
                throw new IOException("The preview folder already exists without this new generation's ownership receipt. It was not adopted.");
            Save(profile with { Phase = Phase.RootCreateIntent });
            if (reserved) {
                candidateRootPin = candidateFence!.CreateExclusiveDirectory(selectedRoot);
                candidateTestHook?.Invoke("root-directory-created");
                if (candidateFence.Recheck(selectedRoot) != candidateRootPin) throw new IOException("Candidate root directory changed.");
            } else Directory.CreateDirectory(selectedRoot);
            reservedCandidate = null; preparedCandidate = null;
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
            if (reserved) RequireCandidateJournal(reservation);
            Save(profile! with { Phase = Phase.NativeRegisterIntent });
            try
            {
                registration = await RegisterWithPreflightRecoveryAsync(
                    () => {
                        // This hook is available only through CandidateForTest.
                        candidateTestHook?.Invoke("native-registration-attempt");
                        return ShellRegistration.RegisterAsync(p.Root, ShellRegistration.CreateId(p.Identity), p.Icon, Context(p), ProfileDisplayName(p));
                    },
                    () => {
                        // Only an explicit refusal from before the broker call permits this
                        // transition. The lease and candidate selector must still be held.
                        if (registration is not null || profile is not { Phase: Phase.NativeRegisterIntent } current ||
                            current.Identity != p.Identity || current.Root != p.Root || ReadProfile() != current)
                            throw new IOException("The preflight receipt changed; registration needs review.");
                        if (reserved) RequireCandidateJournal(reservation);
                        Save(current with { Phase = Phase.RootCreated });
                        Add("Windows registration was not attempted. The existing folder was kept.");
                    });
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

    internal static async Task<T> RegisterWithPreflightRecoveryAsync<T>(Func<Task<T>> register, Action recover)
    {
        try { return await register().ConfigureAwait(false); }
        catch (ShellRegistrationPreflightRefusedException) { recover(); throw; }
    }

    private void RequireCandidateJournal(PreparedConnectedGeneration? reservation)
    {
        if (reservation is null || (activeCandidateJournalProof ?? candidateJournalProof)?.Invoke(reservation) != true)
            throw new IOException("A durable matching candidate selector must be confirmed before starting.");
    }

    private NativePlaceholderProvider CreateProvider(IPreviewRootRegistration native, ExplorerSourceGate boundSource, string cache)
    {
        var inventory = manifest ?? throw new IOException("The frozen Explorer inventory is unavailable.");
        var result = new NativePlaceholderProvider(native, cache, boundSource, scope.Channel, scope.PrincipalId, inventory.Files, inventory.Directories);
        result.ActivityDetailed += OnProviderActivity;
        result.AvailabilityFailureObserved += OnProviderAvailabilityFailure;
        result.HydrationFailureObserved += value => { try { HydrationFailureObserved?.Invoke(this, value); } catch { } };
        return result;
    }
    internal void OnProviderActivity(string value, HydrationFailureDiagnostic? diagnostic) {
        if (diagnostic is null) Add(value);
        else { activity.AddDownloadFailure(diagnostic); Notify(); }
        if (value.StartsWith("Hydration timing: outcome=", StringComparison.Ordinal))
            try { HydrationTimingObserved?.Invoke(this, value); } catch { }
    }
    private int availabilityWorkerFailureSeen;
    internal bool HasAvailabilityWorkerFailure => Volatile.Read(ref availabilityWorkerFailureSeen)!=0;
    internal void OnProviderAvailabilityFailure(LocalAvailabilityException failure) {
        Interlocked.Exchange(ref availabilityWorkerFailureSeen,1);
        try { AvailabilityFailureObserved?.Invoke(this, failure); } catch { }
    }
    internal event Action<OwnedExplorerRootSession, LocalAvailabilityException>? AvailabilityFailureObserved;
    internal event Action<OwnedExplorerRootSession, string>? HydrationTimingObserved;
    internal event Action<OwnedExplorerRootSession, HydrationFailureDiagnostic>? HydrationFailureObserved;

    private async Task RemoveCoreAsync(OwnedExplorerRemovalBinding? expected = null, Func<bool>? selectorProof = null,
        GeneratedRemovalBinding? generatedBinding = null, Func<bool>? generatedProof = null, Action? nativeAttemptStarted = null)
    {
        if (generatedBinding is not null && (!generated || generatedProof is null || nativeAttemptStarted is null))
            throw new IOException("Confirmed generated ownership proof is unavailable.");
        if (expected is not null && selectorProof?.Invoke() != true)
            throw new IOException("The fresh-files selector is not current.");
        if (!Directory.Exists(directory)) {
            if (expected is not null || generatedBinding is not null) throw new IOException("The selected profile is missing; ownership needs review.");
            SetState(ExplorerPreviewState.Removed); return;
        }
        AcquireLease(allowCreate: false);
        profile = ReadProfile();
        var p = profile;
        if (generatedBinding is not null) VerifyGeneratedRemovalBinding(p, generatedBinding, generatedProof!);
        if (expected is not null) VerifyRemovalGeneration(p, expected);
        SetRoot(p.Root);
        if (p.Phase == Phase.Removed) {
            if (expected is not null) RemovedGenerationEvidence = VerifyRemovedGeneration(expected, selectorProof!) ??
                throw new IOException("The fresh-files root removal is not confirmed.");
            SetState(ExplorerPreviewState.Removed); return;
        }

        source?.Pause();
        if (provider is not null)
        {
            await provider.DisposeAsync();
            provider = null; // Never detach persistent resources after an uncertain disconnect.
        }
        if (p.Phase <= Phase.RootCreated)
        {
            // Windows integration was never attempted, or a confirmed preflight refusal
            // durably restored this phase before any broker call.
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
        candidateTestHook?.Invoke("native-absence-check"); // CandidateForTest only.
        if (ShellRegistration.IsAbsent(shellId, p.Root, Context(p), p.NamespaceClsid == Guid.Empty ? null : p.NamespaceClsid, p.Icon, ProfileDisplayName(p)))
        {
            // Early setup did not reach native registration, or a previously journaled removal completed.
            if (p.Phase <= Phase.NativeRegisterIntent || p.Phase == Phase.NativeRemoveIntent)
            {
                Save(p with { Phase = Phase.Removed }); SetState(ExplorerPreviewState.Removed);
                if (expected is not null) RemovedGenerationEvidence = VerifyRemovedGeneration(expected, selectorProof!) ??
                    throw new IOException("The fresh-files root removal is not confirmed.");
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

        if (generatedBinding is not null) VerifyGeneratedRemovalBinding(ReadProfile(), generatedBinding, generatedProof!);

        if (expected is not null && selectorProof?.Invoke() != true)
            throw new IOException("The fresh-files selector changed before unregistering this root.");
        Save(profile! with { Phase = Phase.NativeRemoveIntent });
        if (generatedBinding is not null) {
            var journal = profile!;
            var journalIdentity = CandidateDirectoryFence.ObserveFile(profilePath);
            if (journal.Phase != Phase.NativeRemoveIntent || journal.Identity != generatedBinding.Identity ||
                journal.Revision != checked(generatedBinding.ProfileRevision + 1) || ReadProfile() != journal ||
                !generatedProof!() || CandidateDirectoryFence.ObserveFile(profilePath) != journalIdentity || ReadProfile() != journal)
                throw new IOException("Confirmed generated ownership changed after the removal journal; no unregister was attempted.");
        }
        if (generatedBinding is not null) nativeAttemptStarted!();
        registration.Unregister(); registration = null;
        Save(profile! with { Phase = Phase.Removed });
        if (expected is not null) RemovedGenerationEvidence = VerifyRemovedGeneration(expected, selectorProof!) ??
            throw new IOException("The fresh-files root removal is not confirmed.");
        source.Dispose(); source = null;
        SetState(ExplorerPreviewState.Removed);
        Add("The preview integration was removed. Check the previous folder for local files; online-only items may no longer be present.");
    }

    private void VerifyGeneratedRemovalBinding(Profile observed, GeneratedRemovalBinding expected, Func<bool> heldIdentityProof)
    {
        if (!generated || expected.Identity == Guid.Empty || expected.RootFileId == 0 || expected.NamespaceClsid == Guid.Empty ||
            observed.Phase != Phase.Ready || observed.Owner != GeneratedOwner || observed.Sid != sid || observed.Sid != expected.Sid ||
            observed.Identity != expected.Identity || !string.Equals(directory, expected.ProfileDirectory, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(observed.Root, expected.RootPath, StringComparison.OrdinalIgnoreCase) || observed.Icon != expected.Icon ||
            observed.Context != GeneratedOwner + ":" + expected.Identity.ToString("N") || observed.RootFileId != expected.RootFileId ||
            observed.NamespaceClsid != expected.NamespaceClsid || observed.Revision != expected.ProfileRevision ||
            CandidateDirectoryFence.ObserveFile(profilePath) != expected.ProfileFileIdentity || !heldIdentityProof() ||
            CandidateDirectoryFence.ObserveFile(profilePath) != expected.ProfileFileIdentity || ReadProfile() != observed)
            throw new IOException("The confirmed generated preview identity changed; removal was not attempted.");
    }

    private void VerifyRemovalGeneration(Profile observed, OwnedExplorerRemovalBinding expected)
    {
        var expectedRevision = observed.Phase switch {
            Phase.Ready => expected.ProfileRevision,
            Phase.NativeRemoveIntent => checked(expected.ProfileRevision + 1),
            Phase.Removed => checked(expected.ProfileRevision + 2),
            _ => -1
        };
        if (generated || expected.Scope != scope || observed.Owner != ConnectedOwner || observed.Sid != sid ||
            observed.Identity != expected.Identity || !string.Equals(directory, expected.ProfileDirectory, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(observed.Root, expected.RootPath, StringComparison.OrdinalIgnoreCase) ||
            observed.RootFileId == 0 || unchecked((ulong)observed.RootFileId) != expected.RootFileId ||
            observed.NamespaceClsid != expected.NamespaceClsid || observed.Binding is null ||
            observed.Binding.Digest != expected.ManifestDigest || observed.Binding.Scope != scope ||
            observed.Revision != expectedRevision)
            throw new IOException("The saved root does not match the fresh-files selector.");
        if (expected.ProfileDirectoryVolume == 0 || expected.ProfileDirectoryFileId == 0 ||
            expected.ProfileDocumentVolume == 0 || expected.ProfileDocumentFileId == 0 || expected.RootVolume == 0 || expected.RootFileId == 0)
            throw new IOException("The fresh-files selector has incomplete physical identity.");
        var manifest = ReadFrozenManifestFile(observed);
        if (manifest.Scope != scope || manifest.Digest != expected.ManifestDigest)
            throw new IOException("The saved root inventory does not match the fresh-files selector.");
        using var handles = ConnectedGenerationHandleLease.Open(directory, observed.Binding.File, observed.Root);
        var profileBytes = handles.ReadProfile();
        if (!ProfileBytesMatch(profileBytes) || ReadProfile() != observed ||
            handles.ProfileDirectoryVolume != expected.ProfileDirectoryVolume ||
            handles.ProfileDirectoryFileId != expected.ProfileDirectoryFileId ||
            handles.ProfileVolume != expected.ProfileDocumentVolume ||
            (observed.Phase == Phase.Ready ? handles.ProfileFileId != expected.ProfileDocumentFileId :
                handles.ProfileFileId == expected.ProfileDocumentFileId) ||
            handles.RootVolume != expected.RootVolume || handles.RootFileId != expected.RootFileId)
            throw new IOException("The fresh-files profile or root identity changed.");
        handles.Recheck();
    }

    private OwnedExplorerRemovalEvidence? VerifyRemovedGeneration(OwnedExplorerRemovalBinding expected, Func<bool> selectorProof)
    {
        if (selectorProof() != true) return null;
        var observed = ReadProfile();
        if (observed.Phase != Phase.Removed || observed.Identity != expected.Identity || observed.Owner != ConnectedOwner ||
            observed.Sid != sid || !string.Equals(observed.Root, expected.RootPath, StringComparison.OrdinalIgnoreCase) ||
            observed.RootFileId == 0 || unchecked((ulong)observed.RootFileId) != expected.RootFileId ||
            observed.NamespaceClsid != expected.NamespaceClsid || observed.Binding is null ||
            observed.Binding.Digest != expected.ManifestDigest || observed.Binding.Scope != expected.Scope ||
            observed.Revision != checked(expected.ProfileRevision + 2) ||
            !string.Equals(directory, expected.ProfileDirectory, StringComparison.OrdinalIgnoreCase)) return null;
        if (!NativeRootRegistration.HasExactRootFileId(observed.Root, observed.RootFileId)) return null;
        using var handles = ConnectedGenerationHandleLease.Open(directory, observed.Binding.File, observed.Root);
        if (handles.ProfileDirectoryVolume != expected.ProfileDirectoryVolume ||
            handles.ProfileDirectoryFileId != expected.ProfileDirectoryFileId || handles.RootVolume != expected.RootVolume ||
            handles.ProfileVolume != expected.ProfileDocumentVolume || handles.ProfileFileId == 0 ||
            handles.RootFileId != expected.RootFileId || !ProfileBytesMatch(handles.ReadProfile())) return null;
        var absence = ShellRegistration.Inspect(observed.Root, ShellRegistration.CreateId(observed.Identity), Context(observed),
            observed.NamespaceClsid, observed.Icon, ProfileDisplayName(observed));
        handles.Recheck();
        if (!absence.CompleteAbsenceVerified || !selectorProof() || ReadProfile() != observed ||
            !NativeRootRegistration.HasExactRootFileId(observed.Root, observed.RootFileId)) return null;
        return new(observed.Identity, handles.ProfileVolume, handles.ProfileFileId, observed.Revision);
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

    private bool ProfileBytesMatch(byte[] expected)
    {
        if (expected.Length is < 1 or > 65536) return false;
        using var input = new FileStream(profilePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length != expected.Length) return false;
        var actual = new byte[expected.Length]; input.ReadExactly(actual); return actual.AsSpan().SequenceEqual(expected);
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
        var loaded = ReadFrozenManifestFile(p);
        lock (view) manifest = loaded;
    }

    private ExplorerRootManifest ReadFrozenManifestFile(Profile p)
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
        return loaded;
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
            if (pendingFreshLeaseTransfer is not null || pendingPriorObservation is not null || priorLeaseTransferred || restartLeaseReview)
                throw new IOException("The prior generation lease is retained for recovery review.");
            candidateTestHook?.Invoke("before-dispose");
            source?.Pause();
            if (provider is not null) { await provider.DisposeAsync(); provider = null; }
            source?.Dispose(); source = null;
            lease?.Dispose(); lease = null;
            reclaimedPriorObservation?.Dispose(); reclaimedPriorObservation = null;
            candidateFence?.Dispose(); candidateFence = null;
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
        activity.Add(text);
        Notify();
    }
    private void Notify() { try { Changed?.Invoke(this, EventArgs.Empty); } catch { } }
}

/// <summary>Read-only profile and Windows identity pins; callers must hold their own coordinator lease.</summary>
public sealed record ConnectedGenerationSnapshot(Guid Identity, string ProfileDirectory, string RootPath, long RootFileId,
    Guid NamespaceClsid, string ManifestDigest, ExplorerRootScope Scope, long ProfileRevision);

internal sealed record RestartGenerationEvidence(ConnectedGenerationSnapshot Snapshot, uint ProfileDirectoryVolume,
    ulong ProfileDirectoryFileId, uint ProfileDocumentVolume, ulong ProfileDocumentFileId, uint RootVolume, ulong RootFileId);

/// <summary>Durable prepared profile identity; no Windows root or provider has been created.</summary>
public sealed record PreparedConnectedGeneration(Guid Identity, string ProfileDirectory, string RootPath,
    string ManifestDigest, ExplorerRootScope Scope, long ProfileRevision, uint ProfileVolume, ulong ProfileFileId,
    uint ProfileDocumentVolume, ulong ProfileDocumentFileId);

/// <summary>Caller must dispose the retained handles and separately hold coordinator/session leases.</summary>
public sealed class ConnectedGenerationHeldObservation : IDisposable
{
    private readonly object gate = new();
    private ConnectedGenerationHandleLease? handles;
    public ConnectedGenerationSnapshot Snapshot { get; }
    internal ConnectedGenerationHandleLease Handles { get { lock (gate) return handles ?? throw new ObjectDisposedException(nameof(ConnectedGenerationHeldObservation)); } }
    internal ConnectedGenerationHeldObservation(ConnectedGenerationSnapshot snapshot, ConnectedGenerationHandleLease handles)
    { Snapshot = snapshot; this.handles = handles; }
    internal ConnectedGenerationHeldObservation TakeOwnership()
    {
        lock (gate) {
            var held = handles ?? throw new ObjectDisposedException(nameof(ConnectedGenerationHeldObservation));
            var next = new ConnectedGenerationHeldObservation(Snapshot, held); handles = null; return next;
        }
    }
    public void Dispose() { ConnectedGenerationHandleLease? previous; lock (gate) { previous = handles; handles = null; } previous?.Dispose(); }
}

// Internal transfer receipt owns both the exact session lock and physical observation.
internal sealed class RetainedPriorGeneration : IDisposable
{
    private readonly object gate = new();
    private readonly OwnedExplorerRootSession owner;
    private SessionLeaseReceipt? session;
    private ConnectedGenerationHeldObservation? observation;
    internal RetainedPriorGeneration(OwnedExplorerRootSession owner, SessionLeaseReceipt session, ConnectedGenerationHeldObservation observation)
    { this.owner = owner; this.session = session; this.observation = observation; }
    internal ConnectedGenerationSnapshot Snapshot { get { lock (gate) return (observation ?? throw new ObjectDisposedException(nameof(RetainedPriorGeneration))).Snapshot; } }
    internal (FileStream Stream, ConnectedGenerationHeldObservation Observation) Reclaim(OwnedExplorerRootSession requested,
        Action<FileStream, ConnectedGenerationHeldObservation> verify)
    {
        lock (gate) {
            if (!ReferenceEquals(owner, requested) || session is null || observation is null) throw new IOException("Prior generation receipt is unavailable or foreign.");
            var stream = session.Inspect(); verify(stream, observation);
            var moved = session.Take(); var held = observation; session = null; observation = null; return (moved, held);
        }
    }
    public void Dispose()
    {
        lock (gate) { session?.Dispose(); observation?.Dispose(); session = null; observation = null; }
    }
}
