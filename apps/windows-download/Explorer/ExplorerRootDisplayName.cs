namespace LedgeTop.Files.Explorer;

/// <summary>Exact persisted display metadata, never source admission or ownership evidence by itself.</summary>
internal static class ExplorerRootDisplayName
{
    internal const string Legacy = "LedgeTop Files Preview";
    internal const string Generic = "LedgeTop Files";
    internal const string Company = "LedgeTop Files — Company files";
    internal const string Client = "LedgeTop Files — Client deliveries";

    internal static string ForConnectedAlias(string alias) => alias switch {
        "employee" => Company,
        "portal" => Client,
        _ => Generic // Existing valid generic scopes retain their separate authority checks.
    };

    internal static string ResolveProfile(bool generated, int schema, string alias, bool hasDisplayName, string? displayName)
    {
        if (generated) {
            if (schema != 2 || hasDisplayName) throw new IOException("Generated preview display metadata is invalid.");
            return Legacy;
        }
        if (schema == 3) {
            if (hasDisplayName) throw new IOException("Legacy connected display metadata is invalid.");
            return Legacy;
        }
        if (schema != 4 || !hasDisplayName || displayName != ForConnectedAlias(alias))
            throw new IOException("Connected display metadata differs from its source and schema.");
        return displayName;
    }

    internal static string ResolveProfileJson(System.Text.Json.JsonElement profile, bool generated, string alias)
    {
        if (profile.ValueKind != System.Text.Json.JsonValueKind.Object) throw new IOException("Explorer profile must be an object.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in profile.EnumerateObject())
            if (!names.Add(property.Name)) throw new IOException("Duplicate Explorer profile fields are invalid.");
        if (!profile.TryGetProperty("Schema", out var schema) || schema.ValueKind != System.Text.Json.JsonValueKind.Number ||
            !schema.TryGetInt32(out var number)) throw new IOException("Explorer display schema is invalid.");
        var labels = profile.EnumerateObject().Where(property => property.Name == "DisplayName").ToArray();
        if (labels.Length > 1 || labels.Length == 1 && labels[0].Value.ValueKind != System.Text.Json.JsonValueKind.String)
            throw new IOException("Explorer display metadata must be one explicit string or an admitted legacy omission.");
        return ResolveProfile(generated, number, alias, labels.Length == 1, labels.Length == 1 ? labels[0].Value.GetString() : null);
    }

    internal static void ValidateRegistration(string displayName)
    {
        if (displayName is not (Legacy or Generic or Company or Client))
            throw new ArgumentException("An exact supported Explorer display name is required.", nameof(displayName));
    }
}
