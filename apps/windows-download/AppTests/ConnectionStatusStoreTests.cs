using System.Text.Json;
using LedgeTop.Files;
using LedgeTop.Files.Explorer;

internal static class ConnectionStatusStoreTests
{
    internal static Task Run()
    {
        var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Generated test root required.");
        var dir = Path.Combine(parent, "status-" + Guid.NewGuid().ToString("N"), "connected-explorer-pilot-employee");
        Directory.CreateDirectory(dir); var path = Path.Combine(dir, ConnectionStatusStore.Leaf); var now = DateTimeOffset.UtcNow;
        DiagnosticPathBoundaryTests.Run(parent,'s',ConnectionStatusStore.Leaf,".last-connection-status.write.tmp",(d,owned)=>ConnectionStatusStore.TrySave(d,owned,ExplorerPreviewState.Running,false,now));
        Require(!ConnectionStatusStore.TrySave(dir, () => false, ExplorerPreviewState.Running, false, now), "unowned write must not report success");
        Require(!File.Exists(path), "unowned directory must not receive status");
        var legacy = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, owner = "LedgeTop.Files.ConnectionStatus/1", observedAtUtc = now.AddSeconds(-1).ToString("O"), appVersion = "0.5.16.0", processId = 1, processStartUtcTicks = 1, state = "Running", freshReadOnly = false });
        File.WriteAllBytes(path, legacy);
        Require(ConnectionStatusStore.TrySave(dir, () => true, ExplorerPreviewState.Running, true, now), "owned write must be verified");
        var first = File.ReadAllBytes(path); using (var doc = JsonDocument.Parse(first)) {
            var root = doc.RootElement;
            Require(root.GetProperty("schemaVersion").GetInt32() == 2 && root.GetProperty("state").GetString() == "Running" && root.GetProperty("freshReadOnly").GetBoolean(), "prior status safely upgrades to closed schema 2");
            Require(root.EnumerateObject().Count() == 10 && root.GetProperty("processId").GetInt32() > 0 && root.GetProperty("freshAction").GetString() == "Unknown", "status fields are bounded");
        }
        Require(!ConnectionStatusStore.TrySave(dir, () => true, ExplorerPreviewState.Failed, false, now.AddMinutes(-1)), "stale write must not report success");
        Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(first), "older event cannot overwrite newer observation");
        ConnectionStatusStore.TrySave(dir, () => true, ExplorerPreviewState.NotStarted, false, now.AddSeconds(1));
        Require(JsonDocument.Parse(File.ReadAllBytes(path)).RootElement.GetProperty("state").GetString() == "NotStarted", "newer stop is recorded");
        int checks = 0;
        Require(!ConnectionStatusStore.TrySave(dir, () => ++checks < 3, ExplorerPreviewState.Failed, false, now.AddSeconds(2)), "ownership lost after publication must not report verified");
        Require(JsonDocument.Parse(File.ReadAllBytes(path)).RootElement.GetProperty("state").GetString() == "Failed", "unverified publication can have taken effect");
        var malformed = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllBytes(path))!.AsObject();
        malformed["freshAction"] = "Failed"; malformed["freshActionAtUtc"] = "invalid timestamp";
        var malformedBytes = JsonSerializer.SerializeToUtf8Bytes(malformed); File.WriteAllBytes(path, malformedBytes);
        ConnectionStatusStore.TrySave(dir, () => true, ExplorerPreviewState.Running, false, now.AddMinutes(1));
        Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(malformedBytes), "malformed schema 2 action timestamp remains untouched");
        File.WriteAllText(path, "foreign data");
        Require(!ConnectionStatusStore.TrySave(dir, () => true, ExplorerPreviewState.Running, false, now.AddMinutes(2)), "foreign status must not report success");
        Require(File.ReadAllText(path) == "foreign data", "unknown existing data is retained");
        return Task.CompletedTask;
    }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
}
