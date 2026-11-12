#if LEDGETOP_BRAND_OBSERVER_TEST
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using Microsoft.Win32.SafeHandles;

// One specific generated test only. This is not an app cleanup or generic repair tool.
internal static class ExactBrandReconciliation
{
    private const string Fixture = @"C:\Users\fstor\.codex\artifacts\LedgeTop-Files-2026-10-25\LedgeTopHeldBrokerProbe-332ffec8b9d54d58bfab806eda4b39f3\held-broker-67dd364b7da544f19b0d4582028fe99c";
    private const string IdText = "67dd364b7da544f19b0d4582028fe99c";
    private const uint Volume = 1727898972;
    private const ulong FileId = 1688849875496948;
    private static readonly Guid Namespace = Guid.Parse("d208c2d8-b05a-42f4-81d4-72f8224672fb");
    private static readonly Guid Id = Guid.ParseExact(IdText, "N");
    private static string Root => Path.Combine(Fixture, "Files");
    private static string Label => "LedgeTop Files Test " + IdText;
    private static byte[] Context => Encoding.UTF8.GetBytes("LedgeTop.Files.HeldBrokerProbe.v1:" + IdText);

    private static void Require(bool condition, string reason) { if (!condition) throw new IOException(reason); }
    private static bool EvidenceMatches(string id, string root, uint volume, ulong fileId, string context, Guid ns, ulong nativeId, bool expectedContext, bool unregisterAttempted) =>
        id == Id.ToString() && string.Equals(root, Root, StringComparison.OrdinalIgnoreCase) && volume == Volume && fileId == FileId &&
        context == Convert.ToBase64String(Context) && ns == Namespace && nativeId == FileId && expectedContext && !unregisterAttempted;

    internal static int Tests()
    {
        var context = Convert.ToBase64String(Context);
        Require(EvidenceMatches(Id.ToString(), Root, Volume, FileId, context, Namespace, FileId, true, false), "valid evidence refused");
        Require(!EvidenceMatches(Id.ToString(), Root, Volume, FileId, context, Namespace, FileId + 1, true, false), "different native ID accepted");
        Require(!EvidenceMatches(Id.ToString(), Root, Volume, FileId, context, Namespace, FileId, true, true), "replayed removal accepted");
        Require(!EvidenceMatches(Id.ToString(), Root, Volume, FileId, context, Guid.NewGuid(), FileId, true, false), "different namespace accepted");
        Require(!EvidenceMatches(Id.ToString(), Root, Volume, FileId, context, Namespace, FileId, false, false), "mismatched context accepted");
        Console.WriteLine("PASS exact fixture evidence decisions; no shell or filesystem mutation.");
        return 0;
    }

    internal static int Run()
    {
        var attempt = Path.Combine(Fixture, "reconcile-attempt.json");
        var result = Path.Combine(Fixture, "reconcile-result.json");
        Require(!File.Exists(attempt) && !File.Exists(result), "A reconciliation attempt already exists; no retry.");
        using var intent = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Fixture, "intent.json")));
        using var saved = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Fixture, "registered.json")));
        using var uncertain = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(Fixture, "uncertain.json")));
        var a = intent.RootElement; var b = saved.RootElement; var c = uncertain.RootElement;
        Require(a.GetProperty("generatedDataOnly").GetBoolean() && !a.GetProperty("productionAccess").GetBoolean() &&
            a.GetProperty("shellId").GetString() == ShellRegistration.CreateId(Id) && b.GetProperty("id").GetString() == Id.ToString() &&
            c.GetProperty("id").GetString() == Id.ToString() && c.GetProperty("phase").GetString() == "post-registration" &&
            EvidenceMatches(a.GetProperty("id").GetString()!, a.GetProperty("root").GetString()!, a.GetProperty("volume").GetUInt32(),
                a.GetProperty("fileId").GetUInt64(), a.GetProperty("context").GetString()!, b.GetProperty("NamespaceClsid").GetGuid(),
                b.GetProperty("RootFileId").GetUInt64(), b.GetProperty("ExpectedContextMatches").GetBoolean(), c.GetProperty("unregisterAttempted").GetBoolean()) &&
            b.GetProperty("volume").GetUInt32() == Volume && b.GetProperty("fileId").GetUInt64() == FileId, "Saved fixture identity differs.");
        foreach (var ancestor in Ancestors(Fixture))
            Require((File.GetAttributes(ancestor) & FileAttributes.ReparsePoint) == 0, "Fixture ancestry contains an alias.");
        using var root = CreateFileW(Root, 0x80, 3, 0, 3, 0x02200000, 0);
        Require(!root.IsInvalid && GetFileInformationByHandle(root, out var info) && info.Volume == Volume &&
            (((ulong)info.IndexHigh << 32) | info.IndexLow) == FileId && (info.Attributes & 0x10) != 0, "Held root identity differs.");
        RequireNoOwnedProcessesOrWindows();
        var icon = ExplorerBrandIcon.Resource;
        var observation = ShellRegistration.Inspect(Root, ShellRegistration.CreateId(Id), Context, Namespace, icon, Label);
        Require(observation.ExpectedNativeIdentityMatches && observation.ExactShellMetadataPresent && unchecked((ulong)observation.RootFileId) == FileId && observation.NamespaceClsid == Namespace,
            "Current registration differs from the saved identity.");
        var owned = ShellRegistration.OpenForRemoval(Root, ShellRegistration.CreateId(Id), Context, Namespace, (long)FileId, icon, Label);
        owned.VerifyOwned();
        RequireNoOwnedProcessesOrWindows();
        WriteNew(attempt, new { id = Id, root = Root, volume = Volume, fileId = FileId, namespaceClsid = Namespace, operation = "unregister-once" });
        owned.Unregister(); // Never replay after the durable intent, even if the call throws.
        var after = ShellRegistration.Inspect(Root, ShellRegistration.CreateId(Id), Context, Namespace, icon, Label);
        Require(after.CompleteAbsenceVerified, "Removal needs read-only reconciliation; do not retry.");
        WriteNew(result, new { id = Id, completeAbsenceVerified = true });
        Console.WriteLine("Exact generated test registration removed and absence verified; fixture retained.");
        return 0;
    }

    private static IEnumerable<string> Ancestors(string path) { for (string? p = path; p is not null; p = Path.GetDirectoryName(p)) yield return p; }
    private static void WriteNew(string path, object value)
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        stream.Write(JsonSerializer.SerializeToUtf8Bytes(value)); stream.Flush(true);
    }
    private static void RequireNoOwnedProcessesOrWindows()
    {
        // Use WMI and Shell.Application in a separate, bounded PowerShell child. Failure to enumerate is a refusal.
        var script = """
$ErrorActionPreference='Stop'
$fixture='C:\Users\fstor\.codex\artifacts\LedgeTop-Files-2026-10-25\LedgeTopHeldBrokerProbe-332ffec8b9d54d58bfab806eda4b39f3\held-broker-67dd364b7da544f19b0d4582028fe99c'
$root=Join-Path $fixture 'Files'
$parentId=__PARENT__
foreach($p in Get-CimInstance Win32_Process -Filter "Name = 'dotnet.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'") {
  if ($p.ProcessId -eq $PID -or $p.ProcessId -eq $parentId) { continue }
  if ($null -eq $p.CommandLine) { throw 'Process command line unavailable.' }
  if ($p.CommandLine.IndexOf($fixture,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $p.CommandLine.IndexOf('--held-brand-observer-probe',[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Matching observer/test process remains.' }
}
$shell=New-Object -ComObject Shell.Application
foreach($window in $shell.Windows()) {
  try { $path=$window.Document.Folder.Self.Path } catch { throw 'Explorer window path unavailable.' }
  if ([string]::Equals($path,$root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Matching Explorer window remains.' }
}
""";
        var bytes = Encoding.Unicode.GetBytes(script.Replace("__PARENT__", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe")) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true
        };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(bytes) }) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("Observation process unavailable.");
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000)) { try { process.Kill(); } catch { } throw new IOException("Observation timed out; no removal attempted."); }
        Task.WaitAll(output, error);
        Require(process.ExitCode == 0, "Process or Explorer-window observation unavailable; no removal attempted.");
    }
    [StructLayout(LayoutKind.Sequential)] private struct NativeFileInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out NativeFileInfo info);
}
#endif
