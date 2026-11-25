using System.Runtime.InteropServices;

namespace Maestro;

/// <summary>
/// Hardware media keys (Play/Pause, Next, Previous, Stop), taken as global hotkeys so background Spotify never sees them.
///
/// With its media overlay off (MediaControls/SpotifyApp turn it off so Maestro is the only Windows media session), Spotify
/// listens for media keys through a shell hook instead: every key press that no window handles is broadcast to it, and
/// it plays or pauses no matter which app Windows is controlling. Fn+F5 then started Spotify next to Maestro, and the
/// next press paused Maestro but started Spotify again. A registered hotkey is consumed before that broadcast happens.
///
/// Each key goes where Windows would have sent it: the current media session. That's Maestro (or the Spotify it drives)
/// most of the time; when another app is current (a video in a browser), the key is passed on to that app's session.
/// Talks directly to the WinRT COM interfaces in combase.dll, like MediaControls.
/// </summary>
sealed unsafe class MediaKeys : IDisposable
{
    public const int WM_HOTKEY = 0x0312;
    const uint MOD_NOREPEAT = 0x4000;
    const int VK_MEDIA_NEXT_TRACK = 0xB0, VK_MEDIA_PREV_TRACK = 0xB1, VK_MEDIA_STOP = 0xB2, VK_MEDIA_PLAY_PAUSE = 0xB3;
    const int IdBase = 0x4D00; // hotkey ids: IdBase + virtual key

    static readonly Guid IidManagerStatics = new("2050c4ee-11a0-57de-aed7-c97c70338245");
    static readonly Guid IidAsyncInfo = new("00000036-0000-0000-c000-000000000046");

    readonly IntPtr hwnd;
    readonly Action<string> onCommand;
    readonly Func<string, bool> isOurs;
    readonly List<int> registered = [];
    IntPtr managerOp; // IAsyncOperation<GlobalSystemMediaTransportControlsSessionManager>, until it completes
    IntPtr manager;
    bool disposed;

    /// <param name="onCommand">Maestro's handler: "toggle", "next", "prev" or "stop".</param>
    /// <param name="isOurs">Whether a media session (by app id, e.g. "Spotify.exe") counts as Maestro's own.</param>
    public MediaKeys(IntPtr hwnd, Action<string> onCommand, Func<string, bool> isOurs)
    {
        this.hwnd = hwnd;
        this.onCommand = onCommand;
        this.isOurs = isOurs;
        foreach (var vk in new[] { VK_MEDIA_PLAY_PAUSE, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP })
        {
            // Fails if another app holds the key; Windows then routes it as before (to the current media session).
            if (RegisterHotKey(hwnd, IdBase + vk, MOD_NOREPEAT, (uint)vk)) registered.Add(IdBase + vk);
        }
        try { RequestManager(); }
        catch { managerOp = IntPtr.Zero; }
    }

    /// <summary>Handle a WM_HOTKEY. Returns false if it isn't one of ours.</summary>
    public bool OnHotKey(int id)
    {
        if (disposed || !registered.Contains(id)) return false;
        var cmd = (id - IdBase) switch
        {
            VK_MEDIA_PLAY_PAUSE => "toggle",
            VK_MEDIA_NEXT_TRACK => "next",
            VK_MEDIA_PREV_TRACK => "prev",
            _ => "stop",
        };
        try
        {
            if (ForwardToOtherApp(cmd)) return true;
        }
        catch { }
        onCommand(cmd);
        return true;
    }

    /// <summary>Send the key to the current media session if it belongs to another app. False if it's Maestro's (or none).</summary>
    bool ForwardToOtherApp(string cmd)
    {
        var mgr = Manager();
        if (mgr == IntPtr.Zero) return false;
        IntPtr session = IntPtr.Zero;
        if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(mgr)[6])(mgr, &session) != 0 || session == IntPtr.Zero) return false; // GetCurrentSession
        try
        {
            IntPtr hs = IntPtr.Zero;
            if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(session)[6])(session, &hs) != 0) return false; // get_SourceAppUserModelId
            string app;
            try { app = HStringToString(hs); }
            finally { if (hs != IntPtr.Zero) WindowsDeleteString(hs); }
            if (isOurs(app)) return false;

            var slot = cmd switch
            {
                "toggle" => 20, // TryTogglePlayPauseAsync
                "next" => 16,   // TrySkipNextAsync
                "prev" => 17,   // TrySkipPreviousAsync
                _ => 12,        // TryStopAsync
            };
            IntPtr op = IntPtr.Zero;
            if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(session)[slot])(session, &op) != 0) return false;
            Release(ref op); // runs on without us
            return true;
        }
        finally { Release(ref session); }
    }

    void RequestManager()
    {
        var hs = MakeHString("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager");
        IntPtr statics = IntPtr.Zero;
        try
        {
            var iid = IidManagerStatics;
            if (RoGetActivationFactory(hs, ref iid, out statics) != 0 || statics == IntPtr.Zero) return;
            IntPtr op = IntPtr.Zero;
            if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(statics)[6])(statics, &op) == 0) managerOp = op; // RequestAsync
        }
        finally
        {
            Release(ref statics);
            if (hs != IntPtr.Zero) WindowsDeleteString(hs);
        }
    }

    /// <summary>The session manager, once RequestAsync (started at launch) has completed.</summary>
    IntPtr Manager()
    {
        if (manager != IntPtr.Zero || managerOp == IntPtr.Zero) return manager;
        var iid = IidAsyncInfo;
        if (Marshal.QueryInterface(managerOp, ref iid, out var info) != 0) return IntPtr.Zero;
        int status;
        try
        {
            if (((delegate* unmanaged[Stdcall]<IntPtr, int*, int>)Vtbl(info)[7])(info, &status) != 0) return IntPtr.Zero; // get_Status
        }
        finally { Marshal.Release(info); }
        if (status == 0) return IntPtr.Zero; // Started: still waiting
        if (status == 1) // Completed
        {
            IntPtr m = IntPtr.Zero;
            if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(managerOp)[8])(managerOp, &m) == 0) manager = m; // GetResults
        }
        Release(ref managerOp);
        return manager;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        foreach (var id in registered) UnregisterHotKey(hwnd, id);
        registered.Clear();
        Release(ref managerOp);
        Release(ref manager);
    }

    // ---- WinRT / COM helpers --------------------------------------------------------------

    static IntPtr* Vtbl(IntPtr obj) => *(IntPtr**)obj;

    static void Release(ref IntPtr obj)
    {
        if (obj == IntPtr.Zero) return;
        Marshal.Release(obj);
        obj = IntPtr.Zero;
    }

    static IntPtr MakeHString(string s) => WindowsCreateString(s, s.Length, out var hs) == 0 ? hs : IntPtr.Zero;

    static string HStringToString(IntPtr hs)
    {
        if (hs == IntPtr.Zero) return "";
        var p = WindowsGetStringRawBuffer(hs, out var len);
        return p == IntPtr.Zero ? "" : new string((char*)p, 0, (int)len);
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("combase.dll")]
    static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll")]
    static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll")]
    static extern IntPtr WindowsGetStringRawBuffer(IntPtr hstring, out uint length);
}
