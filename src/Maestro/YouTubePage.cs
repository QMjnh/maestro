using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace Maestro;

/// <summary>
/// A second browser, hidden behind the UI, that plays YouTube videos on youtube.com itself. Some owners block their
/// videos from playing inside other apps (YouTube errors 101/150), but the watch page still plays them. watch.js runs
/// the page. Messages pass through untouched: the UI posts {ytPage: msg} and gets {ytPage: msg} back, except for
/// requests to click an ad's Skip button, which are handled here.
/// </summary>
sealed class YouTubePage(CoreWebView2Environment env, Control parent, CoreWebView2 ui) : IDisposable
{
    CoreWebView2Controller? controller;
    Task? starting;
    int seq;
    string? activeVideoId;

    public async Task Handle(JsonNode msg)
    {
        var cmd = msg.Str("cmd");
        if (cmd == "load" && YouTube.ParseUrl("https://youtu.be/" + msg.Str("id")) is { Kind: YouTube.Kind.Video } v)
        {
            var mySeq = ++seq;
            activeVideoId = v.Id;
            await (starting ??= Start());
            // Stopped or superseded while the hidden browser was still starting up.
            if (mySeq != seq) return;
            controller!.CoreWebView2.Navigate("https://www.youtube.com/watch?v=" + v.Id);
        }
        else if (cmd == "stop")
        {
            seq++;
            activeVideoId = null;
            controller?.CoreWebView2.Navigate("about:blank");
        }
        else
        {
            controller?.CoreWebView2.PostWebMessageAsJson(msg.ToJsonString());
        }
    }

    async Task Start()
    {
        controller = await env.CreateCoreWebView2ControllerAsync(parent.Handle);
        controller.Bounds = parent.ClientRectangle;
        var core = controller.CoreWebView2;
        core.Settings.AreDevToolsEnabled = ui.Settings.AreDevToolsEnabled;
        var cookies = core.CookieManager;
        cookies.AddOrUpdateCookie(cookies.CreateCookie("SOCS", "CAI", ".youtube.com", "/")); // skip the EU consent wall
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationStarting += (_, e) =>
        {
            if (e.Uri == "about:blank") return;
            if (!IsYouTube(e.Uri)) { e.Cancel = true; return; }
            if (YouTube.ParseUrl(e.Uri) is { Kind: YouTube.Kind.Video } v && (activeVideoId == null || v.Id != activeVideoId))
                e.Cancel = true;
        };
        core.WebMessageReceived += (_, e) =>
        {
            if (!IsYouTube(e.Source)) return;
            if (JsonNode.Parse(e.WebMessageAsJson) is JsonObject msg && msg["skipAt"] is JsonObject at)
                _ = Click(core, at.Num("x") ?? 0, at.Num("y") ?? 0);
            else
                ui.PostWebMessageAsJson($$"""{"ytPage":{{e.WebMessageAsJson}}}""");
        };
        await core.AddScriptToExecuteOnDocumentCreatedAsync(Program.Resource("normalizer.js"));
        await core.AddScriptToExecuteOnDocumentCreatedAsync(Program.Resource("watch.js"));
    }

    static bool IsYouTube(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Host == "youtube.com" || u.Host.EndsWith(".youtube.com"));

    /// <summary>A real mouse click, for the ad's Skip button (YouTube ignores clicks made by scripts).</summary>
    static async Task Click(CoreWebView2 core, long x, long y)
    {
        foreach (var (type, button) in new[] { ("mouseMoved", "none"), ("mousePressed", "left"), ("mouseReleased", "left") })
            await core.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent",
                new JsonObject { ["type"] = type, ["x"] = x, ["y"] = y, ["button"] = button, ["clickCount"] = 1 }.ToJsonString());
    }

    public void Dispose() => controller?.Close();
}
