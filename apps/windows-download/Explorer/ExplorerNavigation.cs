using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Explorer;

/// <summary>
/// Per-user navigation entry for an already owned Cloud Files root. This is the documented folder
/// namespace pattern, not a substitute for sync-root metadata, native callbacks or Cloud Files policies.
/// https://learn.microsoft.com/en-us/windows/win32/shell/integrate-cloud-storage
/// </summary>
public sealed class ExplorerNavigation
{
    public const string DisplayName = "LedgeTop Files Preview";
    private const string ClassParent = @"Software\Classes\CLSID";
    private const string NamespaceParent = @"Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace";
    private const string HiddenParent = @"Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel";
    private const string OwnerValue = "LedgeTopPreviewOwner";
    private const string RootValue = "LedgeTopPreviewRoot";
    private const string IconValue = "LedgeTopPreviewIcon";
    private const string FolderInstance = "{0E5AAE11-A475-4C5B-AB00-C66DE400274E}";
    private static readonly object changes = new();
    private static readonly HashSet<Guid> attempted = [];
    private static readonly Dictionary<Guid, ExplorerNavigation> active = [];
    private readonly IPreviewRootRegistration registration;
    private readonly Dictionary<string, Dictionary<string, Value>> classPlan, namespacePlan;
    private readonly string owner;
    private bool classCreated, namespaceCreated, hideAttempted, complete, removalStarted, removed;

    private sealed record Value(object Data, RegistryValueKind Kind);

    private ExplorerNavigation(IPreviewRootRegistration registration, Guid identity, string icon)
    {
        this.registration = registration;
        Identity = identity; Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(registration.Root)); Icon = icon;
        Clsid = identity.ToString("B").ToUpperInvariant();
        owner = "LedgeTop.Files.ExplorerNavigation/1:" + identity.ToString("N");
        classPlan = new(StringComparer.OrdinalIgnoreCase) {
            [""] = new(StringComparer.OrdinalIgnoreCase) {
                [OwnerValue] = String(owner), [RootValue] = String(Root), [IconValue] = String(Icon),
                [""] = String(DisplayName), ["System.IsPinnedToNameSpaceTree"] = Dword(1), ["SortOrderIndex"] = Dword(0x42)
            },
            ["DefaultIcon"] = new(StringComparer.OrdinalIgnoreCase) { [""] = Expand(Icon) },
            ["InProcServer32"] = new(StringComparer.OrdinalIgnoreCase) { [""] = Expand(@"%SystemRoot%\system32\shell32.dll") },
            ["Instance"] = new(StringComparer.OrdinalIgnoreCase) { ["CLSID"] = String(FolderInstance) },
            [@"Instance\InitPropertyBag"] = new(StringComparer.OrdinalIgnoreCase) {
                ["Attributes"] = Dword(0x11), ["TargetFolderPath"] = Expand(Root)
            },
            ["ShellFolder"] = new(StringComparer.OrdinalIgnoreCase) {
                ["FolderValueFlags"] = Dword(0x28), ["Attributes"] = Dword(unchecked((int)0xF080004D))
            }
        };
        namespacePlan = new(StringComparer.OrdinalIgnoreCase) {
            [""] = new(StringComparer.OrdinalIgnoreCase) {
                [OwnerValue] = String(owner), [RootValue] = String(Root), [IconValue] = String(Icon), [""] = String(DisplayName)
            }
        };
    }

    public Guid Identity { get; }
    public string Clsid { get; }
    public string Root { get; }
    public string Icon { get; }

    public static bool IsAbsent(Guid identity)
    {
        if (identity == Guid.Empty) throw new ArgumentException("A preview navigation identity is required.");
        var clsid = identity.ToString("B").ToUpperInvariant();
        lock (changes) {
            using var user = User();
            using var instance = user.OpenSubKey(ClassParent + "\\" + clsid);
            using var entry = user.OpenSubKey(NamespaceParent + "\\" + clsid);
            using var hidden = user.OpenSubKey(HiddenParent);
            return instance is null && entry is null && (hidden is null || !HasValue(hidden, clsid));
        }
    }

    /// <summary>Creates only new per-preview HKCU keys. A repeated or uncertain attempt is never replayed.</summary>
    public static ExplorerNavigation Register(IPreviewRootRegistration registration, Guid identity, string icon)
    {
        ValidateInputs(registration, identity, icon);
        registration.VerifyOwned();
        var receipt = new ExplorerNavigation(registration, identity, icon);
        lock (changes) {
            if (attempted.Contains(identity) || active.ContainsKey(identity))
                throw new InvalidOperationException("This process already attempted this navigation identity; reconcile it before continuing.");
            using var user = User();
            receipt.RequireAbsent(user);
            attempted.Add(identity);
            try {
                using (var parent = user.CreateSubKey(ClassParent, true))
                using (var key = NewKey(parent, receipt.Clsid)) {
                    receipt.classCreated = true;
                    WriteTree(key, receipt.classPlan);
                }
                using (var parent = user.CreateSubKey(NamespaceParent, true))
                using (var key = NewKey(parent, receipt.Clsid)) {
                    receipt.namespaceCreated = true;
                    WriteTree(key, receipt.namespacePlan);
                }
                using (var hidden = user.CreateSubKey(HiddenParent, true)) {
                    // Values have no create-only registry API. The unpredictable CLSID and its
                    // exclusively created owned anchors bind this value; still refuse any existing value.
                    if (HasValue(hidden, receipt.Clsid)) throw new IOException("The preview desktop-icon value already exists.");
                    receipt.hideAttempted = true;
                    hidden.SetValue(receipt.Clsid, 1, RegistryValueKind.DWord);
                }
                receipt.complete = true;
                receipt.VerifyCore(user, allowPartial: false);
                active.Add(identity, receipt);
                NotifyShell();
                return receipt;
            } catch (Exception original) {
                try {
                    // Read back every created anchor before cleanup. Do not delete a changed or foreign tree.
                    receipt.RemoveCore(user, allowPartial: true);
                } catch (Exception cleanup) {
                    throw new ExplorerNavigationRegistrationException(
                        "Navigation registration is incomplete and needs exact ownership reconciliation.", receipt,
                        new AggregateException(original, cleanup));
                }
                throw new ExplorerNavigationRegistrationException(
                    "Navigation registration failed; the exact created entries were removed.", null, original);
            }
        }
    }

    /// <summary>Read-only recovery using a durable preview GUID, exact native-root receipt and original icon.</summary>
    public static ExplorerNavigation OpenOwned(IPreviewRootRegistration registration, Guid identity, string icon)
    {
        ValidateInputs(registration, identity, icon);
        registration.VerifyOwned();
        lock (changes) {
            if (active.TryGetValue(identity, out var current)) {
                if (!StringComparer.OrdinalIgnoreCase.Equals(current.Root, registration.Root) || current.Icon != icon)
                    throw new InvalidOperationException("A different navigation receipt already uses this identity.");
                current.VerifyOwned();
                return current;
            }
            var receipt = new ExplorerNavigation(registration, identity, icon) {
                classCreated = true, namespaceCreated = true, hideAttempted = true, complete = true
            };
            using var user = User();
            receipt.VerifyCore(user, allowPartial: false);
            attempted.Add(identity); active.Add(identity, receipt);
            return receipt;
        }
    }

    public void VerifyOwned()
    {
        lock (changes) {
            if (!complete || removalStarted || removed) throw new InvalidOperationException("Navigation registration is not complete and current.");
            registration.VerifyOwned();
            using var user = User(); VerifyCore(user, allowPartial: false);
        }
    }

    /// <summary>Remove navigation before unregistering its native root. Never removes shared parent keys.</summary>
    public void Remove()
    {
        lock (changes) {
            if (removed) return;
            registration.VerifyOwned();
            using var user = User();
            // A second explicit call after a failed removal first reconciles the remaining exact schema.
            RemoveCore(user, allowPartial: removalStarted || !complete);
        }
    }

    private void RequireAbsent(RegistryKey user)
    {
        using var clsid = user.OpenSubKey(ClassParent + "\\" + Clsid);
        using var ns = user.OpenSubKey(NamespaceParent + "\\" + Clsid);
        using var hidden = user.OpenSubKey(HiddenParent);
        if (clsid is not null || ns is not null || hidden is not null && HasValue(hidden, Clsid))
            throw new IOException("An existing namespace entry uses this preview identity; it was not changed.");
    }

    private void VerifyCore(RegistryKey user, bool allowPartial)
    {
        if (classCreated) VerifyTree(user, ClassParent + "\\" + Clsid, classPlan, allowPartial);
        if (namespaceCreated) VerifyTree(user, NamespaceParent + "\\" + Clsid, namespacePlan, allowPartial);
        using var hidden = user.OpenSubKey(HiddenParent);
        if (hideAttempted) {
            if (hidden is null || !HasValue(hidden, Clsid)) {
                if (!allowPartial) throw new IOException("The owned desktop-icon entry is missing.");
            } else if (hidden.GetValueKind(Clsid) != RegistryValueKind.DWord || hidden.GetValue(Clsid) is not int value || value != 1)
                throw new IOException("The desktop-icon entry no longer matches this preview.");
        }
    }

    private void RemoveCore(RegistryKey user, bool allowPartial)
    {
        registration.VerifyOwned();
        VerifyCore(user, allowPartial);
        removalStarted = true;
        if (hideAttempted) {
            using var hidden = user.OpenSubKey(HiddenParent, true);
            if (hidden is not null && HasValue(hidden, Clsid)) hidden.DeleteValue(Clsid, true);
        }
        if (namespaceCreated) user.DeleteSubKeyTree(NamespaceParent + "\\" + Clsid, throwOnMissingSubKey: false);
        if (classCreated) user.DeleteSubKeyTree(ClassParent + "\\" + Clsid, throwOnMissingSubKey: false);
        using var remainingClass = user.OpenSubKey(ClassParent + "\\" + Clsid);
        using var remainingNamespace = user.OpenSubKey(NamespaceParent + "\\" + Clsid);
        using var remainingHidden = user.OpenSubKey(HiddenParent);
        if (classCreated && remainingClass is not null || namespaceCreated && remainingNamespace is not null ||
            hideAttempted && remainingHidden is not null && HasValue(remainingHidden, Clsid))
            throw new IOException("Navigation removal did not pass readback; it was not retried.");
        removed = true; active.Remove(Identity);
        NotifyShell();
    }

    private void VerifyTree(RegistryKey user, string path, Dictionary<string, Dictionary<string, Value>> plan, bool partial)
    {
        using var anchor = user.OpenSubKey(path);
        if (anchor is null) {
            if (!partial) throw new IOException("An owned navigation key is missing.");
            return;
        }
        // A failed first marker write can leave only a known-new empty anchor. No nonempty
        // markerless tree is adopted, even when its other values happen to look familiar.
        if (anchor.GetValue(OwnerValue, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string marker || marker != owner) {
            if (partial && anchor.ValueCount == 0 && anchor.SubKeyCount == 0) return;
            throw new IOException("Navigation ownership marker does not match.");
        }
        VerifyBranch(anchor, "", plan, partial);
    }

    private static void VerifyBranch(RegistryKey key, string branch, Dictionary<string, Dictionary<string, Value>> plan, bool partial)
    {
        var expected = plan[branch];
        foreach (var name in key.GetValueNames()) {
            if (!expected.TryGetValue(name, out var value) || key.GetValueKind(name) != value.Kind ||
                !Equals(key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames), value.Data))
                throw new IOException("A navigation value differs from the ownership receipt.");
        }
        if (!partial && key.ValueCount != expected.Count) throw new IOException("An owned navigation value is missing.");
        var children = plan.Keys.Where(path => path.Length > 0 &&
            string.Equals(Parent(path), branch, StringComparison.OrdinalIgnoreCase)).ToArray();
        foreach (var name in key.GetSubKeyNames()) {
            var childPath = branch.Length == 0 ? name : branch + "\\" + name;
            if (!children.Contains(childPath, StringComparer.OrdinalIgnoreCase)) throw new IOException("An unexpected navigation subkey is present.");
            using var child = key.OpenSubKey(name) ?? throw new IOException("Navigation metadata changed during readback.");
            VerifyBranch(child, childPath, plan, partial);
        }
        if (!partial && key.SubKeyCount != children.Length) throw new IOException("An owned navigation subkey is missing.");
    }

    private static void WriteTree(RegistryKey root, Dictionary<string, Dictionary<string, Value>> plan)
    {
        foreach (var (branch, values) in plan) {
            if (branch.Length == 0) { WriteValues(root, values); continue; }
            var parentPath = Parent(branch);
            if (parentPath.Length == 0) {
                using var child = NewKey(root, branch); WriteValues(child, values);
            } else {
                using var parent = root.OpenSubKey(parentPath, true) ?? throw new IOException("Owned navigation parent is missing.");
                using var child = NewKey(parent, branch[(parentPath.Length + 1)..]); WriteValues(child, values);
            }
        }
    }

    private static void WriteValues(RegistryKey key, Dictionary<string, Value> values)
    {
        foreach (var (name, value) in values) {
            if (HasValue(key, name)) throw new IOException("A new navigation key already has a conflicting value.");
            key.SetValue(name, value.Data, value.Kind);
        }
    }

    private static RegistryKey NewKey(RegistryKey parent, string name)
    {
        var status = RegCreateKeyExW(parent.Handle, name, 0, null, 0, 0x2011F | 0x100, 0, out var handle, out var disposition);
        if (status != 0) { handle?.Dispose(); throw new IOException("Cannot create the preview navigation key.", new System.ComponentModel.Win32Exception(status)); }
        if (disposition != 1) { handle.Dispose(); throw new IOException("A navigation key was created concurrently; it was not overwritten."); }
        return RegistryKey.FromHandle(handle, RegistryView.Registry64);
    }

    private static RegistryKey User() => RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
    private static string Parent(string path) { var slash = path.LastIndexOf('\\'); return slash < 0 ? "" : path[..slash]; }
    private static bool HasValue(RegistryKey key, string name) => key.GetValueNames().Contains(name, StringComparer.OrdinalIgnoreCase);
    private static Value String(string data) => new(data, RegistryValueKind.String);
    private static Value Expand(string data) => new(data, RegistryValueKind.ExpandString);
    private static Value Dword(int data) => new(data, RegistryValueKind.DWord);

    // Pure metadata validation is deliberately separate from registry access for no-mutation tests.
    internal static void ValidateInputs(IPreviewRootRegistration registration, Guid identity, string icon)
    {
        ArgumentNullException.ThrowIfNull(registration);
        if (identity == Guid.Empty || identity == new Guid("0672A6D1-A6E0-40FE-AB16-F25BADC6D9E3"))
            throw new ArgumentException("A unique per-preview navigation identity is required.", nameof(identity));
        var root = registration.Root;
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root) || root.StartsWith("\\\\", StringComparison.Ordinal) ||
            root.IndexOfAny(['\0', '%']) >= 0 || Path.GetFullPath(root) != root || !Directory.Exists(root))
            throw new ArgumentException("An existing canonical local preview root is required.", nameof(registration));
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        if (canonical.Equals(Path.TrimEndingDirectorySeparator(Path.GetPathRoot(root)!), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A drive root cannot be a preview navigation folder.", nameof(registration));
        ArgumentException.ThrowIfNullOrWhiteSpace(icon);
        var comma = icon.LastIndexOf(',');
        if (comma <= 0 || !int.TryParse(icon[(comma + 1)..], System.Globalization.NumberStyles.AllowLeadingSign,
                System.Globalization.CultureInfo.InvariantCulture, out _) ||
            !Path.IsPathFullyQualified(icon[..comma]) || icon[..comma].StartsWith("\\\\", StringComparison.Ordinal) ||
            icon.IndexOfAny(['\0', '%']) >= 0 || Path.GetFullPath(icon[..comma]) != icon[..comma] || !File.Exists(icon[..comma]))
            throw new ArgumentException("An existing canonical local icon resource and index are required.", nameof(icon));
    }

    // SHCNE_ASSOCCHANGED | SHCNF_IDLIST: documented notification after namespace registration changes.
    private static void NotifyShell() => SHChangeNotify(0x08000000, 0, 0, 0);
    [DllImport("shell32.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern void SHChangeNotify(uint eventId, uint flags, nint first, nint second);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern int RegCreateKeyExW(SafeRegistryHandle key, string subKey, uint reserved, string? keyClass,
        uint options, uint access, nint security, out SafeRegistryHandle result, out uint disposition);
}

/// <summary>A failed registration may retain an exact partial receipt for explicit reconciliation.</summary>
public sealed class ExplorerNavigationRegistrationException(string message, ExplorerNavigation? ownedPartial, Exception inner)
    : IOException(message, inner)
{
    public ExplorerNavigation? OwnedPartial { get; } = ownedPartial;
}
