using System.Diagnostics;
using Microsoft.Win32;
using LedgeTop.Files;

internal static class InstallerVersionConflictIntegrationTests {
    internal static void Run() {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException();
        var id=Guid.NewGuid().ToString("N");var relative=@"Software\LedgeTopSyntheticInstallerTests\"+id;
        var fixtureParent=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".codex","tmp");
        if(!Directory.Exists(fixtureParent) || (File.GetAttributes(fixtureParent)&FileAttributes.ReparsePoint)!=0)throw new IOException("Synthetic fixture parent unavailable.");
        var fixture=Path.Combine(fixtureParent,"ltv-"+id);
        var versionDir=Path.Combine(fixture,"versions","0.5.44.0");var exe=Path.Combine(versionDir,"LedgeTop.Files.exe");
        var active=Path.Combine(fixture,"versions","0.5.34.0"); Process? child=null; bool registryCreated=false;
        using var hkcu=RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,RegistryView.Registry64);
        try {
            if(hkcu.OpenSubKey(relative,false) is not null || Directory.Exists(fixture) || File.Exists(fixture))throw new IOException("Synthetic fixture collision.");
            Directory.CreateDirectory(versionDir);File.Copy(Path.Combine(Environment.SystemDirectory,"cmd.exe"),exe,false);
            using(var root=hkcu.CreateSubKey(relative,true) ?? throw new IOException("Synthetic key creation failed.")) {
                registryCreated=true;
                using(var uninstall=root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot",true)) {
                    uninstall.SetValue("DisplayVersion","0.5.34.0",RegistryValueKind.String);uninstall.SetValue("InstallLocation",active,RegistryValueKind.String);
                }
                using(var run=root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true))run.SetValue("LedgeTopFilesPilot","\""+Path.Combine(active,"LedgeTop.Files.exe")+"\" --startup-saved-source-v1 employee",RegistryValueKind.String);
                var info=new ProcessStartInfo(exe,"/d /q") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
                child=Process.Start(info) ?? throw new IOException("Synthetic child did not start.");
                if(child.HasExited)throw new IOException("Synthetic child exited early.");
                Process[] OwnedOnly() {
                    var all=Process.GetProcessesByName("LedgeTop.Files");var own=new List<Process>();
                    foreach(var process in all){if(process.Id==child.Id)own.Add(process);else process.Dispose();}return own.ToArray();
                }
                if(InstallerVersionConflict.CheckObserved(root,fixture,OwnedOnly))throw new IOException("Mismatched real child was not refused.");
                using(var uninstall=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot",true)!)uninstall.SetValue("DisplayVersion","0.5.44.0",RegistryValueKind.String);
                using(var uninstall=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot",true)!)uninstall.SetValue("InstallLocation",versionDir,RegistryValueKind.String);
                using(var run=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true)!)run.SetValue("LedgeTopFilesPilot","\""+exe+"\" --startup-saved-source-v1 employee",RegistryValueKind.String);
                if(!InstallerVersionConflict.CheckObserved(root,fixture,OwnedOnly))throw new IOException("Matching real child was refused.");
                using(var run=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true)!)run.SetValue("LedgeTopFilesPilot","foreign synthetic command",RegistryValueKind.String);
                if(!InstallerVersionConflict.CheckObserved(root,fixture,OwnedOnly))throw new IOException("Foreign value was not preserved.");
                using(var run=root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",false)!)if((string?)run.GetValue("LedgeTopFilesPilot")!="foreign synthetic command")throw new IOException("Foreign value changed.");
                Console.WriteLine("PASS disposable registry and exact owned real process: mismatch, match, foreign-preservation; no host startup key or app process changed.");
            }
        } finally {
            if(child is not null) {try {if(!child.HasExited){child.StandardInput.WriteLine("exit");child.StandardInput.Flush();if(!child.WaitForExit(5000)){child.Kill(true);if(!child.WaitForExit(5000))throw new IOException("Synthetic child exit unconfirmed.");}}}finally{child.Dispose();}}
            if(registryCreated)hkcu.DeleteSubKeyTree(relative,false);
            if(File.Exists(exe))File.Delete(exe);
            if(Directory.Exists(versionDir))Directory.Delete(versionDir);
            var versions=Path.Combine(fixture,"versions");if(Directory.Exists(versions))Directory.Delete(versions);
            if(Directory.Exists(fixture))Directory.Delete(fixture);
        }
    }
}
