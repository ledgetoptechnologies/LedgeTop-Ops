using System.Security.Principal;
using System.Text.Json;
using LedgeTop.Files.Explorer;

internal static class GeneratedRemovalBindingTests
{
    internal static async Task<int> RunAsync()
    {
        var temp = Path.Combine(Path.GetTempPath(), "LedgeTopGeneratedBinding-" + Guid.NewGuid().ToString("N"));
        var directory = Path.Combine(temp, "profile"); var root = Path.Combine(temp, "root");
        Directory.CreateDirectory(directory); Directory.CreateDirectory(root);
        var path = Path.Combine(directory, "profile.json");
        try {
            using var user = WindowsIdentity.GetCurrent(); var sid = user.User!.Value;
            var identity = Guid.NewGuid(); var ns = Guid.NewGuid(); var icon = ExplorerBrandIcon.LegacyResource;
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { Schema=2, Owner="LedgeTop.Files.ExplorerPreview/1", Sid=sid,
                Identity=identity, Root=root, Context="LedgeTop.Files.ExplorerPreview/1:"+identity.ToString("N"), Icon=icon,
                RootFileId=123L, Phase="Ready", Paused=false, Revision=1L, NamespaceClsid=ns });
            await File.WriteAllBytesAsync(path, bytes);
            var binding = new GeneratedRemovalBinding(identity,sid,directory,root,icon,123,ns,1,CandidateDirectoryFence.ObserveFile(path));
            await using(var session = OwnedExplorerRootSession.Generated(directory,root)) {
                if (session.CaptureGeneratedConfirmationBinding() != binding) throw new IOException("Recorded preview confirmation snapshot differs.");
                var changedIdentity=Guid.NewGuid();
                var changed=JsonSerializer.SerializeToUtf8Bytes(new { Schema=2, Owner="LedgeTop.Files.ExplorerPreview/1", Sid=sid,
                    Identity=changedIdentity, Root=root, Context="LedgeTop.Files.ExplorerPreview/1:"+changedIdentity.ToString("N"), Icon=icon,
                    RootFileId=123L, Phase="Ready", Paused=false, Revision=1L, NamespaceClsid=ns });
                await File.WriteAllBytesAsync(path,changed);
                if (session.CaptureGeneratedConfirmationBinding() == binding) throw new IOException("A different valid receipt was treated as the confirmed one.");
                await File.WriteAllBytesAsync(path,bytes);
            }
            var missing = Path.Combine(temp,"missing-profile");
            await using(var session = OwnedExplorerRootSession.Generated(missing,root)) {
                bool refused=false; try { await session.RemoveConfirmedGeneratedAsync(binding with { ProfileDirectory=missing },()=>true,()=>throw new Exception("Native attempt forbidden.")); }
                catch(IOException){refused=true;}
                if(!refused || Directory.Exists(missing))throw new IOException("Missing confirmed profile was treated as removed.");
            }
            foreach(var wrong in new[] { binding with { Identity=Guid.NewGuid() }, binding with { RootPath=root+"-other" },
                binding with { RootFileId=124 }, binding with { NamespaceClsid=Guid.NewGuid() }, binding with { ProfileRevision=2 },
                binding with { ProfileFileIdentity=default } }) {
                await using var session = OwnedExplorerRootSession.Generated(directory,root);
                bool refused=false; try { await session.RemoveConfirmedGeneratedAsync(wrong,()=>throw new Exception("Changed tuple reached held proof."),()=>throw new Exception("Native attempt forbidden.")); }
                catch(IOException) { refused=true; }
                if(!refused || !(await File.ReadAllBytesAsync(path)).AsSpan().SequenceEqual(bytes))throw new IOException("Changed generated binding was not refused without rewriting the profile.");
            }
            await using(var session = OwnedExplorerRootSession.Generated(directory,root)) {
                bool called=false,refused=false;
                try { await session.RemoveConfirmedGeneratedAsync(binding,()=>{called=true;return false;},()=>throw new Exception("Native attempt forbidden.")); } catch(IOException){refused=true;}
                if(!called || !refused || !(await File.ReadAllBytesAsync(path)).AsSpan().SequenceEqual(bytes))throw new IOException("Changed held root/metadata was not refused.");
            }
            var newFile = Path.Combine(directory,"replacement.json");
            await File.WriteAllBytesAsync(newFile,bytes); File.Move(newFile,path,overwrite:true);
            await using(var session = OwnedExplorerRootSession.Generated(directory,root)) {
                bool refused=false; try { await session.RemoveConfirmedGeneratedAsync(binding,()=>true,()=>throw new Exception("Native attempt forbidden.")); } catch(IOException){refused=true;}
                if(!refused || !(await File.ReadAllBytesAsync(path)).AsSpan().SequenceEqual(bytes))throw new IOException("Replacement profile file was not refused.");
            }
            binding = binding with { ProfileFileIdentity=CandidateDirectoryFence.ObserveFile(path) };
            var replacement = JsonSerializer.SerializeToUtf8Bytes(new { Schema=2, Owner="LedgeTop.Files.ExplorerPreview/1", Sid=sid,
                Identity=identity, Root=root, Context="LedgeTop.Files.ExplorerPreview/1:"+identity.ToString("N"), Icon=icon,
                RootFileId=123L, Phase="Ready", Paused=true, Revision=1L, NamespaceClsid=ns });
            await using(var session = OwnedExplorerRootSession.Generated(directory,root)) {
                bool refused=false;
                try { await session.RemoveConfirmedGeneratedAsync(binding,()=>{File.WriteAllBytes(path,replacement);return true;},()=>throw new Exception("Native attempt forbidden.")); } catch(IOException){refused=true;}
                if(!refused || !(await File.ReadAllBytesAsync(path)).AsSpan().SequenceEqual(replacement))throw new IOException("Profile mutation during proof was not refused.");
            }
            Console.WriteLine("PASS generated confirmed binding rejects changed tuples and held proof before native calls; no native registration."); return 0;
        } finally {
            var lockPath=Path.Combine(directory,"session.lock"); if(File.Exists(lockPath))File.Delete(lockPath);
            if(File.Exists(path))File.Delete(path); if(Directory.Exists(directory))Directory.Delete(directory);
            if(Directory.Exists(root))Directory.Delete(root); if(Directory.Exists(temp))Directory.Delete(temp);
        }
    }
}
