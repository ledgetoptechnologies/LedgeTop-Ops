using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Interop;
using LedgeTop.Files;

// Explicit native test only. Messages target this test icon's own hidden window;
// no Explorer restart, system-wide broadcast, or existing icon is touched.
internal static class ShellTrayRoutingTests
{
    private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;

    internal static Task PositionTests()
    {
        var cursor = new ShellTrayIcon.MenuPosition(900, 700);
        Require(ShellTrayIcon.ContextMenuPosition(true, new(-180, -50, -148, -18), cursor) == new ShellTrayIcon.MenuPosition(-180, -18), "Negative monitor coordinates were lost.");
        Require(ShellTrayIcon.ContextMenuPosition(true, new(0, -32, 32, 0), cursor) == new ShellTrayIcon.MenuPosition(0, 0), "Zero anchor is valid.");
        Require(ShellTrayIcon.ContextMenuPosition(true, null, cursor) == cursor, "Failed icon lookup must use the cursor.");
        Require(ShellTrayIcon.ContextMenuPosition(true, new(5, 5, 5, 10), cursor) == cursor, "Invalid icon rectangle must use the cursor.");
        Require(ShellTrayIcon.ContextMenuPosition(false, new(0, 0, 32, 32), cursor) == cursor, "Legacy menu must use the cursor.");
        Console.WriteLine("PASS tray context-menu anchor and fallback position.");
        return Task.CompletedTask;
    }

    internal static Task Run()
    {
        using var tray = new ShellTrayIcon(() => []);
        Require(tray.IsAvailable, "Windows refused the test notification icon.");
        var type = typeof(ShellTrayIcon);
        var source = (HwndSource)(type.GetField("source", PrivateInstance)?.GetValue(tray)
            ?? throw new InvalidOperationException("Test icon window unavailable."));
        var version4 = (bool)(type.GetField("version4", PrivateInstance)?.GetValue(tray)
            ?? throw new InvalidOperationException("Test icon version unavailable."));
        var taskbarCreated = (uint)(type.GetField("taskbarCreated", PrivateInstance)?.GetValue(tray)
            ?? throw new InvalidOperationException("Taskbar message unavailable."));
        Require(source.Handle != 0 && taskbarCreated != 0, "Test icon has no window or taskbar message.");

        var activated = 0; var unavailable = 0;
        tray.Activated += () => activated++;
        tray.Unavailable += () => unavailable++;
        nint Event(int notification) => version4 ? (nint)((1 << 16) | notification) : (nint)notification;
        SendMessage(source.Handle, 0x8000 + 71, 0, Event(0x400));
        SendMessage(source.Handle, 0x8000 + 71, 0, Event(0x401));
        SendMessage(source.Handle, 0x8000 + 71, 0, Event(0x200));
        Require(activated == 2 && unavailable == 0, "Select callbacks did not route exactly once each.");

        // Remove only the icon identified by this instance's HWND and id, then
        // send TaskbarCreated directly to that same HWND to emulate Explorer's
        // restart notification without restarting Explorer or broadcasting.
        var data = type.GetMethod("Data", PrivateInstance)?.Invoke(tray, null)
            ?? throw new InvalidOperationException("Test icon data unavailable.");
        var native = type.GetNestedType("Native", BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Shell API unavailable.");
        var notify = native.GetMethod("ShellNotifyIcon", BindingFlags.Static | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Shell notification API unavailable.");
        var arguments = new object[] { (uint)2, data };
        Require(notify.Invoke(null, arguments) is true, "Could not remove the owned test icon before re-registration.");
        SendMessage(source.Handle, taskbarCreated, 0, 0);
        Require(tray.IsAvailable && unavailable == 0, "The owned icon did not re-register after the direct test message.");
        tray.Update("LedgeTop Files test: restored");
        Require(tray.IsAvailable, "The re-registered icon did not accept an update.");
        tray.Dispose();
        Require(!tray.IsAvailable, "The owned test icon remained available after disposal.");
        Console.WriteLine("PASS native owned tray select routing and direct TaskbarCreated re-registration; no Explorer restart or user icon changed.");
        return Task.CompletedTask;
    }

    private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern nint SendMessage(nint hwnd, uint message, nint wParam, nint lParam);
}
