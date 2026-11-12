using System.Text.Json;

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
