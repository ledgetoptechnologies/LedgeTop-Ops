using System.Text.Json;
using LedgeTop.Files.Explorer;

// Intent is evidence for a manual, read-only reconciliation, not ownership proof.
// In particular, a matching context after an ambiguous call never authorizes cleanup.
internal static class SyntheticRegistrationIntent
{
    internal static IPreviewRootRegistration Register(string owned, string root, Guid id, byte[] context, Func<IPreviewRootRegistration> register)
    {
        var path = Path.Combine(owned, "registration-intent.json");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { schema = 1, id, root, context = Convert.ToBase64String(context), operation = "single-native-register-attempt" });
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough)) {
            stream.Write(bytes); stream.Flush(true);
        }
        try { return register(); }
        catch {
            // Observation only. Never adopt, retry, unregister, or delete after ambiguity.
            try { Console.Error.WriteLine("Registration outcome requires reconciliation: " + JsonSerializer.Serialize(NativeRootRegistration.Inspect(root, context))); }
            catch (Exception e) { Console.Error.WriteLine("Registration readback unavailable: " + e.GetType().Name); }
            throw;
        }
    }

    internal static int Tests()
    {
        var owned = Path.Combine(Path.GetTempPath(), "lt-registration-intent-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(owned);
        try {
            var calls = 0; var root = Path.Combine(owned, "Files"); var id = Guid.NewGuid(); var ctx = new byte[] { 1, 2, 3 };
            try { Register(owned, root, id, ctx, () => { calls++; if (!File.Exists(Path.Combine(owned, "registration-intent.json"))) throw new Exception("missing intent"); throw new IOException("ambiguous"); }); }
            catch (IOException) { }
            var record = JsonSerializer.Deserialize<JsonElement>(File.ReadAllBytes(Path.Combine(owned, "registration-intent.json")));
            if (calls != 1 || record.GetProperty("root").GetString() != root || record.GetProperty("id").GetGuid() != id || record.GetProperty("context").GetString() != Convert.ToBase64String(ctx)) throw new Exception("intent mismatch");
            try { Register(owned, root, id, ctx, () => { calls++; throw new Exception("replayed"); }); } catch (IOException) { }
            if (calls != 1) throw new Exception("ambiguous attempt retried");
            Console.WriteLine("PASS durable registration intent and ambiguous no-retry; no native registration performed.");
            return 0;
        } finally { Directory.Delete(owned, true); }
    }
}
