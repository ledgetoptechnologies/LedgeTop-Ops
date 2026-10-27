using Microsoft.Win32;

namespace LedgeTop.Files.Explorer;

/// <summary>Read-only exact evidence for supported WinRT brokered registration; never writes registry data.
/// https://learn.microsoft.com/en-us/windows/win32/shell/integrate-cloud-storage </summary>
internal static class ShellMetadata
{
    private const string MachineParent = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager\";
    private const string ClassParent = @"Software\Classes\CLSID\";
    private const string NamespaceParent = @"Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\";
    private const string HiddenParent = @"Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel";
    internal sealed record Evidence(Guid NamespaceClsid);

    internal static Evidence? Read(string id, string sid, string root, string icon, Guid pinnedNamespace, bool allowMissingLinks, string displayName)
    {
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var metadata = machine.OpenSubKey(MachineParent + id, false);
        if (metadata is null) return null;
        RequireString(metadata, "DisplayNameResource", displayName);
        RequireString(metadata, "IconResource", icon, ignoreCase: true);
        if (HasValue(metadata, "Version")) RequireString(metadata, "Version", NativeRootRegistration.ProviderVersion);
        // Observed broker output for this exact pinning/grouping configuration; unknown shapes fail closed.
        if (!HasValue(metadata, "Flags") || metadata.GetValueKind("Flags") != RegistryValueKind.DWord ||
            metadata.GetValue("Flags") is not int flags || flags != 34)
            throw new IOException("The brokered shell pinning/grouping flags differ from this preview.");
        using var roots = metadata.OpenSubKey("UserSyncRoots", false) ?? throw new IOException("The exact shell user-root mapping is missing.");
        if (!roots.GetValueNames().SequenceEqual([sid], StringComparer.OrdinalIgnoreCase))
            throw new IOException("The shell ID contains an unexpected user-root mapping.");
        RequireString(roots, sid, root, ignoreCase: true);
        if (!HasValue(metadata, "NamespaceCLSID") || metadata.GetValueKind("NamespaceCLSID") != RegistryValueKind.String ||
            metadata.GetValue("NamespaceCLSID") is not string text || !Guid.TryParse(text, out var ns) || ns == Guid.Empty ||
            pinnedNamespace != Guid.Empty && pinnedNamespace != ns)
            throw new IOException("The brokered namespace identity differs from its ownership receipt.");
        var name = ns.ToString("B").ToUpperInvariant();
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var clsid = user.OpenSubKey(ClassParent + name, false);
        using var bag = user.OpenSubKey(ClassParent + name + @"\Instance\InitPropertyBag", false);
        using var entry = user.OpenSubKey(NamespaceParent + name, false);
        // Before binding a generated namespace GUID, its exact target must be positively observed.
        var partialAllowed = allowMissingLinks && pinnedNamespace != Guid.Empty;
        if (bag is null)
        {
            if (clsid is not null || !partialAllowed) throw new IOException("The owned shell namespace target is missing.");
        }
        else RequireString(bag, "TargetFolderPath", root, ignoreCase: true);
        if (entry is null && !partialAllowed) throw new IOException("The owned desktop namespace entry is missing.");
        return new(ns);
    }

    internal static bool LinkedEntriesAbsent(Guid ns)
    {
        if (ns == Guid.Empty) return false;
        var name = ns.ToString("B").ToUpperInvariant();
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var clsid = user.OpenSubKey(ClassParent + name, false);
        using var entry = user.OpenSubKey(NamespaceParent + name, false);
        using var hidden = user.OpenSubKey(HiddenParent, false);
        return clsid is null && entry is null && (hidden is null || !HasValue(hidden, name));
    }

    private static bool HasValue(RegistryKey key, string name) => key.GetValueNames().Contains(name, StringComparer.OrdinalIgnoreCase);
    private static void RequireString(RegistryKey key, string name, string expected, bool ignoreCase = false)
    {
        if (!HasValue(key, name) || key.GetValueKind(name) is not (RegistryValueKind.String or RegistryValueKind.ExpandString) ||
            key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string value ||
            !string.Equals(value, expected, ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new IOException("An exact brokered shell metadata value differs from its ownership receipt.");
    }
}
