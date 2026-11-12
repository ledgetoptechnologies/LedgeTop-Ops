using System.Diagnostics;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Ordinary generated directories and a fake drain; never registers a Cloud Files root.
internal static class SyntheticSessionLeaseTests {
    internal static int Child(string path) {
        var full=Path.GetFullPath(path); var temp=Path.GetFullPath(Path.GetTempPath());
        if (!full.StartsWith(temp, StringComparison.OrdinalIgnoreCase) || Path.GetFileName(full)!="session.lock" ||
            Path.GetFileName(Path.GetDirectoryName(full))!="profile" ||
            !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(full))) ?? "", @"\Alt-session-proof-[a-f0-9]{32}\z")) return 2;
        try { using var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None); return 0; }
        catch (IOException e) when ((e.HResult & 0xffff) == 32) { return 10; }
    }
    private static async Task<int> Probe(string path) {
        var exe = Environment.ProcessPath ?? throw new IOException("Missing executable");
        var info = new ProcessStartInfo(exe) { UseShellExecute=false, CreateNoWindow=true };
        if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            info.ArgumentList.Add(System.Reflection.Assembly.GetEntryAssembly()!.Location);
        info.ArgumentList.Add("--synthetic-session-lease-child"); info.ArgumentList.Add(path);
        using var p = Process.Start(info) ?? throw new IOException("Child unavailable");
        try { await p.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); return p.ExitCode; }
        finally { if (!p.HasExited) { p.Kill(); await p.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); } }
    }
    internal static async Task<int> RunAsync() {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var dir=Path.Combine(Path.GetTempPath(),"lt-session-proof-"+Guid.NewGuid().ToString("N"));
        var profile=Path.Combine(dir,"profile"); var root=Path.Combine(dir,"root"); Directory.CreateDirectory(profile); Directory.CreateDirectory(root);
        var profileFile=Path.Combine(profile,"profile.json"); var manifestFile=Path.Combine(profile,"manifest.json"); var lockFile=Path.Combine(profile,"session.lock");
        File.WriteAllText(profileFile,"synthetic profile"); File.WriteAllText(manifestFile,"synthetic manifest");
        using var source=new ExplorerDemoSource(signedIn:true,chunkDelay:TimeSpan.Zero);
        var scope=new ExplorerRootScope(source.Channel,source.Alias,source.Origin.GetLeftPart(UriPartial.Authority),source.PrincipalId);
        var manifest=new ExplorerRootManifest(scope,source.Entries.ToDictionary(e=>e.RelativePath.Replace('/','\\'),e=>e.Identity));
        var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var session=OwnedExplorerRootSession.CandidateForTest(profile,root,source,scope,manifest,priorVerify:_=>true,priorDrain:async ct=>{entered.TrySetResult(); await release.Task.WaitAsync(ct);});
        session.AttachSyntheticPriorLeaseForTest(new FileStream(lockFile,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.None));
        using var initial=ConnectedGenerationHandleLease.Open(profile,"manifest.json",root);
        var snap=new ConnectedGenerationSnapshot(Guid.NewGuid(),profile,root,unchecked((long)initial.RootFileId),Guid.NewGuid(),manifest.Digest,scope,1);
        var observation=new ConnectedGenerationHeldObservation(snap,ConnectedGenerationHandleLease.Open(profile,"manifest.json",root));
        Task<RetainedPriorGeneration>? drain=null; RetainedPriorGeneration? receipt=null;
        try {
            if(await Probe(lockFile)!=10) throw new IOException("Competing process acquired active lease");
            drain=session.DrainAndTransferPriorLeaseAsync(observation,CancellationToken.None);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if(await Probe(lockFile)!=10) throw new IOException("Competing process acquired during drain");
            release.TrySetResult(); receipt=await drain.WaitAsync(TimeSpan.FromSeconds(10));
            if(await Probe(lockFile)!=10) throw new IOException("Competing process acquired retained receipt lease");
            await session.ReclaimPriorLeaseAsync(receipt,CancellationToken.None); receipt.Dispose(); receipt=null;
            if(await Probe(lockFile)!=10) throw new IOException("Competing process acquired reclaimed lease");
            await session.DisposeAsync();
            if(await Probe(lockFile)!=0) throw new IOException("Competing process failed to acquire after dispose");
            Console.WriteLine("PASS two-process synthetic prior session lease: excluded through drain/reclaim, available after dispose; no native root."); return 0;
        } finally {
            release.TrySetResult(); if(drain is not null && !drain.IsCompleted) await drain.WaitAsync(TimeSpan.FromSeconds(10)); receipt?.Dispose();
            try { await session.DisposeAsync(); } catch (IOException) { }
            observation.Dispose();
            // Keep generated fixture for inspection; no recursive cleanup or user data.
            Console.WriteLine("Synthetic fixture: "+dir);
        }
    }
}
