using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

public sealed record QueuedDownloadSession(string PrincipalId, DateTimeOffset ExpiresAt);
public sealed record ResolvedQueuedDownload(string PrincipalId, string LogicalFileId, string RemoteVersion, DownloadSpec Spec);
public interface IQueuedDownloadSource
{
    string Alias { get; }
    Uri Origin { get; }
    Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default);
    Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default);
    Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
        CancellationToken cancellationToken = default);
}
public enum QueuedTransferState { Queued, Running, Paused, Cancelled, Completed, Failed, VersionChanged, LoginRequired, AccessDenied, ResourceUnavailable }
public sealed record QueuedTransfer(Guid JobId, string ResourceReference, string Destination, string LogicalFileId,
    string RemoteVersion, string FileName, long Length, string ETag, string Sha256, bool RecoveryRequired, QueuedTransferState State, string? ErrorCode);
public sealed class QueueStorageException(string? completedFilePath = null) : Exception(completedFilePath is null
    ? "The durable queue could not be saved; no new transfer will start."
    : "The verified file was completed, but its queue status could not be saved. Keep the completed file.")
{
    public string? CompletedFilePath { get; } = completedFilePath;
}

/// <summary>One process-held, app-owned queue for one source and verified principal.
/// It stores only non-authorizing references and trusted pins, never network credentials.</summary>
public sealed class TransferQueue : IAsyncDisposable
{
    private const int MaximumJobs = 1000, MaximumStateBytes = 8 * 1024 * 1024;
    private const string Marker = ".ltds-queue-owner", LockName = ".queue.lock", StateName = "queue.json";
    private const string Owner = "LedgeTop.WindowsDownload.Queue/1\n";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, MaxDepth = 12,
        Converters = { new JsonStringEnumConverter(allowIntegerValues: false) } };
    private sealed record State(int SchemaVersion, string SourceAlias, string Origin, string PrincipalId, QueuedTransfer[] Jobs);
    private readonly string directory, alias, origin, principal;
    private readonly IQueuedDownloadSource source;
    private readonly FileStream processLock;
    private readonly SemaphoreSlim commands = new(1, 1);
    private readonly object sync = new();
    private QueuedTransfer[] jobs;
    private CancellationTokenSource? activeCancellation;
    private Task activeTask = Task.CompletedTask;
    private Guid? activeJob;
    private QueuedTransferState stopState = QueuedTransferState.Paused;
    private QueueStorageException? storageFault;
    private bool disposed;

    private TransferQueue(string directory, IQueuedDownloadSource source, string alias, string origin, string principal,
        FileStream processLock, QueuedTransfer[] jobs)
    {
        this.directory = directory; this.source = source; this.alias = alias; this.origin = origin; this.principal = principal;
        this.processLock = processLock; this.jobs = jobs;
    }

    public static async Task<TransferQueue> OpenAsync(string stateDirectory, IQueuedDownloadSource source, CancellationToken cancellationToken = default)
    {
        var alias = source.Alias; var origin = FixedOrigin(source.Origin);
        if (!Regex.IsMatch(alias, "\\A[a-z0-9][a-z0-9_-]{0,63}\\z")) throw new TransferException("A stable configured source alias is required.");
        var session = await source.GetSessionAsync(cancellationToken); ValidSession(session);
        if (source.Alias != alias || FixedOrigin(source.Origin) != origin) throw new AccessDeniedException();
        var directory = LocalDirectory(stateDirectory);
        var marker = Path.Combine(directory, Marker); var lockPath = Path.Combine(directory, LockName); var statePath = Path.Combine(directory, StateName);
        CheckPath(marker); CheckPath(lockPath); CheckPath(statePath);
        var names = Directory.EnumerateFileSystemEntries(directory).Select(Path.GetFileName).ToArray();
        var fresh = !File.Exists(marker);
        if (fresh) {
            if (names.Length != 0) throw new TransferException("The queue directory is not empty or app-owned.");
            using var created = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            created.Write(Utf8.GetBytes(Owner)); created.Flush(true);
        } else if (new FileInfo(marker).Length != Utf8.GetByteCount(Owner) || File.ReadAllText(marker, Utf8) != Owner
            || names.Any(name => name is not (Marker or LockName or StateName))) throw new TransferException("The queue directory has unknown or ambiguous state.");
        if (!fresh && !File.Exists(statePath)) throw new TransferException("The owned queue state is missing; manual recovery is required.");
        FileStream held;
        try { held = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { throw new TransferException("This queue is already open or unavailable."); }
        TransferQueue? queue = null;
        try {
            var values = File.Exists(statePath) ? ReadState(statePath, alias, origin, session.PrincipalId) : [];
            queue = new(directory, source, alias, origin, session.PrincipalId, held, values);
            // Running is never trusted as resumable completion after a crash.
            queue.Commit(values.Select(job => job.State == QueuedTransferState.Running ? job with { State = QueuedTransferState.Paused, RecoveryRequired = true, ErrorCode = "interrupted" } : job).ToArray());
            return queue;
        } catch { held.Dispose(); throw; }
    }

    public async Task<IReadOnlyList<QueuedTransfer>> GetJobsAsync(CancellationToken cancellationToken = default)
    {
        await commands.WaitAsync(cancellationToken);
        try { EnsureOpen(); await VerifySessionAsync(cancellationToken); lock (sync) { Healthy(); return jobs.ToArray(); } }
        finally { commands.Release(); }
    }

    public async Task<Guid> EnqueueAsync(string resourceReference, string destination, CancellationToken cancellationToken = default)
    {
        Reference(resourceReference); var local = LocalDirectory(destination);
        await commands.WaitAsync(cancellationToken);
        try {
            EnsureOpen(); await VerifySessionAsync(cancellationToken);
            var resolved = await source.ResolveAsync(resourceReference, cancellationToken);
            await VerifySessionAsync(cancellationToken); ValidateResolved(resolved);
            var spec = resolved.Spec;
            var job = new QueuedTransfer(Guid.NewGuid(), resourceReference, local, resolved.LogicalFileId, resolved.RemoteVersion,
                spec.FileName, spec.Length, spec.ETag, spec.Sha256, false, QueuedTransferState.Queued, null);
            lock (sync) {
                Healthy();
                if (jobs.Length >= MaximumJobs || jobs.Any(old => old.ResourceReference == resourceReference && old.Destination == local
                    && old.State is not (QueuedTransferState.Completed or QueuedTransferState.Cancelled or QueuedTransferState.VersionChanged)))
                    throw new TransferException("The queue is full or already contains this resource and destination.");
                Commit([.. jobs, job]);
            }
            return job.JobId;
        } finally { commands.Release(); }
    }

    public Task StartAsync(Guid jobId, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        => BeginAsync(jobId, progress, cancellationToken);
    public Task RetryAsync(Guid jobId, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        => BeginAsync(jobId, progress, cancellationToken);

    private async Task BeginAsync(Guid jobId, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        await commands.WaitAsync(cancellationToken);
        try {
            EnsureOpen(); await VerifySessionAsync(cancellationToken);
            lock (sync) {
                Healthy(); var job = Find(jobId);
                if (activeJob is not null || job.State is QueuedTransferState.Running or QueuedTransferState.Completed
                    or QueuedTransferState.Cancelled or QueuedTransferState.VersionChanged) throw new TransferException("This job cannot start; choose an eligible paused job or explicitly create a new version.");
                // Persist Running before starting any resolution or byte request.
                Commit(jobs.Select(value => value.JobId == jobId ? value with { State = QueuedTransferState.Running, ErrorCode = null } : value).ToArray());
                activeCancellation = new CancellationTokenSource(); activeJob = jobId; stopState = QueuedTransferState.Paused;
                var stop = activeCancellation.Token;
                activeTask = Task.Run(() => RunAsync(job, progress, stop), CancellationToken.None);
            }
        } finally { commands.Release(); }
    }

    public Task PauseAsync(Guid jobId, CancellationToken cancellationToken = default) => StopAsync(jobId, QueuedTransferState.Paused, cancellationToken);
    public Task CancelAsync(Guid jobId, CancellationToken cancellationToken = default) => StopAsync(jobId, QueuedTransferState.Cancelled, cancellationToken);
    private async Task StopAsync(Guid jobId, QueuedTransferState requested, CancellationToken cancellationToken)
    {
        // Stopping app-owned work needs no network authorization. Signal before
        // even waiting for a command that may be blocked on session discovery.
        var active = SignalStop(jobId, requested);
        if (active is not null) { await active; return; }
        await commands.WaitAsync(cancellationToken);
        try {
            EnsureOpen();
            active = SignalStop(jobId, requested);
            if (active is not null) { await active; return; }
            await VerifySessionAsync(cancellationToken);
            lock (sync) { Healthy(); var job = Find(jobId); if (job.State is QueuedTransferState.Completed or QueuedTransferState.Cancelled or QueuedTransferState.VersionChanged) return;
                Commit(jobs.Select(job => job.JobId == jobId ? job with { State = requested, ErrorCode = null,
                RecoveryRequired = requested != QueuedTransferState.Cancelled && job.RecoveryRequired } : job).ToArray()); }
        } finally { commands.Release(); }
    }

    private Task? SignalStop(Guid jobId, QueuedTransferState requested)
    {
        Task pending; CancellationTokenSource? cancellation;
        lock (sync) {
            EnsureOpen();
            if (activeJob != jobId) return null;
            if (requested == QueuedTransferState.Cancelled || stopState != QueuedTransferState.Cancelled) stopState = requested;
            cancellation = activeCancellation; pending = activeTask;
        }
        try { cancellation?.Cancel(); } catch (ObjectDisposedException) { /* completed concurrently */ }
        return pending;
    }

    public async Task RefreshSessionAsync(CancellationToken cancellationToken = default)
    {
        await commands.WaitAsync(cancellationToken);
        try { EnsureOpen(); await VerifySessionAsync(cancellationToken); }
        finally { commands.Release(); }
    }
    public Task WaitForIdleAsync(CancellationToken cancellationToken = default)
    { lock (sync) { EnsureOpen(); return activeTask.WaitAsync(cancellationToken); } }

    private async Task VerifySessionAsync(CancellationToken cancellationToken)
    {
        try {
            CheckSource(); var current = await source.GetSessionAsync(cancellationToken); CheckSource(); ValidSession(current);
            if (current.PrincipalId != principal) throw new AccessDeniedException();
        } catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch {
            // Never hand the previous person's queue to a replacement session.
            await DrainAsync(); throw;
        }
    }
    private async Task DrainAsync()
    {
        Task pending; CancellationTokenSource? cancellation;
        lock (sync) { cancellation = activeCancellation; pending = activeTask; }
        try { cancellation?.Cancel(); } catch (ObjectDisposedException) { /* worker already drained */ }
        await pending;
    }

    private async Task RunAsync(QueuedTransfer job, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        var sessionExpiry = DateTimeOffset.MaxValue;
        try {
            CheckSource(); var session = await source.GetSessionAsync(cancellationToken); ValidSession(session);
            if (session.PrincipalId != principal) throw new AccessDeniedException();
            var resolved = await source.ResolveAsync(job.ResourceReference, cancellationToken);
            CheckSource(); ValidateResolved(resolved);
            if (resolved.LogicalFileId != job.LogicalFileId) { Finish(job.JobId, QueuedTransferState.AccessDenied, "resource-identity-changed"); return; }
            var spec = resolved.Spec;
            if (resolved.RemoteVersion != job.RemoteVersion || spec.FileName != job.FileName || spec.Length != job.Length
                || spec.ETag != job.ETag || spec.Sha256 != job.Sha256) { Finish(job.JobId, QueuedTransferState.VersionChanged, "version-changed"); return; }
            session = await source.GetSessionAsync(cancellationToken); CheckSource(); ValidSession(session);
            if (session.PrincipalId != principal) throw new AccessDeniedException();
            cancellationToken.ThrowIfCancellationRequested();
            sessionExpiry = session.ExpiresAt;
            using var authorization = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            authorization.CancelAfter(TimeSpan.FromMilliseconds(Math.Min(uint.MaxValue - 1, Math.Max(1, (sessionExpiry - DateTimeOffset.UtcNow).TotalMilliseconds))));
            if (job.RecoveryRequired && await RecoverExistingAsync(job, authorization.Token)) return;
            var output = await source.DownloadAsync(spec, LocalDirectory(job.Destination), progress, authorization.Token);
            if (Path.GetFullPath(output) != Path.Combine(job.Destination, job.FileName)) throw new TransferException("The transfer returned an unexpected local result.");
            Finish(job.JobId, QueuedTransferState.Completed, null, output);
        } catch (QueueStorageException) { throw; }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { QueuedTransferState state; lock (sync) state = stopState; Finish(job.JobId, state, null); }
        catch (OperationCanceledException) when (DateTimeOffset.UtcNow >= sessionExpiry) { Finish(job.JobId, QueuedTransferState.LoginRequired, "login-required"); }
        catch (LoginRequiredException) { Finish(job.JobId, QueuedTransferState.LoginRequired, "login-required"); }
        catch (AccessDeniedException) { Finish(job.JobId, QueuedTransferState.AccessDenied, "access-denied"); }
        catch (ResourceUnavailableException) { Finish(job.JobId, QueuedTransferState.ResourceUnavailable, "resource-unavailable"); }
        catch (Exception) { Finish(job.JobId, QueuedTransferState.Failed, "transfer-failed"); }
        finally { lock (sync) { activeJob = null; activeCancellation?.Dispose(); activeCancellation = null; } }
    }

    private async Task<bool> RecoverExistingAsync(QueuedTransfer job, CancellationToken cancellationToken)
    {
        var output = Path.Combine(LocalDirectory(job.Destination), job.FileName);
        CheckPath(output);
        if (!File.Exists(output) && !Directory.Exists(output)) return false;
        if (Directory.Exists(output)) { Finish(job.JobId, QueuedTransferState.Failed, "existing-content-mismatch"); return true; }
        // This proves content presence, not who created the existing file. Keep
        // the read handle through state commit; never modify or replace it.
        await using var input = new FileStream(output, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
        if (input.Length != job.Length) { Finish(job.JobId, QueuedTransferState.Failed, "existing-content-mismatch"); return true; }
        var actual = await SHA256.HashDataAsync(input, cancellationToken);
        if (input.Length != job.Length || !CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(job.Sha256))) {
            Finish(job.JobId, QueuedTransferState.Failed, "existing-content-mismatch"); return true;
        }
        var current = await source.GetSessionAsync(cancellationToken); CheckSource(); ValidSession(current);
        if (current.PrincipalId != principal) throw new AccessDeniedException();
        cancellationToken.ThrowIfCancellationRequested();
        Finish(job.JobId, QueuedTransferState.Completed, null, output);
        return true;
    }

    private void Finish(Guid jobId, QueuedTransferState state, string? error, string? completed = null)
    {
        lock (sync) {
            try { Commit(jobs.Select(job => job.JobId == jobId ? job with { State = state, ErrorCode = error,
                RecoveryRequired = job.RecoveryRequired && state is not (QueuedTransferState.Completed or QueuedTransferState.Cancelled or QueuedTransferState.VersionChanged) } : job).ToArray()); }
            catch (QueueStorageException) {
                storageFault = new QueueStorageException(completed);
                if (completed is not null) jobs = jobs.Select(job => job.JobId == jobId ? job with { State = QueuedTransferState.Completed, RecoveryRequired = false, ErrorCode = "state-save-failed" } : job).ToArray();
                throw storageFault;
            }
        }
    }
    private void Commit(QueuedTransfer[] values)
    {
        var pending = Path.Combine(directory, ".queue-" + Guid.NewGuid().ToString("N") + ".tmp");
        try {
            Healthy(); CheckPath(directory); CheckPath(Path.Combine(directory, StateName));
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new State(1, alias, origin, principal, values), Json);
            if (bytes.Length > MaximumStateBytes || values.Length > MaximumJobs) throw new QueueStorageException();
            using (var output = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { output.Write(bytes); output.Flush(true); }
            var state = Path.Combine(directory, StateName);
            if (File.Exists(state)) File.Replace(pending, state, null); else File.Move(pending, state, false);
            jobs = values;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or TransferException) { throw new QueueStorageException(); }
        finally { if (File.Exists(pending)) try { File.Delete(pending); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }

    private void ValidateResolved(ResolvedQueuedDownload value)
    {
        if (value.PrincipalId != principal) throw new AccessDeniedException();
        var spec = value.Spec;
        if (!Regex.IsMatch(value.LogicalFileId, "\\A(?:oef1_|ondf1_)[a-f0-9]{64}\\z") || value.RemoteVersion.Length is < 1 or > 256
            || value.RemoteVersion.Any(char.IsControl) || spec.OpaqueIdentity != value.LogicalFileId + ":" + value.RemoteVersion
            || FixedContentOrigin(spec.ContentUri) != origin) throw new TransferException("Unsupported queued resource metadata.");
        ValidatePins(spec.FileName, spec.Length, spec.ETag, spec.Sha256);
    }
    private static void ValidatePins(string name, long size, string etag, string sha)
    {
        Downloader.SafeFileName(name); Utf8.GetByteCount(name);
        if (size < 0 || size > 1L << 40 || !Regex.IsMatch(sha, "\\A[a-f0-9]{64}\\z") || etag.Length > 512
            || !EntityTagHeaderValue.TryParse(etag, out var parsed) || parsed.IsWeak || parsed.Tag == "*" || parsed.ToString() != etag) throw new TransferException("Unsupported queued file pins.");
    }
    private static void Reference(string value) { if (value is null || value.Length > 16384 || !Regex.IsMatch(value, "\\Aodqr1_[A-Za-z0-9_-]+\\z")) throw new TransferException("A non-authorizing durable resource reference is required."); }
    private static void ValidSession(QueuedDownloadSession value)
    {
        if (value is null || !Regex.IsMatch(value.PrincipalId, "\\Aodqp1_[a-f0-9]{64}\\z") || value.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new LoginRequiredException();
    }
    private void CheckSource() { if (source.Alias != alias || FixedOrigin(source.Origin) != origin) throw new AccessDeniedException(); }
    private static string FixedOrigin(Uri value)
    {
        var result = FixedContentOrigin(value);
        if (value.AbsolutePath != "/" || value.Query.Length != 0) throw new TransferException("A fixed source HTTPS origin is required."); return result;
    }
    private static string FixedContentOrigin(Uri value)
    {
        if (!value.IsAbsoluteUri || value.Scheme != "https" || value.UserInfo.Length != 0 || value.Fragment.Length != 0) throw new TransferException("Only a fixed HTTPS source is supported.");
        return value.GetLeftPart(UriPartial.Authority);
    }
    private static string LocalDirectory(string value)
    {
        if (!Path.IsPathFullyQualified(value) || value.StartsWith("\\\\", StringComparison.Ordinal) || !Directory.Exists(value)) throw new TransferException("Choose an existing absolute local directory.");
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(value)); CheckPath(path); return path;
    }
    private static void CheckPath(string path)
    {
        string? current = path;
        while (current is not null) {
            try { if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new TransferException("Reparse paths are not allowed for queue state."); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            current = Path.GetDirectoryName(current);
        }
    }
    private static QueuedTransfer[] ReadState(string path, string alias, string origin, string principal)
    {
        try {
            CheckPath(path);
            if (new FileInfo(path).Length > MaximumStateBytes) throw new TransferException("Queue state exceeds its bounds.");
            using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var output = new MemoryStream(); var buffer = new byte[8192];
            while (true) { var count = input.Read(buffer, 0, Math.Min(buffer.Length, MaximumStateBytes + 1 - (int)output.Length));
                if (count == 0) break; output.Write(buffer, 0, count); if (output.Length > MaximumStateBytes) throw new TransferException("Queue state exceeds its bounds."); }
            var text = Utf8.GetString(output.ToArray());
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 12 }); NoDuplicates(document.RootElement);
            Exact(document.RootElement, "schemaVersion", "sourceAlias", "origin", "principalId", "jobs");
            if (document.RootElement.GetProperty("schemaVersion").GetRawText() != "1") throw new JsonException();
            foreach (var item in document.RootElement.GetProperty("jobs").EnumerateArray()) {
                Exact(item, "jobId", "resourceReference", "destination", "logicalFileId", "remoteVersion", "fileName", "length", "eTag", "sha256", "recoveryRequired", "state", "errorCode");
                var id = item.GetProperty("jobId").GetGuid(); if (id.ToString("D") != item.GetProperty("jobId").GetString()) throw new JsonException();
            }
            var state = JsonSerializer.Deserialize<State>(text, Json) ?? throw new JsonException();
            if (state.SchemaVersion != 1 || state.SourceAlias != alias || state.Origin != origin) throw new TransferException("This queue belongs to another source.");
            if (state.PrincipalId != principal) throw new AccessDeniedException();
            if (state.Jobs is null || state.Jobs.Length > MaximumJobs || state.Jobs.Select(job => job.JobId).Distinct().Count() != state.Jobs.Length) throw new JsonException();
            foreach (var job in state.Jobs) {
                if (job.JobId == Guid.Empty || !Enum.IsDefined(job.State) || !Regex.IsMatch(job.LogicalFileId, "\\A(?:oef1_|ondf1_)[a-f0-9]{64}\\z")
                    || (job.RecoveryRequired && job.State is QueuedTransferState.Queued or QueuedTransferState.Completed or QueuedTransferState.Cancelled or QueuedTransferState.VersionChanged)
                    || string.IsNullOrWhiteSpace(job.RemoteVersion) || job.RemoteVersion.Length > 256 || job.RemoteVersion.Any(char.IsControl)
                    || job.ErrorCode is not (null or "interrupted" or "resource-identity-changed" or "version-changed" or "login-required" or "access-denied" or "resource-unavailable" or "transfer-failed" or "state-save-failed" or "existing-content-mismatch")) throw new JsonException();
                Reference(job.ResourceReference); LocalDirectory(job.Destination); ValidatePins(job.FileName, job.Length, job.ETag, job.Sha256);
            }
            return state.Jobs;
        } catch (Exception error) when (error is JsonException or DecoderFallbackException or ArgumentException or InvalidOperationException or NullReferenceException) { throw new TransferException("Queue state is malformed or ambiguous."); }
    }
    private static void NoDuplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object) { var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject()) { if (!names.Add(property.Name)) throw new JsonException(); NoDuplicates(property.Value); }
        } else if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) NoDuplicates(item);
    }
    private static void Exact(JsonElement value, params string[] names)
    { if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(names.Order())) throw new JsonException(); }
    private QueuedTransfer Find(Guid id) => jobs.SingleOrDefault(job => job.JobId == id) ?? throw new TransferException("Unknown queued transfer.");
    private void Healthy() { if (storageFault is not null) throw storageFault; }
    private void EnsureOpen() { ObjectDisposedException.ThrowIf(disposed, this); }
    public async ValueTask DisposeAsync()
    {
        await commands.WaitAsync();
        try { if (disposed) return; try { await DrainAsync(); } finally { disposed = true; processLock.Dispose(); } }
        finally { commands.Release(); }
    }
}
