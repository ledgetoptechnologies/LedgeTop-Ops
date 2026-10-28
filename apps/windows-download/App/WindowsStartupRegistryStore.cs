using System.Runtime.Versioning;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files;

/// <summary>No key/value supplied by a caller. Only fixed per-user Registry64 Run/REG_SZ.
/// The local mutex serializes cooperating clients in this session. Registry supplies no native CAS
/// against arbitrary same-user external writers; the expected value is rechecked immediately before mutation.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsStartupRegistryStore : IWindowsStartupRunStore
{
    public WindowsStartupRunValue? Read() => Locked(ReadValue);
    public WindowsStartupPreference ReadPreference() => Locked(ReadPreferenceValue);
    public void SavePreference(bool enabled) => Locked(() => {
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var key = user.CreateSubKey(WindowsStartupPolicy.PreferenceKey, true) ?? throw new IOException("Startup preference unavailable.");
        key.SetValue(WindowsStartupPolicy.PreferenceValueName, enabled ? 1 : 0, RegistryValueKind.DWord);
        return true;
    });
    public bool TryReplace(WindowsStartupRunValue? expected, WindowsStartupRunValue? replacement, bool requireUnsetPreference = false) => Locked(() => {
        if (replacement is not null && !WindowsStartupPolicy.RecognizedCommandShape(replacement))
            throw new IOException("Startup replacement refused.");
        if (expected is not null && !WindowsStartupPolicy.RecognizedCommandShape(expected)) return false;
        if (requireUnsetPreference && ReadPreferenceValue() != WindowsStartupPreference.Unset) return false;
        if (ReadValue() != expected) return false;
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        if (replacement is null) {
            using var key = user.OpenSubKey(WindowsStartupPolicy.RunKey, true);
            key?.DeleteValue(WindowsStartupPolicy.RunValueName, false);
        } else {
            using var key = user.CreateSubKey(WindowsStartupPolicy.RunKey, true) ?? throw new IOException("Startup setting unavailable.");
            key.SetValue(WindowsStartupPolicy.RunValueName, replacement.Text!, RegistryValueKind.String);
        }
        return true;
    });
    private static WindowsStartupPreference ReadPreferenceValue()
    {
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var key = user.OpenSubKey(WindowsStartupPolicy.PreferenceKey, false);
        if (key is null) return WindowsStartupPreference.Unset;
        uint size = 4; var bytes = new byte[4];
        var result = RegQueryValueEx(key.Handle, WindowsStartupPolicy.PreferenceValueName, IntPtr.Zero, out var type, bytes, ref size);
        if (result == 2) return WindowsStartupPreference.Unset;
        if (result == 234) return WindowsStartupPreference.Invalid;
        if (result != 0) throw new IOException("Startup preference could not be read.");
        return size != 4 ? WindowsStartupPreference.Invalid : WindowsStartupPolicy.DecodePreference(type, bytes);
    }
    private static WindowsStartupRunValue? ReadValue()
    {
        using var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var key = user.OpenSubKey(WindowsStartupPolicy.RunKey, false);
        if (key is null) return null;
        uint size = 0;
        var result = RegQueryValueEx(key.Handle, WindowsStartupPolicy.RunValueName, IntPtr.Zero, out var type, null, ref size);
        if (result == 2) return null;
        if (result != 0) throw new IOException("Startup value could not be read.");
        if (type != 1 || size is < 2 or > 522 || size % 2 != 0) return new(WindowsStartupValueKind.Other, null);
        var bytes = new byte[size]; var actual = size;
        result = RegQueryValueEx(key.Handle, WindowsStartupPolicy.RunValueName, IntPtr.Zero, out type, bytes, ref actual);
        if (result == 2) return null;
        if (result == 234 || actual > size) return new(WindowsStartupValueKind.Other, null);
        if (result != 0) throw new IOException("Startup value changed during read.");
        return WindowsStartupPolicy.DecodeRunValue(type, bytes.AsSpan(0, checked((int)actual)));
    }
    private static T Locked<T>(Func<T> action)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sid = identity.User?.Value ?? throw new IOException("Startup identity unavailable.");
        // Public local SID namespace only, not a server principal or credential-derived digest.
        var name = @"Local\LedgeTop.Files.Startup." + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sid)));
        using var mutex = new Mutex(false, name); var acquired = false;
        try {
            try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new IOException("Startup setting is busy.");
            return action(); // Synchronous registry operations; mutex released on this exact thread.
        } finally { if (acquired) mutex.ReleaseMutex(); }
    }
    [DllImport("advapi32.dll", EntryPoint = "RegQueryValueExW", CharSet = CharSet.Unicode)]
    private static extern int RegQueryValueEx(SafeRegistryHandle key, string value, IntPtr reserved, out uint type,
        [Out] byte[]? data, ref uint bytes);
}
