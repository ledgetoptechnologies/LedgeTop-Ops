using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
if (args.Length > 0) return await Child(args);
string root = Path.Combine(Path.GetTempPath(), "LedgeTopSelectorProof-" + Guid.NewGuid().ToString("N"));
string dir = Path.Combine(root, "owner"), moved = Path.Combine(root, "moved"), selector = Path.Combine(dir, "selector.json"), backup = Path.Combine(dir, "backup.json"), replacement = Path.Combine(dir, "new.json");
Directory.CreateDirectory(dir); File.WriteAllText(selector, "first"); File.WriteAllText(backup, "backup"); File.WriteAllText(replacement, "replacement");
try {
    using (var writer = Start("hold", selector)) try {
        string? ready = await writer.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
        if (ready != "ready") throw new Exception("writer did not acquire handle");
        bool denied = false; try { using var conflict = new FileStream(selector, FileMode.Open, FileAccess.Read, FileShare.Read); } catch (IOException e) when (e.HResult == unchecked((int)0x80070020)) { denied = true; }
        if (!denied) throw new Exception("existing writer was not rejected");
        await writer.StandardInput.WriteLineAsync("exit"); await WaitOwned(writer); if (writer.ExitCode != 0) throw new Exception("writer failed");
    } finally { if (!writer.HasExited) { writer.Kill(true); await writer.WaitForExitAsync(); } }
    using (var folder = CreateFileW(dir, 0x81, 3, 0, 3, 0x02200000, 0)) {
        if (folder.IsInvalid) throw new Exception("failed to fence directory");
        using (var current = new FileStream(selector, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var prior = new FileStream(backup, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            await ExpectDenied("write", selector); await ExpectDenied("write", backup); await ExpectDenied("replace", selector, replacement); await ExpectDenied("rename", dir, moved);
        }
    }
    await ExpectSuccess("write", selector); await ExpectSuccess("replace", selector, replacement); await ExpectSuccess("rename", dir, moved);
    Console.WriteLine("PASS preexisting-writer refused; selector/backup writes, replacement and held-directory rename denied; operations succeeded after release");
    return 0;
} finally {
    string actual = Directory.Exists(dir) ? dir : moved;
    foreach (var name in new[] { "selector.json", "backup.json", "new.json" }) { string path = Path.Combine(actual, name); if (File.Exists(path)) File.Delete(path); }
    if (Directory.Exists(actual)) Directory.Delete(actual); if (Directory.Exists(root)) Directory.Delete(root);
}

static Process Start(params string[] a) { var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true }; foreach (var x in a) info.ArgumentList.Add(x); return Process.Start(info) ?? throw new Exception("child start failed"); }
static async Task WaitOwned(Process p) { try { await p.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); } catch { if (!p.HasExited) { p.Kill(true); await p.WaitForExitAsync(); } throw; } }
static async Task ExpectDenied(params string[] a) { using var p = Start(a); await WaitOwned(p); string reason = (await p.StandardError.ReadToEndAsync()).Trim(); string expected = a[0] == "replace" ? "UnauthorizedAccessException 0x80070005" : "IOException 0x80070020"; if (p.ExitCode != 3 || reason != expected) throw new Exception($"expected {expected}: {a[0]}, exit {p.ExitCode}, stderr {reason}"); Console.WriteLine($"Denied {a[0]}: {reason}"); }
static async Task ExpectSuccess(params string[] a) { using var p = Start(a); await WaitOwned(p); if (p.ExitCode != 0) throw new Exception($"expected success: {a[0]}, exit {p.ExitCode}, stderr {await p.StandardError.ReadToEndAsync()}"); }
static async Task<int> Child(string[] a) { try { switch(a[0]) { case "hold": using (var f = new FileStream(a[1], FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) { Console.WriteLine("ready"); await Console.In.ReadLineAsync(); } break; case "write": using (var f = new FileStream(a[1], FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) { f.WriteByte(1); } break; case "replace": File.Move(a[2], a[1], true); break; case "rename": Directory.Move(a[1], a[2]); break; default: return 2; } return 0; } catch (IOException e) { Console.Error.WriteLine($"IOException 0x{e.HResult:X8}"); return 3; } catch (UnauthorizedAccessException e) { Console.Error.WriteLine($"UnauthorizedAccessException 0x{e.HResult:X8}"); return 3; } }
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
