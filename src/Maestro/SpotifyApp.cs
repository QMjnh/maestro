using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace Maestro;

/// <summary>A Spotify-app state the UI knows how to handle (offer a restart, show Spotify, ...). Returned as HTTP 409.</summary>
sealed class AppException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// Drives the Spotify (SpotX) desktop app from the inside.
///
/// The desktop app is a Chromium page that is already signed in to your account. Started with
/// --remote-debugging-port, it lets Maestro run code in that page over the Chrome DevTools
/// Protocol, so Maestro uses the app's own player and search: no Premium, no Web API keys.
/// Maestro also starts Spotify itself, keeps its window hidden, and closes it on exit, so
/// Maestro is the only window you deal with.
/// </summary>
sealed class SpotifyApp : IDisposable
{
    public const int DebugPort = 9233;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static readonly string Flag = $"--remote-debugging-port={DebugPort}";
    // Keep the hidden page responsive (Chromium otherwise throttles background pages).
    static readonly string LaunchArgs = $"{Flag} --minimized --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

    static readonly string Boot = LoadInjectScript();
    static readonly HttpClient Local = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    readonly SemaphoreSlim connectLock = new(1, 1);
    readonly SemaphoreSlim startLock = new(1, 1);
    readonly SemaphoreSlim playLock = new(1, 1);
    readonly SemaphoreSlim mediaOverlayLock = new(1, 1);
    Connection? conn;
    readonly System.Threading.Timer hideTimer;
    // Spotify processes Maestro launched. A Spotify you start yourself is never hidden or closed.
    volatile HashSet<uint> ourPids = [];
    // Hiding only covers the launch (Spotify pops its window up while starting). After that the
    // window is yours: open Spotify from the Start menu and it stays open.
    DateTime hideUntil = DateTime.MinValue;
    volatile bool showingForLogin; // pause hiding while the user logs in
    volatile bool userTookSpotify; // user opened Spotify's window themselves; give media keys back
    volatile bool exiting;
    int playbackSeq; // bumps on play/pause/resume/seek so stale async starts abort instead of racing

    HashSet<uint>? knownRoots; // null until the first look

    /// <summary>You opened Spotify's window yourself, so it's yours: Maestro hands its media keys back.</summary>
    public bool UserOwnsSpotify => userTookSpotify;

    public SpotifyApp()
    {
        // A second Spotify launch only lives ~200 ms (it hands off to the running one and exits).
        hideTimer = new System.Threading.Timer(_ => WatchWindow(), null, 100, 100);
    }

    bool StartedByUs(HashSet<uint> pids) => pids.Overlaps(ourPids);

    static string LoadInjectScript() => Program.Resource("inject.js");

    // ---- DevTools connection ------------------------------------------------------

    sealed class Connection(ClientWebSocket ws)
    {
        public readonly ClientWebSocket Ws = ws;
        public readonly ConcurrentDictionary<int, TaskCompletionSource<JsonNode?>> Pending = new();
        public readonly SemaphoreSlim SendLock = new(1, 1);
        public int NextId;
        public bool Open => Ws.State == WebSocketState.Open;
    }

    /// <summary>The DevTools targets Spotify exposes, or null if the debug port isn't open.</summary>
    static async Task<JsonArray?> Targets()
    {
        try { return JsonNode.Parse(await Local.GetStringAsync($"http://127.0.0.1:{DebugPort}/json/list")) as JsonArray; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { return null; }
    }

    static JsonNode? MainPage(JsonArray targets) =>
        targets.FirstOrDefault(t => t.Str("type") == "page" && t.Str("url")?.Contains("xpui") == true);

    async Task<Connection?> Connect()
    {
        if (conn?.Open == true) return conn;
        await connectLock.WaitAsync();
        try
        {
            if (conn?.Open == true) return conn;
            var targets = await Targets();
            if (targets == null || MainPage(targets)?.Str("webSocketDebuggerUrl") is not { } wsUrl) return null;
            var ws = new ClientWebSocket();
            await ws.ConnectAsync(new Uri(wsUrl), new CancellationTokenSource(5000).Token);
            var c = new Connection(ws);
            _ = Task.Run(() => ReceiveLoop(c));
            showingForLogin = false;
            conn = c;
            if (!userTookSpotify) _ = Task.Run(SuppressMediaControls);
            return c;
        }
        finally { connectLock.Release(); }
    }

    async Task ReceiveLoop(Connection c)
    {
        var buffer = new byte[64 * 1024];
        var message = new MemoryStream();
        try
        {
            while (c.Open)
            {
                var r = await c.Ws.ReceiveAsync(buffer, CancellationToken.None);
                if (r.MessageType == WebSocketMessageType.Close) break;
                message.Write(buffer, 0, r.Count);
                if (!r.EndOfMessage) continue;
                var msg = JsonNode.Parse(message.ToArray());
                message.SetLength(0);
                if (msg?["id"] is JsonValue idv && c.Pending.TryRemove(idv.GetValue<int>(), out var tcs)) tcs.TrySetResult(msg);
            }
        }
        catch (Exception e) when (e is WebSocketException or JsonException or ObjectDisposedException) { }
        if (conn == c) conn = null;
        foreach (var tcs in c.Pending.Values) tcs.TrySetException(new AppException("NOT_CONNECTED", "Lost connection to Spotify"));
        c.Pending.Clear();
    }

    static async Task<JsonNode?> Evaluate(Connection c, string expression, TimeSpan timeout)
    {
        var id = Interlocked.Increment(ref c.NextId);
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        c.Pending[id] = tcs;
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            id,
            method = "Runtime.evaluate",
            @params = new { expression, awaitPromise = true, returnByValue = true },
        });
        await c.SendLock.WaitAsync();
        try { await c.Ws.SendAsync(payload, WebSocketMessageType.Text, true, CancellationToken.None); }
        finally { c.SendLock.Release(); }

        var done = await Task.WhenAny(tcs.Task, Task.Delay(timeout));
        if (done != tcs.Task)
        {
            c.Pending.TryRemove(id, out _);
            throw new AppException("NOT_CONNECTED", "Spotify did not respond");
        }
        var msg = await tcs.Task;
        if (msg?["error"] is { } err) throw new Exception(err.Str("message") ?? "DevTools error");
        var result = msg?["result"];
        if (result?["exceptionDetails"] is { } ex)
        {
            var desc = ex.Str("exception.description") ?? ex.Str("text") ?? "Error in Spotify";
            throw new Exception(desc.Split('\n')[0].Replace("Error: ", ""));
        }
        return result.At("result.value")?.DeepClone();
    }

    /// <summary>Call a window.__maestro method inside Spotify, waiting for the app's UI if it's still loading.</summary>
    public async Task<JsonNode?> Call(string method, params object?[] args)
    {
        var expr = $"(async () => {{ {Boot}; return await window.__maestro[{JsonSerializer.Serialize(method)}](...{JsonSerializer.Serialize(args)}); }})()";
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            var c = await Connect() ?? throw new AppException("NOT_CONNECTED", "Spotify is not connected");
            try { return await Evaluate(c, expr, TimeSpan.FromSeconds(15)); }
            catch (Exception e) when (e.Message.Contains("MAESTRO_NOT_READY") && DateTime.UtcNow < deadline)
            {
                await Task.Delay(500);
            }
            catch (Exception e) when (e.Message.StartsWith("UNPLAYABLE"))
            {
                var reason = e.Message["UNPLAYABLE".Length..].Trim();
                throw new AppException("UNPLAYABLE", reason == "COUNTRY_RESTRICTED"
                    ? "not available in your country"
                    : reason.Length > 0 ? reason.ToLowerInvariant().Replace('_', ' ') : "not playable");
            }
        }
    }

    // ---- process management -------------------------------------------------------------

    public static string? FindExe(string custom)
    {
        string[] candidates =
        [
            custom,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Spotify", "Spotify.exe"),
        ];
        return candidates.FirstOrDefault(p => p.Length > 0 && File.Exists(p));
    }

    static Process[] Processes() => Process.GetProcessesByName("Spotify");
    static bool IsRunning() => Processes().Length > 0;

    async Task Start(string exePath)
    {
        var exe = FindExe(exePath) ?? throw new AppException("NO_SPOTIFY", "Couldn't find Spotify.exe — set its path in Settings.");
        Process.Start(new ProcessStartInfo(exe, LaunchArgs) { UseShellExecute = true })?.Dispose();
        var deadline = DateTime.UtcNow.AddSeconds(30);
        hideUntil = deadline;
        while (DateTime.UtcNow < deadline)
        {
            HideWindowIfWanted();
            ourPids = Pids();
            var targets = await Targets();
            if (targets != null && MainPage(targets) != null)
            {
                hideUntil = DateTime.UtcNow.AddSeconds(5);
                return;
            }
            await Task.Delay(300);
        }
        if (await NeedsLogin()) throw LoginError();
        throw new AppException("NOT_CONNECTED", "Spotify started but Maestro could not connect to it.");
    }

    /// <summary>Debug port is open but the signed-in player page isn't there: Spotify is showing its login screen.</summary>
    static async Task<bool> NeedsLogin()
    {
        var targets = await Targets();
        return targets != null && targets.Count > 0 && MainPage(targets) == null;
    }

    public void ShowForLogin()
    {
        showingForLogin = true;
        RevealWindows();
    }

    AppException LoginError()
    {
        ShowForLogin();
        return new AppException("NEEDS_LOGIN", "Log in to Spotify in the window that just opened, then try again.");
    }

    /// <summary>
    /// Make sure we're connected. Starts Spotify (hidden) if it isn't running. If it's running
    /// without Maestro support we don't kill it unasked: NEEDS_RESTART.
    /// </summary>
    public async Task Ensure(string exePath)
    {
        if (await Connect() != null) return;
        await startLock.WaitAsync();
        try
        {
            if (await Connect() != null) return;
            if (IsRunning())
            {
                // It may still be starting up with the flag; give it a moment.
                for (int i = 0; i < 6; i++)
                {
                    await Task.Delay(500);
                    if (await Connect() != null) return;
                }
                if (await NeedsLogin()) throw LoginError();
                throw new AppException("NEEDS_RESTART", "Spotify is running without Maestro support. Restart it once so Maestro can connect.");
            }
            await Start(exePath);
            if (await Connect() == null) throw new AppException("NOT_CONNECTED", "Could not connect to Spotify.");
        }
        finally { startLock.Release(); }
    }

    /// <summary>Start Spotify in the background when Maestro opens, so the first song plays instantly.</summary>
    public async Task Prewarm(string exePath)
    {
        try
        {
            if (!IsRunning()) await Ensure(exePath);
            else await Connect();
        }
        catch (Exception e) when (e is AppException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    public async Task Restart(string exePath)
    {
        conn?.Ws.Abort();
        userTookSpotify = false;
        KillAll();
        for (int i = 0; i < 40 && IsRunning(); i++) await Task.Delay(250);
        await startLock.WaitAsync();
        try { await Start(exePath); }
        finally { startLock.Release(); }
        if (await Connect() == null) throw new AppException("NOT_CONNECTED", "Could not connect to Spotify.");
    }

    /// <summary>
    /// Take the background Spotify out of Windows' media controls while Maestro drives it, so the media
    /// flyout shows one session (Maestro's) and its buttons never skip within Spotify. Media keys are
    /// handled separately (MediaKeys.cs): with this off, Spotify listens for them through a shell hook.
    /// </summary>
    async Task SuppressMediaControls()
    {
        await mediaOverlayLock.WaitAsync();
        try
        {
            if (exiting || userTookSpotify) return;
            var cur = await Call("getMediaOverlay");
            if (cur is JsonValue v && v.TryGetValue<bool>(out var enabled) && enabled)
            {
                Store.SetRestoreSpotifyMediaOverlay(true);
                await Call("setMediaOverlay", false);
            }
        }
        catch (Exception) { }
        finally { mediaOverlayLock.Release(); }
    }

    async Task RestoreMediaControls(bool waitForFlush = false)
    {
        await mediaOverlayLock.WaitAsync();
        try
        {
            if (!Store.GetSettings().RestoreSpotifyMediaOverlay) return;
            if (conn?.Open != true && await Connect() == null) return;
            var ok = await Call("setMediaOverlay", true);
            if (ok is JsonValue v && v.TryGetValue<bool>(out var restored) && restored)
            {
                Store.SetRestoreSpotifyMediaOverlay(false);
                if (waitForFlush) await Task.Delay(200);
            }
        }
        catch (Exception) { }
        finally { mediaOverlayLock.Release(); }
    }

    static void KillAll()
    {
        foreach (var p in Processes())
        {
            try { p.Kill(entireProcessTree: true); }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            p.Dispose();
        }
    }

    /// <summary>
    /// On Maestro exit: restore Spotify's media-key overlay if Maestro turned it off, then quit Spotify
    /// if Maestro started it, it's still in the background, and the user wants that. If you opened its
    /// window, you're using it, so it stays. A Spotify that stays gets its window back (minimized) so
    /// it's never left running invisibly.
    /// </summary>
    public void OnAppExit()
    {
        exiting = true;
        hideTimer.Change(Timeout.Infinite, Timeout.Infinite);
        var pids = Pids();
        var startedByUs = StartedByUs(pids);
        var inUse = startedByUs && NativeMethods.MainWindowsOf(pids, onlyVisible: true).Count > 0;
        var willKill = startedByUs && !inUse && Store.GetSettings().CloseSpotifyOnExit;

        if (Store.GetSettings().RestoreSpotifyMediaOverlay)
        {
            try { Task.Run(() => RestoreMediaControls(waitForFlush: willKill)).Wait(1500); } catch (AggregateException) { }
        }

        if (!startedByUs) return;
        if (willKill)
        {
            // Off the UI thread: Call's continuations would otherwise wait for the (blocked) UI thread.
            try { Task.Run(() => Call("pause")).Wait(800); } catch (AggregateException) { }
            KillAll();
            return;
        }
        if (!inUse)
            foreach (var hwnd in NativeMethods.MainWindowsOf(pids, onlyVisible: false))
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_SHOWMINNOACTIVE);
    }

    // ---- Spotify's window -----------------------------------------------------------------

    static HashSet<uint> Pids() => Processes().Select(p => { using (p) return (uint)p.Id; }).ToHashSet();

    /// <summary>
    /// Opening Spotify (Start menu, taskbar, ...) while it runs hidden only asks the hidden window
    /// to come forward, which it can't. So watch for that launch, show the window, and from then
    /// on Spotify is yours: Maestro won't hide it or close it.
    /// </summary>
    void WatchWindow()
    {
        if (Interlocked.Exchange(ref watching, 1) == 1) return;
        try { WatchWindowCore(); }
        finally { watching = 0; }
    }

    int watching;

    void WatchWindowCore()
    {
        var roots = NativeMethods.RootProcesses("Spotify.exe");
        var launched = knownRoots != null && roots.Except(knownRoots).Any();        knownRoots = roots;
        if (DateTime.UtcNow <= hideUntil)
        {
            HideWindowIfWanted(); // our own launch
            return;
        }
        if (!launched) return;
        var pids = Pids();
        var hidden = NativeMethods.MainWindowsOf(pids, onlyVisible: false).Count > NativeMethods.MainWindowsOf(pids, onlyVisible: true).Count;
        if (!hidden) return;
        ourPids = [];
        userTookSpotify = true;
        RevealWindows();
        _ = Task.Run(() => RestoreMediaControls());
    }

    void HideWindowIfWanted()
    {
        try
        {
            if (DateTime.UtcNow > hideUntil || showingForLogin || !Store.GetSettings().HideSpotify) return;
            var pids = Pids();
            if (pids.Count == 0) return;
            foreach (var hwnd in NativeMethods.MainWindowsOf(pids, onlyVisible: true)) NativeMethods.ShowWindow(hwnd, NativeMethods.SW_HIDE);
        }
        catch (Exception e) when (e is IOException or InvalidOperationException) { }
    }

    /// <summary>Turning "hide Spotify" off brings back the window Maestro hid; turning it on applies from the next launch.</summary>
    public void ApplyWindowSetting()
    {
        if (!Store.GetSettings().HideSpotify && StartedByUs(Pids())) RevealWindows();
    }

    static void RevealWindows()
    {
        foreach (var hwnd in NativeMethods.MainWindowsOf(Pids(), onlyVisible: false))
        {
            NativeMethods.ShowWindow(hwnd, NativeMethods.SW_SHOW);
            NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
            NativeMethods.SetForegroundWindow(hwnd);
        }
    }

    // ---- autostart (so Spotify is connectable right after login) --------------------------

    static string? ReadAutostart()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue("Spotify") as string;
    }

    static JsonObject AutostartStatus()
    {
        var cmd = ReadAutostart();
        return new JsonObject { ["exists"] = cmd != null, ["enabled"] = cmd?.Contains(Flag) == true };
    }

    public static JsonObject SetAutostart(bool enable)
    {
        var cmd = ReadAutostart() ?? throw new AppException("NO_AUTOSTART",
            "Spotify isn't set to start with Windows (turn on “Open Spotify automatically” in Spotify's settings first).");
        var baseCmd = System.Text.RegularExpressions.Regex.Replace(cmd, @"\s*--remote-debugging-port=\d+", "");
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true)!;
        key.SetValue("Spotify", enable ? $"{baseCmd} {Flag}" : baseCmd);
        return AutostartStatus();
    }

    // ---- public API ---------------------------------------------------------------------------

    public async Task<JsonObject> Status(string exePath)
    {
        var connected = await Connect().ContinueWith(t => t.IsCompletedSuccessfully && t.Result != null);
        var running = connected || IsRunning();
        var needsLogin = running && !connected && await NeedsLogin();
        return new JsonObject
        {
            ["supported"] = true,
            ["exe"] = FindExe(exePath),
            ["running"] = running,
            ["connected"] = connected,
            ["needsLogin"] = needsLogin,
            ["needsRestart"] = running && !connected && !needsLogin,
            ["startedByMaestro"] = StartedByUs(Pids()),
            ["autostart"] = AutostartStatus(),
        };
    }

    // ---- serialized playback control ----------------------------------------------------------

    public async Task<JsonObject> PlayTrack(string exePath, string uri, double? volume)
    {
        var seq = Interlocked.Increment(ref playbackSeq);
        await Ensure(exePath);
        if (seq != Volatile.Read(ref playbackSeq)) return new JsonObject { ["ok"] = false, ["cancelled"] = true };

        string? before;
        await playLock.WaitAsync();
        try
        {
            if (seq != Volatile.Read(ref playbackSeq)) return new JsonObject { ["ok"] = false, ["cancelled"] = true };
            if (volume.HasValue) await Call("setVolume", Math.Clamp(volume.Value, 0, 1));
            before = (await Call("state")).Str("uri");
            await Call("play", uri);
            if (seq != Volatile.Read(ref playbackSeq)) return new JsonObject { ["ok"] = false, ["cancelled"] = true };
        }
        finally { playLock.Release(); }

        return await WaitForTrack(uri, before, seq);
    }

    public async Task<bool> Pause(bool quiet = false, bool onlyIfHidden = false)
    {
        if (onlyIfHidden)
        {
            if (userTookSpotify) return false;
            var pids = Pids();
            if (pids.Count == 0 || NativeMethods.MainWindowsOf(pids, onlyVisible: true).Count > 0) return false;
        }
        Interlocked.Increment(ref playbackSeq);
        if (quiet && conn?.Open != true && !IsRunning()) return false;

        await playLock.WaitAsync();
        try
        {
            if (quiet)
            {
                if (await Connect() == null) return false;
                try { await Call("pause"); return true; }
                catch (AppException e) when (e.Code == "NOT_CONNECTED") { return false; }
            }
            await Call("pause");
            return true;
        }
        finally { playLock.Release(); }
    }

    public async Task<bool> Resume(string? uri, double ms)
    {
        var seq = Interlocked.Increment(ref playbackSeq);
        await playLock.WaitAsync();
        try
        {
            if (seq != Volatile.Read(ref playbackSeq)) return false;
            await Call("resume", uri, Math.Max(0, Math.Round(ms)));
            return true;
        }
        finally { playLock.Release(); }
    }

    public async Task<bool> Seek(double ms, string? uri)
    {
        var seq = Interlocked.Increment(ref playbackSeq);
        await playLock.WaitAsync();
        try
        {
            if (seq != Volatile.Read(ref playbackSeq)) return false;
            await Call("seek", Math.Max(0, Math.Round(ms)), uri);
            return true;
        }
        finally { playLock.Release(); }
    }

    /// <summary>
    /// Wait until Spotify plays the track. In some regions it plays the same song under another ("relinked") URI,
    /// so any track other than the one loaded before the play call counts; the UI checks which song it is.
    /// </summary>
    async Task<JsonObject> WaitForTrack(string uri, string? before, int seq, int timeoutMs = 6000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        JsonNode? state = null;
        while (DateTime.UtcNow < deadline)
        {
            if (seq != Volatile.Read(ref playbackSeq))
                return new JsonObject { ["ok"] = false, ["cancelled"] = true };
            state = await Call("state");
            var playing = state?["playing"]?.GetValue<bool>() == true;
            var now = state.Str("uri");
            var matches = now == uri || (now != null && now != before);
            if (playing && matches)
                return new JsonObject { ["ok"] = true, ["state"] = state?.DeepClone() };
            await Task.Delay(200);
        }
        return new JsonObject { ["ok"] = false, ["state"] = state?.DeepClone() };
    }

    public void Dispose()
    {
        hideTimer.Dispose();
        conn?.Ws.Dispose();
    }
}
