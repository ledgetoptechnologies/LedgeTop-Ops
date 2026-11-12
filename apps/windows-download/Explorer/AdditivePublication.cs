using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LedgeTop.Files.Explorer;

// A journaled addition is not permission to use a source or mutate a root. A real
// surface must hold the owned-root lease, check source authority and verify native
// placeholder identity/root ownership at every call. No production adapter is supplied.
internal sealed record AdditiveEntry(string Path, bool Directory, string IdentitySha256);
internal sealed class AdditivePublicationPlan
{
    internal Guid Id { get; }
    internal ExplorerRootManifest Previous { get; }
    internal ExplorerRootManifest Candidate { get; }
    internal IReadOnlyList<AdditiveEntry> Entries { get; }
    internal string Digest { get; }
    internal AdditivePublicationPlan(Guid id, ExplorerRootManifest previous, ExplorerRootManifest candidate)
    {
        if (id == Guid.Empty || previous.Scope != candidate.Scope || previous.Digest == candidate.Digest ||
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
        Id = id; Previous = previous; Candidate = candidate; Entries = Array.AsReadOnly(entries);
        Digest = Hash(JsonSerializer.SerializeToUtf8Bytes(new { id, old = previous.Digest, candidate = candidate.Digest, entries }));
    }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}

internal enum AdditiveRecordKind { Prepared, CreateIntent, Created, CommitIntent, Committed }
internal sealed record AdditiveRecord(int Sequence, Guid Transaction, string PlanDigest, AdditiveRecordKind Kind, int? Entry = null);

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
        var files = Directory.EnumerateFiles(directory, prefix + "*.json").Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray();
        if (files.Length > 2003) throw new IOException("Journal is too large.");
        var records = new List<AdditiveRecord>();
        for (var i = 0; i < files.Length; i++) {
            if (files[i] != Path.GetFileName(FileFor(i + 1))) throw new IOException("Journal sequence is incomplete.");
            var path = FileFor(i + 1); var info = new FileInfo(path);
            if (!info.Exists || info.Length is < 1 or > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Journal record is unavailable.");
            var identity = CandidateDirectoryFence.ObserveFile(path); byte[] bytes;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                if (stream.Length != info.Length) throw new IOException("Journal record changed.");
                bytes = new byte[stream.Length]; stream.ReadExactly(bytes);
                if (CandidateDirectoryFence.ObserveFile(path) != identity) throw new IOException("Journal record identity changed.");
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
            stream.Write(bytes); stream.Flush(flushToDisk: true);
        }
        _ = CandidateDirectoryFence.ObserveFile(path); CheckDirectory();
    }
    public void Dispose() => fence.Dispose();
}

internal enum AdditiveObservation { Absent, ExactOwned, Conflict }
internal interface IAdditivePublicationSurface
{
    // Validates existing root/profile lease and retained exact old/new manifest bytes.
    Task VerifyOwnershipAndManifestsAsync(AdditivePublicationPlan plan, CancellationToken token);
    Task VerifyFreshAuthorityAsync(AdditivePublicationPlan plan, AdditiveEntry? entry, CancellationToken token);
    Task<AdditiveObservation> InspectAsync(AdditivePublicationPlan plan, AdditiveEntry entry, CancellationToken token);
    // Must be create-if-absent; existing local data and unknown cloud entries are never overwritten.
    Task CreateIfAbsentAsync(AdditivePublicationPlan plan, AdditiveEntry entry, CancellationToken token);
    Task<string> ReadBindingDigestAsync(CancellationToken token);
    Task<bool> CompareExchangeBindingAsync(AdditivePublicationPlan plan, CancellationToken token);
}

// No production entrypoint. This coordinator deliberately leaves every uncertain
// write on disk for inspection; callers must never auto-delete a pending journal.
internal sealed class AdditivePublication(AdditiveDiskJournal journal, IAdditivePublicationSurface surface)
{
    internal async Task<bool> ExecuteAsync(AdditivePublicationPlan plan, CancellationToken token = default)
    {
        var records = journal.Read().ToList(); var stages = Validate(plan, records);
        await surface.VerifyOwnershipAndManifestsAsync(plan, token);
        var binding = await surface.ReadBindingDigestAsync(token);
        if (binding != plan.Previous.Digest && binding != plan.Candidate.Digest) throw new IOException("Profile binding changed.");
        if (binding == plan.Candidate.Digest && !records.Any(record => record.Kind == AdditiveRecordKind.CommitIntent) ||
            binding == plan.Previous.Digest && records.Any(record => record.Kind == AdditiveRecordKind.Committed))
            throw new IOException("Profile binding is inconsistent with the journal.");
        if (records.Count == 0) Append(AdditiveRecordKind.Prepared);
        for (var index = 0; index < stages.Length; index++) {
            var entry = plan.Entries[index];
            await surface.VerifyFreshAuthorityAsync(plan, entry, token);
            await surface.VerifyOwnershipAndManifestsAsync(plan, token);
            if (stages[index] == 0) { if (binding != plan.Previous.Digest) throw new IOException("Binding advanced before additions."); Append(AdditiveRecordKind.CreateIntent, index); stages[index] = 1; }
            var actual = await surface.InspectAsync(plan, entry, token);
            if (actual == AdditiveObservation.Absent && stages[index] == 1) {
                await surface.VerifyFreshAuthorityAsync(plan, entry, token);
                await surface.CreateIfAbsentAsync(plan, entry, token);
                actual = await surface.InspectAsync(plan, entry, token);
            }
            if (actual != AdditiveObservation.ExactOwned) throw new IOException("An addition is missing or conflicts with local data.");
            if (stages[index] == 1) { Append(AdditiveRecordKind.Created, index); stages[index] = 2; }
        }
        await surface.VerifyFreshAuthorityAsync(plan, null, token);
        await surface.VerifyOwnershipAndManifestsAsync(plan, token);
        if (!records.Any(record => record.Kind == AdditiveRecordKind.CommitIntent)) Append(AdditiveRecordKind.CommitIntent);
        binding = await surface.ReadBindingDigestAsync(token);
        if (binding == plan.Previous.Digest) {
            await surface.VerifyFreshAuthorityAsync(plan, null, token);
            if (!await surface.CompareExchangeBindingAsync(plan, token)) throw new IOException("Profile binding changed before commit.");
        } else if (binding != plan.Candidate.Digest) throw new IOException("Profile binding changed.");
        if (await surface.ReadBindingDigestAsync(token) != plan.Candidate.Digest) throw new IOException("Profile binding commit could not be verified.");
        if (!records.Any(record => record.Kind == AdditiveRecordKind.Committed)) Append(AdditiveRecordKind.Committed);
        return true;

        void Append(AdditiveRecordKind kind, int? entry = null) {
            var record = new AdditiveRecord(records.Count + 1, plan.Id, plan.Digest, kind, entry);
            journal.Append(record); records.Add(record);
        }
    }
    private static int[] Validate(AdditivePublicationPlan plan, IReadOnlyList<AdditiveRecord> records)
    {
        var stages = new int[plan.Entries.Count]; var commit = false; var finished = false;
        for (var i = 0; i < records.Count; i++) {
            var record = records[i];
            if (record.Sequence != i + 1 || record.Transaction != plan.Id || record.PlanDigest != plan.Digest || finished) throw new IOException("Journal identity or sequence changed.");
            if (i == 0) { if (record.Kind != AdditiveRecordKind.Prepared || record.Entry is not null) throw new IOException("Journal has no preparation."); continue; }
            switch (record.Kind) {
                case AdditiveRecordKind.CreateIntent when !commit && record.Entry is int intent && intent >= 0 && intent < stages.Length && stages[intent] == 0 && stages.Take(intent).All(stage => stage == 2): stages[intent] = 1; break;
                case AdditiveRecordKind.Created when !commit && record.Entry is int created && created >= 0 && created < stages.Length && stages[created] == 1: stages[created] = 2; break;
                case AdditiveRecordKind.CommitIntent when !commit && record.Entry is null && stages.All(stage => stage == 2): commit = true; break;
                case AdditiveRecordKind.Committed when commit && record.Entry is null: finished = true; break;
                default: throw new IOException("Journal transition is invalid.");
            }
        }
        return stages;
    }
}
