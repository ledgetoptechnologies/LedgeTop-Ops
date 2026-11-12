using System.Text.Json;
using System.Reflection;
using System.Text;
using LedgeTop.Files.Explorer;

internal static class ShellAttemptEvidenceTests
{
    internal static int Run()
    {
        var directory = Path.Combine(Path.GetTempPath(), "LedgeTopShellEvidence-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var intentPath = Path.Combine(directory, "shell-intent.json");
        var partialPath = Path.Combine(directory, "shell-partial.json");
        try {
            var id = Guid.NewGuid(); var shellId = "synthetic-shell-id";
            ShellAttemptEvidence.WriteNew(intentPath, new ShellAttemptEvidence.Intent(id, "synthetic-root", shellId, "synthetic-icon", "synthetic-label", "Y29udGV4dA=="));
            var original = File.ReadAllBytes(intentPath);
            using (var parsed = JsonDocument.Parse(original)) {
                Require(parsed.RootElement.GetProperty("PreviewId").GetGuid() == id);
                Require(parsed.RootElement.GetProperty("ShellId").GetString() == shellId);
                Require(parsed.RootElement.GetProperty("ContextBase64").GetString() == "Y29udGV4dA==");
            }
            var collision = false;
            try { ShellAttemptEvidence.WriteNew(intentPath, new { Other = "replacement" }); }
            catch (IOException) { collision = true; }
            Require(collision && File.ReadAllBytes(intentPath).AsSpan().SequenceEqual(original));
            ShellAttemptEvidence.WriteNew(partialPath, new ShellAttemptEvidence.Partial(id, "synthetic-root", shellId, "synthetic-icon", "synthetic-label", 0, Guid.Empty));
            using (var parsed = JsonDocument.Parse(File.ReadAllBytes(partialPath))) {
                Require(parsed.RootElement.GetProperty("RootFileId").GetInt64() == 0);
                Require(parsed.RootElement.GetProperty("NamespaceClsid").GetGuid() == Guid.Empty);
                Require(!parsed.RootElement.GetProperty("OwnershipVerified").GetBoolean());
            }
            // The Program catch/finally uses this same state object. Inject the actual typed
            // partial exception without a broker call, including a failed evidence write.
            var constructor = typeof(ShellRegistration).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single();
            var receipt = (ShellRegistration)constructor.Invoke(["synthetic-root", shellId, "synthetic-icon", Encoding.UTF8.GetBytes("synthetic-context"), Guid.Empty, 0L, "synthetic-label"]);
            var failure = new ShellRegistrationException("synthetic partial", receipt, new IOException("broker uncertain"));
            foreach (var failWrite in new[] { false, true }) {
                var retention = new ShellPartialRetention(); var evidenceAttempts = 0; var reported = 0; var removed = 0;
                Require(retention.Capture(failure, observed => {
                    evidenceAttempts++; Require(ReferenceEquals(observed, receipt));
                    if (failWrite) throw new IOException("synthetic evidence failure");
                }, _ => reported++));
                // Simulate a later successful provider drain and closed observer: neither can
                // authorize unregister of an uncertain partial result.
                if (retention.CanUnregister(disconnected: true, observerConfirmed: true)) removed++;
                Require(retention.Partial && ReferenceEquals(retention.Registration, receipt) && evidenceAttempts == 1 &&
                    reported == (failWrite ? 1 : 0) && removed == 0);
            }
            var ordinary = new ShellPartialRetention();
            Require(!ordinary.Capture(new IOException("ordinary"), _ => throw new IOException(), _ => throw new IOException()) &&
                !ordinary.Partial && ordinary.Registration is null && ordinary.CanUnregister(true, true) &&
                !ordinary.CanUnregister(false, true) && !ordinary.CanUnregister(true, false));
            Console.WriteLine("PASS shell attempt evidence is create-only and retains unknown partial identities; no shell registration.");
            return 0;
        } finally {
            if (File.Exists(intentPath)) File.Delete(intentPath);
            if (File.Exists(partialPath)) File.Delete(partialPath);
            Directory.Delete(directory);
        }
    }
    private static void Require(bool value) { if (!value) throw new IOException("Shell attempt evidence test failed."); }
}
