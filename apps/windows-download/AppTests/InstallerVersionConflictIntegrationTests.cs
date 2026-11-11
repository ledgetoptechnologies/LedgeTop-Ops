using System.Diagnostics;
using Microsoft.Win32;
using LedgeTop.Files;
using LedgeTop.Files.Explorer;

internal static class InstallerVersionConflictIntegrationTests {
    internal static void Run() {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException();
        var id=Guid.NewGuid().ToString("N");var relative=@"Software\LedgeTopSyntheticInstallerTests\"+id;
        var fixtureParent=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".codex","tmp");
        if(!Directory.Exists(fixtureParent) || (File.GetAttributes(fixtureParent)&FileAttributes.ReparsePoint)!=0)throw new IOException("Synthetic fixture parent unavailable.");
        var fixture=Path.Combine(fixtureParent,"ltv-"+id);
        var versionDir=Path.Combine(fixture,"versions","0.5.44.0");var exe=Path.Combine(versionDir,"LedgeTop.Files.exe");
        var active=Path.Combine(fixture,"versions","0.5.34.0"); Process? child=null; bool registryCreated=false, fixtureCreated=false, childStopped=true;
        CandidateDirectoryFence? parentFence=null, fixtureFence=null; CandidateDirectoryFence.DirectoryIdentity? exeIdentity=null;
        var failures=new List<Exception>();
        using var hkcu=RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,RegistryView.Registry64);
        try {
            using(var existing=hkcu.OpenSubKey(relative,false))if(existing is not null)throw new IOException("Synthetic fixture collision.");
            if(Directory.Exists(fixture) || File.Exists(fixture))throw new IOException("Synthetic fixture collision.");
            parentFence=new CandidateDirectoryFence();parentFence.HoldAncestors(fixtureParent);
            fixtureFence=new CandidateDirectoryFence();fixtureFence.HoldAncestors(fixtureParent);
            fixtureFence.CreateExclusiveDirectory(fixture);fixtureCreated=true;
            fixtureFence.CreateExclusiveDirectory(Path.Combine(fixture,"versions"));fixtureFence.CreateExclusiveDirectory(versionDir);
            File.Copy(Path.Combine(Environment.SystemDirectory,"cmd.exe"),exe,false);exeIdentity=CandidateDirectoryFence.ObserveFile(exe);
            using(var root=hkcu.CreateSubKey(relative,true) ?? throw new IOException("Synthetic key creation failed.")) {
                registryCreated=true;
                using(var uninstall=root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot",true)) {
                    uninstall.SetValue("DisplayVersion","0.5.34.0",RegistryValueKind.String);uninstall.SetValue("InstallLocation",active,RegistryValueKind.String);
                }
                using(var run=root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run",true))run.SetValue("LedgeTopFilesPilot","\""+Path.Combine(active,"LedgeTop.Files.exe")+"\" --startup-saved-source-v1 employee",RegistryValueKind.String);
                var info=new ProcessStartInfo(exe,"/d /q") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
                child=Process.Start(info) ?? throw new IOException("Synthetic child did not start.");childStopped=false;
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

            }
        } finally {
            // Independent cleanup attempts: one failure cannot suppress another. Never touch
            // a child unless it is the exact Process instance created above.
            try {
                if(child is not null) {
                    try {if(!child.HasExited){child.StandardInput.WriteLine("exit");child.StandardInput.Flush();if(!child.WaitForExit(5000)){child.Kill(true);if(!child.WaitForExit(5000))throw new IOException("Synthetic child exit unconfirmed.");}}childStopped=true;}
                    finally {child.Dispose();}
                }
            } catch(Exception e) {failures.Add(e);}
            try {if(registryCreated)DeleteKnownRegistryFixture(hkcu,relative,active,versionDir,exe);}catch(Exception e){failures.Add(e);}
            try {
                if(fixtureCreated && childStopped && fixtureFence is not null && parentFence is not null) {
                    _=parentFence.Recheck(fixtureParent);_=fixtureFence.Recheck(fixture);_=fixtureFence.Recheck(Path.Combine(fixture,"versions"));_=fixtureFence.Recheck(versionDir);
                    if(exeIdentity is null || CandidateDirectoryFence.ObserveFile(exe)!=exeIdentity)throw new IOException("Synthetic executable identity unverified; fixture retained.");
                    if(Directory.EnumerateFileSystemEntries(versionDir).Single()!=exe)throw new IOException("Synthetic directory contains unknown entries; fixture retained.");
                    fixtureFence.Dispose();fixtureFence=null;
                    // Parent remains pinned. Deletes are individual, never recursive; an external
                    // same-user name swap between observation and deletion is not an atomic CAS.
                    File.Delete(exe);Directory.Delete(versionDir);Directory.Delete(Path.Combine(fixture,"versions"));Directory.Delete(fixture);
                } else if(fixtureCreated)throw new IOException("Synthetic child or directory ownership uncertain; fixture retained.");
            } catch(Exception e) {failures.Add(e);}
            try {fixtureFence?.Dispose();}catch(Exception e){failures.Add(e);}
            try {parentFence?.Dispose();}catch(Exception e){failures.Add(e);}
            if(failures.Count!=0)throw new AggregateException("Synthetic fixture cleanup requires review.",failures);
        }
        // Unknown synthetic children cause refusal without recursive deletion.
        var reviewKey=@"Software\LedgeTopSyntheticInstallerTests\"+Guid.NewGuid().ToString("N");
        using(var existing=hkcu.OpenSubKey(reviewKey,false))if(existing is not null)throw new IOException("Synthetic review key collision.");
        using(var test=hkcu.CreateSubKey(reviewKey,true) ?? throw new IOException("Synthetic review key unavailable."))using(test.CreateSubKey("Unknown",true)) { }
        try {
            var refused=false;try{DeleteKnownRegistryFixture(hkcu,reviewKey,active,versionDir,exe);}catch(IOException){refused=true;}
            using var unknown=hkcu.OpenSubKey(reviewKey+@"\Unknown",false);
            if(!refused || unknown is null)throw new IOException("Unknown registry child not preserved.");
        } finally {using(var test=hkcu.OpenSubKey(reviewKey,true))test?.DeleteSubKey("Unknown",false);DeleteKnownRegistryFixture(hkcu,reviewKey,active,versionDir,exe);}
        Console.WriteLine("PASS disposable registry and exact owned real process: mismatch, match, foreign-preservation; no host startup key or app process changed.");
    }
    private static void DeleteKnownRegistryFixture(RegistryKey hkcu,string path,string active,string versionDir,string exe) {
        using var fixture=hkcu.OpenSubKey(path,true);if(fixture is null)return;
        var branches=new Dictionary<string,string[]>(StringComparer.OrdinalIgnoreCase) {
            [""]=["Software"], [@"Software"]=["Microsoft"], [@"Software\Microsoft"]=["Windows"],
            [@"Software\Microsoft\Windows"]=["CurrentVersion"], [@"Software\Microsoft\Windows\CurrentVersion"]=["Uninstall","Run"],
            [@"Software\Microsoft\Windows\CurrentVersion\Uninstall"]=["LedgeTopFilesPilot"],
            [@"Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot"]=[],
            [@"Software\Microsoft\Windows\CurrentVersion\Run"]=[]
        };
        foreach(var pair in branches) {
            using var key=pair.Key.Length==0?null:fixture.OpenSubKey(pair.Key,false);var current=key??(pair.Key.Length==0?fixture:null);
            if(current is null)continue;
            if(current.GetSubKeyNames().Except(pair.Value,StringComparer.OrdinalIgnoreCase).Any())throw new IOException("Unknown synthetic registry child; retain fixture.");
            var allowed=pair.Key.EndsWith(@"\Uninstall\LedgeTopFilesPilot",StringComparison.OrdinalIgnoreCase)?new[]{"DisplayVersion","InstallLocation"}:
                pair.Key.EndsWith(@"\CurrentVersion\Run",StringComparison.OrdinalIgnoreCase)?new[]{"LedgeTopFilesPilot"}:Array.Empty<string>();
            if(current.GetValueNames().Except(allowed,StringComparer.OrdinalIgnoreCase).Any())throw new IOException("Unknown synthetic registry value; retain fixture.");
            foreach(var name in current.GetValueNames()) {
                if(current.GetValueKind(name)!=RegistryValueKind.String)throw new IOException("Synthetic registry value type changed; retain fixture.");
                var value=current.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                var expected=name switch {
                    "DisplayVersion" => value is "0.5.34.0" or "0.5.44.0",
                    "InstallLocation" => value==active || value==versionDir,
                    "LedgeTopFilesPilot" => value=="foreign synthetic command" || value=="\""+Path.Combine(active,"LedgeTop.Files.exe")+"\" --startup-saved-source-v1 employee" || value=="\""+exe+"\" --startup-saved-source-v1 employee",
                    _ => false
                };
                if(!expected)throw new IOException("Synthetic registry value changed; retain fixture.");
            }
        }
        foreach(var leaf in branches.Keys.Where(x=>x.Length!=0).OrderByDescending(x=>x.Count(c=>c=='\\')))fixture.DeleteSubKey(leaf,false);
        fixture.Close();hkcu.DeleteSubKey(path,false);
    }
}
