using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

/// <summary>Explicit native generated-only acceptance. Never normal tests; no default profile or cleanup fallback.</summary>
internal static class GeneratedRemovedAbsenceAcceptance
{
    internal static async Task<int> RunAsync()
    {
        var fixture = Guid.NewGuid().ToString("N");
        var artifactRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "artifacts", "LedgeTop-Files-2026-10-25");
        // Keep the exact existing branding file read-locked through Start/Remove/verification.
        // EnsureResource can read it, but cannot replace/delete it or create a missing shared asset.
        FileStream branding;
        try { CheckOrdinaryAncestors(artifactRoot); branding = OpenExistingBranding(); }
        catch { Console.Error.WriteLine("Owned artifact/approved existing branding precondition unavailable; no native action attempted."); return 1; }
        using var brandingLease = branding;
        var owned = Path.Combine(artifactRoot, "legacy-generated-removal-native-" + fixture);
        Require(!Directory.Exists(owned) && !File.Exists(owned), "fresh-fixture-required");
        Directory.CreateDirectory(owned); CheckOrdinaryAncestors(owned);
        using (var marker = new FileStream(Path.Combine(owned, "fixture-owner.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.None))
            marker.Write(Encoding.UTF8.GetBytes("LedgeTop.GeneratedRemovedAbsenceAcceptance/1\n" + fixture));
        var profileDirectory = Path.Combine(owned, "Profile");
        var root = Path.Combine(owned, "Files");
        var profile = Path.Combine(profileDirectory, "profile.json");
        var phases = new List<string>(); var failures = new List<string>(); var checkpoint = 0;
        ExplorerPreviewSession? active = null; var unregisterRequested = false; var removedConfirmed = false;
        try {
            using var oracle = new ExplorerDemoSource(signedIn: false);
            var expectedCsv = oracle.Entries.Single(entry => entry.RelativePath == "Samples/sample.csv").Identity;
            active = new ExplorerPreviewSession(profileDirectory, root);
            await active.StartAsync();
            Require(active.State == ExplorerPreviewState.Running && active.RootPath == root, "generated-start");
            Require(!active.VerifyRecordedRemovedAbsence(), "ready-is-not-removed");
            phases.Add("generated-registration-population-and-ready-verifier-false"); Save();
            var csv = Path.Combine(root, "Samples", "sample.csv");
            var csvBytes = await File.ReadAllBytesAsync(csv);
            Require(csvBytes.LongLength == expectedCsv.Length && Hash(csvBytes) == expectedCsv.Sha256, "generated-hydration-oracle");
            var note = Path.Combine(root, "Samples", "Nested", "notes.txt");
            _ = await File.ReadAllBytesAsync(note);
            File.SetAttributes(note, File.GetAttributes(note) & ~FileAttributes.ReadOnly);
            var editedBytes = Encoding.UTF8.GetBytes("Generated local modification must survive exact preview removal.\r\n");
            await File.WriteAllBytesAsync(note, editedBytes);
            var sentinel = Path.Combine(root, "local-retained-sentinel.txt");
            var sentinelBytes = Encoding.UTF8.GetBytes("Added generated acceptance sentinel; retain.\r\n");
            using (var local = new FileStream(sentinel, FileMode.CreateNew, FileAccess.Write, FileShare.None)) local.Write(sentinelBytes);
            phases.Add("generated-hydration-modified-and-added-local-content-established"); Save();
            unregisterRequested = true; Save();
            await active.RemoveAsync(); // Exactly one explicit Remove. No catch/finally retries.
            Require(active.State == ExplorerPreviewState.Removed, "owned-remove-confirmed");
            removedConfirmed = true;
            await active.DisposeAsync(); active = null;
            var profileHash = Hash(await File.ReadAllBytesAsync(profile));
            await AssertRetained(root, expectedCsv.Sha256, editedBytes, sentinelBytes);
            await using (var fresh = new ExplorerPreviewSession(profileDirectory, root)) {
                Require(fresh.State == ExplorerPreviewState.Removed, "recorded-removed-reopen");
                Require(fresh.VerifyRecordedRemovedAbsence(), "exact-removed-native-namespace-absence");
                Require(fresh.VerifyRecordedRemovedAbsence(), "repeated-readonly-absence");
            }
            Require(Hash(await File.ReadAllBytesAsync(profile)) == profileHash, "verifier-does-not-rewrite-receipt");
            await AssertRetained(root, expectedCsv.Sha256, editedBytes, sentinelBytes);
            phases.Add("fresh-and-repeated-removed-absence-verified-receipt-and-local-bytes-unchanged"); Save();

        } catch {
            // No exception details: profile/Windows errors can contain SID or unrelated private paths.
            failures.Add("acceptance-failed-in-current-phase; exact fixture retained; no unregister replay");
        } finally {
            if (active is not null) {
                try { await active.DisposeAsync(); }
                catch { failures.Add("provider-disconnect-unconfirmed; retained-for-readonly-reconciliation"); }
            }
            Save();
        }
        Console.WriteLine(JsonSerializer.Serialize(new { fixture, passed = failures.Count == 0, phases, failures,
            unregisterRequested, removedConfirmed, recursiveDeletion = false, unregisterRetried = false }));
        return failures.Count == 0 ? 0 : 1;

        void Save()
        {
            var path = Path.Combine(owned, "checkpoint-" + (++checkpoint).ToString("D2", System.Globalization.CultureInfo.InvariantCulture) + ".json");
            using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            JsonSerializer.Serialize(output, new { schema = "LedgeTop.GeneratedRemovedAbsenceAcceptance/1", fixture,
                utc = DateTimeOffset.UtcNow, phases, failures, unregisterRequested, removedConfirmed }, new JsonSerializerOptions { WriteIndented = true });
        }
    }
    private static async Task AssertRetained(string root, string csvHash, byte[] edited, byte[] sentinel)
    {
        Require(Hash(await File.ReadAllBytesAsync(Path.Combine(root,"Samples","sample.csv"))) == csvHash, "hydrated-csv-retained");
        Require((await File.ReadAllBytesAsync(Path.Combine(root,"Samples","Nested","notes.txt"))).AsSpan().SequenceEqual(edited), "modified-note-retained");
        Require((await File.ReadAllBytesAsync(Path.Combine(root,"local-retained-sentinel.txt"))).AsSpan().SequenceEqual(sentinel), "added-local-file-retained");
    }
    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    private static FileStream OpenExistingBranding()
    {
        var icon = ExplorerBrandIcon.Resource[..^2];
        CheckOrdinaryAncestors(Path.GetDirectoryName(icon)!);
        Require((File.GetAttributes(icon) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "ordinary-branding-required");
        var stream = new FileStream(icon, FileMode.Open, FileAccess.Read, FileShare.Read);
        try {
            Require(stream.Length == 1889 && Convert.ToHexStringLower(SHA256.HashData(stream)) == ExplorerBrandIcon.Digest,
                "approved-existing-branding-required");
            CheckOrdinaryAncestors(Path.GetDirectoryName(icon)!);
            Require((File.GetAttributes(icon) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "ordinary-branding-readback-required");
            return stream;
        } catch { stream.Dispose(); throw; }
    }
    private static void Require(bool condition, string code) { if (!condition) throw new IOException(code); }
    private static void CheckOrdinaryAncestors(string directory)
    {
        for (string? part = directory; part is not null; part = Path.GetDirectoryName(part))
            Require(Directory.Exists(part) && (File.GetAttributes(part) & FileAttributes.ReparsePoint) == 0, "ordinary-existing-directory-required");
    }
}
