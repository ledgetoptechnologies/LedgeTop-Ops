// Prepared diagnostic only. C# 5 / Windows PowerShell 5.1. No provider mutation or file data access.
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

public static class LedgeTopShellState
{
    const string Origin = "https://ops-staging.ledgetopdroneservices.com";
    const string Provider = "LedgeTop Files Preview";
    const string CompanyDisplayName = "LedgeTop Files \u2014 Company files";
    const string IndexOwner = "LedgeTop.Files.ConnectedExplorer.Index/1";
    const string ProfileOwner = "LedgeTop.Files.ConnectedExplorer/1";
    static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly Encoding Utf16 = new UnicodeEncoding(false, false, true);
    static void Require(bool yes) { if (!yes) throw new InvalidDataException("Refused"); }
    static string Hash(string text) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Utf8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
    static string S(Dictionary<string,object> d, string k) { object v; Require(d.TryGetValue(k, out v) && v is string); return (string)v; }
    static long N(Dictionary<string,object> d, string k) { object v; Require(d.TryGetValue(k, out v) && v is long); return (long)v; }
    static bool B(Dictionary<string,object> d, string k) { object v; Require(d.TryGetValue(k, out v) && v is bool); return (bool)v; }
    static Dictionary<string,object> D(Dictionary<string,object> d, string k) { object v; Require(d.TryGetValue(k, out v) && v is Dictionary<string,object>); return (Dictionary<string,object>)v; }
    static void Keys(Dictionary<string,object> d, string keys) { var allowed = new HashSet<string>(keys.Split(','), StringComparer.Ordinal); Require(d.Count == allowed.Count); foreach (var k in d.Keys) Require(allowed.Contains(k)); }
    static string Canonical(string path)
    {
        Require(!String.IsNullOrEmpty(path) && path.Length <= 240 && Regex.IsMatch(path, @"\A[A-Za-z]:\\") && path.IndexOfAny(new char[] {'*','?','"','<','>','|'}) < 0 && path.IndexOf(':', 2) < 0);
        var full = Path.GetFullPath(path).TrimEnd('\\'); Require(String.Equals(full, path, StringComparison.OrdinalIgnoreCase));
        foreach (var part in path.Substring(3).Split('\\')) Require(part.Length > 0 && part != "." && part != ".." && !part.EndsWith(" ") && !part.EndsWith("."));
        return full;
    }
    static bool AllowedRoot(string root, string user)
    {
        string preferred = user + "\\LedgeTop Files Pilot \u2014 Company files";
        if (String.Equals(root, preferred, StringComparison.OrdinalIgnoreCase)) return true;
        if (!root.StartsWith(preferred + " (", StringComparison.OrdinalIgnoreCase) || !root.EndsWith(")", StringComparison.Ordinal)) return false;
        string suffix = root.Substring(preferred.Length + 2, root.Length - preferred.Length - 3); int number;
        return Int32.TryParse(suffix, out number) && number >= 2 && number <= 9999 && suffix == number.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }
    static bool Within(string selected, string root) { return selected.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
    static void OrdinaryAncestors(string path)
    {
        for (string p = path; p != null; p = Path.GetDirectoryName(p)) {
            var a = File.GetAttributes(p); Require((a & FileAttributes.ReparsePoint) == 0 && (a & FileAttributes.Directory) != 0);
        }
    }
    static Dictionary<string,object> ReadJson(string path, int limit)
    {
        OrdinaryAncestors(Path.GetDirectoryName(path)); Require((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0);
        byte[] bytes;
        using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
            Require(f.Length > 0 && f.Length <= limit); bytes = new byte[(int)f.Length]; int done = 0;
            while (done < bytes.Length) { int n = f.Read(bytes, done, bytes.Length - done); Require(n > 0); done += n; } Require(f.ReadByte() == -1);
        }
        int offset = bytes.Length >= 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191 ? 3 : 0;
        return Json.Parse(Utf8.GetString(bytes, offset, bytes.Length - offset));
    }
    sealed class Binding { internal string Root, Sid, Id, Namespace, Context, DisplayName; internal long FileId; }
    static Binding ReadBinding()
    {
        string sid; using (var identity = WindowsIdentity.GetCurrent()) { Require(identity.User != null); sid = identity.User.Value; }
        string basePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", "pilot", "connected-explorer-pilot-employee");
        var index = ReadJson(Path.Combine(basePath, "current.json"), 8192);
        Keys(index, "Schema,Owner,Sid,Channel,Alias,OriginSha256,PrincipalId,Revision,Removed");
        Require(N(index,"Schema") == 1 && S(index,"Owner") == IndexOwner && S(index,"Sid") == sid && S(index,"Channel") == "pilot" && S(index,"Alias") == "employee" && S(index,"OriginSha256") == Hash(Origin) && N(index,"Revision") >= 1 && !B(index,"Removed"));
        string principal = S(index,"PrincipalId"); Require(Regex.IsMatch(principal, @"\Aodqp1_[a-f0-9]{64}\z"));
        string profilePath = Path.Combine(basePath, "profiles", Hash("pilot\nemployee\n" + Origin + "\n" + principal), "profile.json");
        var profile = ReadJson(profilePath, 65536);
        return ParseProfileBinding(profile,principal,sid,Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
    }
    // Pure parser: the caller already bound the fixed current-user employee index and derived profile path.
    static Binding ParseProfileBinding(Dictionary<string,object> profile,string principal,string sid,string user)
    {
        long schema = N(profile,"Schema");
        string displayName;
        if (schema == 3) {
            Keys(profile,"Schema,Owner,Sid,Identity,Root,Context,Icon,RootFileId,Phase,Paused,Revision,NamespaceClsid,Binding");
            displayName = Provider;
        } else {
            Require(schema == 4);
            Keys(profile,"Schema,Owner,Sid,Identity,Root,Context,Icon,RootFileId,Phase,Paused,Revision,NamespaceClsid,Binding,DisplayName");
            displayName = S(profile,"DisplayName"); Require(displayName == CompanyDisplayName);
        }
        Guid id = Guid.Empty, ns = Guid.Empty; Require(Guid.TryParse(S(profile,"Identity"), out id) && id != Guid.Empty && Guid.TryParse(S(profile,"NamespaceClsid"), out ns) && ns != Guid.Empty);
        Require(S(profile,"Owner") == ProfileOwner && S(profile,"Sid") == sid && S(profile,"Phase") == "Ready" && N(profile,"Revision") >= 1 && N(profile,"RootFileId") != 0);
        string context = ProfileOwner + ":" + id.ToString("N"); Require(S(profile,"Context") == context);
        string root = Canonical(S(profile,"Root")); Require(AllowedRoot(root, Canonical(user)));
        var manifest = D(profile,"Binding"); Keys(manifest,"Scope,File,Digest"); var scope = D(manifest,"Scope"); Keys(scope,"Channel,Alias,Origin,PrincipalId");
        Require(S(scope,"Channel") == "pilot" && S(scope,"Alias") == "employee" && S(scope,"Origin") == Origin && S(scope,"PrincipalId") == principal && S(manifest,"File") == "manifest-" + id.ToString("N") + ".json" && Regex.IsMatch(S(manifest,"Digest"), @"\A[a-f0-9]{64}\z"));
        return new Binding { Root = root, Sid = sid, Id = Provider + "!" + sid + "!" + id.ToString("N"), Namespace = ns.ToString("B").ToUpperInvariant(), Context = context, FileId = N(profile,"RootFileId"), DisplayName = displayName };
    }
    public static Dictionary<string,object> Collect(string literalPath)
    {
        Require(Environment.Is64BitProcess); var binding = ReadBinding(); string selected = Canonical(literalPath); Require(Within(selected, binding.Root));
        var report = new Dictionary<string,object>(); report["Schema"] = "LedgeTop.Files.ShellDiagnostic/2"; report["Utc"] = DateTime.UtcNow.ToString("o"); report["Scope"] = "pilot-company-owned-root";
        report["NamespaceShellQuerySkipped"] = true; report["NamespaceActivationQualified"] = false;
        report["ShellNamespaceStatus"] = "Unavailable-RegistryShapeDoesNotQualifyComActivation";
        report["NativeProviderGuid"] = "NotExposedBySupportedCfRootInfoClasses";
        sbyte previous = RtlSetThreadPlaceholderCompatibilityMode(2); Require(previous >= 0);
        try {
            // Retain metadata handles through all observations. No FILE_READ_DATA/GENERIC_READ on placeholders.
            using (var ancestors = FenceDirectories(Path.GetDirectoryName(selected),binding.Root)) using (var rootHandle = MetadataHandle(binding.Root)) using (var selectedHandle = MetadataHandle(selected)) {
                AttrTag rootTag = Tag(rootHandle), fileTag = Tag(selectedHandle); Require((rootTag.Attributes & 16) != 0 && (fileTag.Attributes & 16) == 0 && ((fileTag.Attributes & 1024) == 0 || CloudTag(fileTag.Tag)));
                Require((rootTag.Attributes & 1024) == 0 || CloudTag(rootTag.Tag));
                var file = new Dictionary<string,object>(); report["SelectedFile"] = file; file["Attributes"] = fileTag.Attributes; file["ReparseTag"] = fileTag.Tag; file["CloudTag"] = CloudTag(fileTag.Tag); file["PlaceholderState"] = CfGetPlaceholderStateFromAttributeTag(fileTag.Attributes,fileTag.Tag);
                byte[] root = new byte[66592]; uint returned; int hr = CfGetSyncRootInfoByPath(binding.Root,1,root,(uint)root.Length,out returned);
                var native = new Dictionary<string,object>(); native["Status"] = hr; report["NativeRoot"] = native;
                if (hr != 0 || returned < 1056 || returned > root.Length) { report["CollectionStatus"] = "NativeRootUnavailableOrMalformed"; return report; }
                uint length = BitConverter.ToUInt32(root,1052); if (length > 65536 || 1056 + length > returned) { report["CollectionStatus"] = "NativeIdentityMalformed"; return report; }
                bool owner = BitConverter.ToInt64(root,0) == binding.FileId && Utf8.GetString(root,1056,(int)length) == binding.Context;
                native["OwnedIdentityMatches"] = owner; native["ProviderNameMatches"] = Fixed(root,28) == Provider; native["ProviderVersionMatches"] = Fixed(root,540) == "0.1.0";
                native["HydrationPrimary"] = BitConverter.ToUInt16(root,8); native["HydrationModifier"] = BitConverter.ToUInt16(root,10); native["PopulationPrimary"] = BitConverter.ToUInt16(root,12); native["PopulationModifier"] = BitConverter.ToUInt16(root,14); native["InSyncPolicy"] = BitConverter.ToUInt32(root,16); native["HardlinkPolicy"] = BitConverter.ToUInt32(root,20);
                if (!owner) { report["CollectionStatus"] = "NativeOwnershipMismatch-NoFurtherInspection"; return report; }
                byte[] provider = new byte[1028]; uint providerReturned; int providerHr = CfGetSyncRootInfoByPath(binding.Root,2,provider,(uint)provider.Length,out providerReturned);
                native["ProviderStatusReadResult"] = providerHr; if (providerHr == 0 && providerReturned >= 1028 && providerReturned <= provider.Length) native["ProviderStatus"] = BitConverter.ToUInt32(provider,0);
                byte[] basic = new byte[65564]; uint basicReturned; int basicHr = CfGetPlaceholderInfo(selectedHandle,0,basic,(uint)basic.Length,out basicReturned); file["BasicInfoStatus"] = basicHr;
                bool validBasic = ValidBasicInfo(basicHr,basicReturned,basic);
                bool rootMatches = validBasic && BitConverter.ToInt64(basic,16) == binding.FileId;
                file["BasicInfoValid"] = validBasic;
                if (validBasic) { file["PinState"] = BitConverter.ToUInt32(basic,0); file["InSyncState"] = BitConverter.ToUInt32(basic,4); file["SyncRootFileIdMatches"] = rootMatches; }
                if (!MayInspectPhysicalShell(CloudTag(fileTag.Tag),validBasic,rootMatches)) {
                    report["CollectionStatus"] = "SelectedPlaceholderOwnershipUnavailable-NoShellInspection";
                    return report;
                }
                var registration = ReadRegistration(binding); report["Registration"] = registration;
                report["WinRtRegistration"] = ReadWinRt(binding);
                report["ShellPhysicalSelected"] = FastProperties(selected,binding);
                report["ShellPhysicalRoot"] = FastProperties(binding.Root,binding);
                // Registry ownership observations cannot qualify arbitrary COM activation chains.
                // Never parse/activate the persisted namespace CLSID from this diagnostic.
                var after = Tag(selectedHandle); file["AttributesUnchangedDuringObservation"] = after.Attributes == fileTag.Attributes && after.Tag == fileTag.Tag;
            }
        } finally { Require(RtlSetThreadPlaceholderCompatibilityMode(previous) >= 0); }
        // OS version from RtlGetVersion, no broad registry enumeration and no manifest-version virtualization.
        var version = new OsVersion(); version.Size = (uint)Marshal.SizeOf(typeof(OsVersion)); int status = RtlGetVersion(ref version); report["OsVersionReadStatus"] = status;
        if (status == 0) { report["OsMajor"] = version.Major; report["OsMinor"] = version.Minor; report["OsBuild"] = version.Build; }
        report["Limits"] = "Fast properties may be absent; registry flags are not a direct AllowPinning getter. Optional WinRT projection reports unavailability. No menu invocation or hydration proof. Local snapshots do not exclude concurrent changes.";
        report["CollectionStatus"] = "Collected";
        return report;
    }
    static Dictionary<string,object> ReadWinRt(Binding b)
    {
        var r = new Dictionary<string,object>(); r["Status"] = "ProjectionUnavailable";
        // Existing WinPS classic WinRT projection only; no downloaded assembly or alternative identity.
        try {
            Type t = Type.GetType("Windows.Storage.Provider.StorageProviderSyncRootManager, Windows.Storage.Provider, ContentType=WindowsRuntime",false);
            if (t == null) return r;
            var method = t.GetMethod("GetSyncRootInformationForId",new Type[]{typeof(string)}); if (method == null) return r;
            object info = method.Invoke(null,new object[]{b.Id}); if (info == null) { r["Status"] = "NoExactRegistration"; return r; }
            Type it = info.GetType(); var id = it.GetProperty("Id"); var pinning = it.GetProperty("AllowPinning");
            if (id == null || pinning == null) return r;
            bool match = String.Equals(id.GetValue(info,null) as string,b.Id,StringComparison.Ordinal); r["ExactIdMatches"] = match;
            var pathProperty = it.GetProperty("Path"); object folder = pathProperty == null ? null : pathProperty.GetValue(info,null);
            var folderPath = folder == null ? null : folder.GetType().GetProperty("Path");
            r["RootPathMatches"] = folderPath != null && String.Equals(folderPath.GetValue(folder,null) as string,b.Root,StringComparison.OrdinalIgnoreCase);
            object value = pinning.GetValue(info,null); if (match && value is bool) { r["Status"] = "Read"; r["AllowPinning"] = (bool)value; }
        } catch { r["Status"] = "ReadUnavailable"; }
        return r;
    }
    static object Value(RegistryKey key,string name) { return key == null ? null : key.GetValue(name,null,RegistryValueOptions.DoNotExpandEnvironmentNames); }
    static object Number(RegistryKey key,string name) { object v = Value(key,name); return v is int ? (object)unchecked((uint)(int)v) : null; }
    static Dictionary<string,object> ReadRegistration(Binding b)
    {
        var r = new Dictionary<string,object>();
        using (var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,RegistryView.Registry64)) using (var metadata = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager\" + b.Id,false)) {
            r["DisplayNameMatchesReceipt"] = String.Equals(Value(metadata,"DisplayNameResource") as string,b.DisplayName,StringComparison.Ordinal);
            r["ExactProviderKeyPresent"] = metadata != null; r["Flags"] = Number(metadata,"Flags"); r["NamespaceMatchesReceipt"] = String.Equals(Value(metadata,"NamespaceCLSID") as string,b.Namespace,StringComparison.OrdinalIgnoreCase);
            using (var roots = metadata == null ? null : metadata.OpenSubKey("UserSyncRoots",false)) r["ExactUserRootMatches"] = String.Equals(Value(roots,b.Sid) as string,b.Root,StringComparison.OrdinalIgnoreCase);
        }
        using (var user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,RegistryView.Registry64)) using (var clsid = user.OpenSubKey(@"Software\Classes\CLSID\"+b.Namespace,false)) using (var instance = clsid == null ? null : clsid.OpenSubKey("Instance",false)) using (var bag = instance == null ? null : instance.OpenSubKey("InitPropertyBag",false)) using (var folder = clsid == null ? null : clsid.OpenSubKey("ShellFolder",false)) using (var entry = user.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\"+b.Namespace,false)) {
            r["NamespaceClassPresent"] = clsid != null; r["DesktopNamespacePresent"] = entry != null; r["TargetFolderMatches"] = String.Equals(Value(bag,"TargetFolderPath") as string,b.Root,StringComparison.OrdinalIgnoreCase);
            r["FilesystemFolderInstanceClsidMatches"] = String.Equals(Value(instance,"CLSID") as string,"{0E5AAE11-A475-4c5b-AB00-C66DE400274E}",StringComparison.OrdinalIgnoreCase);
            r["TargetFolderAttributes"] = Number(bag,"Attributes"); r["ShellFolderAttributes"] = Number(folder,"Attributes"); r["FolderValueFlags"] = Number(folder,"FolderValueFlags"); r["PinnedToNamespaceTree"] = Number(clsid,"System.IsPinnedToNameSpaceTree");
        }
        return r;
    }
    static Dictionary<string,object> FastProperties(string path,Binding b)
    {
        // Defense in depth: even a future call site cannot pass a shell namespace parsing name.
        Canonical(path);
        var r = new Dictionary<string,object>(); Guid iid = typeof(IPropertyStore).GUID; IPropertyStore store = null;
        int hr = SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,8,ref iid,out store); r["ReadStatus"] = hr;
        if (hr != 0 || store == null) return r;
        try {
            foreach (string name in new string[] {"System.FilePlaceholderStatus","System.StorageProviderId","System.StorageProviderFullyQualifiedId","System.StorageProviderStatus"}) {
                PropertyKey key; int keyHr = PSGetPropertyKeyFromName(name,out key); var item = new Dictionary<string,object>(); r[name] = item; item["KeyStatus"] = keyHr; if (keyHr != 0) continue;
                var value = new PropVariant(); int valueHr = store.GetValue(ref key,out value); item["ReadStatus"] = valueHr;
                try { item["VariantType"] = value.Type; if (valueHr != 0) continue;
                    if (name == "System.StorageProviderId" || name == "System.StorageProviderFullyQualifiedId") {
                        if (value.Type == 31 && value.Pointer != IntPtr.Zero) { string text = Marshal.PtrToStringUni(value.Pointer); item["Present"] = !String.IsNullOrEmpty(text); item["MatchesExpected"] = text == (name == "System.StorageProviderId" ? Provider : b.Id); }
                    } else if (value.Type == 19) item["NumericValue"] = value.UInt32;
                    else if (value.Type == 3) item["NumericValue"] = value.Int32;
                } finally { PropVariantClear(ref value); }
            }
        } finally { Marshal.ReleaseComObject(store); }
        return r;
    }
    static SafeFileHandle MetadataHandle(string path) {
        var h = CreateFileW(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        try { Require(!h.IsInvalid); var final = new StringBuilder(512); uint n = GetFinalPathNameByHandleW(h,final,(uint)final.Capacity,0); Require(n > 0 && n < final.Capacity && String.Equals(final.ToString(),"\\\\?\\"+path,StringComparison.OrdinalIgnoreCase)); return h; }
        catch { h.Dispose(); throw; }
    }
    sealed class Handles : IDisposable { internal readonly List<SafeFileHandle> Items = new List<SafeFileHandle>(); public void Dispose() { for (int i = Items.Count-1; i >= 0; i--) Items[i].Dispose(); } }
    static Handles FenceDirectories(string leaf,string cloudRoot)
    {
        var paths = new List<string>(); for (string p = leaf; p != null; p = Path.GetDirectoryName(p)) paths.Add(p); paths.Reverse(); var handles = new Handles();
        try { foreach (string p in paths) { var h = MetadataHandle(p); handles.Items.Add(h); AttrTag t = Tag(h); bool ownedCloud = cloudRoot != null && (String.Equals(p,cloudRoot,StringComparison.OrdinalIgnoreCase) || Within(p,cloudRoot)); Require((t.Attributes & 16) != 0 && ((t.Attributes & 1024) == 0 || ownedCloud && CloudTag(t.Tag))); } return handles; } catch { handles.Dispose(); throw; }
    }
    static AttrTag Tag(SafeFileHandle h) { AttrTag a; Require(GetFileInformationByHandleEx(h,9,out a,8)); return a; }
    static bool CloudTag(uint t) { return (t & 0xFFFF0FFFu) == 0x9000001Au; }
    static bool ValidBasicInfo(int status,uint returned,byte[] bytes) { return status == 0 && returned >= 28 && returned <= bytes.Length && BitConverter.ToUInt32(bytes,24) <= 65536 && 28 + BitConverter.ToUInt32(bytes,24) <= returned; }
    static bool MayInspectPhysicalShell(bool cloudTag,bool validBasic,bool rootMatches) { return !cloudTag || validBasic && rootMatches; }
    static string Fixed(byte[] bytes,int offset) { string text = Utf16.GetString(bytes,offset,512); int end = text.IndexOf('\0'); Require(end >= 0); return text.Substring(0,end); }
    public static void SaveReport(string json)
    {
        Require(json != null && json.Length <= 65536); string parent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"LedgeTop","Files","pilot");
        using (var parentFence = FenceDirectories(parent,null)) {
            string target = Path.Combine(parent,"Diagnostics"); if (!Directory.Exists(target)) Directory.CreateDirectory(target);
            using (var targetFence = FenceDirectories(target,null)) {
                string path = Path.Combine(target,"shell-state-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfff") + "-" + Guid.NewGuid().ToString("N") + ".json");
                using (var f = new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { byte[] bytes = Utf8.GetBytes(json); f.Write(bytes,0,bytes.Length); }
            }
        }
    }
    public static void PureTests()
    {
        PureProfileTests();
        string user = @"C:\Users\Synthetic"; string root = user + "\\LedgeTop Files Pilot \u2014 Company files";
        Require(AllowedRoot(root,user) && AllowedRoot(root+" (2)",user) && AllowedRoot(root+" (9999)",user));
        foreach (string suffix in new string[]{" (1)"," (02)"," (10000)"," (2)\\Nested","-evil"}) Require(!AllowedRoot(root+suffix,user));
        Require(Within(root+"\\photo.jpg",root) && !Within(root+"-other\\photo.jpg",root));
        foreach (string bad in new string[]{@"\\server\share\file",@"C:\a\..\b",@"C:\a\file:stream",@"C:\a\*.jpg",@"C:\a\file.",@"C:\a\file ","shell:::{00000000-0000-0000-0000-000000000000}"}) { bool refused = false; try { Canonical(bad); } catch { refused = true; } Require(refused); }
        Require(S(Json.Parse("{\"x\":\"ok\"}"),"x") == "ok");
        foreach (string bad in new string[]{"{\"x\":1,\"x\":2}","{\"X\":1,\"x\":2} trailing","{\"x\":1.2}","{\"x\":01}","{\"x\":\"\\uD800\"}","[]"}) { bool refused = false; try { Json.Parse(bad); } catch { refused = true; } Require(refused); }
        Require(CloudTag(0x9000001A) && CloudTag(0x9000101A) && !CloudTag(0xA0000003));
        Require(!MayInspectPhysicalShell(true,false,false) && !MayInspectPhysicalShell(true,true,false) && !MayInspectPhysicalShell(true,false,true) && MayInspectPhysicalShell(true,true,true) && MayInspectPhysicalShell(false,false,false));
        byte[] basic = new byte[28]; Require(ValidBasicInfo(0,28,basic) && !ValidBasicInfo(-1,28,basic) && !ValidBasicInfo(0,27,basic) && !ValidBasicInfo(0,29,basic)); basic[24] = 1; Require(!ValidBasicInfo(0,28,basic));
        Require(Marshal.SizeOf(typeof(AttrTag)) == 8 && Marshal.SizeOf(typeof(PropertyKey)) == 20 && Marshal.SizeOf(typeof(PropVariant)) == 24 && typeof(IPropertyStore).GUID.ToString() == "886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
        bool unknown = false; try { Keys(Json.Parse("{\"Expected\":1,\"Unexpected\":2}"),"Expected"); } catch { unknown = true; } Require(unknown);
    }
    static Dictionary<string,object> SyntheticProfile(long schema,string sid,string user,string principal)
    {
        const string id = "11111111111111111111111111111111";
        var scope = new Dictionary<string,object> { {"Channel","pilot"}, {"Alias","employee"}, {"Origin",Origin}, {"PrincipalId",principal} };
        var manifest = new Dictionary<string,object> { {"Scope",scope}, {"File","manifest-"+id+".json"}, {"Digest",new string('a',64)} };
        var profile = new Dictionary<string,object> {
            {"Schema",schema}, {"Owner",ProfileOwner}, {"Sid",sid}, {"Identity",id},
            {"Root",user+"\\LedgeTop Files Pilot \u2014 Company files"}, {"Context",ProfileOwner+":"+id},
            {"Icon",@"C:\Synthetic\icon.ico,0"}, {"RootFileId",42L}, {"Phase","Ready"},
            {"Paused",false}, {"Revision",1L}, {"NamespaceClsid","22222222-2222-2222-2222-222222222222"}, {"Binding",manifest}
        };
        if (schema == 4) profile.Add("DisplayName",CompanyDisplayName);
        return profile;
    }
    static void PureProfileTests()
    {
        const string sid = "S-1-5-21-111-222-333-1001", user = @"C:\Users\Synthetic";
        string principal = "odqp1_"+new string('b',64);
        Binding legacy = ParseProfileBinding(SyntheticProfile(3,sid,user,principal),principal,sid,user);
        Binding current = ParseProfileBinding(SyntheticProfile(4,sid,user,principal),principal,sid,user);
        Require(legacy.DisplayName == Provider && current.DisplayName == CompanyDisplayName &&
            legacy.Id == current.Id && legacy.Context == current.Context && legacy.Root == current.Root && legacy.FileId == current.FileId);
        foreach (long schema in new long[]{2,5}) RefuseProfile(SyntheticProfile(schema,sid,user,principal),principal,sid,user);
        foreach (object label in new object[]{null,42L,Provider,"LedgeTop Files","LedgeTop Files \u2014 Client deliveries",CompanyDisplayName+" "}) {
            var p = SyntheticProfile(4,sid,user,principal); p["DisplayName"] = label; RefuseProfile(p,principal,sid,user);
        }
        var missing = SyntheticProfile(4,sid,user,principal); missing.Remove("DisplayName"); RefuseProfile(missing,principal,sid,user);
        foreach (object label in new object[]{null,Provider,CompanyDisplayName}) {
            var p = SyntheticProfile(3,sid,user,principal); p.Add("DisplayName",label); RefuseProfile(p,principal,sid,user);
        }
        foreach (string field in new string[]{"Owner","Sid","Context","Phase","Identity","NamespaceClsid"}) {
            var p = SyntheticProfile(4,sid,user,principal); p[field] = "foreign"; RefuseProfile(p,principal,sid,user);
        }
        foreach (string field in new string[]{"Revision","RootFileId"}) {
            var p = SyntheticProfile(4,sid,user,principal); p[field] = 0L; RefuseProfile(p,principal,sid,user);
        }
        foreach (string field in new string[]{"Channel","Alias","Origin","PrincipalId"}) {
            var p = SyntheticProfile(4,sid,user,principal); D(D(p,"Binding"),"Scope")[field] = "foreign"; RefuseProfile(p,principal,sid,user);
        }
        foreach (string field in new string[]{"File","Digest"}) {
            var p = SyntheticProfile(4,sid,user,principal); D(p,"Binding")[field] = "foreign"; RefuseProfile(p,principal,sid,user);
        }
        foreach (string root in new string[]{user+"\\LedgeTop Files Pilot \u2014 Client deliveries",user+"\\LedgeTop Files Pilot \u2014 Company files-foreign"}) {
            var p = SyntheticProfile(4,sid,user,principal); p["Root"] = root; RefuseProfile(p,principal,sid,user);
        }
        var unknown = SyntheticProfile(4,sid,user,principal); unknown.Add("Other",true); RefuseProfile(unknown,principal,sid,user);
        foreach (string json in new string[]{"{\"Schema\":4,\"Schema\":3}","{\"DisplayName\":null,\"DisplayName\":\"LedgeTop Files\"}"}) {
            bool refused = false; try { Json.Parse(json); } catch (InvalidDataException) { refused = true; } Require(refused);
        }
    }
    static void RefuseProfile(Dictionary<string,object> profile,string principal,string sid,string user)
    {
        bool refused = false; try { ParseProfileBinding(profile,principal,sid,user); } catch (InvalidDataException) { refused = true; } Require(refused);
    }
    // Small bounded JSON reader: object/string/integer/boolean/null only; rejects duplicate names and invalid UTF16.
    sealed class Json
    {
        string text; int p; Json(string text) { this.text = text; }
        internal static Dictionary<string,object> Parse(string text) { var j = new Json(text); object value = j.Read(0); j.White(); Require(j.p == text.Length && value is Dictionary<string,object>); return (Dictionary<string,object>)value; }
        void White() { while (p < text.Length && (text[p] == ' ' || text[p] == '\t' || text[p] == '\r' || text[p] == '\n')) p++; }
        bool Eat(char c) { White(); if (p < text.Length && text[p] == c) { p++; return true; } return false; }
        object Read(int depth) { Require(depth <= 8); White(); Require(p < text.Length); char c = text[p]; if (c == '{') { p++; var d = new Dictionary<string,object>(StringComparer.Ordinal); if (Eat('}')) return d; do { string k = String(); Require(!d.ContainsKey(k) && d.Count < 32 && Eat(':')); d.Add(k,Read(depth+1)); if (Eat('}')) return d; Require(Eat(',')); } while (true); }
            if (c == '"') return String(); foreach (string s in new string[]{"true","false","null"}) if (text.Substring(p).StartsWith(s,StringComparison.Ordinal)) { p+=s.Length; return s == "null" ? null : (object)(s == "true"); }
            int start=p; if (c=='-') p++; Require(p<text.Length && text[p]>='0' && text[p]<='9'); if (text[p]=='0') p++; else while(p<text.Length && text[p]>='0' && text[p]<='9') p++; long n; Require(Int64.TryParse(text.Substring(start,p-start),System.Globalization.NumberStyles.AllowLeadingSign,System.Globalization.CultureInfo.InvariantCulture,out n)); return n;
        }
        string String() { Require(Eat('"')); var b = new StringBuilder(); bool end=false; while(p<text.Length) { char c=text[p++]; if(c=='"') {end=true;break;} Require(c>=32); if(c=='\\') {Require(p<text.Length); c=text[p++]; if(c=='u') {Require(p+4<=text.Length); int n; Require(Int32.TryParse(text.Substring(p,4),System.Globalization.NumberStyles.HexNumber,System.Globalization.CultureInfo.InvariantCulture,out n));p+=4;c=(char)n;} else {int i="\"\\/bfnrt".IndexOf(c); Require(i>=0);c="\"\\/\b\f\n\r\t"[i];}} b.Append(c);Require(b.Length<=65536); } Require(end); string result=b.ToString(); Utf8.GetBytes(result); return result; }
    }
    [StructLayout(LayoutKind.Sequential)] struct AttrTag { public uint Attributes,Tag; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct OsVersion { public uint Size,Major,Minor,Build,Platform; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Csd; }
    [StructLayout(LayoutKind.Sequential,Pack=4)] struct PropertyKey { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit,Size=24)] struct PropVariant { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; [FieldOffset(8)] public uint UInt32; [FieldOffset(8)] public int Int32; }
    [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore { [PreserveSig] int GetCount(out uint count); [PreserveSig] int GetAt(uint index,out PropertyKey key); [PreserveSig] int GetValue(ref PropertyKey key,out PropVariant value); [PreserveSig] int SetValue(ref PropertyKey key,ref PropVariant value); [PreserveSig] int Commit(); }
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint capacity,uint flags);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("kernel32.dll",ExactSpelling=true,SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,out AttrTag info,uint size);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("CldApi.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int CfGetSyncRootInfoByPath(string path,int kind,[Out]byte[] info,uint size,out uint returned);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("CldApi.dll",ExactSpelling=true)] static extern int CfGetPlaceholderInfo(SafeFileHandle h,int kind,[Out]byte[] info,uint size,out uint returned);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("CldApi.dll",ExactSpelling=true)] static extern uint CfGetPlaceholderStateFromAttributeTag(uint attributes,uint tag);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("ntdll.dll",ExactSpelling=true)] static extern sbyte RtlSetThreadPlaceholderCompatibilityMode(sbyte mode);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("ntdll.dll",ExactSpelling=true)] static extern int RtlGetVersion(ref OsVersion version);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("shell32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int SHGetPropertyStoreFromParsingName(string path,IntPtr bind,uint flags,ref Guid iid,[MarshalAs(UnmanagedType.Interface)]out IPropertyStore store);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("propsys.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int PSGetPropertyKeyFromName(string name,out PropertyKey key);
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] [DllImport("ole32.dll",ExactSpelling=true)] static extern int PropVariantClear(ref PropVariant value);
}
