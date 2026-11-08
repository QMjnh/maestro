using System.Diagnostics;
using System.Reflection;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Maestro;

/// <summary>The app window: a WebView2 (Windows' built-in Edge engine) showing the player UI.</summary>
sealed class MainForm : Form
{
    // The UI is served from inside the exe under this made-up https origin.
    const string Origin = "https://maestro.app";

    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(11, 13, 16) };
    readonly SpotifyApp spotify = new();
    readonly Api api;
    CoreWebView2Environment? env;

    public MainForm()
    {
        api = new Api(spotify);
        Text = "Maestro";
        using (var icoStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("maestro.ico"))
        {
            Icon = icoStream != null ? new Icon(icoStream) : Icon.ExtractAssociatedIcon(Environment.ProcessPath!);
        }
        BackColor = Color.FromArgb(11, 13, 16);
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.Manual;
        RestorePlacement();
        Controls.Add(web);
        Load += async (_, _) => await InitWebView();
        FormClosing += (_, _) => { SavePlacement(); spotify.OnAppExit(); spotify.Dispose(); };
        _ = spotify.Prewarm(Store.GetSettings().SpotifyExePath);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.UseDarkTitleBar(Handle);
    }

    // A second Maestro launch asks this window to come forward.
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == NativeMethods.WM_SHOWMAESTRO)
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show();
            Activate();
            NativeMethods.SetForegroundWindow(Handle);
        }
        base.WndProc(ref m);
    }

    async Task InitWebView()
    {
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maestro", "WebView2");
        // Autoplay lets a YouTube or SoundCloud track start on its own when another engine hands over to it.
        var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
        env = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
        await web.EnsureCoreWebView2Async(env);

        var core = web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false; // the UI has its own menus
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
#if DEBUG
        core.Settings.AreDevToolsEnabled = true;
#else
        core.Settings.AreDevToolsEnabled = false;
#endif
        core.AddWebResourceRequestedFilter(Origin + "/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.DocumentTitleChanged += (_, _) => Text = core.DocumentTitle is { Length: > 0 } t ? t : "Maestro";
        // Links (Open in Spotify / YouTube / SoundCloud) go to the default browser.
        core.NewWindowRequested += (_, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith(Origin)) { e.Cancel = true; OpenExternal(e.Uri); }
        };
        await core.AddScriptToExecuteOnDocumentCreatedAsync(Normalizer());
        core.Navigate(Origin + "/index.html");
    }

    static string Normalizer()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("normalizer.js")!;
        return new StreamReader(s).ReadToEnd();
    }

    static void OpenExternal(string uri)
    {
        if (uri.StartsWith("https://") || uri.StartsWith("http://"))
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true })?.Dispose();
    }

    async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var url = new Uri(e.Request.Uri);
        if (!url.AbsolutePath.StartsWith("/api/"))
        {
            e.Response = StaticFile(url.AbsolutePath);
            return;
        }

        // Read the request body now, while we're still inside the event.
        var body = "";
        if (e.Request.Content is { } content)
            using (var reader = new StreamReader(content, Encoding.UTF8)) body = reader.ReadToEnd();
        var method = e.Request.Method;

        var deferral = e.GetDeferral();
        var (status, json) = await api.Handle(method, url, body);
        e.Response = env!.CreateWebResourceResponse(
            new MemoryStream(Encoding.UTF8.GetBytes(json)), status, status == 200 ? "OK" : "Error",
            "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store");
        deferral.Complete();
    }

    static readonly Dictionary<string, string> Mime = new()
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
    };

    CoreWebView2WebResourceResponse StaticFile(string path)
    {
        var name = "wwwroot/" + (path == "/" ? "index.html" : path.TrimStart('/'));
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream == null) return env!.CreateWebResourceResponse(new MemoryStream(), 404, "Not Found", "");
        var type = Mime.GetValueOrDefault(Path.GetExtension(name), "application/octet-stream");
        return env!.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {type}\r\nCache-Control: no-cache");
    }

    // ---- window size/position -------------------------------------------------------------

    void RestorePlacement()
    {
        var p = Store.GetSettings().Window;
        var bounds = p == null ? Rectangle.Empty : new Rectangle(p.X, p.Y, p.Width, p.Height);
        // Only reuse it if it's still on a connected screen.
        if (p != null && Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(bounds)))
        {
            Bounds = bounds;
            if (p.Maximized) WindowState = FormWindowState.Maximized;
        }
        else
        {
            var area = Screen.PrimaryScreen!.WorkingArea;
            Size = new Size(Math.Min(1280, area.Width - 80), Math.Min(820, area.Height - 80));
            Location = new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2);
        }
    }

    void SavePlacement()
    {
        var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        var s = Store.GetSettings();
        s.Window = new Store.WindowPlacement(b.X, b.Y, b.Width, b.Height, WindowState == FormWindowState.Maximized);
        Store.SaveSettings(s);
    }
}
