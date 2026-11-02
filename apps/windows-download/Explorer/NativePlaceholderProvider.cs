using System.Runtime.InteropServices;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

/// <summary>Connects a registered, completely enumerated preview root to the verified transfer pipeline.
/// The caller owns shell registration and the lifetime of the authorized source.</summary>
public sealed class NativePlaceholderProvider : IAsyncDisposable
{
    private readonly string root;
    private readonly IPreviewRootRegistration registration;
    private readonly CloudFilesConnectionOwner connection;
    private readonly Dictionary<string, PlaceholderIdentity> files;
    private readonly HashSet<string> directories = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> preservedLocalFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> reclaimedCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly BoundedAvailabilityWorkers availabilityWorkers;
    private readonly CancellationTokenSource stopping = new();
    private Task? pinWorker;
    private AvailabilityScanWake? scanWake;
    private Task? closing;
    private readonly object availabilityGate = new();
    private readonly HashSet<Task> availabilityWork = [];
    private bool availabilityStopping;
    private int started;
    public string? LastCreationDiagnostic { get; private set; }
    public string? LastNativeTransferDiagnostic { get; private set; }
    public event Action<string>? Activity;
    internal event Action<HydrationFailureDiagnostic>? HydrationFailureObserved;

    public NativePlaceholderProvider(IPreviewRootRegistration registration, string cacheDirectory, IQueuedDownloadSource source,
        string channel, string principal, IReadOnlyDictionary<string, PlaceholderIdentity> manifest,
        IEnumerable<string>? directoryManifest = null)
    {
        ArgumentNullException.ThrowIfNull(principal);
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(registration);
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            throw new PlatformNotSupportedException("The preview requires Windows x64.");
        AssertAbi();
        this.registration = registration;
        registration.VerifyOwned();
        root = registration.Root;
        if (!Directory.Exists(cacheDirectory)) throw new IOException("The application cache directory must exist before connecting a provider.");
        files = new(StringComparer.OrdinalIgnoreCase);
        if (manifest.Count > 1000 || channel is not ("pilot" or "stable") ||
            !System.Text.RegularExpressions.Regex.IsMatch(principal, "\\Aodqp1_[a-f0-9]{64}\\z"))
            throw new TransferException("Provider scope or manifest size is unsupported.");
        foreach (var (relative, identity) in manifest) {
            ValidateRelative(relative); identity.Encode(); // Refuse oversized native identities before any connection or placeholder writes.
            if (identity.Length > (64L << 30) || identity.FileName != Path.GetFileName(relative) || identity.Channel != channel || identity.PrincipalId != principal
                || identity.SourceAlias != source.Alias || identity.Origin != source.Origin.GetLeftPart(UriPartial.Authority))
                throw new TransferException("Provider manifest does not match this source or supported hydration capacity.");
            files.Add(relative, identity);
            if (files.Count + directories.Count > 1000) throw new TransferException("Provider manifest size is unsupported.");
            foreach (var parent in Parents(relative)) AddDirectory(parent);
        }
        foreach (var directory in directoryManifest ?? []) {
            AddDirectory(directory);
            foreach (var parent in Parents(directory)) AddDirectory(parent);
        }
        if (directories.Any(files.ContainsKey)) throw new TransferException("A provider path cannot be both a file and a directory.");
        connection = new(new NativeConnection(root), key => new CloudFilesCallbackDispatcher(source, channel, principal, key,
            cacheDirectory, async (coordinator, identity, context, token) => {
                Notice("Downloading " + identity.FileName);
                try {
                    await CloudFilesNativeTransfer.HydrateForCallbackAsync(coordinator, identity, context, token,
                        new TransferNative(value => LastNativeTransferDiagnostic = value), TimeSpan.FromSeconds(20), summary => Notice(summary.ActivityText));
                } catch (TransferException error) when (error.HydrationFailure is { } diagnostic) {
                    Notice(diagnostic.ActivityText); // Bounded enums/statuses only, before the callback's generic WorkFailed notice.
                    try { HydrationFailureObserved?.Invoke(diagnostic); } catch { }
                    throw;
                }
                Notice("Available locally: " + identity.FileName);
            }), notice => Notice("Provider: " + notice), normalizeNativeRanges: true);
        availabilityWorkers = new(files.Keys, InspectAvailability, async (relative, intent, token) => {
            if (intent == AvailabilityIntent.Keep) {
                try { HydrateCore(relative); }
                catch (Exception error) { throw LocalAvailabilityException.FromException(LocalAvailabilityStage.Hydrate, error); }
                Notice("Kept on this device: " + Path.GetFileName(relative));
            } else await FreeSpaceCoreAsync(relative, token).ConfigureAwait(false);
        }, error => Notice(LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect, error).ActivityText));
    }

    public async Task ConnectAndPopulateAsync()
    {
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException("Provider cannot be started twice.");
        if (Directory.EnumerateFileSystemEntries(root).Any()) throw new IOException("A new empty preview folder is required.");
        try {
        registration.VerifyOwned();
        connection.Connect();
        var folders = directories
            .OrderBy(path => path.Count(c => c == Path.DirectorySeparatorChar)).ThenBy(path => path, StringComparer.OrdinalIgnoreCase);
        foreach (var folder in folders) Create(folder, null);
        foreach (var (path, identity) in files) Create(path, identity);
        scanWake = AvailabilityScanWake.ForRoot(root);
        pinWorker = Task.Run(PinLoopAsync);
        } catch {
            await DisposeAsync();
            throw;
        }
    }

    /// <summary>Reconnects an owned persisted root only after every expected placeholder identity is verified.
    /// Missing, renamed, replaced and foreign placeholders are never recreated or overwritten.</summary>
    public async Task ConnectExistingAsync()
    {
        if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException("Provider cannot be started twice.");
        registration.VerifyOwned();
        var rootInfo = new byte[8];
        Check(Native.CfGetSyncRootInfoByPath(root, 0, rootInfo, 8, out var rootLength), "Inspect registered root");
        if (rootLength != 8 || BitConverter.ToInt64(rootInfo) == 0) throw new IOException("The persisted root identity is unavailable.");
        var rootFileId = BitConverter.ToInt64(rootInfo);
        foreach (var (relative, identity) in files) {
            if (!VerifyPlaceholder(CheckedPath(relative), identity.Encode(), rootFileId, allowLocalFile: true)) {
                preservedLocalFiles.Add(relative);
                Notice("Local changes kept outside preview management: " + Path.GetFileName(relative));
            }
        }
        foreach (var folder in directories)
            VerifyPlaceholder(CheckedPath(folder, directory: true),
                System.Text.Encoding.UTF8.GetBytes("LedgeTop.Files.Preview.Directory.v1:" + folder), rootFileId);
        try {
            connection.Connect();
            scanWake = AvailabilityScanWake.ForRoot(root);
            pinWorker = Task.Run(PinLoopAsync);
        } catch { await DisposeAsync(); throw; }
    }

    private static bool VerifyPlaceholder(string path, byte[] expectedIdentity, long rootFileId, bool allowLocalFile = false)
    {
        return PlaceholderVisibility.Run(() => {
            using var handle = Native.CreateFileW(path, 0x80, 7, 0, 3, 0x02200000, 0);
            if (handle.IsInvalid) throw new IOException("An expected preview placeholder is missing.");
            var info = new byte[32 + 4096];
            var result = Native.CfGetPlaceholderInfo(handle, 0, info, (uint)info.Length, out var returned);
            // Some editors replace/truncate a hydrated sample into an ordinary local file. Keep it
            // untouched and exclude it from all native availability operations; never recreate it.
            if (result == unchecked((int)0x80070178) && allowLocalFile &&
                Native.GetFileInformationByHandleEx(handle, 9, out var metadata, 8) && (metadata.Attributes & (0x10 | 0x400)) == 0)
                return false;
            Check(result, "Inspect persisted placeholder " + Path.GetFileName(path));
            if (returned < 28 || returned > info.Length || BitConverter.ToInt64(info, 8) == 0 ||
                BitConverter.ToInt64(info, 16) != rootFileId || BitConverter.ToUInt32(info, 24) != expectedIdentity.Length ||
                28 + expectedIdentity.Length > returned || !info.AsSpan(28, expectedIdentity.Length).SequenceEqual(expectedIdentity))
                throw new IOException("A persisted placeholder no longer matches this preview's source and root.");
            return true;
        });
    }

    /// <summary>Read-only removal gate. Unknown cloud entries and junctions must be reconciled before unregistering.
    /// Ordinary local files are preserved; missing generated entries are allowed during explicit removal.</summary>
    public void ValidateForRemoval()
    {
        registration.VerifyOwned();
        var rootInfo = new byte[8];
        Check(Native.CfGetSyncRootInfoByPath(root, 0, rootInfo, 8, out var rootLength), "Inspect removal root");
        if (rootLength != 8) throw new IOException("Removal root identity is unavailable.");
        var rootId = BitConverter.ToInt64(rootInfo);
        var folders = directories;
        var pending = new Stack<(string Directory, int Depth)>();
        pending.Push((root, 0)); var count = 0;
        while (pending.TryPop(out var item)) {
            if (item.Depth > 32) throw new IOException("The preview removal tree is too deep to verify.");
            foreach (var path in Directory.EnumerateFileSystemEntries(item.Directory)) {
                if (++count > 10000) throw new IOException("The preview removal tree exceeds verification limits.");
                var relative = Path.GetRelativePath(root, path);
                var metadata = PlaceholderVisibility.Run(() => {
                    using var handle = Native.CreateFileW(path, 0x80, 7, 0, 3, 0x02200000, 0);
                    if (handle.IsInvalid || !Native.GetFileInformationByHandleEx(handle, 9, out var tag, 8))
                        throw new IOException("Removal entry metadata is unavailable.");
                    return tag;
                });
                var directory = (metadata.Attributes & 0x10) != 0;
                if ((metadata.Attributes & 0x400) != 0) {
                    if ((metadata.Tag & 0xFFFF0FFF) != 0x9000001A) throw new IOException("A foreign reparse entry prevents preview removal.");
                    byte[] identity;
                    if (directory && folders.Contains(relative)) identity = System.Text.Encoding.UTF8.GetBytes("LedgeTop.Files.Preview.Directory.v1:" + relative);
                    else if (!directory && files.TryGetValue(relative, out var file)) identity = file.Encode();
                    else throw new IOException("An unknown cloud placeholder prevents preview removal.");
                    VerifyPlaceholder(path, identity, rootId);
                }
                if (directory) pending.Push((path, item.Depth + 1));
            }
        }
    }

    private static IEnumerable<string> Parents(string path)
    {
        for (var parent = Path.GetDirectoryName(path); !string.IsNullOrEmpty(parent); parent = Path.GetDirectoryName(parent))
            yield return parent;
    }

    private void AddDirectory(string path)
    {
        ValidateRelative(path);
        directories.Add(path);
        if (directories.Count + files.Count > 1000) throw new TransferException("Provider manifest size is unsupported.");
    }

    private void Create(string relative, PlaceholderIdentity? identity)
    {
        var name = Marshal.StringToHGlobalUni(Path.GetFileName(relative));
        nint opaque = 0;
        try {
            var bytes = identity?.Encode() ?? System.Text.Encoding.UTF8.GetBytes("LedgeTop.Files.Preview.Directory.v1:" + relative);
            if (bytes.Length > 0) { opaque = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, opaque, bytes.Length); }
            var stamp = DateTime.UtcNow.ToFileTimeUtc();
            var entry = new PlaceholderCreate {
                RelativeName = name,
                Metadata = new() { Basic = new() {
                    Creation = stamp, LastAccess = stamp, LastWrite = stamp, Change = stamp,
                    Attributes = identity is null ? 0x10u : 0x1u // Sample deliveries are read-only.
                }, Length = identity?.Length ?? 0 },
                Identity = opaque, IdentityLength = (uint)bytes.Length, Flags = identity is null ? 3u : 2u
            };
            var parent = Path.GetDirectoryName(Path.Combine(root, relative))!;
            uint processed = 0;
            var result = PlaceholderVisibility.Run(() => Native.CfCreatePlaceholders(parent, ref entry, 1, 1, out processed));
            LastCreationDiagnostic = $"{relative}: api=0x{result:X8}, processed={processed}, entry=0x{entry.Result:X8}";
            Check(result, "Create placeholder " + relative);
            if (processed != 1) throw new IOException("Placeholder creation was incomplete.");
            Check(entry.Result, "Create placeholder entry");
        } finally { Marshal.FreeHGlobal(name); if (opaque != 0) Marshal.FreeHGlobal(opaque); }
    }

    // One scanner observes the bounded manifest without waiting for native hydration.
    // Exactly two tracked workers re-read intent after their per-path availability gate.
    private Task PinLoopAsync() => scanWake!.RunScannerAsync(files.Keys, relative => {
        if (preservedLocalFiles.Contains(relative)) return;
        try { availabilityWorkers.Observe(relative, InspectAvailability(relative)); }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or TransferException) {
            Notice(LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect, error).ActivityText);
        }
    }, stopping.Token);

    private AvailabilityObservation InspectAvailability(string relative)
    {
        var attributes = (uint)PlaceholderVisibility.Run(() => File.GetAttributes(CheckedPath(relative)));
        var intent = FailedAvailabilityIntents.ObserveAttributes(attributes);
        bool reclaimed;
        lock (reclaimedCache) {
            if ((attributes & 0x100000) == 0) reclaimedCache.Remove(relative);
            reclaimed = reclaimedCache.Contains(relative);
        }
        return new(intent, intent == AvailabilityIntent.Keep ? (attributes & (0x1000u | 0x40000u | 0x400000u)) != 0
            : intent == AvailabilityIntent.Free && ((attributes & 0x1000) == 0 || !reclaimed));
    }

    /// <summary>Used by acceptance tests and explicit UI actions; pin intent alone is never an availability receipt.</summary>
    public void KeepOnDevice(string relative) => RunAvailabilityAsync(relative, _ => {
        var path = CheckedPath(relative);
        WithHandle(path, handle => { Check(Native.CfSetPinState(handle, 1, 0, 0), "Pin sample"); });
        HydrateCore(relative);
        return Task.CompletedTask;
    }).GetAwaiter().GetResult();

    public void Hydrate(string relative) => RunAvailabilityAsync(relative, _ => {
        HydrateCore(relative); return Task.CompletedTask;
    }).GetAwaiter().GetResult();

    private void HydrateCore(string relative)
    {
        var path = CheckedPath(relative);
        WithHandle(path, handle => Check(Native.CfHydratePlaceholder(handle, 0, -1, 0, 0), "Hydrate sample"));
    }

    public FileAttributes InspectAttributes(string relative) => PlaceholderVisibility.Run(() => File.GetAttributes(CheckedPath(relative)));

    /// <summary>Mirrors the Windows folder action. Completion sets intent; the worker verifies each file separately.</summary>
    public void SetFolderAvailabilityIntent(string relative, bool keepOffline)
    {
        var path = CheckedPath(relative, directory: true);
        // RECURSE|RECURSE_STOP_ON_ERROR; never imply full availability merely because setting intent succeeded.
        WithHandle(path, handle => Check(Native.CfSetPinState(handle, keepOffline ? 1 : 2, 1 | 4, 0), "Set folder availability intent"));
    }

    /// <summary>The platform refuses dirty or pinned placeholders. Never mark modified data in-sync to permit eviction.</summary>
    public void FreeSpace(string relative) => FreeSpaceAsync(relative).GetAwaiter().GetResult();

    /// <summary>Does not block a UI caller. Online-only receipt includes successful verified-cache reclamation.</summary>
    public Task FreeSpaceAsync(string relative, CancellationToken cancellationToken = default) =>
        RunAvailabilityAsync(relative, token => FreeSpaceCoreAsync(relative, token), cancellationToken);

    private Task RunAvailabilityAsync(string relative, Func<CancellationToken, Task> operation, CancellationToken cancellationToken = default)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (availabilityGate) {
            if (availabilityStopping || availabilityWork.Count >= 1000) throw new IOException("Availability changes are stopping or at capacity.");
            availabilityWork.Add(completion.Task);
        }
        _ = CompleteAvailabilityAsync(relative, operation, cancellationToken, completion);
        return completion.Task;
    }
    private async Task CompleteAvailabilityAsync(string relative, Func<CancellationToken, Task> operation, CancellationToken cancellationToken, TaskCompletionSource completion)
    {
        try { await availabilityWorkers.RunExclusiveAsync(relative, operation, cancellationToken).ConfigureAwait(false); completion.TrySetResult(); }
        catch (OperationCanceledException error) { completion.TrySetCanceled(error.CancellationToken); }
        catch (Exception error) { completion.TrySetException(error); }
        finally { lock (availabilityGate) availabilityWork.Remove(completion.Task); }
    }
    private async Task FreeSpaceCoreAsync(string relative, CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, stopping.Token);
        await Task.Run(() => {
            linked.Token.ThrowIfCancellationRequested();
            string path;
            try { path = CheckedPath(relative); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or TransferException) {
                throw LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect, error);
            }
            LocalAvailabilityOperations.FreeNative(new FreeNative(path), linked.Token);
        }, linked.Token).ConfigureAwait(false);
        // Close native oplock before waiting for hydration drain/cache leases; no lock inversion.
        try { await connection.EvictVerifiedCacheAsync(files[relative], linked.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (linked.IsCancellationRequested) { throw; }
        catch (Exception error) { throw LocalAvailabilityException.FromException(LocalAvailabilityStage.CacheReclamation, error); }
        lock (reclaimedCache) reclaimedCache.Add(relative);
        Notice("Online only: " + Path.GetFileName(relative));
    }

    private static void WithHandle(string path, Action<nint> action)
    {
        // A protected EXCLUSIVE oplock handle is opaque and must be released with CfCloseHandle.
        Check(Native.CfOpenFileWithOplock(path, 1, out var handle), "Open sample placeholder");
        try { action(handle); } finally { Native.CfCloseHandle(handle); }
    }

    private string CheckedPath(string relative, bool directory = false)
    {
        if (stopping.IsCancellationRequested) throw new IOException("Provider is stopping.");
        if (preservedLocalFiles.Contains(relative)) throw new IOException("This local file has been kept unchanged and is no longer managed by the preview.");
        if (directory ? !directories.Contains(relative) : !files.ContainsKey(relative))
            throw new IOException("Path is outside this preview manifest.");
        ValidateRelative(relative);
        var path = Path.Combine(root, relative);
        return PlaceholderVisibility.Run(() => {
        // Cloud directories are reparse points too. Reject every other kind, including junctions
        // that could redirect a provider operation into a different application's tree.
        for (var current = path; current is not null; current = Path.GetDirectoryName(current)) {
            using var handle = Native.CreateFileW(current, 0x80, 7, 0, 3, 0x02200000, 0);
            if (handle.IsInvalid || !Native.GetFileInformationByHandleEx(handle, 9, out var metadata, 8))
                throw new IOException("Preview path metadata is unavailable.");
            var insideRoot = StringComparer.OrdinalIgnoreCase.Equals(current, root) || current.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            if ((metadata.Attributes & 0x400) != 0 && (!insideRoot || (metadata.Tag & 0xFFFF0FFF) != 0x9000001A))
                throw new IOException("Preview path passes through another reparse provider.");
        }
        return path;
        });
    }

    private static void ValidateRelative(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains('/') || path.Length > 180 || path.Count(c => c == '\\') >= 32)
            throw new IOException("Invalid preview path.");
        foreach (var part in path.Split('\\')) Downloader.SafeFileName(part);
    }

    private void Notice(string value) { try { Activity?.Invoke(value); } catch { } }
    private static void Check(int status, string action) { if (status < 0) throw new IOException(action + " failed.", Marshal.GetExceptionForHR(status)); }

    public ValueTask DisposeAsync()
    {
        TaskCompletionSource completion;
        lock (availabilityGate) {
            if (closing is not null) return new(closing);
            availabilityStopping = true; availabilityWorkers.StopAdmission();
            completion = new(TaskCreationOptions.RunContinuationsAsynchronously); closing = completion.Task;
        }
        _ = CompleteStopAsync(completion);
        return new(completion.Task);
    }
    private async Task CompleteStopAsync(TaskCompletionSource completion)
    {
        try { await StopAsync().ConfigureAwait(false); completion.TrySetResult(); }
        catch (Exception error) { completion.TrySetException(error); }
    }
    private async Task StopAsync()
    {
        scanWake?.Stop();
        Exception? cancellationFailure = null;
        try { stopping.Cancel(); } catch (Exception error) { cancellationFailure = error; }
        await availabilityWorkers.StopAndDrainAsync(() => connection.StopAsync(), async () => {
            Task[] availability; lock (availabilityGate) availability = availabilityWork.ToArray();
            await Task.WhenAll(availability.Select(async task => { try { await task.ConfigureAwait(false); } catch { } }));
            if (pinWorker is not null) await pinWorker.ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (scanWake is not null) await scanWake.DisposeAsync().ConfigureAwait(false);
        if (cancellationFailure is not null) throw new IOException("Provider cancellation notification failed after disconnect and drain.", cancellationFailure);
    }

    internal static void AssertAbi()
    {
        CloudFilesConnectionOwner.AssertAbi(); CloudFilesNativeTransfer.AssertAbi();
        if (Marshal.SizeOf<FileBasic>() != 40 || Marshal.SizeOf<FsMetadata>() != 48 || Marshal.SizeOf<PlaceholderCreate>() != 88
            || Marshal.OffsetOf<PlaceholderCreate>(nameof(PlaceholderCreate.Metadata)).ToInt32() != 8
            || Marshal.OffsetOf<PlaceholderCreate>(nameof(PlaceholderCreate.Identity)).ToInt32() != 56
            || Marshal.OffsetOf<PlaceholderCreate>(nameof(PlaceholderCreate.Result)).ToInt32() != 72
            || Marshal.OffsetOf<PlaceholderCreate>(nameof(PlaceholderCreate.Usn)).ToInt32() != 80)
            throw new PlatformNotSupportedException("Unsupported Cloud Files placeholder ABI.");
    }

    [StructLayout(LayoutKind.Sequential)] private struct FileBasic { internal long Creation, LastAccess, LastWrite, Change; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct FsMetadata { internal FileBasic Basic; internal long Length; }
    [StructLayout(LayoutKind.Sequential)] private struct PlaceholderCreate {
        internal nint RelativeName; internal FsMetadata Metadata; internal nint Identity; internal uint IdentityLength, Flags;
        internal int Result; internal long Usn;
    }
    [StructLayout(LayoutKind.Sequential)] private struct AttributeTag { internal uint Attributes, Tag; }

    private sealed class NativeConnection(string root) : ICloudFilesConnectionNative
    {
        public int Connect(nint table, nint context, out long key) => Native.CfConnectSyncRoot(root, table, context, 4, out key);
        public int Disconnect(long key) => Native.CfDisconnectSyncRoot(key);
        public void RejectFetch(CloudFilesOperationContext context, int status)
        {
            var info = new CloudOperationInfo { StructSize = 48, Type = 0, ConnectionKey = new() { Internal = context.ConnectionKey },
                TransferKey = context.TransferKey, RequestKey = context.RequestKey };
            var parameters = new CloudOperationParameters { ParamSize = 40, TransferData = new() {
                CompletionStatus = status, Offset = context.RequiredOffset, Length = context.RequiredLength } };
            Check(Native.CfExecute(ref info, ref parameters), "Reject hydration");
        }
    }

    private sealed class FreeNative(string path) : ILocalAvailabilityNative
    {
        public int Open(out nint handle) => Native.CfOpenFileWithOplock(path, 1, out handle);
        public int Unpin(nint handle) => Native.CfSetPinState(handle, 2, 0, 0);
        public int Dehydrate(nint handle) => Native.CfDehydratePlaceholder(handle, 0, -1, 0, 0);
        public void Close(nint handle) => Native.CfCloseHandle(handle);
    }

    private sealed class TransferNative(Action<string> diagnostic) : ICloudFilesTransferNative
    {
        public int Execute(nint info, nint parameters)
        {
            var result = Native.CfExecutePointers(info, parameters);
            diagnostic($"completion=0x{Marshal.ReadInt32(parameters, 12):X8}; execute=0x{result:X8}");
            return result;
        }
        public int ReportProgress(long connection, long transfer, long total, long completed) => Native.CfReportProviderProgress(connection, transfer, total, completed);
    }

    private static class Native
    {
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfConnectSyncRoot(string root, nint callbacks, nint context, uint flags, out long key);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfDisconnectSyncRoot(long key);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfCreatePlaceholders(string root, ref PlaceholderCreate entry, uint count, uint flags, out uint processed);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfExecute(ref CloudOperationInfo info, ref CloudOperationParameters parameters);
        [DllImport("CldApi.dll", EntryPoint = "CfExecute", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfExecutePointers(nint info, nint parameters);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfReportProviderProgress(long connection, long transfer, long total, long completed);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfOpenFileWithOplock(string path, uint flags, out nint handle);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern void CfCloseHandle(nint handle);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfHydratePlaceholder(nint handle, long offset, long length, uint flags, nint overlapped);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfDehydratePlaceholder(nint handle, long offset, long length, uint flags, nint overlapped);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfSetPinState(nint handle, int state, uint flags, nint overlapped);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfGetSyncRootInfoByPath(string path, int kind, [Out] byte[] info, uint size, out uint returned);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern int CfGetPlaceholderInfo(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int kind, [Out] byte[] info, uint size, out uint returned);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int kind, out AttributeTag info, uint size);
    }
}
