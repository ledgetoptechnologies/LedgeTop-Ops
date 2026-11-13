using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;
using System.Reflection;
using System.Text;
using System.Text.Json;

internal static class PreflightRecoveryBoundaryTests
{
    internal static async Task<int> RunAsync()
    {
        var directory = Path.Combine(Path.GetTempPath(), "ltfiles-preflight-boundary-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var journal = Path.Combine(directory, "phase.txt");
        try
        {
            async Task Refuses(Func<Task<int>> action)
            {
                try { await action(); throw new InvalidOperationException("Expected registration refusal."); }
                catch (IOException) { }
            }
            void Intent() => File.WriteAllText(journal, "intent");
            void Restore() => File.WriteAllText(journal, "root-created");
            void Require(string expected) {
                if (File.ReadAllText(journal) != expected) throw new InvalidOperationException("Unexpected durable registration phase.");
            }

            Intent();
            await Refuses(() => OwnedExplorerRootSession.RegisterWithPreflightRecoveryAsync<int>(
                () => Task.FromException<int>(new ShellRegistrationPreflightRefusedException("preflight")), Restore));
            Require("root-created");

            Intent();
            await Refuses(() => OwnedExplorerRootSession.RegisterWithPreflightRecoveryAsync<int>(
                () => Task.FromException<int>(new IOException("broker outcome unknown")), Restore));
            Require("intent");

            Intent();
            await Refuses(() => OwnedExplorerRootSession.RegisterWithPreflightRecoveryAsync<int>(
                () => Task.FromException<int>(new ShellRegistrationPreflightRefusedException("preflight")),
                () => throw new IOException("selector proof lost")));
            Require("intent");

            Intent();
            var value = await OwnedExplorerRootSession.RegisterWithPreflightRecoveryAsync(() => Task.FromResult(42), Restore);
            if (value != 42) throw new InvalidOperationException("Registration result was changed.");
            Require("intent");
            await ActualSessionAsync(directory, "refused");
            await ActualSessionAsync(directory, "unknown");
            await ActualSessionAsync(directory, "proof-lost");
            await ActualSessionAsync(directory, "observed-native");
            Console.WriteLine("Preflight recovery boundary: 4 boundary and 4 persisted-session scenarios passed.");
            return 0;
        }
        finally
        {
            var safeTemp = Path.GetFullPath(Path.GetTempPath());
            var ownedDirectory = Path.GetFullPath(directory);
            if (!ownedDirectory.StartsWith(safeTemp, StringComparison.OrdinalIgnoreCase) ||
                !Path.GetFileName(ownedDirectory).StartsWith("ltfiles-preflight-boundary-", StringComparison.Ordinal))
                throw new IOException("Refusing to clean an unexpected test directory.");
            Directory.Delete(ownedDirectory, recursive: true);
        }
    }

    private static async Task ActualSessionAsync(string directory, string scenarioName)
    {
        var scenario = Path.Combine(directory, scenarioName);
        var explicitRefusal = scenarioName == "refused";
        var proofLost = scenarioName == "proof-lost";
        var observedNative = scenarioName == "observed-native";
        Directory.CreateDirectory(scenario);
        var profileDirectory = Path.Combine(scenario, "profile");
        var root = Path.Combine(scenario, "files");
        using var source = new ExplorerDemoSource(signedIn: true, chunkDelay: TimeSpan.Zero);
        var scope = new ExplorerRootScope(source.Channel, source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), source.PrincipalId);
        var manifest = new ExplorerRootManifest(scope, source.Entries.ToDictionary(e => e.RelativePath.Replace('/', '\\'), e => e.Identity));
        var attemptSeen = false;
        void Hook(string phase)
        {
            if (phase != "native-registration-attempt") return;
            attemptSeen = true;
            if (explicitRefusal || proofLost) throw new ShellRegistrationPreflightRefusedException("synthetic preflight refusal");
            // Construct only a process-local receipt; no OS registration is performed.
            var constructor = typeof(ShellRegistration).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single();
            var owned = (ShellRegistration)constructor.Invoke([root, "synthetic", ExplorerBrandIcon.LegacyResource,
                Encoding.UTF8.GetBytes("synthetic-context"), Guid.Empty, 0L, ExplorerRootDisplayName.ForConnectedAlias(scope.Alias)]);
            if (observedNative) {
                try { owned.VerifyObservedIdentity(new NativeRootObservation(0, 42, true, true, true, 2, 0, 3, 0, 1023, 0), true,
                    () => throw new IOException("synthetic shell metadata failure")); }
                catch (IOException) { }
            }
            throw new ShellRegistrationException("synthetic ambiguous broker outcome", owned, new IOException("uncertain"));
        }
        await using (var session = OwnedExplorerRootSession.CandidateForTest(profileDirectory, root, source, scope, manifest, Hook))
        {
            await session.PrepareFreshConnectedCandidateAsync();
            try { await session.StartReservedCandidateAsync(_ => !proofLost || !attemptSeen); throw new InvalidOperationException("Synthetic registration unexpectedly succeeded."); }
            catch (IOException) { }
            if (!attemptSeen) throw new InvalidOperationException("Registration seam was not reached.");
            AssertPhase(explicitRefusal ? "RootCreated" : "NativeRegisterIntent");
            if (!Directory.Exists(root)) throw new InvalidOperationException("The candidate folder was not retained.");
        }
        void FailAbsence(string phase) { if (phase == "native-absence-check") throw new IOException("synthetic native observation unavailable"); }
        await using (var reopened = OwnedExplorerRootSession.CandidateForTest(profileDirectory, root, source, scope, manifest,
            explicitRefusal ? null : FailAbsence))
        {
            if (reopened.State != ExplorerPreviewState.Failed) throw new InvalidOperationException("Partial receipt did not require attention after restart.");
            if (explicitRefusal) {
                await reopened.RemoveAsync();
                if (reopened.State != ExplorerPreviewState.Removed) throw new InvalidOperationException("Known no-call setup was not removable.");
                AssertPhase("Removed");
            } else {
                try { await reopened.RemoveAsync(); throw new InvalidOperationException("Unknown outcome was removed without observation."); }
                catch (IOException) { }
                AssertPhase("NativeRegisterIntent");
            }
            if (!Directory.Exists(root)) throw new InvalidOperationException("Removal changed the candidate folder.");
        }
        await using (var restarted = OwnedExplorerRootSession.CandidateForTest(profileDirectory, root, source, scope, manifest))
        {
            var expected = explicitRefusal ? ExplorerPreviewState.Removed : ExplorerPreviewState.Failed;
            if (restarted.State != expected) throw new InvalidOperationException("Persisted outcome was not recognized after restart.");
        }
        void AssertPhase(string expected)
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(profileDirectory, "profile.json")));
            if (document.RootElement.GetProperty("Phase").GetString() != expected)
                throw new InvalidOperationException("Unexpected actual profile phase.");
            if (observedNative && document.RootElement.GetProperty("RootFileId").GetInt64() != 42)
                throw new InvalidOperationException("Verified native identity was not persisted for review.");
        }
    }
}
