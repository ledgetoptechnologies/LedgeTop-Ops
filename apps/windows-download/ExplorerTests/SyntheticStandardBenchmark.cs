#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Diagnostics;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Generated content, fake employee HTTP and actual unmodified coordinator/cache.
// Always requires the supervisor's kill-on-close job; never accepts a user root.
internal static class SyntheticStandardBenchmark {
    private const int Length = 100 * 1024 * 1024;
    private const string Digest = "5b05b298e974f3b9e40f0a1a8188f50984a4f18fb329e050324296632d3d9dfc";
    private const string Principal = "odqp1_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    private static void Need(bool value, string message) { if (!value) throw new IOException(message); }
    private static bool MatchedReaderOutput(string text, int pid) {
        if(text.Length>256) return false;
        var match=Regex.Match(text,@"\ASynthetic standard reader: outcome=matched; elapsedMs=[0-9]+; pid=([0-9]+)\r?\n?\z",RegexOptions.CultureInvariant);
        return match.Success && int.TryParse(match.Groups[1].Value,out var reported) && reported==pid;
    }
    private static byte[] Expected() => Convert.FromHexString(Digest);
    internal static int Tests() {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); var block = new byte[1024*1024]; Array.Fill(block, (byte)'x');
        for (var i=0;i<100;i++) hash.AppendData(block);
        Need(CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), Expected()), "Synthetic benchmark digest differs.");
        Need(MatchedReaderOutput("Synthetic standard reader: outcome=matched; elapsedMs=42; pid=17\r\n",17),"Reader evidence rejected.");
        Need(!MatchedReaderOutput("Synthetic standard reader: outcome=matched; elapsedMs=42; pid=18\n",17) &&
             !MatchedReaderOutput("Synthetic standard reader: outcome=matched; elapsedMs=42; pid=17\nextra",17) &&
             !MatchedReaderOutput("Synthetic standard reader: outcome=IOException; elapsedMs=42; pid=17\n",17),"Invalid reader evidence accepted.");
        Console.WriteLine("PASS synthetic standard benchmark digest."); return 0;
    }
    internal static int Reader(string path, string gate, string ready) {
        if (Environment.GetEnvironmentVariable("LEDGETOP_STANDARD_BENCH_READER") != "1") return 2;
        try {
            SyntheticBusySupervisor.AwaitAndVerify();
            using var start=EventWaitHandle.OpenExisting(gate); using var prepared=EventWaitHandle.OpenExisting(ready);
            prepared.Set(); if(!start.WaitOne(TimeSpan.FromSeconds(20))) throw new TimeoutException();
            var clock=Stopwatch.StartNew(); using var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
            Need(file.Length==Length,"Synthetic benchmark size differs."); var hash=SHA256.HashData(file);
            Need(CryptographicOperations.FixedTimeEquals(hash,Expected()),"Synthetic benchmark hash differs.");
            Console.WriteLine($"Synthetic standard reader: outcome=matched; elapsedMs={clock.ElapsedMilliseconds}; pid={Environment.ProcessId}"); return 0;
        } catch(Exception e) when(e is IOException or UnauthorizedAccessException or TimeoutException) { Console.WriteLine($"Synthetic standard reader: outcome={e.GetType().Name}; hresult=0x{e.HResult:X8}"); return 1; }
    }
    internal static async Task<int> RunAsync(int count, bool memory) {
#if !LEDGETOP_MEMORY_HYDRATION
        if(memory) throw new InvalidOperationException("Synthetic memory test build is required.");
#endif
        if(count is <1 or >2) throw new ArgumentOutOfRangeException(nameof(count));
        SyntheticBusySupervisor.AwaitAndVerify();
        var basePath=Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Need local task artifact root.");
        if(!Path.IsPathFullyQualified(basePath)||basePath.StartsWith(@"\\",StringComparison.Ordinal)) throw new IOException("Need local task artifact root.");
        basePath=Path.GetFullPath(basePath);
        for(string? part=basePath;part is not null;part=Path.GetDirectoryName(part)) if((File.GetAttributes(part)&FileAttributes.ReparsePoint)!=0) throw new IOException("Artifact ancestor is an alias.");
        foreach(var key in new[]{"LEDGETOP_SYNTHETIC_MEMORY_PROBE","LEDGETOP_TEST_BLOCK_SELF_IMPLICIT_HYDRATION","LEDGETOP_TEST_DISABLE_AVAILABILITY_SCANNER","LEDGETOP_TEST_SUPPRESS_NATIVE_PROGRESS"}) if(Environment.GetEnvironmentVariable(key)=="1") throw new IOException("Default provider flags required.");
        var executable=Environment.ProcessPath ?? throw new IOException("Need test apphost."); if(Path.GetFileNameWithoutExtension(executable).Equals("dotnet",StringComparison.OrdinalIgnoreCase)) throw new IOException("Need self-contained test apphost.");
        using var self=Process.GetCurrentProcess();var parentStart=self.StartTime.ToUniversalTime().Ticks; var id=Guid.NewGuid();
        var owned=Path.Combine(basePath,"standard-benchmark-fixtures",id.ToString("N"));var root=Path.Combine(owned,"Files");var legacyCache=Path.Combine(owned,"Cache");
        var cache=legacyCache;
        if(Directory.Exists(owned)||File.Exists(owned)) throw new IOException("Fixture already exists."); Directory.CreateDirectory(root);Directory.CreateDirectory(legacyCache);
        var helper=Path.Combine(owned,"synthetic-helper.bin"); await File.WriteAllTextAsync(helper,"synthetic; never executed");
        var session=new CloudflareAccessSession(new Uri("https://source.example.invalid/portal/"),helper,Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(helper))),new Runner());
        var payload=new byte[Length]; Array.Fill(payload,(byte)'x');
        var entries=Enumerable.Range(0,count).Select(i=>new PlaceholderIdentity("pilot","staff","https://source.example.invalid",Principal,"odqr1_"+i,"oef1_"+new string((char)('a'+i),64),Digest,$"sample-{i}.bin",Length,"\""+Digest+"\"",Digest)).ToArray();
        var state=new State(entries,payload); var downloader=new Downloader(new Data(state),[session.Origin],session:session);
#if LEDGETOP_MEMORY_HYDRATION
        var oldMaximum=PlaceholderHydrationCoordinator.MemoryHydrationMaxBytes;
        if(!memory) PlaceholderHydrationCoordinator.MemoryHydrationMaxBytes=0;
#else
        if(memory) throw new InvalidOperationException("Memory test build is required.");
#endif
        var source=new EmployeeQueuedDownloadSource("staff",session,new Metadata(state),downloader);
        IPreviewRootRegistration? registration=null;NativePlaceholderProvider? provider=null;var children=new List<Process>();var readerOutputs=new List<Task<string>>();var readies=new List<EventWaitHandle>();var failures=new List<string>();
        var readersJoined=true;var readerOutcomesVerified=false;var providerDrained=false;var unregisterVerified=false;var traceComplete=false;
        using var gate=new EventWaitHandle(false,EventResetMode.ManualReset,"LedgeTopBusyStart-"+id.ToString("N"));
        var trace=NativeStallTrace.Enable();var seen=new HashSet<long>();
        try {
            var context=Encoding.UTF8.GetBytes("LedgeTop.Files.StandardBenchmark.v1:"+id);
            registration=SyntheticRegistrationIntent.Register(owned,root,id,context,()=>NativeRootRegistration.Register(root,context));
            provider=new NativePlaceholderProvider(registration,cache,source,"pilot",Principal,entries.ToDictionary(e=>e.FileName,StringComparer.OrdinalIgnoreCase),[]);
            provider.Activity+=message=>Console.WriteLine(message); await provider.ConnectAndPopulateAsync();
            for(var i=0;i<count;i++) {
                var readyName="LedgeTopBusyReady-"+id.ToString("N")+"-"+i; readies.Add(new EventWaitHandle(false,EventResetMode.ManualReset,readyName));
                var info=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true}; info.Environment["LEDGETOP_STANDARD_BENCH_READER"]="1";
                info.ArgumentList.Add("--synthetic-standard-benchmark-reader");info.ArgumentList.Add(Path.Combine(root,entries[i].FileName));info.ArgumentList.Add("LedgeTopBusyStart-"+id.ToString("N"));info.ArgumentList.Add(readyName);
                SyntheticBusySupervisor.WriteRecord(owned,$"reader-{i}-intent.json",new{schema=1,fixtureId=id,parentPid=Environment.ProcessId,parentStartUtcTicks=parentStart,index=i,executable=Path.GetFullPath(executable),file=Path.Combine(root,entries[i].FileName)});
                var child=Process.Start(info)??throw new IOException("Synthetic reader unavailable.");children.Add(child);readerOutputs.Add(child.StandardOutput.ReadToEndAsync());SyntheticBusySupervisor.VerifyChild(child);var image=SyntheticBusySupervisor.VerifyImage(child,executable);
                SyntheticBusySupervisor.WriteRecord(owned,$"reader-{i}-started.json",new{schema=1,fixtureId=id,parentPid=Environment.ProcessId,parentStartUtcTicks=parentStart,index=i,pid=child.Id,startUtcTicks=child.StartTime.ToUniversalTime().Ticks,executable=image});
            }
            Need(WaitHandle.WaitAll(readies.ToArray(),TimeSpan.FromSeconds(15)),"Synthetic readers did not reach their gate.");
            var clock=Stopwatch.StartNew();gate.Set();await Task.WhenAll(children.Select(p=>p.WaitForExitAsync())).WaitAsync(TimeSpan.FromSeconds(180));
            Need(children.All(p=>p.ExitCode==0),"A synthetic reader failed; consult reader outcome.");
            var outcomes=await Task.WhenAll(readerOutputs).WaitAsync(TimeSpan.FromSeconds(10));
            for(var i=0;i<outcomes.Length;i++) {
                Need(MatchedReaderOutput(outcomes[i],children[i].Id),"Synthetic reader hash outcome was not captured.");
                Console.WriteLine($"Reader {i}: {outcomes[i].Trim()}");
            }
            readerOutcomesVerified=true;
            Need(state.Downloads==count,"Unexpected synthetic download count.");
            Need(entries.All(e=>state.Resolutions.TryGetValue(e.ResourceReference,out var n) && n>=2),"Before/after authorization resolutions were not observed for each reader.");
            Console.WriteLine($"Synthetic standard benchmark: readers={count}; bytesEach={Length}; readerWallMs={clock.ElapsedMilliseconds}; downloads={state.Downloads}; source=in-memory; busyResponses=0");
        } catch(Exception e) { failures.Add(e.GetType().Name+": "+e.Message);Console.Error.WriteLine(e); }
        finally {
            foreach(var child in children) try { if(!child.HasExited){child.Kill();await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));} if(!child.HasExited)readersJoined=false; } catch {readersJoined=false;}
            foreach(var child in children)child.Dispose();foreach(var ready in readies)ready.Dispose();
            if(provider is null)providerDrained=true;else try{await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20));providerDrained=true;}catch{failures.Add("Provider drain unverified.");}
            if(registration is not null&&readersJoined&&providerDrained)try{registration.Unregister();unregisterVerified=true;}catch{failures.Add("Unregister unverified.");}
            if(readersJoined&&providerDrained) try { source.Dispose(); } catch { failures.Add("Synthetic source disposal unverified."); }
            foreach(var item in NativeStallTrace.Snapshot(trace))if(seen.Add(item.Sequence))Console.WriteLine($"Native trace: seq={item.Sequence}; timestamp={item.Timestamp}; thread={item.ThreadId}; stage={item.Kind}");
#if LEDGETOP_MEMORY_HYDRATION
            var attempts=PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest;
            var completed=PlaceholderHydrationCoordinator.MemoryHydrationsForTest;
            if(memory ? attempts!=count || completed!=count : attempts!=0 || completed!=0) failures.Add("Synthetic memory path count differs.");
            if(providerDrained) PlaceholderHydrationCoordinator.MemoryHydrationMaxBytes=oldMaximum;
#else
            const int attempts=0, completed=0;
#endif
            traceComplete=readersJoined&&providerDrained&&NativeStallTrace.Dropped(trace)==0&&NativeStallTrace.Attempted(trace)==seen.Count;
            Console.WriteLine($"Native trace snapshot: attempted={NativeStallTrace.Attempted(trace)}; observed={seen.Count}; dropped={NativeStallTrace.Dropped(trace)}");NativeStallTrace.Disable(trace);
            if(!readersJoined||!providerDrained||!unregisterVerified||!traceComplete)failures.Add("Synthetic cleanup or trace unverified; fixture retained.");
            await File.WriteAllTextAsync(Path.Combine(owned,"receipt.json"),JsonSerializer.Serialize(new{id,count,synthetic=true,memory,attempts,completed,downloads=state.Downloads,resolvesPerEntry=entries.Select(e=>state.Resolutions.GetValueOrDefault(e.ResourceReference)).ToArray(),bytesEach=Length,readersJoined,readerOutcomesVerified,providerDrained,unregisterVerified,traceComplete,failures},new JsonSerializerOptions{WriteIndented=true}));
        }
        Console.WriteLine(JsonSerializer.Serialize(new{passed=failures.Count==0,fixture=owned,failures}));return failures.Count==0?0:1;
    }
    private sealed class State(PlaceholderIdentity[] entries,byte[] payload){internal readonly Dictionary<string,PlaceholderIdentity> Entries=entries.ToDictionary(e=>e.ResourceReference,StringComparer.Ordinal);internal readonly ConcurrentDictionary<string,int> Resolutions=new(StringComparer.Ordinal);internal readonly byte[] Payload=payload;internal int Downloads;}
    private sealed class Metadata(State state):HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){var reference=Uri.UnescapeDataString(request.RequestUri!.Query["?resourceRef=".Length..]);var entry=state.Entries[reference];state.Resolutions.AddOrUpdate(reference,1,(_,n)=>checked(n+1));var body=new{schemaVersion=1,principalId=Principal,manifest=new{schemaVersion=1,logicalFileId=entry.LogicalFileId,remoteVersion=Digest,strongETag="\""+Digest+"\"",size=Length,sha256=Digest,name=entry.FileName,downloadPath="/api/staff/files/downloads/eof1_"+reference,expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+600}};return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json")});}}
    private sealed class Data(State state):HttpMessageHandler {protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){Interlocked.Increment(ref state.Downloads);var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(state.Payload)};response.Headers.ETag=EntityTagHeaderValue.Parse("\""+Digest+"\"");return Task.FromResult(response);}}
    private sealed class Runner:IAccessCommandRunner {public Task<AccessCommandResult> RunAsync(string path,IReadOnlyList<string> args,CancellationToken token){var body=Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new{sub="synthetic",exp=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600})).TrimEnd('=').Replace('+','-').Replace('/','_');return Task.FromResult(new AccessCommandResult(0,"eyJhbGciOiJSUzI1NiJ9."+body+".c2ln",""));}}
}
#endif
