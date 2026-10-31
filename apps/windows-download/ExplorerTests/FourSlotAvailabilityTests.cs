using System.Collections.Concurrent;
using LedgeTop.Files.Explorer;

internal static partial class FourSlotAvailabilityTests {
 static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
 static async Task Wait(Task t) => await t.WaitAsync(TimeSpan.FromSeconds(15));
 static void Need(bool x,string message) { if (!x) throw new Exception(message); }
 internal static async Task RunAsync() { await FourAndSupersession(); await SharedBoundAndPathGate(); await CancelWaitAndFailureGeneration(); await Drain(); await CombinedDrain(); Console.WriteLine("PASS 4 availability groups and 1 combined group (synthetic only)"); }
 static async Task FourAndSupersession() {
  var paths = new[]{"a","b","c","d","e"}; var current = new ConcurrentDictionary<string,AvailabilityObservation>();
  foreach(var p in paths) current[p]=new(AvailabilityIntent.Keep,true);
  var entered=paths.Select(_=>Signal()).ToArray(); var release=paths.Select(_=>Signal()).ToArray(); var calls=new ConcurrentQueue<string>(); int active=0,peak=0;
  var w=new BoundedAvailabilityWorkers(paths,p=>current[p],async(p,i,t)=>{ int n=Array.IndexOf(paths,p); int a=Interlocked.Increment(ref active); int old; do { old=Volatile.Read(ref peak); } while(a>old && Interlocked.CompareExchange(ref peak,a,old)!=old); calls.Enqueue(p+":"+i); entered[n].TrySetResult(); try {await release[n].Task;} finally {Interlocked.Decrement(ref active);} },_=>{});
  try { foreach(var p in paths.Take(4)) Need(w.Observe(p,current[p]),"schedule"); await Wait(Task.WhenAll(entered.Take(4).Select(x=>x.Task))); Need(active==4 && peak==4,"four enter");
   for (var i = 0; i < 100; i++) Need(!w.Observe("A", current["a"]), "running path deduplicates case-insensitively");
   Need(calls.Count(x => x.StartsWith("a:", StringComparison.Ordinal)) == 1, "repeated alternate-case observations do not launch a duplicate job");
   Need(w.Observe("e",current["e"]),"fifth queued"); Need(!entered[4].Task.IsCompleted,"fifth held"); current["e"]=new(AvailabilityIntent.Free,true); Need(!w.Observe("e",current["e"]),"dedup changed intent"); release[0].TrySetResult(); await Wait(w.WhenJoinedAsync("e")); Need(!calls.Any(x=>x.StartsWith("e:")),"stale keep dropped"); Need(w.Observe("e",current["e"]),"schedule free"); await Wait(entered[4].Task); Need(calls.Contains("e:Free"),"latest intent"); }
  finally {foreach(var x in release)x.TrySetResult(); await Wait(w.StopAndDrainAsync(()=>Task.CompletedTask,()=>Task.CompletedTask));}
 }
 static async Task SharedBoundAndPathGate() {
  var names=new[]{"a","b","c","d","e"}; var entered=names.Select(_=>Signal()).ToArray(); var release=names.Select(_=>Signal()).ToArray(); var same=Signal(); var history=new ConcurrentQueue<string>();
  var w=new BoundedAvailabilityWorkers(names,_=>new(AvailabilityIntent.Keep,true),async(p,_,_)=>{history.Enqueue("keep-start"); entered[0].TrySetResult(); await release[0].Task; history.Enqueue("keep-end");},_=>{}); var tasks=new List<Task>();
  try {w.Observe("a",new(AvailabilityIntent.Keep,true)); await Wait(entered[0].Task); tasks.Add(w.RunExclusiveAsync("a",_=>{history.Enqueue("free"); same.TrySetResult(); return Task.CompletedTask;})); for(int j=1;j<5;j++){int n=j; tasks.Add(w.RunExclusiveAsync(names[n],async _=>{entered[n].TrySetResult(); await release[n].Task;}));} await Wait(Task.WhenAll(entered.Skip(1).Take(3).Select(x=>x.Task))); Need(!entered[4].Task.IsCompleted && !same.Task.IsCompleted,"shared four cap and per-path gate"); release[1].TrySetResult(); await Wait(entered[4].Task); Need(!same.Task.IsCompleted,"same file cannot overlap"); release[0].TrySetResult(); await Wait(same.Task); Need(history.SequenceEqual(new[]{"keep-start","keep-end","free"}),"same path sequence"); }
  finally {foreach(var x in release)x.TrySetResult(); await Wait(w.StopAndDrainAsync(()=>Task.CompletedTask,async()=>{try{await Task.WhenAll(tasks);}catch(OperationCanceledException){}}));}
 }
 static async Task Drain() {
  var paths=new[]{"a","b","c","d","e"}; var entered=paths.Select(_=>Signal()).ToArray(); var release=paths.Select(_=>Signal()).ToArray(); var disconnected=Signal(); int calls=0;
  var w=new BoundedAvailabilityWorkers(paths,_=>new(AvailabilityIntent.Keep,true),async(p,_,_)=>{int n=Array.IndexOf(paths,p); Interlocked.Increment(ref calls); entered[n].TrySetResult(); await release[n].Task;},_=>{});
  foreach(var p in paths.Take(4)) w.Observe(p,new(AvailabilityIntent.Keep,true)); await Wait(Task.WhenAll(entered.Take(4).Select(x=>x.Task))); w.Observe("e",new(AvailabilityIntent.Keep,true));
  var stop=w.StopAndDrainAsync(()=>{disconnected.TrySetResult(); foreach(var x in release.Take(3))x.TrySetResult(); return Task.CompletedTask;},()=>Task.CompletedTask);
  try {await Wait(disconnected.Task); Need(!stop.IsCompleted && !entered[4].Task.IsCompleted,"disconnect before join, queued not executed"); Need(!w.Observe("e",new(AvailabilityIntent.Free,true)),"stopped admission"); release[3].TrySetResult(); await Wait(stop); Need(calls==4 && w.WhenJoinedAsync("e").IsCompleted,"all active joined, queued settled"); Need(ReferenceEquals(stop,w.StopAndDrainAsync(()=>throw new Exception(),()=>Task.CompletedTask)),"stop idempotent"); }
  finally {foreach(var x in release)x.TrySetResult(); await Wait(stop);}
 }
 static async Task CancelWaitAndFailureGeneration() {
  var current=new AvailabilityObservation(AvailabilityIntent.Keep,true); var entered=Signal(); var release=Signal(); int attempts=0;
  var w=new BoundedAvailabilityWorkers(new[]{"same"},_=>current,async(_,_,_)=>{Interlocked.Increment(ref attempts); entered.TrySetResult(); await release.Task; throw new IOException("synthetic failure");},_=>{});
  using var cts=new CancellationTokenSource(); Task? waiter=null;
  try {Need(w.Observe("same",current),"initial keep"); await Wait(entered.Task); waiter=w.RunExclusiveAsync("same",_=>throw new Exception("cancelled waiter entered"),cts.Token); cts.Cancel(); try {await Wait(waiter); throw new Exception("waiter did not cancel");} catch(OperationCanceledException){} release.TrySetResult(); await Wait(w.WhenJoinedAsync("same")); Need(!w.Observe("same",current),"failed keep suppressed"); current=new(AvailabilityIntent.Free,true); Need(w.Observe("same",current),"new free accepted"); await Wait(w.WhenJoinedAsync("same")); Need(attempts==2,"only two distinct attempts"); }
  finally {release.TrySetResult(); await Wait(w.StopAndDrainAsync(()=>Task.CompletedTask,async()=>{if(waiter is not null)try{await waiter;}catch(OperationCanceledException){}}));}
 }
}
