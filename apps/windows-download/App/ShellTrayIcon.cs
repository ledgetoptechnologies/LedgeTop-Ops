using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace LedgeTop.Files;

internal sealed record TrayAction(string Label, bool Enabled = true, Action? Run = null);

/// <summary>Only an actually registered icon permits the window to disappear into the tray.</summary>
internal interface ITrayIcon : IDisposable
{
    bool IsAvailable { get; }
    event Action? Activated;
    event Action? Unavailable;
    void Update(string status);
}

/// <summary>
/// Owns one notification icon, its hidden message window and native icon. No services, startup entries,
/// account data or shell extensions are installed. Re-registers after Explorer restarts.
/// </summary>
internal sealed class ShellTrayIcon : ITrayIcon
{
    private const int Callback = 0x8000 + 71;
    private readonly HwndSource source;
    private readonly Func<IReadOnlyList<TrayAction>> actions;
    private readonly uint taskbarCreated;
    private nint icon;
    private bool disposed;
    private bool version4;
    private string status = "LedgeTop Files";
    public bool IsAvailable { get; private set; }
    public event Action? Activated;
    public event Action? Unavailable;

    internal ShellTrayIcon(Func<IReadOnlyList<TrayAction>> actions)
    {
        this.actions = actions;
        taskbarCreated = Native.RegisterWindowMessage("TaskbarCreated");
        source = new HwndSource(new HwndSourceParameters("LedgeTop Files notification icon") {
            Width = 0, Height = 0, WindowStyle = 0, ParentWindow = 0
        });
        source.AddHook(HandleMessage);
        try {
            icon = CreateBrandIcon();
            Register();
        } catch {
            Dispose();
            throw;
        }
    }

    private void Register()
    {
        if (disposed) return;
        var data = Data();
        data.Flags = 1 | 2 | 4 | 0x80; // MESSAGE, ICON, TIP, SHOWTIP
        IsAvailable = Native.ShellNotifyIcon(0, ref data);
        if (!IsAvailable) return;
        data.Version = 4;
        version4 = Native.ShellNotifyIcon(4, ref data);
    }

    public void Update(string value)
    {
        if (disposed) return;
        status = value.Length > 127 ? value[..127] : value;
        if (!IsAvailable) return;
        var data = Data(); data.Flags = 4 | 0x80;
        if (!Native.ShellNotifyIcon(1, ref data)) Lost();
    }

    private void Lost()
    {
        IsAvailable = false;
        Unavailable?.Invoke();
    }

    private nint HandleMessage(nint hwnd, int message, nint wParam, nint lParam, ref bool handled)
    {
        if (disposed) return 0;
        try {
            if (taskbarCreated != 0 && (uint)message == taskbarCreated) {
                IsAvailable = false;
                Register();
                if (!IsAvailable) Unavailable?.Invoke();
            } else if (message == Callback) {
                handled = true;
                var notification = version4 ? (int)((long)lParam & 0xffff) : (int)lParam;
                if (notification is 0x400 or 0x401 || (!version4 && notification == 0x202)) Activated?.Invoke();
                else if (notification == 0x7b || (!version4 && notification == 0x205)) ShowMenu();
            }
        } catch (Exception) {
            // A menu/window failure must never escape the native callback or strand an invisible app.
            IsAvailable = false;
            source.Dispatcher.BeginInvoke(() => { if (!disposed) Unavailable?.Invoke(); });
        }
        return 0;
    }

    private void ShowMenu()
    {
        if (disposed) return;
        var menu = Native.CreatePopupMenu();
        if (menu == 0) { Activated?.Invoke(); return; }
        try {
            var items = actions();
            for (var i = 0; i < items.Count; i++) {
                var item = items[i];
                Native.AppendMenu(menu, item.Label.Length == 0 ? 0x800u : item.Enabled ? 0u : 1u,
                    (nuint)(i + 1), item.Label);
            }
            Native.GetCursorPos(out var point);
            Native.SetForegroundWindow(source.Handle);
            var chosen = Native.TrackPopupMenu(menu, 0x100 | 2, point.X, point.Y, 0, source.Handle, 0);
            Native.PostMessage(source.Handle, 0, 0, 0);
            var data = Data(); Native.ShellNotifyIcon(3, ref data);
            if (chosen > 0 && chosen <= items.Count && items[(int)chosen - 1] is { Enabled: true, Run: { } run }) run();
        } finally { Native.DestroyMenu(menu); }
    }

    private NotifyData Data() => new() {
        Size = (uint)Marshal.SizeOf<NotifyData>(), Window = source.Handle, Id = 1,
        CallbackMessage = Callback, Icon = icon, Tip = status, Info = "", InfoTitle = ""
    };

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        var data = Data(); Native.ShellNotifyIcon(2, ref data);
        IsAvailable = false;
        source.RemoveHook(HandleMessage); source.Dispose();
        if (icon != 0) { Native.DestroyIcon(icon); icon = 0; }
    }

    private static nint CreateBrandIcon()
    {
        // Render the existing approved code-native LT mark, not a separately maintained logo image.
        var content = new ContentControl {
            Content = "LT", ContentTemplate = (DataTemplate)Application.Current.FindResource("LtMark"), Width = 32, Height = 32
        };
        content.Measure(new Size(32, 32)); content.Arrange(new Rect(0, 0, 32, 32)); content.UpdateLayout();
        var bitmap = new RenderTargetBitmap(32, 32, 96, 96, PixelFormats.Pbgra32); bitmap.Render(content);
        // RT_ICON consists of a BITMAPINFOHEADER, bottom-up BGRA image and 1-bit AND mask.
        // Avoid a System.Drawing or WinForms dependency for the native HICON.
        var pixels = new byte[32 * 32 * 4]; bitmap.CopyPixels(pixels, 32 * 4, 0);
        if (!Enumerable.Range(0, 32 * 32).Any(pixel => pixels[pixel * 4 + 3] != 0))
            throw new InvalidOperationException("The notification icon was empty.");
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, true)) {
            writer.Write(40); writer.Write(32); writer.Write(64); writer.Write((ushort)1); writer.Write((ushort)32);
            writer.Write(0); writer.Write(pixels.Length); writer.Write(0); writer.Write(0); writer.Write(0); writer.Write(0);
            for (var y = 31; y >= 0; y--) writer.Write(pixels, y * 128, 128);
            writer.Write(new byte[32 * 4]);
        }
        var bytes = stream.ToArray();
        var handle = Native.CreateIconFromResourceEx(bytes, (uint)bytes.Length, true, 0x30000, 32, 32, 0);
        if (handle == 0) throw new InvalidOperationException("The notification icon could not be created.");
        return handle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyData
    {
        internal uint Size; internal nint Window; internal uint Id, Flags, CallbackMessage; internal nint Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] internal string Tip;
        internal uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] internal string Info;
        internal uint Version;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] internal string InfoTitle;
        internal uint InfoFlags; internal Guid Guid; internal nint BalloonIcon;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { internal int X, Y; }
    private static class Native
    {
        [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ShellNotifyIcon(uint message, ref NotifyData data);
        [DllImport("user32.dll", EntryPoint = "RegisterWindowMessageW", CharSet = CharSet.Unicode)] internal static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")] internal static extern nint CreatePopupMenu();
        [DllImport("user32.dll", EntryPoint = "AppendMenuW", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AppendMenu(nint menu, uint flags, nuint id, string text);
        [DllImport("user32.dll")] internal static extern uint TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint window, nint rect);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DestroyMenu(nint menu);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetForegroundWindow(nint window);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll", EntryPoint = "PostMessageW")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool PostMessage(nint window, uint message, nint wParam, nint lParam);
        [DllImport("user32.dll")] internal static extern nint CreateIconFromResourceEx(byte[] bits, uint length, [MarshalAs(UnmanagedType.Bool)] bool icon, uint version, int width, int height, uint flags);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DestroyIcon(nint icon);
    }
}
