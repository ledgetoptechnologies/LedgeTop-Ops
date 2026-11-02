using System.Text;
using LedgeTop.Files.Explorer.IdentityRefresh;

namespace LedgeTop.Files.Explorer.Tests.IdentityRefresh;

internal static class IdentityRefreshTransactionTests {
    internal static async Task<int> RunAsync(){
var tests=new (string Name,Func<Task> Run)[]{
    ("default deny and explicit canonical/content proof",Tests.Admission),
    ("clean same-root identity-only commit preserves metadata/data/ranges",Tests.Complete),
    ("every durable/native/binding interruption recovers forward explicitly",Tests.Interruptions),
    ("failed native calls always read back and record observed outcome",Tests.NativeFailures),
    ("journal durability failures block effects or retain recoverable intent",Tests.JournalFailures),
    ("dirty replaced foreign metadata pin range and alias states hold",Tests.LocalFences),
    ("cross-owner root source principal and binding mismatches hold",Tests.OwnerFences),
    ("expiry during native effect preserves postimage and stops forward work",Tests.Expiry),
    ("mixed-state observation is read-only and requires explicit resume",Tests.Mixed),
    ("journal corruption and third identities never become recovery aliases",Tests.Corrupt),
    ("online-only partial and full data require independent full-content proof",Tests.Availability),
    ("schema3 omission and schema4 exact display compatibility retained",Tests.Compatibility)
    ,("metadata port races cancellation and readback uncertainty remain held",Tests.PortFences)
    ,("OS ChangeTime separately classified while exact user-visible metadata stays fenced",Tests.ChangeTime)
    ,("recorded-new postimages cannot revert to old or authorize another intent",Tests.RecordedPostImageDrift)
};
var passed=0;foreach(var test in tests){try{await test.Run();passed++;Console.WriteLine("PASS "+test.Name);}catch{Console.Error.WriteLine("FAIL "+test.Name);}}
Console.WriteLine($"{passed}/{tests.Length} managed identity-refresh groups passed; no filesystem/native/auth/backend operations invoked.");return passed==tests.Length?0:1;

    }
}

internal static class Tests {
    internal static void Require(bool value){if(!value)throw new Exception("Managed synthetic assertion failed.");}
    private static void Held(Outcome value,HoldReason? reason=null){Require(value.Kind==ResultKind.Held && (reason is null || value.Reason==reason));}
    private static ExplicitResume Consent(Fixture f)=>new(f.Plan.TransactionId,f.Plan.Digest,true);
    internal static async Task Admission(){
        var f=new Fixture();Held(await f.Engine(withAuthority:false).BeginAsync(f.Plan),HoldReason.AuthorityDenied);f.NoEffects();
        foreach(var change in new Action<Fixture>[] {
            x=>x.Authority.ReturnNull=true,x=>x.Authority.Canonical=false,x=>x.Authority.Content=false,x=>x.Authority.WrongPlan=true,
            x=>x.Authority.WrongRoot=true,x=>x.Authority.WrongPrincipal=true,x=>x.Authority.Expires=x.Clock.Now.AddSeconds(4),
            x=>x.Authority.ScopeOverride=x.Plan.Root.Scope with{Alias="portal"},x=>x.Authority.WrongContent=true,x=>x.Authority.WrongContentLength=true
        }){f=new();change(f);Held(await f.Engine().BeginAsync(f.Plan));f.NoEffects();}
    }
    internal static async Task Complete(){
        foreach(var schema in new[]{3,4}){var f=new Fixture(schema:schema);var before=f.LocalState();var result=await f.Engine().BeginAsync(f.Plan);Require(result.Kind==ResultKind.Completed && f.Binding.Current==f.Plan.NewBinding && f.Surface.Updates==2 && f.Surface.Readbacks==2);
            Require(f.Plan.Root.ExistingSchema==schema && before==f.LocalState() && f.Manifests.PairRetained && f.Surface.DataWrites==0);
            for(var i=0;i<2;i++){var intent=f.Events.FindIndex(e=>e=="flush:UpdateIntent:"+i);var effect=f.Events.FindIndex(e=>e=="native:"+i);var read=f.Events.FindIndex(e=>e=="readback:"+i);var post=f.Events.FindIndex(e=>e=="flush:PostImage:"+i);Require(intent<effect && effect<read && read<post);}
            Require(f.Events.FindIndex(e=>e=="flush:CommitIntent:")<f.Events.IndexOf("binding-commit"));
            var calls=f.Authority.Calls;Require((await f.Engine(withAuthority:false).ObserveAsync(f.Plan)).Kind==ResultKind.Completed && f.Authority.Calls==calls);
        }
    }
    internal static async Task Interruptions(){
        var points=new List<string>{"BeforePrepared","AfterPrepared","BeforeCommitIntent","AfterCommitIntent","BeforeBindingCommit","AfterBindingCommit","AfterCommitted"};
        foreach(var i in new[]{0,1})foreach(var name in new[]{"BeforeUpdateIntent","AfterUpdateIntent","AfterNativeEffect","AfterPostImage"})points.Add(name+":"+i);
        foreach(var point in points){var f=new Fixture();var baseline=f.LocalState();f.Hook.Action=(name,index)=>{if(name+(index is null?"":":"+index)==point)throw new IOException("synthetic interrupted process");};
            Held(await f.Engine().BeginAsync(f.Plan));f.Hook.Action=null;var updates=f.Surface.Updates;
            var observed=await f.Engine(withAuthority:false).ObserveAsync(f.Plan);Require(f.Surface.Updates==updates);
            var resumed=f.Journal.Records.Count==0?await f.Engine().BeginAsync(f.Plan):await f.Engine().ResumeAsync(f.Plan,Consent(f));
            Require(resumed.Kind==ResultKind.Completed && f.Surface.Updates==2 && f.LocalState()==baseline && f.Binding.Current==f.Plan.NewBinding);
            if(point=="AfterNativeEffect:0")Require(f.Journal.Records.Any(r=>r.Kind==RecordKind.RecoveredPostImage && r.EntryIndex==0));
            Require(observed.Kind==ResultKind.Held || point=="AfterCommitted");
        }
    }
    internal static async Task NativeFailures(){
        foreach(var mode in new[]{"throw-before","throw-after","return-failure-old","return-failure-new","success-no-effect"}){
            var f=new Fixture();f.Surface.FailMode=mode;Held(await f.Engine().BeginAsync(f.Plan),HoldReason.NativeFailure);
            Require(f.Surface.Readbacks==1 && f.Journal.Records.Any(r=>r.Kind==RecordKind.PostImage) && f.Binding.Current==f.Plan.OldBinding && f.Surface.DataWrites==0);
            f.Surface.FailMode=null;Require((await f.Engine().ResumeAsync(f.Plan,Consent(f))).Kind==ResultKind.Completed);
            Require(f.Surface.ActualMutations==2); // No rollback/reapplication of already-new file.
        }
    }
    internal static async Task JournalFailures(){
        foreach(var sequence in new[]{1,2,3,4,5,6,7})foreach(var after in new[]{false,true}){
            var f=new Fixture();f.Journal.FailSequence=sequence;f.Journal.FailAfterAppend=after;
            Held(await f.Engine().BeginAsync(f.Plan));if(sequence==2 && !after)Require(f.Surface.Updates==0);
            f.Journal.FailSequence=null;
            var resumed=f.Journal.Records.Count==0?await f.Engine().BeginAsync(f.Plan):await f.Engine().ResumeAsync(f.Plan,Consent(f));
            Require(resumed.Kind==ResultKind.Completed && f.Surface.ActualMutations==2 && f.Surface.DataWrites==0);
        }
        var binding=new Fixture();binding.Binding.ThrowAfterCommit=true;Held(await binding.Engine().BeginAsync(binding.Plan));Require(binding.Binding.Current==binding.Plan.NewBinding);
        binding.Binding.ThrowAfterCommit=false;Require((await binding.Engine().ResumeAsync(binding.Plan,Consent(binding))).Kind==ResultKind.Completed && binding.Surface.Updates==2);
    }
    internal static async Task LocalFences(){
        foreach(var change in new Func<EntryImage,EntryImage>[] {
            x=>x with{Clean=false},x=>x with{FileId=999},x=>x with{NoAliases=false},x=>x with{Placeholder=false},
            x=>x with{MetadataSha256=Canonical.Hash("changed")},x=>x with{ExistingRangeDataSha256=Canonical.Hash("changed")},
            x=>x with{PinStateSha256=Canonical.Hash("changed")},x=>x with{RangeMapSha256=Canonical.Hash("changed")},
            x=>x with{ObservedUsn=x.ObservedUsn+1},x=>x with{Identity=new Descriptor("foreign"u8.ToArray())}
        }){var f=new Fixture();f.Surface.Images[0]=change(f.Surface.Images[0]);Held(await f.Engine().BeginAsync(f.Plan));f.NoEffects();}
        var race=new Fixture();race.Surface.AfterEffect=(i)=>race.Surface.Images[i]=race.Surface.Images[i] with{Clean=false};
        Held(await race.Engine().BeginAsync(race.Plan),HoldReason.Dirty);Require(race.Surface.Readbacks==1 && race.Journal.Records.Last().Kind==RecordKind.PostImage && race.Binding.Current==race.Plan.OldBinding);
    }
    internal static async Task OwnerFences(){
        foreach(var change in new Func<RootObservation,RootObservation>[] {
            x=>x with{OwnershipVerified=false},x=>x with{NoAliasesVerified=false},x=>x with{CallbacksAndAvailabilityDrained=false},
            x=>x with{Pins=x.Pins with{RootFileId=99}},x=>x with{Pins=x.Pins with{ContextSha256=Canonical.Hash("different")}},
            x=>x with{Pins=x.Pins with{NamespaceClsid=Guid.NewGuid()}},x=>x with{Pins=x.Pins with{Scope=x.Pins.Scope with{Principal="other"}}}
        }){var f=new Fixture();f.Surface.Root=change(f.Surface.Root);Held(await f.Engine().BeginAsync(f.Plan),HoldReason.OwnerMismatch);f.NoEffects();}
        var foreign=new Fixture();foreign.Binding.Current=new("foreign.json",Canonical.Hash("foreign"),3);var foreignBinding=foreign.Binding.Current;Held(await foreign.Engine().BeginAsync(foreign.Plan),HoldReason.BindingMismatch);Require(foreign.Surface.Updates==0 && foreign.Journal.Records.Count==0 && foreign.Binding.Current==foreignBinding);
        var missing=new Fixture();missing.Manifests.PairRetained=false;Held(await missing.Engine().BeginAsync(missing.Plan),HoldReason.PlanInvalid);missing.NoEffects();
    }
    internal static async Task Expiry(){
        var f=new Fixture();var bytes=f.LocalState();f.Surface.AfterEffect=_=>f.Clock.Now=f.Authority.Expires;
        Held(await f.Engine().BeginAsync(f.Plan),HoldReason.AuthorityExpired);Require(f.Surface.Updates==1 && f.Surface.Readbacks==1 && f.Journal.Records.Last().Kind==RecordKind.PostImage && f.LocalState()==bytes && f.Binding.Current==f.Plan.OldBinding);
        Held(await f.Engine().ResumeAsync(f.Plan,Consent(f)),HoldReason.AuthorityExpired);Require(f.Surface.Updates==1);
        f.Surface.AfterEffect=null;f.Authority.Expires=f.Clock.Now.AddMinutes(10);Require((await f.Engine().ResumeAsync(f.Plan,Consent(f))).Kind==ResultKind.Completed);
        f=new Fixture();f.Hook.Action=(name,_)=>{if(name=="BeforeBindingCommit")f.Clock.Now=f.Authority.Expires;};
        Held(await f.Engine().BeginAsync(f.Plan),HoldReason.AuthorityExpired);Require(f.Binding.Current==f.Plan.OldBinding && f.Surface.Updates==2);
    }
    internal static async Task Mixed(){
        var f=new Fixture();f.Hook.Action=(name,index)=>{if(name=="AfterPostImage" && index==0)throw new IOException();};Held(await f.Engine().BeginAsync(f.Plan));f.Hook.Action=null;
        var count=f.Journal.Records.Count;var calls=f.Authority.Calls;
        var observed=await f.Engine(withAuthority:false).ObserveAsync(f.Plan);Held(observed,HoldReason.ExplicitResumeRequired);Require(observed.OldEntries==1 && observed.NewEntries==1 && count==f.Journal.Records.Count && calls==f.Authority.Calls && f.Surface.Updates==1);
        Held(await f.Engine().BeginAsync(f.Plan),HoldReason.ExplicitResumeRequired);
        Held(await f.Engine().ResumeAsync(f.Plan,new(f.Plan.TransactionId,f.Plan.Digest,false)),HoldReason.ExplicitResumeRequired);
        Held(await f.Engine().ResumeAsync(f.Plan,new(Guid.NewGuid(),f.Plan.Digest,true)),HoldReason.ExplicitResumeRequired);
        Require((await f.Engine().ResumeAsync(f.Plan,Consent(f))).Kind==ResultKind.Completed && f.Surface.Updates==2);
    }
    internal static async Task Corrupt(){
        foreach(var change in new Action<Fixture>[] {
            f=>f.Journal.Records[0]=f.Journal.Records[0] with{Sequence=3},f=>f.Journal.Records[0]=f.Journal.Records[0] with{PlanDigest=Canonical.Hash("foreign")},
            f=>f.Surface.Images[0]=f.Surface.Images[0] with{Identity=new Descriptor("third identity"u8.ToArray())},
            f=>f.Surface.Images[0]=f.Surface.Images[0] with{PinStateSha256=Canonical.Hash("user changed pin")}
        }){var f=new Fixture();f.Hook.Action=(name,index)=>{if(name=="AfterPostImage" && index==0)throw new IOException();};await f.Engine().BeginAsync(f.Plan);f.Hook.Action=null;change(f);
            Held(await f.Engine().ObserveAsync(f.Plan));Held(await f.Engine().ResumeAsync(f.Plan,Consent(f)));Require(f.Surface.Updates==1 && f.Binding.Current==f.Plan.OldBinding);}
    }
    internal static async Task Availability(){
        foreach(var availability in Enum.GetValues<Availability>()){
            var f=new Fixture(availability:availability);var local=f.LocalState();Require((await f.Engine().BeginAsync(f.Plan)).Kind==ResultKind.Completed && f.LocalState()==local && f.Surface.DataWrites==0 && f.Surface.PlaceholderDataReads==0);
            f=new(availability:availability);f.Authority.Content=false;Held(await f.Engine().BeginAsync(f.Plan),HoldReason.ProofMismatch);f.NoEffects();
        }
    }
    internal static Task Compatibility(){
        Require(ExistingProfileCompatibility.Accept(3,"employee",false,null) && !ExistingProfileCompatibility.Accept(3,"employee",true,"LedgeTop Files — Company files"));
        Require(!ExistingProfileCompatibility.Accept(3,"employee",true,null));
        Require(!ExistingProfileCompatibility.Accept(3,"employee",false,"LedgeTop Files — Company files"));
        Require(ExistingProfileCompatibility.Accept(4,"employee",true,"LedgeTop Files — Company files") && !ExistingProfileCompatibility.Accept(4,"employee",true,null));
        Require(!ExistingProfileCompatibility.Accept(4,"employee",false,"LedgeTop Files — Company files"));
        Require(ExistingProfileCompatibility.Accept(4,"portal",true,"LedgeTop Files — Client deliveries") && !ExistingProfileCompatibility.Accept(4,"portal",true,"LedgeTop Files — Company files"));
        Require(!ExistingProfileCompatibility.Accept(2,"employee",false,null) && !ExistingProfileCompatibility.Accept(5,"employee",true,"LedgeTop Files — Company files"));return Task.CompletedTask;
    }
    internal static async Task PortFences(){
        var f=new Fixture();f.Hook.Action=(name,index)=>{if(name=="AfterUpdateIntent" && index==0)f.Surface.Images[0]=f.Surface.Images[0] with{MetadataSha256=Canonical.Hash("raced after intent")};};
        Held(await f.Engine().BeginAsync(f.Plan));Require(f.Surface.ActualMutations==0 && f.Surface.Readbacks==1 && f.Journal.Records.Last().Kind==RecordKind.PostImage);
        f=new();f.Surface.ReadbackThrows=true;Held(await f.Engine().BeginAsync(f.Plan));Require(f.Surface.Readbacks==1 && f.Surface.Updates==1);
        f.Surface.ReadbackThrows=false;Require((await f.Engine().ResumeAsync(f.Plan,Consent(f))).Kind==ResultKind.Completed && f.Surface.Updates==2);
        f=new();f.Hook.Action=(name,index)=>{if(name=="AfterPostImage" && index==0)f.Manifests.PairRetained=false;};
        Held(await f.Engine().BeginAsync(f.Plan),HoldReason.PlanInvalid);Require(f.Surface.Updates==1 && f.Binding.Current==f.Plan.OldBinding);
        f.Manifests.PairRetained=true;f.Hook.Action=null;Require((await f.Engine().ResumeAsync(f.Plan,Consent(f))).Kind==ResultKind.Completed);
        f=new();f.Hook.Action=(name,_)=>{if(name=="BeforeBindingCommit")f.Manifests.PairRetained=false;};
        Held(await f.Engine().BeginAsync(f.Plan),HoldReason.PlanInvalid);Require(f.Binding.Current==f.Plan.OldBinding);
        using var cancel=new CancellationTokenSource();f=new();f.Hook.Action=(name,index)=>{if(name=="AfterUpdateIntent" && index==0)cancel.Cancel();};
        Held(await f.Engine().BeginAsync(f.Plan,cancel.Token));Require(f.Surface.ActualMutations==0 && f.Surface.Readbacks==1 && f.Journal.Records.Last().Kind==RecordKind.PostImage);
        f.Hook.Action=null;Require((await f.Engine().ResumeAsync(f.Plan,Consent(f))).Kind==ResultKind.Completed);
    }
    internal static async Task ChangeTime(){
        var metadata=new UserVisibleMetadata(10,20,30,1);
        foreach(var changed in new[]{metadata with{Creation=11},metadata with{LastAccess=21},metadata with{LastWrite=31},metadata with{Attributes=2}})Require(changed.Digest!=metadata.Digest);
        var f=new Fixture();var before=f.Surface.Images[0];Require((await f.Engine().BeginAsync(f.Plan)).Kind==ResultKind.Completed);
        Require(f.Surface.Images[0].MetadataSha256==before.MetadataSha256 && f.Surface.Images[0].OsChangeTime==before.OsChangeTime+1 &&
            f.Surface.Images[0].ChangeTimeAssessment==ChangeTimeAssessment.QualifiedIdentityUpdateCompatible && f.Surface.Images[0].Digest!=before.Digest);
        foreach(var mutation in new Action<Fixture,int>[] {
            (x,i)=>x.Surface.Images[i]=x.Surface.Images[i] with{ChangeTimeAssessment=ChangeTimeAssessment.Unexplained},
            (x,i)=>x.Surface.Images[i]=x.Surface.Images[i] with{OsChangeTime=x.Plan.Entries[i].Before.OsChangeTime-1},
            (x,i)=>x.Surface.Images[i]=x.Surface.Images[i] with{MetadataSha256=new UserVisibleMetadata(1001,2000,3000,1).Digest}
        }){f=new();f.Surface.AfterEffect=i=>mutation(f,i);Held(await f.Engine().BeginAsync(f.Plan),HoldReason.EntryMismatch);Require(f.Surface.Updates==1 && f.Binding.Current==f.Plan.OldBinding && f.Surface.Readbacks==1);}
        f=new();f.Hook.Action=(name,index)=>{if(name=="AfterPostImage" && index==0)throw new IOException();};await f.Engine().BeginAsync(f.Plan);f.Hook.Action=null;
        f.Surface.Images[0]=f.Surface.Images[0] with{OsChangeTime=f.Surface.Images[0].OsChangeTime+1};
        Held(await f.Engine().ObserveAsync(f.Plan),HoldReason.EntryMismatch);Held(await f.Engine().ResumeAsync(f.Plan,Consent(f)),HoldReason.EntryMismatch);Require(f.Surface.Updates==1);
    }
    internal static async Task RecordedPostImageDrift(){
        foreach(var recovered in new[]{false,true}){
            var f=new Fixture();f.Hook.Action=(name,index)=>{if(index==0 && name==(recovered?"AfterNativeEffect":"AfterPostImage"))throw new IOException();};
            Held(await f.Engine().BeginAsync(f.Plan));f.Hook.Action=null;
            if(recovered){
                f.Journal.FailSequence=3;f.Journal.FailAfterAppend=true;Held(await f.Engine().ResumeAsync(f.Plan,Consent(f)));
                f.Journal.FailSequence=null;Require(f.Journal.Records.Last().Kind==RecordKind.RecoveredPostImage);
            }
            Require(f.Surface.Updates==1 && f.Journal.Records.Last().ObservedIdentitySha256==f.Plan.Entries[0].Target.Sha256);
            f.Surface.Images[0]=f.Plan.Entries[0].Before; // Exact identity/USN/ChangeTime/user data/pin/ranges preimage restoration.
            var records=f.Journal.Records.Count;var authority=f.Authority.Calls;
            Held(await f.Engine(withAuthority:false).ObserveAsync(f.Plan),HoldReason.EntryMismatch);
            Held(await f.Engine().ResumeAsync(f.Plan,Consent(f)),HoldReason.EntryMismatch);
            Require(f.Surface.Updates==1 && f.Surface.ActualMutations==1 && f.Journal.Records.Count==records && f.Authority.Calls==authority && f.Binding.Current==f.Plan.OldBinding);
        }
        foreach(var duplicatePost in new[]{false,true}){
            var f=new Fixture();f.Hook.Action=(name,index)=>{if(name=="AfterPostImage" && index==0)throw new IOException();};await f.Engine().BeginAsync(f.Plan);f.Hook.Action=null;
            var sequence=f.Journal.Records.Count+1;
            f.Journal.Records.Add(duplicatePost?f.Journal.Records.Last() with{Sequence=sequence}:new ForwardRecord(sequence,f.Plan.TransactionId,f.Plan.Digest,f.Plan.RootDigest,RecordKind.UpdateIntent,0));
            Held(await f.Engine().ObserveAsync(f.Plan),HoldReason.JournalInvalid);Held(await f.Engine().ResumeAsync(f.Plan,Consent(f)),HoldReason.JournalInvalid);
            Require(f.Surface.Updates==1 && f.Binding.Current==f.Plan.OldBinding);
        }
        var malformed=new Fixture();malformed.Hook.Action=(name,index)=>{if(name=="AfterPostImage" && index==0)throw new IOException();};await malformed.Engine().BeginAsync(malformed.Plan);malformed.Hook.Action=null;
        malformed.Journal.Records[^1]=malformed.Journal.Records[^1] with{Kind=RecordKind.RecoveredPostImage,ObservedIdentitySha256=malformed.Plan.Entries[0].Before.Identity.Sha256,ObservedImageDigest=malformed.Plan.Entries[0].Before.Digest,NativeResult=null};
        Held(await malformed.Engine().ObserveAsync(malformed.Plan),HoldReason.JournalInvalid);Held(await malformed.Engine().ResumeAsync(malformed.Plan,Consent(malformed)),HoldReason.JournalInvalid);Require(malformed.Surface.Updates==1);
        // Legitimate recorded-old failed/no-effect retry remains explicit and was already covered by NativeFailures.
    }
}

internal sealed class SyntheticClock:TimeProvider {internal DateTimeOffset Now=new(2026,10,28,0,0,0,TimeSpan.Zero);public override DateTimeOffset GetUtcNow()=>Now;}
internal sealed class Hook:ICheckpoints {internal Action<string,int?>? Action;public void Reached(string point,int? index=null)=>Action?.Invoke(point,index);}
internal sealed class Fixture {
    internal readonly List<string> Events=[];internal readonly SyntheticClock Clock=new();internal readonly Hook Hook=new();internal readonly RefreshPlan Plan;
    internal readonly Surface Surface;internal readonly Journal Journal;internal readonly Publication Binding;internal readonly Manifests Manifests=new();internal readonly SyntheticAuthority Authority;
    internal Fixture(int schema=4,Availability availability=Availability.Full){
        var scope=new SourceScope("pilot","employee","https://synthetic.invalid","synthetic-principal");
        var root=new RootPins("synthetic-owner","synthetic-SID",scope,Guid.Parse("11111111-1111-4111-8111-111111111111"),"C:\\SyntheticNotCreated",1,Canonical.Hash("context"),Guid.Parse("22222222-2222-4222-8222-222222222222"),schema,schema==4,schema==3?null:"LedgeTop Files — Company files");
        var entries=Enumerable.Range(0,2).Select(i=>{var bytes=Encoding.UTF8.GetBytes("synthetic-remote-bytes-"+i);var sha=Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));var content=new ContentPins(bytes.Length,sha,"\""+sha+"\"",sha);
            return new EntryChange(new("synthetic"+i+".bin",i+10,new Descriptor(Encoding.UTF8.GetBytes("old"+i)),true,true,true,new UserVisibleMetadata(1000+i,2000+i,3000+i,1).Digest,Canonical.Hash(availability==Availability.OnlineOnly?"empty-local":availability==Availability.Partial?"partial-local"+i:"full-local"+i),Canonical.Hash("pin"+i),Canonical.Hash("ranges"+availability+i),availability,100+i,4000+i,ChangeTimeAssessment.Baseline),new Descriptor(Encoding.UTF8.GetBytes("new"+i)),content,content);}).ToArray();
        Plan=new(Guid.NewGuid(),root,new("manifest-old.json",Canonical.Hash("oldmanifest"),1),new("manifest-next.json",Canonical.Hash("newmanifest"),2),entries);
        Surface=new(Plan,Events);Journal=new(Events);Binding=new(Plan.OldBinding,Events);Authority=new(Plan,Clock);
    }
    internal ForwardTransaction Engine(bool withAuthority=true)=>new(Surface,Manifests,Binding,Journal,withAuthority?Authority:null,Clock,Hook);
    internal string LocalState()=>Canonical.Hash(Surface.Images.Select(x=>new{x.MetadataSha256,x.ExistingRangeDataSha256,x.PinStateSha256,x.RangeMapSha256,x.Availability}).ToArray());
    internal void NoEffects()=>Tests.Require(Surface.Updates==0 && Surface.DataWrites==0 && Journal.Records.Count==0 && Binding.Current==Plan.OldBinding);
}
internal sealed class SyntheticAuthority(RefreshPlan plan,SyntheticClock clock):IRefreshAuthority {
    internal int Calls;internal bool ReturnNull,WrongPlan,WrongRoot,WrongPrincipal,WrongContent,WrongContentLength;internal bool Canonical=true,Content=true;internal DateTimeOffset Expires=clock.Now.AddMinutes(10);internal SourceScope? ScopeOverride;
    public Task<VerifiedAdmission?> ValidateFreshAsync(RefreshPlan request,CancellationToken token){token.ThrowIfCancellationRequested();Calls++;return Task.FromResult(ReturnNull?null:new VerifiedAdmission(WrongPlan?LedgeTop.Files.Explorer.IdentityRefresh.Canonical.Hash("wrong"):plan.Digest,WrongRoot?LedgeTop.Files.Explorer.IdentityRefresh.Canonical.Hash("wrong"):plan.RootDigest,ScopeOverride??(WrongPrincipal?plan.Root.Scope with{Principal="other"}:plan.Root.Scope),Expires,LedgeTop.Files.Explorer.IdentityRefresh.Canonical.Hash("SYNTHETIC_TEST_PROOF_NOT_SERVER_AUTHORITY"),Canonical,Content?plan.Entries.ToDictionary(e=>e.Target.Sha256,e=>new VerifiedContent(WrongContentLength?1:e.NewContent.Length,WrongContent?LedgeTop.Files.Explorer.IdentityRefresh.Canonical.Hash("wrong"):e.NewContent.Sha256)):new()));}
}
internal sealed class Manifests:IImmutableManifests {internal bool PairRetained=true;public Task<bool> VerifyRetainedExactPairAsync(RefreshPlan plan,CancellationToken token)=>Task.FromResult(PairRetained);}
internal sealed class Publication(Binding current,List<string> events):IBindingPublication {
    internal Binding Current=current;internal bool ThrowAfterCommit;
    public Task<Binding> ReadAsync(CancellationToken token)=>Task.FromResult(Current);
    public Task<bool> CompareExchangeAsync(Binding expectedOld,Binding target,CancellationToken token){if(Current!=expectedOld)return Task.FromResult(false);events.Add("binding-commit");Current=target;if(ThrowAfterCommit)throw new IOException();return Task.FromResult(true);}
}
internal sealed class Journal(List<string> events):IForwardJournal {
    internal readonly List<ForwardRecord> Records=[];internal int? FailSequence;internal bool FailAfterAppend;
    public Task<IReadOnlyList<ForwardRecord>> ReadCompleteValidatedAsync(CancellationToken token)=>Task.FromResult<IReadOnlyList<ForwardRecord>>(Records.ToArray());
    public Task AppendAndFlushAsync(ForwardRecord record,CancellationToken token){
        token.ThrowIfCancellationRequested();if(FailSequence==record.Sequence && !FailAfterAppend)throw new IOException();Tests.Require(record.Sequence==Records.Count+1);Records.Add(record);events.Add("flush:"+record.Kind+":"+record.EntryIndex);
        if(FailSequence==record.Sequence && FailAfterAppend)throw new IOException();return Task.CompletedTask;
    }
}
internal sealed class Surface: IRefreshSurface,IExclusiveRefreshLease {
    internal RootObservation Root;internal readonly EntryImage[] Images;internal int Updates,ActualMutations,Readbacks;internal int DataWrites=>0;internal int PlaceholderDataReads=>0;
    internal string? FailMode;internal Action<int>? AfterEffect;internal bool ReadbackThrows;private readonly List<string> events;private bool held;
    internal Surface(RefreshPlan plan,List<string> events){Root=new(plan.Root,true,true,true);Images=plan.Entries.Select(e=>e.Before).ToArray();this.events=events;}
    public Task<IExclusiveRefreshLease> AcquireExistingOwnedExclusiveLeaseAsync(RefreshPlan plan,CancellationToken token){Tests.Require(!held);held=true;return Task.FromResult<IExclusiveRefreshLease>(this);}
    public Task<RootObservation> InspectRootAsync(CancellationToken token)=>Task.FromResult(Root);
    public Task<EntryImage> InspectEntryAsync(int index,CancellationToken token)=>Task.FromResult(Images[index]);
    public Task<int> UpdateIdentityOnlyAsync(int index,Descriptor target,string expectedBeforeDigest,CancellationToken token){
        Tests.Require(held && Images[index].Digest==expectedBeforeDigest);token.ThrowIfCancellationRequested();Updates++;events.Add("native:"+index);
        if(FailMode=="throw-before")throw new IOException();if(FailMode is "return-failure-old" or "success-no-effect")return Task.FromResult(FailMode=="success-no-effect"?0:-1);
        Images[index]=Images[index] with{Identity=target,ObservedUsn=Images[index].ObservedUsn+1,OsChangeTime=Images[index].OsChangeTime+1,ChangeTimeAssessment=ChangeTimeAssessment.QualifiedIdentityUpdateCompatible};ActualMutations++;AfterEffect?.Invoke(index);
        if(FailMode=="throw-after")throw new IOException();return Task.FromResult(FailMode=="return-failure-new"?-1:0);
    }
    public Task<EntryImage> ReadbackAfterAttemptAsync(int index){Readbacks++;events.Add("readback:"+index);if(ReadbackThrows)throw new IOException();return Task.FromResult(Images[index]);}
    public ValueTask DisposeAsync(){held=false;return ValueTask.CompletedTask;}
}
