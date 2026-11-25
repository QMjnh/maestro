using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Maestro;

/// <summary>
/// Maestro's own Windows System Media Transport Controls (SMTC) session: one media card and one set of hardware
/// media-key handlers (Play/Pause, Next, Previous, Stop) across Spotify, YouTube, and SoundCloud.
/// Talks directly to the WinRT COM interfaces in combase.dll so the app needs no WinRT SDK packages.
/// </summary>
sealed unsafe class MediaControls : IDisposable
{
    static readonly Guid IidUnknown = new("00000000-0000-0000-C000-000000000046");
    static readonly Guid IidAgileObject = new("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90");
    static readonly Guid IidSmtcInterop = new("ddb0472d-c911-4a1f-86d9-dc3d71a95f5a");
    static readonly Guid IidSmtc = new("99fa3ff4-1742-42a6-902e-087d41f965ec");
    static readonly Guid IidButtonPressedHandler = new("0557e996-7b23-5bae-aa81-ea0d671143a4");
    static readonly Guid IidUriFactory = new("44a9796f-723e-4fdf-a218-033e75b0c084");
    static readonly Guid IidStreamRefStatics = new("857309dc-3fbf-4e7d-986f-ef3b1a07a964");

    const int StatusClosed = 0;
    const int StatusPlaying = 3;
    const int StatusPaused = 4;
    const int TypeMusic = 1;

    IntPtr smtc;
    IntPtr updater;
    IntPtr uriFactory;
    IntPtr streamRefStatics;
    ButtonHandler* handler;
    long eventToken;
    bool disposed;

    string? lastTitle;
    string? lastArtist;
    string? lastArt;
    int lastStatus = StatusClosed;
    bool lastEnabled;

    public MediaControls(IntPtr hwnd, Action<string> onCommand)
    {
        try
        {
            Init(hwnd, onCommand);
        }
        catch
        {
            Dispose();
        }
    }

    void Init(IntPtr hwnd, Action<string> onCommand)
    {
        if (GetFactory("Windows.Media.SystemMediaTransportControls", IidSmtcInterop, out var interop) != 0) return;
        try
        {
            var iidSmtc = IidSmtc;
            IntPtr s = IntPtr.Zero;
            var hr = ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Guid*, IntPtr*, int>)Vtbl(interop)[6])(interop, hwnd, &iidSmtc, &s);
            if (hr != 0 || s == IntPtr.Zero) return;
            smtc = s;
        }
        finally { Release(ref interop); }

        IntPtr u = IntPtr.Zero;
        if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(smtc)[8])(smtc, &u) != 0 || u == IntPtr.Zero)
        {
            Dispose();
            return;
        }
        updater = u;

        // Optional: album art thumbnails. Failures here are harmless.
        GetFactory("Windows.Foundation.Uri", IidUriFactory, out uriFactory);
        GetFactory("Windows.Storage.Streams.RandomAccessStreamReference", IidStreamRefStatics, out streamRefStatics);

        Action<int> dispatch = button =>
        {
            var cmd = button switch
            {
                0 => "play",
                1 => "pause",
                2 => "stop",
                6 => "next",
                7 => "prev",
                _ => null,
            };
            if (cmd != null) onCommand(cmd);
        };

        handler = CreateHandler(dispatch);
        long token = 0;
        if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, long*, int>)Vtbl(smtc)[32])(smtc, (IntPtr)handler, &token) == 0)
            eventToken = token;
    }

    public void Update(JsonObject m)
    {
        if (disposed || smtc == IntPtr.Zero) return;

        var status = m.Str("status") switch
        {
            "playing" => StatusPlaying,
            "paused" => StatusPaused,
            _ => StatusClosed,
        };
        var title = m.Str("title") ?? "";
        var artist = m.Str("artist") ?? "";
        var art = m.Str("art") ?? "";
        var hasQueue = m["hasQueue"]?.GetValue<bool>() == true;
        var enabled = status != StatusClosed;

        if (!enabled)
        {
            if (lastEnabled || lastStatus != StatusClosed)
            {
                PutStatus(StatusClosed);
                ((delegate* unmanaged[Stdcall]<IntPtr, int>)Vtbl(updater)[16])(updater); // ClearAll
                ((delegate* unmanaged[Stdcall]<IntPtr, int>)Vtbl(updater)[17])(updater); // Update
                PutBool(11, false); // IsEnabled
                lastTitle = lastArtist = lastArt = null;
                lastStatus = StatusClosed;
                lastEnabled = false;
            }
            return;
        }

        PutBool(11, true); // IsEnabled
        PutBool(13, true); // IsPlayEnabled
        PutBool(15, true); // IsStopEnabled
        PutBool(17, true); // IsPauseEnabled
        PutBool(25, hasQueue); // IsPreviousEnabled
        PutBool(27, hasQueue); // IsNextEnabled
        PutStatus(status);
        lastStatus = status;
        lastEnabled = true;

        if (title != lastTitle || artist != lastArtist || art != lastArt)
        {
            ((delegate* unmanaged[Stdcall]<IntPtr, int, int>)Vtbl(updater)[7])(updater, TypeMusic); // put_Type(Music) first so MusicProperties is valid
            IntPtr mp = IntPtr.Zero;
            if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr*, int>)Vtbl(updater)[12])(updater, &mp) == 0 && mp != IntPtr.Zero)
            {
                try
                {
                    PutString(mp, 7, title);  // put_Title
                    PutString(mp, 11, artist); // put_Artist
                }
                finally { Release(ref mp); }
            }
            if (art != lastArt) SetThumbnail(art);
            ((delegate* unmanaged[Stdcall]<IntPtr, int>)Vtbl(updater)[17])(updater); // Update
            lastTitle = title;
            lastArtist = artist;
            lastArt = art;
        }
    }

    /// <summary>Re-assert our active playback status (e.g. right after background Spotify's SMTC is suppressed).</summary>
    public void Refresh()
    {
        if (disposed || smtc == IntPtr.Zero || !lastEnabled) return;
        PutBool(11, true);
        PutStatus(lastStatus);
        ((delegate* unmanaged[Stdcall]<IntPtr, int>)Vtbl(updater)[17])(updater); // Update
    }

    void PutStatus(int status) => ((delegate* unmanaged[Stdcall]<IntPtr, int, int>)Vtbl(smtc)[7])(smtc, status);
    void PutBool(int slot, bool value) => ((delegate* unmanaged[Stdcall]<IntPtr, byte, int>)Vtbl(smtc)[slot])(smtc, value ? (byte)1 : (byte)0);

    static void PutString(IntPtr target, int slot, string value)
    {
        var hs = MakeHString(value);
        try { ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Vtbl(target)[slot])(target, hs); }
        finally { FreeHString(hs); }
    }

    void SetThumbnail(string url)
    {
        if (string.IsNullOrWhiteSpace(url) || (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            || uriFactory == IntPtr.Zero || streamRefStatics == IntPtr.Zero)
        {
            ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Vtbl(updater)[11])(updater, IntPtr.Zero);
            return;
        }
        var hs = MakeHString(url);
        IntPtr uri = IntPtr.Zero;
        IntPtr streamRef = IntPtr.Zero;
        try
        {
            if (((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr*, int>)Vtbl(uriFactory)[6])(uriFactory, hs, &uri) == 0 && uri != IntPtr.Zero
                && ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, IntPtr*, int>)Vtbl(streamRefStatics)[7])(streamRefStatics, uri, &streamRef) == 0 && streamRef != IntPtr.Zero)
            {
                ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Vtbl(updater)[11])(updater, streamRef);
            }
            else
            {
                ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int>)Vtbl(updater)[11])(updater, IntPtr.Zero);
            }
        }
        finally
        {
            Release(ref streamRef);
            Release(ref uri);
            FreeHString(hs);
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (smtc != IntPtr.Zero)
        {
            if (eventToken != 0)
            {
                ((delegate* unmanaged[Stdcall]<IntPtr, long, int>)Vtbl(smtc)[33])(smtc, eventToken);
                eventToken = 0;
            }
            PutStatus(StatusClosed);
            PutBool(11, false);
        }
        if (handler != null)
        {
            ReleaseHandler(handler);
            handler = null;
        }
        Release(ref updater);
        Release(ref smtc);
        Release(ref streamRefStatics);
        Release(ref uriFactory);
    }

    // ---- WinRT / COM helpers --------------------------------------------------------------

    static IntPtr* Vtbl(IntPtr obj) => *(IntPtr**)obj;

    static void Release(ref IntPtr obj)
    {
        if (obj == IntPtr.Zero) return;
        Marshal.Release(obj);
        obj = IntPtr.Zero;
    }

    static int GetFactory(string className, Guid iid, out IntPtr factory)
    {
        factory = IntPtr.Zero;
        var hs = MakeHString(className);
        try { return RoGetActivationFactory(hs, ref iid, out factory); }
        finally { FreeHString(hs); }
    }

    static IntPtr MakeHString(string s) =>
        s.Length == 0 ? IntPtr.Zero : WindowsCreateString(s, s.Length, out var hs) == 0 ? hs : IntPtr.Zero;

    static void FreeHString(IntPtr hs)
    {
        if (hs != IntPtr.Zero) WindowsDeleteString(hs);
    }

    [DllImport("combase.dll")]
    static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", CharSet = CharSet.Unicode)]
    static extern int WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll")]
    static extern int WindowsDeleteString(IntPtr hstring);

    // ---- Unmanaged COM callback for TypedEventHandler<SMTC, ButtonPressedEventArgs> -------

    [StructLayout(LayoutKind.Sequential)]
    struct ButtonHandler
    {
        public IntPtr Vtbl;
        public int RefCount;
        public IntPtr CallbackHandle;
    }

    static readonly IntPtr HandlerVtbl = BuildHandlerVtbl();

    static IntPtr BuildHandlerVtbl()
    {
        var v = (IntPtr*)NativeMemory.Alloc(4, (nuint)sizeof(IntPtr));
        v[0] = (IntPtr)(delegate* unmanaged[Stdcall]<ButtonHandler*, Guid*, IntPtr*, int>)&HandlerQueryInterface;
        v[1] = (IntPtr)(delegate* unmanaged[Stdcall]<ButtonHandler*, uint>)&HandlerAddRef;
        v[2] = (IntPtr)(delegate* unmanaged[Stdcall]<ButtonHandler*, uint>)&HandlerRelease;
        v[3] = (IntPtr)(delegate* unmanaged[Stdcall]<ButtonHandler*, IntPtr, IntPtr, int>)&HandlerInvoke;
        return (IntPtr)v;
    }

    static ButtonHandler* CreateHandler(Action<int> callback)
    {
        var h = (ButtonHandler*)NativeMemory.AllocZeroed((nuint)sizeof(ButtonHandler));
        h->Vtbl = HandlerVtbl;
        h->RefCount = 1;
        h->CallbackHandle = GCHandle.ToIntPtr(GCHandle.Alloc(callback));
        return h;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static int HandlerQueryInterface(ButtonHandler* self, Guid* riid, IntPtr* ppv)
    {
        if (*riid == IidUnknown || *riid == IidAgileObject || *riid == IidButtonPressedHandler)
        {
            Interlocked.Increment(ref self->RefCount);
            *ppv = (IntPtr)self;
            return 0;
        }
        *ppv = IntPtr.Zero;
        return unchecked((int)0x80004002); // E_NOINTERFACE
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static uint HandlerAddRef(ButtonHandler* self) => (uint)Interlocked.Increment(ref self->RefCount);

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static uint HandlerRelease(ButtonHandler* self) => ReleaseHandler(self);

    static uint ReleaseHandler(ButtonHandler* self)
    {
        var n = (uint)Interlocked.Decrement(ref self->RefCount);
        if (n == 0)
        {
            if (self->CallbackHandle != IntPtr.Zero) GCHandle.FromIntPtr(self->CallbackHandle).Free();
            NativeMemory.Free(self);
        }
        return n;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static int HandlerInvoke(ButtonHandler* self, IntPtr sender, IntPtr args)
    {
        if (args == IntPtr.Zero || self->CallbackHandle == IntPtr.Zero) return 0;
        try
        {
            int button = -1;
            if (((delegate* unmanaged[Stdcall]<IntPtr, int*, int>)Vtbl(args)[6])(args, &button) == 0
                && GCHandle.FromIntPtr(self->CallbackHandle).Target is Action<int> cb)
            {
                cb(button);
            }
        }
        catch { }
        return 0;
    }
}
