using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Reflection;
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
    Connection? conn;
    readonly System.Threading.Timer hideTimer;
    // Spotify processes Maestro launched. A Spotify you start yourself is never hidden or closed.
    volatile HashSet<uint> ourPids = [];
    // Hiding only covers the launch (Spotify pops its window up while starting). After that the
    // window is yours: open Spotify from the Start menu and it stays open.
    DateTime hideUntil = DateTime.MinValue;
    volatile bool showingForLogin; // pause hiding while the user logs in

    HashSet<uint>? knownRoots; // null until the first look

    public SpotifyApp()
    {
        // A second Spotify launch only lives ~200 ms (it hands off to the running one and exits).
        hideTimer = new System.Threading.Timer(_ => WatchWindow(), null, 100, 100);
    }

    bool StartedByUs(HashSet<uint> pids) => pids.Overlaps(ourPids);

    static string LoadInjectScript()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("inject.js")!;
        return new StreamReader(s).ReadToEnd();
    }

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
            return conn = c;
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
        KillAll();
        for (int i = 0; i < 40 && IsRunning(); i++) await Task.Delay(250);
        await startLock.WaitAsync();
        try { await Start(exePath); }
        finally { startLock.Release(); }
        if (await Connect() == null) throw new AppException("NOT_CONNECTED", "Could not connect to Spotify.");
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
    /// On Maestro exit: quit Spotify if Maestro started it, it's still in the background, and the
    /// user wants that. If you opened its window, you're using it, so it stays. A Spotify that stays
    /// gets its window back (minimized) so it's never left running invisibly.
    /// </summary>
    public void OnAppExit()
    {
        hideTimer.Change(Timeout.Infinite, Timeout.Infinite);
        var pids = Pids();
        if (!StartedByUs(pids)) return;
        var inUse = NativeMethods.MainWindowsOf(pids, onlyVisible: true).Count > 0;
        if (!inUse && Store.GetSettings().CloseSpotifyOnExit)
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
        var hidden = NativeMethods.MainWindowsOf(pids, onlyVisible: false).Count > NativeMethods.MainWindowsOf(pids, onlyVisible: true).Count;        if (!hidden) return;
        ourPids = [];
        RevealWindows();
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

    public async Task<JsonObject> WaitForTrack(string uri, int timeoutMs = 6000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        JsonNode? state = null;
        while (DateTime.UtcNow < deadline)
        {
            state = await Call("state");
            if (state.Str("uri") == uri && state?["playing"]?.GetValue<bool>() == true)
                return new JsonObject { ["ok"] = true, ["state"] = state.DeepClone() };
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
