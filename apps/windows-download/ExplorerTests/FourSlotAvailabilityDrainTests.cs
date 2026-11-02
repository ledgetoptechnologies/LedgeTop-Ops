using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;
internal static partial class FourSlotAvailabilityTests {
 static async Task CombinedDrain() {
  var paths=new[]{"a","b","c","d","e"}; var entered=paths.Select(_=>Signal()).ToArray(); var release=Signal(); var callbacksDrained=Signal(); var disconnected=Signal(); int completed=0, nativeCalls=0; string root=Guid.NewGuid().ToString();
  // Fake blocking native Keep waits on a fake FETCH_DATA callback; callback takes the
  // independent hydration lease. This is a scheduling model, not CFAPI behavior.
  var w=new BoundedAvailabilityWorkers(paths,_=>new(AvailabilityIntent.Keep,true),async(p,_,_)=>{
   Interlocked.Increment(ref nativeCalls);
   var callback=Task.Run(async()=>{using var lease=await HydrationCacheConcurrency.AcquireAsync(root,p,CancellationToken.None); entered[Array.IndexOf(paths,p)].TrySetResult(); await release.Task; if(Interlocked.Increment(ref completed)==4) callbacksDrained.TrySetResult();});
   await callback;
  },_=>{});
  try {
   foreach(var p in paths.Take(4)) Need(w.Observe(p,new(AvailabilityIntent.Keep,true)),"admit four Keeps");
   await Wait(Task.WhenAll(entered.Take(4).Select(x=>x.Task)));
   Need(w.Observe("e",new(AvailabilityIntent.Keep,true)) && !entered[4].Task.IsCompleted,"fifth availability remains queued");
   // CloudFilesConnectionOwner.StopCoreAsync first stops/drains the dispatcher,
   // then disconnects native. Model cancellation of fake callback work before
   // native disconnect; do not assume disconnect happens before callback drain.
   var stop=w.StopAndDrainAsync(async()=>{release.TrySetResult(); await callbacksDrained.Task; disconnected.TrySetResult();},()=>Task.CompletedTask);
   await Wait(stop); Need(disconnected.Task.IsCompleted && completed==4 && nativeCalls==4 && w.WhenJoinedAsync("e").IsCompleted,"callbacks drained before disconnect, active work joined and queued work settled");
   // All four hydration permits and root ownership must be recoverable after the drain.
   var leases=new List<HydrationCacheConcurrency.Lease>(); try {for(int n=0;n<4;n++) leases.Add(await HydrationCacheConcurrency.AcquireAsync(root,"after"+n,CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(15))); Need(leases.Count==4,"all hydration permits recover");} finally {foreach(var l in leases)l.Dispose();}
  } finally {release.TrySetResult(); await Wait(w.StopAndDrainAsync(()=>Task.CompletedTask,()=>Task.CompletedTask));}
 }
}
