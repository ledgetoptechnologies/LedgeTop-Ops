using System.Runtime.InteropServices;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using Microsoft.Win32;
using Windows.Security.Cryptography;
using Windows.Storage;
using Windows.Storage.Provider;

// Destructive native experiment for an explicitly disposable VM only. The absence of a
// CldFlt volume instance and an empty broker list do NOT prove absence of native-only roots.
// Windows arbitrates root collisions; every ambiguous broker outcome is left for review.
internal static class FirstShellRegistrationProbe
{
    private const string Gate = "LEDGETOP_DISPOSABLE_VM_FIRST_ROOT";
    private const string Confirmation = "I_CONFIRM_DISPOSABLE_VM_NO_USER_DATA";
    private const int InvalidFunction = unchecked((int)0x80070001);
    private const int NoMoreItems = unchecked((int)0x80070103);
    // INSTANCE_INFORMATION_CLASS: Basic=0, Partial=1, Full=2.
    private const int InstanceFullInformation = 2;
    private const string MachineParent = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager";

    internal static int GateTests()
    {
        if (!Admitted(Confirmation) || Admitted(null) || Admitted("") || Admitted("yes") || Admitted(Confirmation.ToLowerInvariant()))
            throw new Exception("Disposable VM gate failed.");
        if (InstanceFullInformation != 2) throw new Exception("Full information class ABI changed.");
        byte[] Record(string name) {
            var bytes = Encoding.Unicode.GetBytes(name); var result = new byte[20 + bytes.Length];
            BinaryPrimitives.WriteUInt16LittleEndian(result.AsSpan(16), checked((ushort)bytes.Length));
            BinaryPrimitives.WriteUInt16LittleEndian(result.AsSpan(18), 20); bytes.CopyTo(result, 20); return result;
        }
        if (InterpretInstance(NoMoreItems, ReadOnlySpan<byte>.Empty) != InstanceResult.End ||
            InterpretInstance(0, Record("CldFlt")) != InstanceResult.CloudFilter ||
            InterpretInstance(0, Record("cldflt")) != InstanceResult.CloudFilter ||
            InterpretInstance(0, Record("CldFltOther")) != InstanceResult.Other)
            throw new Exception("Filter record interpretation failed.");
        void Reject(byte[] bytes) {
            try { _ = InterpretInstance(0, bytes); }
            catch (IOException) { return; }
            throw new Exception("Malformed filter record was accepted.");
        }
        Reject(new byte[19]); Reject(new byte[20]); Reject(new byte[65537]);
        var odd = Record("CldFlt"); odd[16] = 3; Reject(odd);
        var offset = Record("CldFlt"); offset[18] = 21; Reject(offset);
        var outside = Record("CldFlt"); outside[16] = 100; Reject(outside);
        var insideHeader = Record("CldFlt"); insideHeader[18] = 18; Reject(insideHeader);
        var embeddedNull = Record("Cld\0Flt"); Reject(embeddedNull);
        var invalidUnicode = Record("A"); invalidUnicode[20] = 0; invalidUnicode[21] = 0xD8; Reject(invalidUnicode);
        try { _ = InterpretInstance(unchecked((int)0x80070005), ReadOnlySpan<byte>.Empty); throw new Exception("Unexpected HRESULT accepted."); }
        catch (IOException) { }
        Console.WriteLine("PASS: explicit disposable VM gate and full-instance record ABI; no filesystem, registry, filter or broker calls.");
        return 0;
    }

    private static bool Admitted(string? value) => string.Equals(value, Confirmation, StringComparison.Ordinal);

    internal static async Task<int> RunAsync()
    {
        if (!Admitted(Environment.GetEnvironmentVariable(Gate))) {
            Console.Error.WriteLine($"Refused: set {Gate}={Confirmation} only in a separately verified disposable Windows VM.");
            return 2;
        }
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            throw new PlatformNotSupportedException("This explicit VM probe requires Windows x64.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var id = Guid.NewGuid();
        var directory = Path.Combine(local, "LedgeTopFilesFirstShellProbe-" + id.ToString("N"));
        var root = Path.Combine(directory, "Files");
        var receiptPath = Path.Combine(directory, "receipt.jsonl");
        var context = Encoding.UTF8.GetBytes("LedgeTop.FirstShellProbe:" + id.ToString("N"));
        var shellId = ShellRegistration.CreateId(id);
        var icon = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3";
        var volume = Path.GetPathRoot(root) ?? throw new IOException("No root volume.");
        var drive = new DriveInfo(volume);
        if (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase))
            throw new IOException("A fixed local NTFS VM volume is required.");
        ValidateAncestors(local);
        using var fence = new CandidateDirectoryFence();
        fence.HoldAncestors(local);
        var directoryPin = fence.CreateExclusiveDirectory(directory);
        using var receiptStream = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        void Record(string phase, object? details = null)
        {
            var line = JsonSerializer.Serialize(new { phase, utc = DateTimeOffset.UtcNow, id, root, shellId, context = Convert.ToBase64String(context), icon, details }) + "\n";
            var bytes = Encoding.UTF8.GetBytes(line); receiptStream.Write(bytes); receiptStream.Flush(flushToDisk: true);
        }
        Record("root-create-intent", new { machine = Environment.MachineName, osVersion = Environment.OSVersion.VersionString, user = Environment.UserName, volume, directoryPin,
            warning = "No CldFlt instance and empty shell lists do not establish absence of native-only roots. Windows will arbitrate collisions." });
        Console.WriteLine("Receipt: " + receiptPath);
        try {
            var rootPin = fence.CreateExclusiveDirectory(root);
            Record("root-created", new { directoryPin, rootPin });
            if (!StorageProviderSyncRootManager.IsSupported()) throw new IOException("Cloud Files broker unsupported.");
            CheckClean(root, shellId, volume, Record);
            var folder = await StorageFolder.GetFolderFromPathAsync(root);
            CheckClean(root, shellId, volume, Record);
            if (fence.Recheck(directory) != directoryPin || fence.Recheck(root) != rootPin)
                throw new IOException("Retained fixture directory identity changed.");
            // Durable intent precedes the one broker call. A crash or failure after here is
            // ambiguous: no second registration and no cleanup without exact ownership.
            Record("broker-register-intent", new { directoryPin, rootPin });
            try {
                StorageProviderSyncRootManager.Register(new StorageProviderSyncRootInfo {
                    Id = shellId, Path = folder, DisplayNameResource = ShellRegistration.DisplayName, IconResource = icon,
                    Version = NativeRootRegistration.ProviderVersion, AllowPinning = true, ShowSiblingsAsGroup = false,
                    HydrationPolicy = StorageProviderHydrationPolicy.Full, HydrationPolicyModifier = StorageProviderHydrationPolicyModifier.None,
                    PopulationPolicy = StorageProviderPopulationPolicy.AlwaysFull, HardlinkPolicy = StorageProviderHardlinkPolicy.None,
                    InSyncPolicy = (StorageProviderInSyncPolicy)1023, Context = CryptographicBuffer.CreateFromByteArray(context)
                });
            } catch (Exception ex) {
                Record("broker-outcome-uncertain", new { error = ex.GetType().Name, hresult = ex.HResult, nativeHresult = NativeStatus(root), filterAttached = TryFilterObservation(volume) });
                Console.Error.WriteLine("Broker failure retained for review; no retry or unregister."); return 1;
            }
            Record("broker-returned-success", new { nativeHresult = NativeStatus(root), filterAttached = TryFilterObservation(volume) });
            // OpenOwned requires exact native identity/context/policies, root file ID and
            // shell metadata; failure leaves the registration for manual reconciliation.
            var owned = ShellRegistration.OpenOwned(root, shellId, context, icon);
            if (owned.NamespaceClsid == Guid.Empty || owned.RootFileId == 0 || owned.RootFileId != unchecked((long)rootPin.FileId) ||
                fence.Recheck(directory) != directoryPin) throw new IOException("Exact ownership readback or retained root identity differs.");
            var observation = ShellRegistration.Inspect(root, shellId, context, owned.NamespaceClsid, icon);
            Record("exact-ownership-confirmed", new { owned.NamespaceClsid, owned.RootFileId, observation });
            Record("unregister-intent", new { owned.NamespaceClsid, owned.RootFileId });
            owned.Unregister(); // One attempt, internal exact ownership rechecked before the call.
            var absent = ShellRegistration.Inspect(root, shellId, context, owned.NamespaceClsid, icon);
            if (!absent.CompleteAbsenceVerified) throw new IOException("Exact removal absence unconfirmed.");
            Record("completed", new { absent, nativeHresult = NativeStatus(root), filterAttached = TryFilterObservation(volume) });
            Console.WriteLine("PASS: direct broker registration and exact owned unregister. Root and receipt retained."); return 0;
        } catch (Exception ex) {
            try { Record("held-for-review", new { error = ex.GetType().Name, hresult = ex.HResult, nativeHresult = NativeStatus(root), filterAttached = TryFilterObservation(volume) }); } catch { }
            Console.Error.WriteLine("Probe stopped; inspect retained receipt and root. No further mutation was attempted."); return 1;
        }
    }

    private static void CheckClean(string root, string shellId, string volume, Action<string, object?> record)
    {
        ValidateAncestors(root);
        if (Directory.EnumerateFileSystemEntries(root).Any()) throw new IOException("Synthetic root is not empty.");
        using var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var parent = machine.OpenSubKey(MachineParent, false) ?? throw new IOException("SyncRootManager state unavailable.");
        var names = parent.GetSubKeyNames();
        if (names.Any(n => n.Equals(shellId, StringComparison.OrdinalIgnoreCase)) || names.Length != 0)
            throw new IOException("Existing shell sync-root records found; use a clean disposable VM.");
        if (StorageProviderSyncRootManager.GetCurrentSyncRoots().Count != 0)
            throw new IOException("Existing broker sync roots found; use a clean disposable VM.");
        var filter = FilterAttached(volume);
        var native = NativeStatus(root);
        record("preflight-observation", new { nativeHresult = native, filterAttached = filter, shellEntryCount = names.Length });
        if (filter || native != InvalidFunction) throw new IOException("The required clean-volume no-filter observation is unavailable.");
    }

    private static void ValidateAncestors(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current)) {
            if (!Directory.Exists(current) || (File.GetAttributes(current) & System.IO.FileAttributes.ReparsePoint) != 0)
                throw new IOException("Directory path missing or contains a reparse point.");
        }
    }

    private static int NativeStatus(string path)
    {
        var buffer = new byte[1056 + 65536];
        return CfGetSyncRootInfoByPath(path, 1, buffer, (uint)buffer.Length, out _);
    }
    private static bool? TryFilterObservation(string volume) { try { return FilterAttached(volume); } catch { return null; } }

    private enum InstanceResult { End, Other, CloudFilter }
    private static InstanceResult InterpretInstance(int hr, ReadOnlySpan<byte> record)
    {
        if (hr == NoMoreItems) return InstanceResult.End;
        if (hr != 0) throw new IOException($"Filter instance enumeration failed (0x{hr:X8}).");
        if (record.Length < 20 || record.Length > 65536) throw new IOException("Filter instance record invalid.");
        var length = BinaryPrimitives.ReadUInt16LittleEndian(record[16..]);
        var offset = BinaryPrimitives.ReadUInt16LittleEndian(record[18..]);
        if (length == 0 || (length & 1) != 0 || (offset & 1) != 0 || offset < 20 || offset + length > record.Length)
            throw new IOException("Filter instance name bounds invalid.");
        string name;
        try { name = new UnicodeEncoding(false, false, true).GetString(record.Slice(offset, length)); }
        catch (DecoderFallbackException ex) { throw new IOException("Filter instance name encoding invalid.", ex); }
        if (name.Contains('\0')) throw new IOException("Filter instance name contains NUL.");
        return string.Equals(name, "CldFlt", StringComparison.OrdinalIgnoreCase) ? InstanceResult.CloudFilter : InstanceResult.Other;
    }

    private static bool FilterAttached(string volume)
    {
        var buffer = Marshal.AllocHGlobal(65536); nint search = 0;
        try {
            var hr = FilterVolumeInstanceFindFirst(volume, InstanceFullInformation, buffer, 65536, out var size, out search);
            while (true) {
                if (size > 65536 && hr == 0) throw new IOException("Filter instance record oversized.");
                var bytes = new byte[hr == 0 ? checked((int)size) : 0];
                if (bytes.Length != 0) Marshal.Copy(buffer, bytes, 0, bytes.Length);
                var result = InterpretInstance(hr, bytes);
                if (result == InstanceResult.End) return false;
                if (result == InstanceResult.CloudFilter) return true;
                hr = FilterVolumeInstanceFindNext(search, InstanceFullInformation, buffer, 65536, out size);
            }
        } finally { if (search != 0 && search != -1) _ = FilterVolumeInstanceFindClose(search); Marshal.FreeHGlobal(buffer); }
    }

    [DllImport("cldapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int CfGetSyncRootInfoByPath(string path, int infoClass, byte[] buffer, uint size, out uint returned);
    [DllImport("fltlib.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int FilterVolumeInstanceFindFirst(string volume, int infoClass, nint buffer, uint size, out uint returned, out nint search);
    [DllImport("fltlib.dll")] private static extern int FilterVolumeInstanceFindNext(nint search, int infoClass, nint buffer, uint size, out uint returned);
    [DllImport("fltlib.dll")] private static extern int FilterVolumeInstanceFindClose(nint search);
}
