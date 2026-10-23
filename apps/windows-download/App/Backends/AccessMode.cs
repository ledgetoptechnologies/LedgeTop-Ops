namespace LedgeTop.Files.Backends;

/// <summary>One explicit audience per running backend; selecting one never authenticates the other.</summary>
public enum AccessMode { Client, Employee }

internal static class AccessModes
{
    internal static void Validate(AccessMode mode) {
        if (mode is not (AccessMode.Client or AccessMode.Employee))
            throw new ArgumentOutOfRangeException(nameof(mode), "Choose client or employee access.");
    }
    internal static string Alias(AccessMode mode) => mode == AccessMode.Client ? "portal" : "employee";
}
