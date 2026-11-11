using System.Text.Json;
using LedgeTop.Files.Explorer;

internal static class ExplorerRootDisplayNameTests
{
    internal static int Run()
    {
        Require(Resolve("{\"Schema\":2}", true, "explorer-demo") == ExplorerRootDisplayName.Legacy);
        foreach (var alias in new[] { "employee", "portal", "explorer-demo" })
            Require(Resolve("{\"Schema\":3}", false, alias) == ExplorerRootDisplayName.Legacy);
        foreach (var (alias, expected) in new[] {
            ("employee", ExplorerRootDisplayName.Company), ("portal", ExplorerRootDisplayName.Client),
            ("explorer-demo", ExplorerRootDisplayName.Generic), ("another-valid-source", ExplorerRootDisplayName.Generic) }) {
            var profile = JsonSerializer.Serialize(new { Schema = 4, DisplayName = expected });
            Require(Resolve(profile, false, alias) == expected);
            Reject(JsonSerializer.Serialize(new { Schema = 4, DisplayName = expected + " " }), false, alias);
            Reject(JsonSerializer.Serialize(new { Schema = 4, DisplayName = ExplorerRootDisplayName.Legacy }), false, alias);
        }
        Reject(JsonSerializer.Serialize(new { Schema = 4, DisplayName = ExplorerRootDisplayName.Company }), false, "portal");
        Reject(JsonSerializer.Serialize(new { Schema = 4, DisplayName = ExplorerRootDisplayName.Client }), false, "employee");
        Reject(JsonSerializer.Serialize(new { Schema = 4, DisplayName = ExplorerRootDisplayName.Company }), false, "explorer-demo");
        foreach (var schema in new[] { 2, 3, 4 }) {
            Reject("{\"Schema\":" + schema + ",\"DisplayName\":null}", schema == 2, "employee");
            Reject("{\"Schema\":" + schema + ",\"DisplayName\":42}", schema == 2, "employee");
        }
        Reject("{\"Schema\":4}", false, "employee");
        Reject("{\"Schema\":2}", false, "employee");
        Reject("{\"Schema\":3}", true, "explorer-demo");
        Reject("{\"Schema\":5}", false, "employee");
        Reject("{\"Schema\":3,\"DisplayName\":\"LedgeTop Files Preview\"}", false, "employee");
        Reject("{\"Schema\":2,\"DisplayName\":\"LedgeTop Files Preview\"}", true, "explorer-demo");
        Reject("{\"Schema\":4,\"DisplayName\":null,\"DisplayName\":\"LedgeTop Files\"}", false, "explorer-demo");
        Reject("{\"Schema\":4,\"Schema\":3}", false, "employee");
        Reject("{\"Schema\":3,\"Schema\":3}", false, "employee");
        Reject("{\"Schema\":3,\"Owner\":\"one\",\"Owner\":\"two\"}", false, "employee");
        Reject("[]", false, "employee");
        Reject("{\"Schema\":\"4\"}", false, "employee");
        Console.WriteLine("PASS exact schema2/3 legacy omission, schema4 source labels, generic scope labels, null/type/duplicate/unknown/wrong-source refusal; pure policy only.");
        return 0;
    }
    private static string Resolve(string json, bool generated, string alias)
    {
        using var document = JsonDocument.Parse(json);
        return ExplorerRootDisplayName.ResolveProfileJson(document.RootElement, generated, alias);
    }
    private static void Require(bool condition) { if (!condition) throw new IOException("Display-name compatibility failed."); }
    private static void Reject(string json, bool generated, string alias)
    {
        try { _ = Resolve(json, generated, alias); } catch (IOException) { return; }
        throw new IOException("Unowned display metadata was accepted.");
    }
}
