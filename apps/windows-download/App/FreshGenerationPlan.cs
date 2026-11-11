using System.Text.RegularExpressions;

namespace LedgeTop.Files;

// Generation planning and durable removal state. Planning still does not grant access or
// touch roots. Lexical path checks do not prove file-system separation; callers must hold and
// verify actual parent/file identities and make every phase durable under the index lease.
internal static class FreshGenerationPlan
{
    internal const string NewLabel = "LedgeTop Files — Current files";
    internal const string PreviousLabel = "LedgeTop Files — Previous files";
    internal sealed record Scope(string Channel, string Source, string Origin, string Principal);
    internal sealed record Generation(Guid Id, Scope Scope, string ProfileDirectory, string RootPath, string ManifestDigest,
        uint ProfileDirectoryVolume, ulong ProfileDirectoryFileId, long ProfileRevision, uint ProfileDocumentVolume, ulong ProfileDocumentFileId,
        uint RootVolume = 0, ulong RootFileId = 0, Guid NamespaceClsid = default);
    internal sealed record RootEvidence(uint Volume, ulong FileId, Guid NamespaceClsid, long ProfileRevision, uint ProfileDocumentVolume, ulong ProfileDocumentFileId);
    internal sealed record RemovalReceipt(Guid GenerationId, uint ProfileVolume, ulong ProfileFileId, long ProfileRevision);
    internal enum Phase { OldActive, Prepared, OldDrained, NewReady, Published }
    internal enum RemovalPhase { CandidateIntent, CandidateRemoved, PriorIntent, Complete }
    internal sealed record State(Generation Old, Generation? New, Phase Phase, RootEvidence? ReadyRoot = null,
        RemovalPhase? Removal = null, RemovalReceipt? CandidateRemoval = null, RemovalReceipt? PriorRemoval = null);

    internal static State Prepare(State state, Generation candidate, Scope freshlyVerified, bool explicitlyRequested, bool filesystemSeparationVerified)
    {
        Require(explicitlyRequested && filesystemSeparationVerified && state.Phase == Phase.OldActive && state.New is null && state.ReadyRoot is null);
        Validate(state.Old); Validate(candidate);
        Require(state.Old.RootVolume != 0 && state.Old.RootFileId != 0 && state.Old.NamespaceClsid != Guid.Empty &&
            candidate.RootVolume == 0 && candidate.RootFileId == 0 && candidate.NamespaceClsid == Guid.Empty);
        Require(state.Old.Scope == freshlyVerified && candidate.Scope == freshlyVerified && candidate.Id != state.Old.Id);
        Require(Separate(state.Old.RootPath, candidate.RootPath) && Separate(state.Old.ProfileDirectory, candidate.ProfileDirectory));
        Require(Separate(candidate.RootPath, state.Old.ProfileDirectory) && Separate(candidate.RootPath, candidate.ProfileDirectory));
        Require(Separate(state.Old.RootPath, candidate.ProfileDirectory));
        return state with { New = candidate, Phase = Phase.Prepared };
    }
    internal static State Drained(State state, bool exactOldDrainConfirmed)
    {
        Require(state.Phase == Phase.Prepared && state.New is not null && state.ReadyRoot is null && exactOldDrainConfirmed);
        return state with { Phase = Phase.OldDrained };
    }
    internal static State Ready(State state, Scope rechecked, Guid actualGeneration, string actualManifestDigest,
        string actualRoot, RootEvidence root, bool exactOwnedRootReady)
    {
        Require(state.Phase == Phase.OldDrained && state.New is not null && state.ReadyRoot is null && exactOwnedRootReady &&
            root is not null && root.Volume != 0 && root.FileId != 0 && root.NamespaceClsid != Guid.Empty && root.ProfileRevision > 0 &&
            root.ProfileDocumentVolume != 0 && root.ProfileDocumentFileId != 0);
        var next = state.New!;
        Require(next.Scope == rechecked && next.Id == actualGeneration && next.ManifestDigest == actualManifestDigest &&
            SamePath(next.RootPath, actualRoot) && root!.ProfileRevision > next.ProfileRevision &&
            root.ProfileDocumentVolume == next.ProfileDirectoryVolume);
        return state with { Phase = Phase.NewReady, ReadyRoot = root };
    }
    internal static State Publish(State state, bool durableSelectorConfirmed)
    {
        Require(state.Phase == Phase.NewReady && state.New is not null && state.ReadyRoot is not null && durableSelectorConfirmed);
        return state with { Phase = Phase.Published };
    }
    private static void Validate(Generation value)
    {
        Require(value.Id != Guid.Empty && value.ProfileDirectoryVolume != 0 && value.ProfileDirectoryFileId != 0 && value.ProfileRevision > 0 &&
            value.ProfileDocumentVolume == value.ProfileDirectoryVolume && value.ProfileDocumentFileId != 0 && value.Scope is not null && !string.IsNullOrWhiteSpace(value.Scope.Channel) &&
            !string.IsNullOrWhiteSpace(value.Scope.Source) && !string.IsNullOrWhiteSpace(value.Scope.Origin) &&
            !string.IsNullOrWhiteSpace(value.Scope.Principal) && Regex.IsMatch(value.ManifestDigest ?? "", "\\A[0-9a-f]{64}\\z"));
        _ = Canonical(value.RootPath); _ = Canonical(value.ProfileDirectory);
    }
    private static string Canonical(string path)
    {
        Require(!string.IsNullOrWhiteSpace(path) && Path.IsPathFullyQualified(path) && !path.StartsWith("\\\\", StringComparison.Ordinal));
        var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        Require(full.Length > 3 && string.Equals(full, path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase));
        return full;
    }
    private static bool SamePath(string first, string second) => string.Equals(Canonical(first), Canonical(second), StringComparison.OrdinalIgnoreCase);
    private static bool Separate(string first, string second)
    {
        var a = Canonical(first); var b = Canonical(second);
        return !string.Equals(a, b, StringComparison.OrdinalIgnoreCase) &&
            !a.StartsWith(b + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
            !b.StartsWith(a + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
    private static void Require(bool allowed) { if (!allowed) throw new IOException("Fresh connection planning requires verified, distinct owned generations."); }
}
