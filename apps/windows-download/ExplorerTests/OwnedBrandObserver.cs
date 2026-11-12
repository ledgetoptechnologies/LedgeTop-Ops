#if LEDGETOP_BRAND_OBSERVER_TEST
using System.Collections;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;
using Microsoft.Win32.SafeHandles;

// Test-only child. The parent retains the root registration on any failure or timeout.
internal static class OwnedBrandObserver
{
    private sealed class StepFailure(string code) : Exception { internal string Code { get; } = code; }
    private static string SafeCode(Exception error) => error is StepFailure known ? known.Code : "observer-failed";
    internal static int DiagnosticTests()
    {
        if (SafeCode(new StepFailure("window-not-found")) != "window-not-found" ||
            SafeCode(new IOException("SECRET C:\\private\\path")) != "observer-failed") throw new IOException("Child diagnostic redaction failed.");
        var result = HeldShellBrokerProbe.ObserverFailure.FromExit(1, "OBSERVER_STAGE:opening-window\nOBSERVER_CODE:window-not-found\n", false);
        if (result.Code != "window-not-found" || result.LastStage != "opening-window") throw new IOException("Child code was not classified.");
        var invalid = HeldShellBrokerProbe.ObserverFailure.FromExit(1, "OBSERVER_CODE:SECRET-CODE\n", false);
        if (invalid.Code != "observer-failed") throw new IOException("Unrecognized code was accepted.");
        var duplicate = HeldShellBrokerProbe.ObserverFailure.FromExit(1, "OBSERVER_CODE:window-not-found\nOBSERVER_CODE:label-not-found\n", false);
        if (duplicate.Code != "observer-failed") throw new IOException("Ambiguous codes were accepted.");
        Console.WriteLine("PASS fixed child diagnostic codes and redaction; no GUI."); return 0;
    }
    private static void Stage(string value) { Console.Error.WriteLine("OBSERVER_STAGE:" + value); Console.Error.Flush(); }
    private readonly record struct WindowId(long Hwnd, uint Pid, long StartTicks);
    internal static int RunOnSta(string root, uint volume, ulong fileId, string fixture, string label, bool visualOnly = false)
    {
        var code = 1;
        var thread = new Thread(() => code = Run(root, volume, fileId, fixture, label, visualOnly));
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start(); thread.Join(); return code;
    }
    private static int Run(string root, uint volume, ulong fileId, string fixture, string label, bool visualOnly)
    {
        dynamic? selected = null; WindowId identity = default; bool closed = false; string? failure = null;
        try {
            Stage("shell-activate");
            var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new StepFailure("observer-failed");
            dynamic shell = Activator.CreateInstance(shellType) ?? throw new StepFailure("observer-failed");
            Stage("shell-snapshot");
            var before = new HashSet<long>();
            foreach (dynamic w in (IEnumerable)shell.Windows()) { try { before.Add((long)(int)w.HWND); } catch { } }
            Stage("root-check");
            CheckRoot(root, volume, fileId);
            Stage("shell-open");
            shell.Open(root);
            var deadline = Stopwatch.StartNew();
            while (deadline.Elapsed < TimeSpan.FromSeconds(30)) {
                Stage("window-enumerate");
                var matches = new List<object>();
                foreach (dynamic w in (IEnumerable)shell.Windows()) { try {
                    if (!before.Contains((long)(int)w.HWND) && string.Equals((string)w.Document.Folder.Self.Path, root, StringComparison.OrdinalIgnoreCase)) matches.Add(w);
                } catch { } }
                if (matches.Count > 1) throw new StepFailure("window-ambiguous");
                if (matches.Count == 1) { selected = matches[0]; Stage("window-identity"); identity = CheckWindow(selected, root, volume, fileId); break; }
                Thread.Sleep(250);
            }
            if (selected is null) throw new StepFailure("window-not-found");
            if (!visualOnly) {
            Console.Error.WriteLine("OBSERVER_STAGE:finding-label");
            var element = AutomationElement.FromHandle(new IntPtr(identity.Hwnd)) ?? throw new StepFailure("uia-unavailable");
            var condition = new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TreeItem), new PropertyCondition(AutomationElement.NameProperty, label));
            bool found = false;
            for (var n = 0; n < 120; n++) {
                if (CheckWindow(selected, root, volume, fileId) != identity) throw new StepFailure("window-identity-unavailable");
                var count = element.FindAll(TreeScope.Descendants, condition).Count;
                if (count > 1) throw new StepFailure("label-ambiguous");
                if (count == 1) { if (CheckWindow(selected, root, volume, fileId) != identity) throw new StepFailure("window-identity-unavailable"); found = true; break; }
                if (n != 119) Thread.Sleep(250);
            }
            if (!found) throw new StepFailure("label-not-found");
            }
            Console.Error.WriteLine("OBSERVER_STAGE:capturing");
            if (CheckWindow(selected, root, volume, fileId) != identity) throw new StepFailure("window-identity-unavailable");
            if (!GetWindowRect(new IntPtr(identity.Hwnd), out var rect)) throw new StepFailure("window-bounds-unavailable");
            var width = rect.Right - rect.Left; var height = rect.Bottom - rect.Top;
            if (width < 100 || height < 100 || width > 10000 || height > 10000) throw new StepFailure("window-bounds-invalid");
            using var bitmap = new Bitmap(width, height); using var graphics = Graphics.FromImage(bitmap); var dc = graphics.GetHdc();
            try { if (!PrintWindow(new IntPtr(identity.Hwnd), dc, 2)) throw new StepFailure("screenshot-failed"); }
            finally { graphics.ReleaseHdc(dc); }
            var screenshot = Path.Combine(fixture, "observer-window.png");
            using var output = new FileStream(screenshot, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            bitmap.Save(output, ImageFormat.Png); output.Flush(true);
        } catch (Exception error) { failure = SafeCode(error); }
        finally {
            Console.Error.WriteLine("OBSERVER_STAGE:closing");
            if (selected is not null && identity.Hwnd != 0) {
                try {
                    if (CheckWindow(selected, root, volume, fileId) != identity) throw new IOException();
                    selected.Quit(); var deadline = Stopwatch.StartNew();
                    while (IsWindow(new IntPtr(identity.Hwnd)) && deadline.Elapsed < TimeSpan.FromSeconds(10)) Thread.Sleep(200);
                    closed = !IsWindow(new IntPtr(identity.Hwnd));
                } catch { failure = "window-close-unconfirmed"; }
            }
        }
        if (failure is not null || !closed) { Console.Error.WriteLine("OBSERVER_CODE:" + (failure ?? "window-close-unconfirmed")); return 1; }
        Console.WriteLine(JsonSerializer.Serialize(new { identity.Hwnd, identity.Pid, identity.StartTicks, Volume = volume, FileId = fileId, Closed = true, Screenshot = Path.Combine(fixture, "observer-window.png"), LabelObserved = !visualOnly, LabelCount = visualOnly ? 0 : 1 }));
        return 0;
    }
    private static WindowId CheckWindow(dynamic window, string root, uint volume, ulong fileId)
    {
        var hwnd = new IntPtr((int)window.HWND);
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out var pid) == 0) throw new StepFailure("window-identity-unavailable");
        using var process = Process.GetProcessById(checked((int)pid));
        if (!string.Equals(process.ProcessName, "explorer", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals((string)window.Document.Folder.Self.Path, root, StringComparison.OrdinalIgnoreCase)) throw new StepFailure("explorer-path-changed");
        CheckRoot(root, volume, fileId); return new(hwnd.ToInt64(), pid, process.StartTime.ToUniversalTime().Ticks);
    }
    private static void CheckRoot(string root, uint volume, ulong fileId)
    {
        using var h = CreateFileW(root, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (h.IsInvalid || !GetFileInformationByHandle(h, out var i) || (i.Attributes & 0x10) == 0 || i.Volume != volume || ((ulong)i.IndexHigh << 32 | i.IndexLow) != fileId || fileId == 0)
            throw new StepFailure("root-identity-unavailable");
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfoNative { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfoNative info);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
}
#endif
