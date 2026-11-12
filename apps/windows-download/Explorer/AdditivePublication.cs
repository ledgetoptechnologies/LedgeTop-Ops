using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LedgeTop.Files.Explorer;

// A journaled addition is not permission to use a source or mutate a root. A real
// surface must hold the owned-root lease, check source authority and verify native
// placeholder identity/root ownership at every call. No production adapter is supplied.
internal sealed record AdditiveEntry(string Path, bool Directory, string IdentitySha256);
internal sealed record AdditiveRootPins(string WindowsSid, Guid ProfileId, Guid NamespaceId, uint Volume,
    ulong RootFileId, ulong ProfileDirectoryFileId);
// EvidenceSha256 must cover the exact opaque identity, canonical path, root/parent/file
// identities and relevant metadata/pin/range state observed through the held native handle.
internal sealed record AdditivePostimage(uint Volume, ulong ParentFileId, ulong FileId, string EvidenceSha256);
internal sealed record AdditiveAbsenceProof(uint Volume, ulong ParentFileId, string EvidenceSha256);
internal sealed class AdditivePublicationPlan
{
    internal Guid Id { get; }
    internal ExplorerRootManifest Previous { get; }
    internal ExplorerRootManifest Candidate { get; }
    internal IReadOnlyList<AdditiveEntry> Entries { get; }
    internal string Digest { get; }
    internal AdditiveRootPins Root { get; }
    internal AdditivePublicationPlan(Guid id, AdditiveRootPins root, ExplorerRootManifest previous, ExplorerRootManifest candidate)
    {
        if (id == Guid.Empty || root is null || string.IsNullOrWhiteSpace(root.WindowsSid) || root.ProfileId == Guid.Empty ||
            root.NamespaceId == Guid.Empty || root.Volume == 0 || root.RootFileId == 0 || root.ProfileDirectoryFileId == 0 ||
            previous.Scope != candidate.Scope || previous.Digest == candidate.Digest ||
            previous.Files.Any(pair => !candidate.Files.TryGetValue(pair.Key, out var next) || next != pair.Value ||
                !candidate.Files.Keys.Contains(pair.Key, StringComparer.Ordinal)) ||
            previous.Directories.Any(path => !candidate.Directories.Contains(path, StringComparer.Ordinal)))
            throw new IOException("The candidate is not a strict additive inventory.");
        var directories = candidate.Directories.Except(previous.Directories, StringComparer.OrdinalIgnoreCase)
            .OrderBy(path => path.Count(c => c == '\\')).ThenBy(path => path, StringComparer.Ordinal)
            .Select(path => new AdditiveEntry(path, true, Hash(Encoding.UTF8.GetBytes("LedgeTop.Files.Preview.Directory.v1:" + path))));
        var files = candidate.Files.Where(pair => !previous.Files.ContainsKey(pair.Key)).OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => new AdditiveEntry(pair.Key, false, Hash(pair.Value.Encode())));
        var entries = directories.Concat(files).ToArray();
        if (entries.Length is < 1 or > 1000) throw new IOException("The additive inventory is empty or too large.");
        Id = id; Root = root; Previous = previous; Candidate = candidate; Entries = Array.AsReadOnly(entries);
        Digest = Hash(JsonSerializer.SerializeToUtf8Bytes(new { id, root, old = previous.Digest, candidate = candidate.Digest, entries }));
    }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}

internal enum AdditiveRecordKind { Prepared, CreateIntent, Created, CommitIntent, Committed }
internal sealed record AdditiveRecord(int Sequence, Guid Transaction, string PlanDigest, AdditiveRecordKind Kind,
    int? Entry = null, AdditiveAbsenceProof? IntentProof = null, AdditivePostimage? Postimage = null);
internal sealed record AdditiveJournalHead(int Count, string Sha256);

// One create-only file per record. Torn writes remain visible and are rejected on
// restart, never treated as permission to retry. Caller must hold the profile lease.
internal sealed class AdditiveDiskJournal : IDisposable
{
    private readonly string directory; private readonly Guid id;
    private readonly CandidateDirectoryFence fence;
    private readonly CandidateDirectoryFence.DirectoryIdentity directoryIdentity;
    internal AdditiveDiskJournal(string directory, Guid id)
    {
        if (id == Guid.Empty || !Path.IsPathFullyQualified(directory)) throw new IOException("Journal identity is invalid.");
        this.directory = Path.GetFullPath(directory); this.id = id;
        var held = new CandidateDirectoryFence();
        try { held.HoldAncestors(this.directory); directoryIdentity = held.Recheck(this.directory); fence = held; }
        catch { held.Dispose(); throw; }
    }
    private string FileFor(int sequence) => Path.Combine(directory, $"addition-{id:N}-{sequence:D5}.json");
    private void CheckDirectory()
    {
        if (fence.Recheck(directory) != directoryIdentity) throw new IOException("Journal directory identity changed.");
        var current = new DirectoryInfo(directory);
        while (current is not null) {
            if (!current.Exists || (current.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Journal directory is unavailable or aliased.");
            current = current.Parent;
        }
    }
    internal IReadOnlyList<AdditiveRecord> Read()
    {
        CheckDirectory(); var prefix = $"addition-{id:N}-";
        var files = Directory.EnumerateFiles(directory, prefix + "*.json").Take(2004).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray();
        if (files.Length > 2003) throw new IOException("Journal is too large.");
        var records = new List<AdditiveRecord>();
        for (var i = 0; i < files.Length; i++) {
            if (files[i] != Path.GetFileName(FileFor(i + 1))) throw new IOException("Journal sequence is incomplete.");
            var path = FileFor(i + 1); var info = new FileInfo(path);
            if (!info.Exists || info.Length is < 1 or > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Journal record is unavailable.");
            byte[] bytes;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                var identity = CandidateDirectoryFence.IdentifyFile(stream.SafeFileHandle, path);
                if (stream.Length != info.Length) throw new IOException("Journal record changed.");
                bytes = new byte[stream.Length]; stream.ReadExactly(bytes);
                if (CandidateDirectoryFence.IdentifyFile(stream.SafeFileHandle, path) != identity) throw new IOException("Journal record identity changed.");
            }
            AdditiveRecord? record;
            try { record = JsonSerializer.Deserialize<AdditiveRecord>(bytes); } catch (JsonException error) { throw new IOException("Journal record is invalid.", error); }
            if (record is null || !JsonSerializer.SerializeToUtf8Bytes(record).AsSpan().SequenceEqual(bytes)) throw new IOException("Journal record is invalid.");
            records.Add(record);
        }
        return records.AsReadOnly();
    }
    internal void Append(AdditiveRecord record)
    {
        CheckDirectory();
        if (record.Transaction != id || record.Sequence < 1 || record.Sequence > 2003) throw new IOException("Journal record identity is invalid.");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(record);
        var path = FileFor(record.Sequence);
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
            var identity = CandidateDirectoryFence.IdentifyFile(stream.SafeFileHandle, path);
            stream.Write(bytes); stream.Flush(flushToDisk: true);
            if (CandidateDirectoryFence.IdentifyFile(stream.SafeFileHandle, path) != identity) throw new IOException("Journal record identity changed.");
        }
        CheckDirectory();
    }
    public void Dispose() => fence.Dispose();
}

internal enum AdditiveObservation { Absent, ExactOwned, Conflict }
internal sealed record AdditiveInspection(AdditiveObservation Observation, AdditivePostimage? Postimage, AdditiveAbsenceProof? Absence);
internal interface IAdditivePublicationSurface
{
    // Validates existing root/profile lease and retained exact old/new manifest bytes.
    Task VerifyOwnershipAndManifestsAsync(AdditivePublicationPlan plan, CancellationToken token);
    // An independent, crash-durable acknowledged head must match the exact record sequence.
    // A real adapter must hold the owned profile lease and reject missing or extra tails.
    Task VerifyJournalHeadAsync(AdditivePublicationPlan plan, AdditiveJournalHead expected, CancellationToken token);
    Task AcknowledgeJournalHeadAsync(AdditivePublicationPlan plan, AdditiveJournalHead expected, CancellationToken token);
    Task VerifyFreshAuthorityAsync(AdditivePublicationPlan plan, AdditiveEntry? entry, CancellationToken token);
    // ExactOwned requires same-handle root, parent, file and opaque-identity inspection.
    Task<AdditiveInspection> InspectAsync(AdditivePublicationPlan plan, AdditiveEntry entry, CancellationToken token);
    // Must recheck root, parent identity and fresh authority at the actual side effect;
    // create-if-absent only: existing local data is never overwritten.
    Task CreateIfAbsentAsync(AdditivePublicationPlan plan, AdditiveEntry entry, AdditiveAbsenceProof expectedParent, CancellationToken token);
    Task<string> ReadBindingDigestAsync(CancellationToken token);
    // Returned lease must hold authorization and local root/entry fences through binding commit.
    Task<IAsyncDisposable> AcquireCommitFenceAsync(AdditivePublicationPlan plan, CancellationToken token);
    Task<bool> CompareExchangeBindingAsync(AdditivePublicationPlan plan, CancellationToken token);
}

// No production entrypoint. This coordinator deliberately leaves every uncertain
// write on disk for inspection; callers must never auto-delete a pending journal.
internal sealed class AdditivePublication(AdditiveDiskJournal journal, IAdditivePublicationSurface surface)
{
    internal async Task<bool> ExecuteAsync(AdditivePublicationPlan plan, CancellationToken token = default)
    {
        var records = journal.Read().ToList(); var stages = Validate(plan, records);
        // An interrupted create has no durable causal postimage. Neither absence nor
        // a matching-looking placeholder proves what happened: preserve and hold.
        if (stages.Any(stage => stage == 1)) throw new IOException("An interrupted addition needs manual ownership review.");
        await surface.VerifyOwnershipAndManifestsAsync(plan, token);
        await surface.VerifyJournalHeadAsync(plan, Head(plan, records), token);
        var binding = await surface.ReadBindingDigestAsync(token);
        if (binding != plan.Previous.Digest && binding != plan.Candidate.Digest) throw new IOException("Profile binding changed.");
        if (binding == plan.Candidate.Digest && !records.Any(record => record.Kind == AdditiveRecordKind.CommitIntent) ||
            binding == plan.Previous.Digest && records.Any(record => record.Kind == AdditiveRecordKind.Committed))
            throw new IOException("Profile binding is inconsistent with the journal.");
        if (records.Count == 0) await Append(AdditiveRecordKind.Prepared);
        for (var index = 0; index < stages.Length; index++) {
            var entry = plan.Entries[index];
            await surface.VerifyFreshAuthorityAsync(plan, entry, token);
            await surface.VerifyOwnershipAndManifestsAsync(plan, token);
            var actual = await surface.InspectAsync(plan, entry, token);
            if (stages[index] == 0) {
                if (binding != plan.Previous.Digest || actual.Observation != AdditiveObservation.Absent || actual.Postimage is not null ||
                    !Valid(actual.Absence) || actual.Absence!.Volume != plan.Root.Volume)
                    throw new IOException("An addition conflicts with local data.");
                var parent = actual.Absence;
                await Append(AdditiveRecordKind.CreateIntent, index, parent);
                await surface.VerifyFreshAuthorityAsync(plan, entry, token);
                await surface.CreateIfAbsentAsync(plan, entry, parent!, token);
                actual = await surface.InspectAsync(plan, entry, token);
                if (actual.Observation != AdditiveObservation.ExactOwned || actual.Absence is not null || !Valid(actual.Postimage) ||
                    actual.Postimage!.Volume != parent!.Volume || actual.Postimage.ParentFileId != parent.ParentFileId)
                    throw new IOException("Addition postimage is unavailable or its parent changed.");
                await Append(AdditiveRecordKind.Created, index, postimage: actual.Postimage); stages[index] = 2;
            } else {
                var recorded = records.Single(record => record.Kind == AdditiveRecordKind.Created && record.Entry == index).Postimage;
                if (actual.Observation != AdditiveObservation.ExactOwned || actual.Absence is not null || actual.Postimage != recorded)
                    throw new IOException("An addition changed since its recorded postimage.");
            }
        }
        // Recheck every earlier postimage and each grant immediately before the
        // commit fence. A real surface must hold the necessary lease/fence throughout.
        for (var index = 0; index < stages.Length; index++) {
            await surface.VerifyFreshAuthorityAsync(plan, plan.Entries[index], token);
            var actual = await surface.InspectAsync(plan, plan.Entries[index], token);
            var recorded = records.Single(record => record.Kind == AdditiveRecordKind.Created && record.Entry == index).Postimage;
            if (actual.Observation != AdditiveObservation.ExactOwned || actual.Absence is not null || actual.Postimage != recorded)
                throw new IOException("An addition changed before commit.");
        }
        await surface.VerifyOwnershipAndManifestsAsync(plan, token);
        if (!records.Any(record => record.Kind == AdditiveRecordKind.CommitIntent)) await Append(AdditiveRecordKind.CommitIntent);
        binding = await surface.ReadBindingDigestAsync(token);
        if (binding == plan.Previous.Digest) {
            await using var commitFence = await surface.AcquireCommitFenceAsync(plan, token) ?? throw new IOException("The commit fence is unavailable.");
            await surface.VerifyOwnershipAndManifestsAsync(plan, token);
            for (var index = 0; index < stages.Length; index++) {
                await surface.VerifyFreshAuthorityAsync(plan, plan.Entries[index], token);
                var actual = await surface.InspectAsync(plan, plan.Entries[index], token);
                var recorded = records.Single(record => record.Kind == AdditiveRecordKind.Created && record.Entry == index).Postimage;
                if (actual.Observation != AdditiveObservation.ExactOwned || actual.Absence is not null || actual.Postimage != recorded)
                    throw new IOException("An addition changed under the commit fence.");
            }
            if (!await surface.CompareExchangeBindingAsync(plan, token)) throw new IOException("Profile binding changed before commit.");
        } else if (binding != plan.Candidate.Digest) throw new IOException("Profile binding changed.");
        if (await surface.ReadBindingDigestAsync(token) != plan.Candidate.Digest) throw new IOException("Profile binding commit could not be verified.");
        if (!records.Any(record => record.Kind == AdditiveRecordKind.Committed)) await Append(AdditiveRecordKind.Committed);
        return true;

        async Task Append(AdditiveRecordKind kind, int? entry = null, AdditiveAbsenceProof? parent = null, AdditivePostimage? postimage = null) {
            var record = new AdditiveRecord(records.Count + 1, plan.Id, plan.Digest, kind, entry, parent, postimage);
            journal.Append(record); records.Add(record);
            await surface.AcknowledgeJournalHeadAsync(plan, Head(plan, records), token);
        }
    }
    private static int[] Validate(AdditivePublicationPlan plan, IReadOnlyList<AdditiveRecord> records)
    {
        var stages = new int[plan.Entries.Count]; var parents = new AdditiveAbsenceProof?[stages.Length]; var commit = false; var finished = false;
        for (var i = 0; i < records.Count; i++) {
            var record = records[i];
            if (record.Sequence != i + 1 || record.Transaction != plan.Id || record.PlanDigest != plan.Digest || finished) throw new IOException("Journal identity or sequence changed.");
            if (i == 0) { if (record.Kind != AdditiveRecordKind.Prepared || record.Entry is not null || record.IntentProof is not null || record.Postimage is not null) throw new IOException("Journal has no preparation."); continue; }
            switch (record.Kind) {
                case AdditiveRecordKind.CreateIntent when !commit && record.Postimage is null && Valid(record.IntentProof) && record.IntentProof!.Volume == plan.Root.Volume && record.Entry is int intent && intent >= 0 && intent < stages.Length && stages[intent] == 0 && stages.Take(intent).All(stage => stage == 2): stages[intent] = 1; parents[intent] = record.IntentProof; break;
                case AdditiveRecordKind.Created when !commit && record.IntentProof is null && Valid(record.Postimage) && record.Entry is int created && created >= 0 && created < stages.Length && stages[created] == 1 && record.Postimage!.Volume == parents[created]!.Volume && record.Postimage.ParentFileId == parents[created]!.ParentFileId: stages[created] = 2; break;
                case AdditiveRecordKind.CommitIntent when !commit && record.Entry is null && record.IntentProof is null && record.Postimage is null && stages.All(stage => stage == 2): commit = true; break;
                case AdditiveRecordKind.Committed when commit && record.Entry is null && record.IntentProof is null && record.Postimage is null: finished = true; break;
                default: throw new IOException("Journal transition is invalid.");
            }
        }
        return stages;
    }
    private static AdditiveJournalHead Head(AdditivePublicationPlan plan, IReadOnlyList<AdditiveRecord> records) => new(records.Count,
        Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { plan.Digest, Records = records }))));
    private static bool Valid(AdditiveAbsenceProof? proof) => proof is { Volume: > 0, ParentFileId: > 0 } &&
        System.Text.RegularExpressions.Regex.IsMatch(proof.EvidenceSha256 ?? "", "\\A[a-f0-9]{64}\\z");
    private static bool Valid(AdditivePostimage? postimage) => postimage is { Volume: > 0, ParentFileId: > 0, FileId: > 0 } &&
        System.Text.RegularExpressions.Regex.IsMatch(postimage.EvidenceSha256 ?? "", "\\A[a-f0-9]{64}\\z");
}
