using System.Runtime.InteropServices;
using System.Text;

namespace Maestro;

static partial class NativeMethods
{
    public static readonly IntPtr HWND_BROADCAST = 0xffff;
    public static readonly int WM_SHOWMAESTRO = RegisterWindowMessage("Maestro.ShowWindow");

    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;
    public const int SW_SHOWMINNOACTIVE = 7;
    public const int SW_RESTORE = 9;
    const int GWL_STYLE = -16;
    const uint GW_OWNER = 4;
    const long WS_CAPTION = 0x00C00000L;

    [LibraryImport("user32.dll", EntryPoint = "RegisterWindowMessageW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int RegisterWindowMessage(string name);

    [LibraryImport("user32.dll", EntryPoint = "PostMessageW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool PostMessage(IntPtr hWnd, int msg, nint wParam, nint lParam);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool ShowWindow(IntPtr hWnd, int cmd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetForegroundWindow(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool IsWindowVisible(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [LibraryImport("user32.dll")]
    private static partial IntPtr GetWindow(IntPtr hWnd, uint cmd);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static partial nint GetWindowLongPtr(IntPtr hWnd, int index);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowTextLengthW")]
    private static partial int GetWindowTextLength(IntPtr hWnd);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /// <summary>Dark title bar to match the UI (Windows 10 20H1+ / 11).</summary>
    public static void UseDarkTitleBar(IntPtr hwnd)
    {
        int on = 1;
        DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, sizeof(int));
    }

    /// <summary>
    /// Top-level, unowned, captioned windows of the given processes — i.e. their main windows,
    /// not tray menus or tooltips.
    /// </summary>
    public static List<IntPtr> MainWindowsOf(HashSet<uint> pids, bool onlyVisible)
    {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, _) =>
        {
            GetWindowThreadProcessId(hwnd, out uint pid);
            if (!pids.Contains(pid)) return true;
            if (onlyVisible && !IsWindowVisible(hwnd)) return true;
            if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
            if ((GetWindowLongPtr(hwnd, GWL_STYLE) & WS_CAPTION) != WS_CAPTION) return true;
            if (GetWindowTextLength(hwnd) == 0) return true;
            found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
