using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.Files.Explorer.IdentityRefresh;

// Internal, not-yet-wired forward-transaction model. No disk, native, backend or profile adapter is supplied.
internal static class Canonical {
    internal static string Hash(object value)=>Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));
    internal static bool Sha(string value)=>value is not null && Regex.IsMatch(value,"\\A[a-f0-9]{64}\\z");
    internal static void Require(bool condition,HoldReason reason=HoldReason.PlanInvalid){if(!condition)throw new RefreshHold(reason);}
}
internal enum HoldReason {None,PlanInvalid,AuthorityDenied,AuthorityExpired,ProofMismatch,OwnerMismatch,EntryMismatch,Dirty,JournalInvalid,PortFailure,NativeFailure,ExplicitResumeRequired,BindingMismatch}
internal sealed class RefreshHold(HoldReason reason):Exception {internal HoldReason Reason=>reason;}
internal enum ResultKind {Held,Completed}
internal sealed record Outcome(ResultKind Kind,HoldReason Reason,int OldEntries=0,int NewEntries=0);
internal enum Availability {OnlineOnly,Partial,Full}
// Default is a HOLD, not an inferred native causal explanation.
internal enum ChangeTimeAssessment {Unexplained,Baseline,QualifiedIdentityUpdateCompatible}
// Exact canonical user-visible creation/access/write/attributes. OS ChangeTime is deliberately not a member.
internal readonly record struct UserVisibleMetadata(long Creation,long LastAccess,long LastWrite,uint Attributes) {
    internal string Digest=>Canonical.Hash(this);
}
internal sealed record SourceScope(string Channel,string Alias,string Origin,string Principal);
internal sealed record RootPins(string Owner,string WindowsSid,SourceScope Scope,Guid ProfileId,string CanonicalRoot,long RootFileId,
    string ContextSha256,Guid NamespaceClsid,int ExistingSchema,bool HasDisplayName,string? DisplayName);
internal sealed record Binding(string ImmutableFile,string ManifestSha256,long Revision);
internal sealed record ContentPins(long Length,string Sha256,string StrongETag,string RemoteVersion);
internal sealed record Descriptor {
    internal string Base64 {get;}
    internal string Sha256 {get;}
    internal Descriptor(byte[] bytes){Canonical.Require(bytes.Length is >0 and <=4096);Base64=Convert.ToBase64String(bytes);Sha256=Convert.ToHexStringLower(SHA256.HashData(bytes));}
}
internal sealed record EntryImage(string RelativePath,long FileId,Descriptor Identity,bool Placeholder,bool Clean,bool NoAliases,
    string MetadataSha256,string ExistingRangeDataSha256,string PinStateSha256,string RangeMapSha256,Availability Availability,long ObservedUsn,
    long OsChangeTime,ChangeTimeAssessment ChangeTimeAssessment) {
    internal string Digest=>Canonical.Hash(new{RelativePath,FileId,identity=Identity.Sha256,Placeholder,Clean,NoAliases,MetadataSha256,ExistingRangeDataSha256,PinStateSha256,RangeMapSha256,Availability,ObservedUsn,OsChangeTime,ChangeTimeAssessment});
}
internal sealed record EntryChange(EntryImage Before,Descriptor Target,ContentPins OldContent,ContentPins NewContent);
internal static class ExistingProfileCompatibility {
    // Reuse the actual connected3/4 policy, including property presence. No schema parser/writer here.
    internal static bool Accept(int schema,string alias,bool hasDisplayName,string? displayName){
        if(!hasDisplayName && displayName is not null)return false;
        try{_ = ExplorerRootDisplayName.ResolveProfile(false,schema,alias,hasDisplayName,displayName);return true;}
        catch(IOException){return false;}
    }
}
internal sealed class RefreshPlan {
    internal Guid TransactionId {get;}
    internal RootPins Root {get;}
    internal Binding OldBinding {get;}
    internal Binding NewBinding {get;}
    internal IReadOnlyList<EntryChange> Entries {get;}
    internal string RootDigest {get;}
    internal string Digest {get;}
    internal RefreshPlan(Guid transactionId,RootPins root,Binding oldBinding,Binding newBinding,IEnumerable<EntryChange> changes){
        var entries=changes.ToArray();
        Canonical.Require(transactionId!=Guid.Empty && root.ProfileId!=Guid.Empty && root.NamespaceClsid!=Guid.Empty && root.RootFileId>0 &&
            !string.IsNullOrWhiteSpace(root.Owner) && !string.IsNullOrWhiteSpace(root.WindowsSid) && !string.IsNullOrWhiteSpace(root.CanonicalRoot) && Canonical.Sha(root.ContextSha256) &&
            root.Scope.Channel is "pilot" or "stable" && !string.IsNullOrWhiteSpace(root.Scope.Principal) && !string.IsNullOrWhiteSpace(root.Scope.Alias) &&
            Uri.TryCreate(root.Scope.Origin,UriKind.Absolute,out var origin) && origin.Scheme=="https" && origin.UserInfo.Length==0 && origin.Query.Length==0 && origin.Fragment.Length==0 && origin.AbsolutePath=="/" && origin.IsDefaultPort && origin.GetLeftPart(UriPartial.Authority)==root.Scope.Origin &&
            ExistingProfileCompatibility.Accept(root.ExistingSchema,root.Scope.Alias,root.HasDisplayName,root.DisplayName));
        Canonical.Require(Canonical.Sha(oldBinding.ManifestSha256) && Canonical.Sha(newBinding.ManifestSha256) && oldBinding.ManifestSha256!=newBinding.ManifestSha256 &&
            oldBinding.ImmutableFile!=newBinding.ImmutableFile && Leaf(oldBinding.ImmutableFile) && Leaf(newBinding.ImmutableFile) && oldBinding.Revision>0 && newBinding.Revision==oldBinding.Revision+1 && entries.Length is >0 and <=1000);
        var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var ids=new HashSet<long>();var targets=new HashSet<string>(StringComparer.Ordinal);
        foreach(var entry in entries){
            var b=entry.Before;
            Canonical.Require(b.RelativePath.Length is >0 and <=180 && !b.RelativePath.Contains('/') && b.RelativePath.Split('\\').Length<=32 && b.RelativePath.Split('\\').All(Leaf) &&
                paths.Add(b.RelativePath) && ids.Add(b.FileId) && b.FileId>0 && b.Placeholder && b.Clean && b.NoAliases && b.ObservedUsn>0 && b.OsChangeTime>0 && b.ChangeTimeAssessment==ChangeTimeAssessment.Baseline && Enum.IsDefined(b.Availability) &&
                new[]{b.MetadataSha256,b.ExistingRangeDataSha256,b.PinStateSha256,b.RangeMapSha256}.All(Canonical.Sha) && b.Identity!=entry.Target && targets.Add(entry.Target.Sha256));
            Canonical.Require(entry.OldContent==entry.NewContent && entry.NewContent.Length>=0 && entry.NewContent.Length<=(64L<<30) && Canonical.Sha(entry.NewContent.Sha256) &&
                entry.NewContent.StrongETag.Length is >2 and <=512 && entry.NewContent.RemoteVersion.Length is >0 and <=256);
        }
        TransactionId=transactionId;Root=root;OldBinding=oldBinding;NewBinding=newBinding;Entries=Array.AsReadOnly(entries);RootDigest=Canonical.Hash(root);
        Digest=Canonical.Hash(new{transactionId,root,oldBinding,newBinding,entries=entries.Select(e=>new{before=e.Before.Digest,target=e.Target.Sha256,e.OldContent,e.NewContent}).ToArray()});
    }
    private static bool Leaf(string value)=>value.Length>0 && value is not "." and not ".." && value.TrimEnd(' ','.')==value && !value.Any(c=>char.IsControl(c)||"<>:\"/\\|?*".Contains(c));
}

// A real adapter must validate authenticated canonical correspondence AND fresh Resolve/full-SHA proof.
// This data object is not a signature/capability. There is intentionally no production authority implementation.
internal sealed class VerifiedAdmission {
    internal string PlanDigest{get;} internal string RootDigest{get;} internal SourceScope Scope{get;} internal DateTimeOffset ExpiresAt{get;}
    internal string TransitionEvidenceSha256{get;} internal bool CanonicalCorrespondenceValidated{get;} internal IReadOnlyDictionary<string,VerifiedContent> FullContentHashes{get;}
    internal VerifiedAdmission(string planDigest,string rootDigest,SourceScope scope,DateTimeOffset expiresAt,string transitionEvidenceSha256,bool canonicalCorrespondenceValidated,IDictionary<string,VerifiedContent> verifiedFullContentHashes){
        PlanDigest=planDigest;RootDigest=rootDigest;Scope=scope;ExpiresAt=expiresAt;TransitionEvidenceSha256=transitionEvidenceSha256;CanonicalCorrespondenceValidated=canonicalCorrespondenceValidated;
        FullContentHashes=new ReadOnlyDictionary<string,VerifiedContent>(new Dictionary<string,VerifiedContent>(verifiedFullContentHashes,StringComparer.Ordinal));
    }
}
internal sealed record VerifiedContent(long ExactLength,string FullSha256);
internal interface IRefreshAuthority {Task<VerifiedAdmission?> ValidateFreshAsync(RefreshPlan plan,CancellationToken token);}
internal sealed class DenyAuthority:IRefreshAuthority {public Task<VerifiedAdmission?> ValidateFreshAsync(RefreshPlan plan,CancellationToken token)=>Task.FromResult<VerifiedAdmission?>(null);}
internal interface IImmutableManifests {Task<bool> VerifyRetainedExactPairAsync(RefreshPlan plan,CancellationToken token);}
internal sealed record RootObservation(RootPins Pins,bool OwnershipVerified,bool NoAliasesVerified,bool CallbacksAndAvailabilityDrained);
internal interface IExclusiveRefreshLease:IAsyncDisposable {
    Task<RootObservation> InspectRootAsync(CancellationToken token);
    // MetadataSha256 MUST use UserVisibleMetadata.Digest, excluding OS ChangeTime. The adapter independently
    // classifies ChangeTime under qualified same-handle rules; model does not infer causality or kernel CAS.
    Task<EntryImage> InspectEntryAsync(int index,CancellationToken token);
    // expectedBeforeDigest demands a same-handle immediate recheck; it is NOT a claim of kernel metadata CAS.
    Task<int> UpdateIdentityOnlyAsync(int index,Descriptor target,string expectedBeforeDigest,CancellationToken token);
    Task<EntryImage> ReadbackAfterAttemptAsync(int index); // Must run even on native failure/caller cancellation; adapter owns bounded drain/readback.
}
internal interface IRefreshSurface {Task<IExclusiveRefreshLease> AcquireExistingOwnedExclusiveLeaseAsync(RefreshPlan plan,CancellationToken token);}
internal interface IBindingPublication {
    Task<Binding> ReadAsync(CancellationToken token);
    Task<bool> CompareExchangeAsync(Binding expectedOld,Binding target,CancellationToken token); // Existing held profile/index leases; preserve root/context/display, no native CAS claim.
}
internal enum RecordKind {Prepared,UpdateIntent,PostImage,RecoveredPostImage,CommitIntent,Committed}
internal sealed record ForwardRecord(int Sequence,Guid TransactionId,string PlanDigest,string RootDigest,RecordKind Kind,int? EntryIndex=null,
    string? ObservedIdentitySha256=null,string? ObservedImageDigest=null,int? NativeResult=null);
internal interface IForwardJournal {
    Task<IReadOnlyList<ForwardRecord>> ReadCompleteValidatedAsync(CancellationToken token);
    Task AppendAndFlushAsync(ForwardRecord record,CancellationToken token); // Return only after durable append+flush; never acknowledge partial/ambiguous writes.
}
internal interface ICheckpoints {void Reached(string point,int? index=null);}
internal sealed class NoCheckpoints:ICheckpoints {public void Reached(string point,int? index=null){}}
internal sealed record ExplicitResume(Guid TransactionId,string PlanDigest,bool ExplicitUserAction);

internal sealed class ForwardTransaction(IRefreshSurface surface,IImmutableManifests manifests,IBindingPublication binding,IForwardJournal journal,
    IRefreshAuthority? authority=null,TimeProvider? clock=null,ICheckpoints? checkpoints=null) {
    private readonly IRefreshAuthority authority=authority??new DenyAuthority();private readonly TimeProvider clock=clock??TimeProvider.System;
    private readonly ICheckpoints checkpoints=checkpoints??new NoCheckpoints();private readonly SemaphoreSlim serial=new(1,1);
    internal Task<Outcome> BeginAsync(RefreshPlan plan,CancellationToken token=default)=>Execute(plan,null,false,token);
    internal Task<Outcome> ResumeAsync(RefreshPlan plan,ExplicitResume consent,CancellationToken token=default)=>Execute(plan,consent,false,token);
    internal Task<Outcome> ObserveAsync(RefreshPlan plan,CancellationToken token=default)=>Execute(plan,null,true,token);
    private async Task<Outcome> Execute(RefreshPlan plan,ExplicitResume? consent,bool observe,CancellationToken token){
        await serial.WaitAsync(token);try{
            // The integration lease must cover index/profile/journal/manifests and native exclusive state.
            // Never read a journal before lease acquisition and later adopt that stale head.
            await using var lease=await surface.AcquireExistingOwnedExclusiveLeaseAsync(plan,token);
            var records=(await journal.ReadCompleteValidatedAsync(token)).ToList();ValidateJournal(plan,records);
            if(!observe && records.Count>0)Canonical.Require(consent is{ExplicitUserAction:true} && consent.TransactionId==plan.TransactionId && consent.PlanDigest==plan.Digest,HoldReason.ExplicitResumeRequired);
            if(!observe && records.Count==0)Canonical.Require(consent is null,HoldReason.JournalInvalid);
            Canonical.Require(await manifests.VerifyRetainedExactPairAsync(plan,token),HoldReason.PlanInvalid);
            await Root(plan,lease,token);
            var currentBinding=await binding.ReadAsync(token);Canonical.Require(currentBinding==plan.OldBinding || currentBinding==plan.NewBinding,HoldReason.BindingMismatch);
            var classes=new bool[plan.Entries.Count];var old=0;var next=0;
            for(var i=0;i<classes.Length;i++){classes[i]=Classify(plan,i,await lease.InspectEntryAsync(i,token),records);if(classes[i])next++;else old++;}
            if(records.Any(r=>r.Kind==RecordKind.Committed)){
                Canonical.Require(next==classes.Length && currentBinding==plan.NewBinding,HoldReason.BindingMismatch);return new(ResultKind.Completed,HoldReason.None,old,next);
            }
            if(currentBinding==plan.NewBinding)Canonical.Require(records.Any(r=>r.Kind==RecordKind.CommitIntent) && next==classes.Length,HoldReason.BindingMismatch);
            if(observe)return new(ResultKind.Held,HoldReason.ExplicitResumeRequired,old,next); // No authority calls, journal writes, update or binding publication.
            await Admission(plan,token);
            if(records.Count==0){Canonical.Require(old==classes.Length && currentBinding==plan.OldBinding,HoldReason.EntryMismatch);checkpoints.Reached("BeforePrepared");await Append(plan,records,RecordKind.Prepared,token);checkpoints.Reached("AfterPrepared");}
            for(var i=0;i<classes.Length;i++){
                if(classes[i]){
                    var lastIntent=records.Last(r=>r.Kind==RecordKind.UpdateIntent && r.EntryIndex==i);
                    var lastPost=records.LastOrDefault(r=>r.Kind is RecordKind.PostImage or RecordKind.RecoveredPostImage && r.EntryIndex==i);
                    if(lastPost is null || lastPost.Sequence<lastIntent.Sequence){
                        await Admission(plan,token);await Root(plan,lease,token);var recovered=await lease.InspectEntryAsync(i,token);
                        Canonical.Require(Classify(plan,i,recovered,records),HoldReason.EntryMismatch);
                        await Append(plan,records,RecordKind.RecoveredPostImage,token,i,recovered.Identity.Sha256,recovered.Digest);
                    }
                    continue;
                }
                await Admission(plan,token);Canonical.Require(await manifests.VerifyRetainedExactPairAsync(plan,token),HoldReason.PlanInvalid);await Root(plan,lease,token);
                var before=await lease.InspectEntryAsync(i,token);Canonical.Require(!Classify(plan,i,before,records),HoldReason.EntryMismatch);
                checkpoints.Reached("BeforeUpdateIntent",i);await Append(plan,records,RecordKind.UpdateIntent,token,index:i);checkpoints.Reached("AfterUpdateIntent",i);
                int result;try{result=await lease.UpdateIdentityOnlyAsync(i,plan.Entries[i].Target,before.Digest,token);}catch(Exception error){result=error.HResult==0?-1:error.HResult;}
                checkpoints.Reached("AfterNativeEffect",i); // Test seam simulates process interruption, not a native adapter error.
                var after=await lease.ReadbackAfterAttemptAsync(i); // Deliberately before expiry/cancellation/journal/native-result handling.
                await Append(plan,records,RecordKind.PostImage,CancellationToken.None,i,after.Identity.Sha256,after.Digest,result);checkpoints.Reached("AfterPostImage",i);
                var isNew=Classify(plan,i,after,records,ignoreRecordedPostImage:true);
                Canonical.Require(result==0 && isNew,HoldReason.NativeFailure);classes[i]=true;
            }
            await Admission(plan,token);await Root(plan,lease,token);
            for(var i=0;i<classes.Length;i++)Canonical.Require(Classify(plan,i,await lease.InspectEntryAsync(i,token),records),HoldReason.EntryMismatch);
            Canonical.Require(await manifests.VerifyRetainedExactPairAsync(plan,token),HoldReason.PlanInvalid);
            await Admission(plan,token);
            if(!records.Any(r=>r.Kind==RecordKind.CommitIntent)){checkpoints.Reached("BeforeCommitIntent");await Append(plan,records,RecordKind.CommitIntent,token);checkpoints.Reached("AfterCommitIntent");}
            currentBinding=await binding.ReadAsync(token);
            if(currentBinding==plan.OldBinding){checkpoints.Reached("BeforeBindingCommit");await Admission(plan,token);Canonical.Require(await manifests.VerifyRetainedExactPairAsync(plan,token),HoldReason.PlanInvalid);Canonical.Require(await binding.CompareExchangeAsync(plan.OldBinding,plan.NewBinding,token),HoldReason.BindingMismatch);checkpoints.Reached("AfterBindingCommit");}
            else Canonical.Require(currentBinding==plan.NewBinding,HoldReason.BindingMismatch);
            // No further native effect; binding and all postimages remain explicit recovery evidence if this append fails.
            Canonical.Require(await binding.ReadAsync(CancellationToken.None)==plan.NewBinding,HoldReason.BindingMismatch);
            await Append(plan,records,RecordKind.Committed,CancellationToken.None);checkpoints.Reached("AfterCommitted");return new(ResultKind.Completed,HoldReason.None,0,classes.Length);
        }catch(RefreshHold hold){return new(ResultKind.Held,hold.Reason);}catch{return new(ResultKind.Held,HoldReason.PortFailure);}finally{serial.Release();}
    }
    private async Task Admission(RefreshPlan plan,CancellationToken token){
        var proof=await authority.ValidateFreshAsync(plan,token);Canonical.Require(proof is not null,HoldReason.AuthorityDenied);
        Canonical.Require(proof!.ExpiresAt>clock.GetUtcNow().AddSeconds(5),HoldReason.AuthorityExpired);
        Canonical.Require(proof.CanonicalCorrespondenceValidated && proof.PlanDigest==plan.Digest && proof.RootDigest==plan.RootDigest && proof.Scope==plan.Root.Scope &&
            Canonical.Sha(proof.TransitionEvidenceSha256) && proof.FullContentHashes.Count==plan.Entries.Count && plan.Entries.All(e=>proof.FullContentHashes.TryGetValue(e.Target.Sha256,out var content)&&content.FullSha256==e.NewContent.Sha256 && content.ExactLength==e.NewContent.Length),HoldReason.ProofMismatch);
    }
    private static async Task Root(RefreshPlan plan,IExclusiveRefreshLease lease,CancellationToken token){var actual=await lease.InspectRootAsync(token);Canonical.Require(actual.Pins==plan.Root && actual.OwnershipVerified && actual.NoAliasesVerified && actual.CallbacksAndAvailabilityDrained,HoldReason.OwnerMismatch);}
    private static bool Classify(RefreshPlan plan,int index,EntryImage actual,IReadOnlyList<ForwardRecord> records,bool ignoreRecordedPostImage=false){
        var e=plan.Entries[index];var b=e.Before;Canonical.Require(actual.Clean,HoldReason.Dirty);
        Canonical.Require(actual.Placeholder && actual.NoAliases && actual.RelativePath==b.RelativePath && actual.FileId==b.FileId && actual.MetadataSha256==b.MetadataSha256 &&
            actual.ExistingRangeDataSha256==b.ExistingRangeDataSha256 && actual.PinStateSha256==b.PinStateSha256 && actual.RangeMapSha256==b.RangeMapSha256 && actual.Availability==b.Availability && actual.ObservedUsn>0,HoldReason.EntryMismatch);
        // A durable postimage is authoritative local transaction evidence for BOTH identity branches.
        // In particular, returning to the exact old preimage after recorded-new is drift, never retry permission.
        if(!ignoreRecordedPostImage){
            var intent=records.LastOrDefault(r=>r.Kind==RecordKind.UpdateIntent && r.EntryIndex==index);
            var post=records.LastOrDefault(r=>r.Kind is RecordKind.PostImage or RecordKind.RecoveredPostImage && r.EntryIndex==index);
            if(post is not null && (intent is null || post.Sequence>intent.Sequence))
                Canonical.Require(post.ObservedIdentitySha256==actual.Identity.Sha256 && post.ObservedImageDigest==actual.Digest,HoldReason.EntryMismatch);
        }
        if(actual.Identity==b.Identity){Canonical.Require(actual.Digest==b.Digest,HoldReason.EntryMismatch);return false;}
        Canonical.Require(actual.Identity==e.Target,HoldReason.EntryMismatch);
        Canonical.Require(actual.ChangeTimeAssessment==ChangeTimeAssessment.QualifiedIdentityUpdateCompatible && actual.OsChangeTime>=b.OsChangeTime,HoldReason.EntryMismatch);
        Canonical.Require(records.Any(r=>r.Kind==RecordKind.UpdateIntent && r.EntryIndex==index),HoldReason.JournalInvalid);
        return true;
    }
    private async Task Append(RefreshPlan plan,List<ForwardRecord> records,RecordKind kind,CancellationToken token,int? index=null,string? identity=null,string? image=null,int? result=null){
        Canonical.Require(records.Count<10000,HoldReason.JournalInvalid);var record=new ForwardRecord(records.Count+1,plan.TransactionId,plan.Digest,plan.RootDigest,kind,index,identity,image,result);
        await journal.AppendAndFlushAsync(record,token);records.Add(record);
    }
    private static void ValidateJournal(RefreshPlan plan,IReadOnlyList<ForwardRecord> records){
        Canonical.Require(records.Count<=10000,HoldReason.JournalInvalid);var intents=new Dictionary<int,int>();var posts=new Dictionary<int,ForwardRecord>();var commit=false;var committed=false;
        for(var n=0;n<records.Count;n++){
            var r=records[n];Canonical.Require(r.Sequence==n+1 && r.TransactionId==plan.TransactionId && r.PlanDigest==plan.Digest && r.RootDigest==plan.RootDigest && Enum.IsDefined(r.Kind) && !committed,HoldReason.JournalInvalid);
            if(n==0)Canonical.Require(r.Kind==RecordKind.Prepared,HoldReason.JournalInvalid);else Canonical.Require(r.Kind!=RecordKind.Prepared,HoldReason.JournalInvalid);
            if(r.Kind is RecordKind.UpdateIntent or RecordKind.PostImage or RecordKind.RecoveredPostImage){Canonical.Require(!commit && r.EntryIndex is>=0 && r.EntryIndex<plan.Entries.Count,HoldReason.JournalInvalid);var index=r.EntryIndex!.Value;
                if(r.Kind==RecordKind.UpdateIntent){Canonical.Require(r.ObservedIdentitySha256 is null && r.ObservedImageDigest is null && r.NativeResult is null &&
                    (!posts.TryGetValue(index,out var previous) || previous.ObservedIdentitySha256!=plan.Entries[index].Target.Sha256),HoldReason.JournalInvalid);intents[index]=r.Sequence;}
                else{Canonical.Require(intents.TryGetValue(index,out var intentSequence) && (!posts.TryGetValue(index,out var previous) || previous.Sequence<intentSequence) &&
                    (r.ObservedIdentitySha256==plan.Entries[index].Target.Sha256 || r.Kind==RecordKind.PostImage && r.ObservedIdentitySha256==plan.Entries[index].Before.Identity.Sha256) && Canonical.Sha(r.ObservedImageDigest!) && (r.Kind==RecordKind.PostImage?r.NativeResult is not null:r.NativeResult is null),HoldReason.JournalInvalid);posts[index]=r;}
            }else{Canonical.Require(r.EntryIndex is null && r.ObservedIdentitySha256 is null && r.ObservedImageDigest is null && r.NativeResult is null,HoldReason.JournalInvalid);if(r.Kind==RecordKind.CommitIntent){Canonical.Require(!commit && Enumerable.Range(0,plan.Entries.Count).All(i=>intents.TryGetValue(i,out var intent) && posts.TryGetValue(i,out var post) && post.Sequence>intent && post.ObservedIdentitySha256==plan.Entries[i].Target.Sha256),HoldReason.JournalInvalid);commit=true;}if(r.Kind==RecordKind.Committed){Canonical.Require(commit,HoldReason.JournalInvalid);committed=true;}}
        }
    }
}
