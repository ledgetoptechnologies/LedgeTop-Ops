using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace LedgeTop.Files;

// Installer check only. A recognized other-version owner is never stopped or adopted.
internal static class InstallerVersionConflict {
    private const string Uninstall=@"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot";
    private const string Run=@"Software\Microsoft\Windows\CurrentVersion\Run";
    internal static bool CanonicalVersion(string text) => Regex.IsMatch(text,@"\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}\z",RegexOptions.CultureInvariant,TimeSpan.FromMilliseconds(100)) &&
        text.Split('.').All(p=>ushort.TryParse(p,NumberStyles.None,CultureInfo.InvariantCulture,out _));
    internal static string? OwnedVersion(string? path,string baseDirectory) {
        if(path is null)return null;
        var prefix=Path.Combine(baseDirectory,"versions")+Path.DirectorySeparatorChar;
        if(!path.StartsWith(prefix,StringComparison.OrdinalIgnoreCase) || !path.EndsWith(@"\LedgeTop.Files.exe",StringComparison.OrdinalIgnoreCase))return null;
        var version=path[prefix.Length..^@"\LedgeTop.Files.exe".Length];
        return CanonicalVersion(version)?version:null;
    }
    internal static string? OwnedStartupVersion(string? command,string baseDirectory) {
        if(command is null || !command.StartsWith('"'))return null;
        var end=command.IndexOf('"',1);if(end<0)return null;
        var suffix=command[(end+1)..];if(suffix is not (" --startup-saved-source-v1 portal" or " --startup-saved-source-v1 employee"))return null;
        return OwnedVersion(command[1..end],baseDirectory);
    }
    internal static bool HasConflict(string? active,string? startup,IEnumerable<string?> processPaths,string baseDirectory) {
        var startupVersion=OwnedStartupVersion(startup,baseDirectory);
        if(startupVersion is not null && !string.Equals(startupVersion,active,StringComparison.Ordinal))return true;
        foreach(var path in processPaths) {var version=OwnedVersion(path,baseDirectory);if(version is not null && !string.Equals(version,active,StringComparison.Ordinal))return true;}
        return false;
    }
    internal static string? ReadUnlessExited(Func<string> read,Func<bool> exited) {
        try { return read(); }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) {
            if (exited()) return null;
            throw;
        }
    }
    internal static bool Check() {
        var baseDirectory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","LedgeTop Files Pilot");
        using var user=RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,RegistryView.Registry64);
        using var uninstall=user.OpenSubKey(Uninstall,false);
        string? active=null;
        if(uninstall is not null) {
            if(uninstall.GetValueKind("DisplayVersion")!=RegistryValueKind.String || uninstall.GetValueKind("InstallLocation")!=RegistryValueKind.String)throw new IOException("Active installation metadata unavailable.");
            active=uninstall.GetValue("DisplayVersion",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            var location=uninstall.GetValue("InstallLocation",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            if(active is null || !CanonicalVersion(active) || !string.Equals(location,Path.Combine(baseDirectory,"versions",active),StringComparison.Ordinal))throw new IOException("Active installation metadata differs.");
        }
        using var run=user.OpenSubKey(Run,false);string? startup=null;
        if(run is not null && run.GetValueNames().Contains("LedgeTopFilesPilot",StringComparer.OrdinalIgnoreCase) && run.GetValueKind("LedgeTopFilesPilot")==RegistryValueKind.String)
            startup=run.GetValue("LedgeTopFilesPilot",null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        var paths=new List<string?>();var processes=Process.GetProcessesByName("LedgeTop.Files");
        try { foreach(var process in processes) if(process.Id!=Environment.ProcessId) paths.Add(ReadUnlessExited(() => process.MainModule?.FileName ?? throw new IOException("Running owner path unavailable."), () => process.HasExited)); }
        finally {foreach(var process in processes)process.Dispose();}
        return !HasConflict(active,startup,paths,baseDirectory);
    }
}
