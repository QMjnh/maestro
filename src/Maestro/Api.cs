using System.Text.Json;
using System.Text.Json.Nodes;

namespace Maestro;

/// <summary>
/// The UI's backend. The page calls fetch('/api/...') as before; MainForm intercepts those
/// requests inside WebView2 and hands them here, so there is no local server or port.
/// </summary>
sealed class Api(SpotifyApp spotify)
{
    sealed class BadRequest(string message) : Exception(message);

    readonly Radio radio = new(spotify);

    public async Task<(int Status, string Json)> Handle(string method, Uri url, string body)
    {
        try
        {
            var result = await Route(method, url.AbsolutePath, System.Web.HttpUtility.ParseQueryString(url.Query), body);
            return (200, JsonSerializer.Serialize(result, Store.Json));
        }
        catch (Exception e)
        {
            var (status, code) = e switch
            {
                AppException a => (409, a.Code),
                BadRequest => (400, null),
                KeyNotFoundException => (404, null),
                _ => (502, null), // other websites failing, network errors, Spotify-side errors
            };
            return (status, new JsonObject { ["error"] = e.Message, ["code"] = code }.ToJsonString());
        }
    }

    async Task<object?> Route(string method, string path, System.Collections.Specialized.NameValueCollection query, string body)
    {
        var settings = Store.GetSettings();
        JsonNode? Body() => body.Length > 0 ? JsonNode.Parse(body) : null;

        switch (method, path)
        {
            case ("GET", "/api/status"):
                return new JsonObject
                {
                    ["platform"] = "win32",
                    ["spotify"] = await spotify.Status(settings.SpotifyExePath),
                    ["youtubeApi"] = settings.YoutubeApiKey.Length > 0,
                };

            case ("GET", "/api/search"):
            {
                var q = (query["q"] ?? "").Trim();
                if (q.Length == 0) return new { items = Array.Empty<Track>() };
                if (query["source"] == "spotify")
                {
                    await spotify.Ensure(settings.SpotifyExePath);
                    return new JsonObject { ["items"] = await spotify.Call("search", q, 25) };
                }
                if (query["source"] == "youtube") return new { items = await YouTube.Search(q, settings.YoutubeApiKey) };
                if (query["source"] == "soundcloud") return new { items = await SoundCloud.Search(q) };
                throw new BadRequest("source must be spotify, youtube, or soundcloud");
            }

            // Recommendations to keep playing after the queue runs out.
            case ("GET", "/api/radio"):
            {
                var source = query["source"];
                var id = query["id"] ?? "";
                if (source is not ("spotify" or "youtube" or "soundcloud") || id.Length == 0) throw new BadRequest("source and id are required");
                var items = await radio.For(source, id, query["title"] ?? "", query["artist"] ?? "", query["mix"] == "both", settings);
                return new { items };
            }

            // Home page shelves. These load without being asked, so none of them may start Spotify.
            case ("GET", "/api/home/radio"):
            {
                var source = query["source"];
                var id = query["id"] ?? "";
                if (source is not ("spotify" or "youtube" or "soundcloud") || id.Length == 0) throw new BadRequest("source and id are required");
                return new { lists = await radio.ForHome(source, id, query["title"] ?? "", query["artist"] ?? "", settings) };
            }

            case ("GET", "/api/home/spotify"):
                try
                {
                    return new { connected = true, items = await spotify.Call("home") };
                }
                catch (AppException e) when (e.Code == "NOT_CONNECTED")
                {
                    return new { connected = false, items = (JsonNode?)new JsonArray() };
                }

            case ("GET", "/api/home/chart"):
                return new { items = await YouTube.Chart(settings.YoutubeApiKey) };

            case ("GET", "/api/home/featured"):
                return new { items = await SpotifyLinks.Featured() };

            case ("GET", "/api/home/playlists"):
                return new { items = await Radio.PlaylistsLike(query["q"] ?? "") };

            // Turn a pasted link into playable items.
            case ("POST", "/api/resolve"):
            {
                var url = Body().Str("url") ?? "";
                if (SpotifyLinks.ParseUrl(url) is { } sp)
                {
                    try
                    {
                        var (title, items, truncated) = await SpotifyLinks.Resolve(sp.Kind, sp.Id);
                        return new { title, items, truncated };
                    }
                    // Private lists like "Your Top Songs" have no public page, but the signed-in app can read them.
                    catch (UpstreamException) when (sp.Kind == "playlist")
                    {
                        return await spotify.Call("contents", "spotify:playlist:" + sp.Id);
                    }
                }
                if (YouTube.ParseUrl(url) is { } yt)
                {
                    if (yt.Kind == YouTube.Kind.Video)
                    {
                        var item = await YouTube.Video(yt.Id, settings.YoutubeApiKey);
                        return new { title = item.Title, items = new[] { item } };
                    }
                    var (title, items) = await YouTube.Playlist(yt.Id, settings.YoutubeApiKey);
                    return new { title, items };
                }
                if (SoundCloud.IsUrl(url))
                {
                    var (title, items, truncated) = await SoundCloud.Resolve(url);
                    return new { title, items, truncated };
                }
                throw new BadRequest("That doesn't look like a Spotify, YouTube, or SoundCloud link.");
            }

            // Polled while a Spotify track is playing; never launches Spotify by itself.
            case ("GET", "/api/spotify/state"):
                try
                {
                    var state = (await spotify.Call("state"))?.AsObject() ?? [];
                    state["connected"] = true;
                    return state;
                }
                catch (AppException e) when (e.Code == "NOT_CONNECTED")
                {
                    return new { connected = false };
                }

            case ("POST", "/api/spotify/play"):
            {
                var b = Body();
                var id = b.Str("id") ?? "";
                if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9]{22}$")) throw new BadRequest("Bad track id");
                await spotify.Ensure(settings.SpotifyExePath);
                if (b?["volume"] is JsonValue v && v.TryGetValue<double>(out var vol)) await spotify.Call("setVolume", Math.Clamp(vol, 0, 1));
                var uri = "spotify:track:" + id;
                await spotify.Call("play", uri);
                return await spotify.WaitForTrack(uri);
            }

            case ("POST", "/api/spotify/control"):
            {
                var b = Body();
                var value = b?["value"] is JsonValue jv && jv.TryGetValue<double>(out var d) ? d : 0;
                return b.Str("action") switch
                {
                    "pause" => new { ok = await spotify.Call("pause") },
                    "resume" => new { ok = await spotify.Call("resume") },
                    "seek" => new { ok = await spotify.Call("seek", Math.Max(0, Math.Round(value))) },
                    "volume" => new { ok = await spotify.Call("setVolume", Math.Clamp(value, 0, 1)) },
                    _ => throw new BadRequest("Unknown action"),
                };
            }

            // Restart Spotify with Maestro support (only ever on the user's request).
            case ("POST", "/api/spotify/restart"):
                await spotify.Restart(settings.SpotifyExePath);
                return await spotify.Status(settings.SpotifyExePath);

            // Bring Spotify's window up so the user can log in.
            case ("POST", "/api/spotify/show"):
                spotify.ShowForLogin();
                return new { ok = true };

            case ("POST", "/api/spotify/autostart"):
                return SpotifyApp.SetAutostart(Body()?["enable"]?.GetValue<bool>() == true);

            case ("GET", "/api/settings"):
                return Store.PublicSettings();

            case ("PUT", "/api/settings"):
            {
                var updated = Store.UpdateSettings(Body());
                spotify.ApplyWindowSetting();
                return updated;
            }

            case ("GET", "/api/playlists"):
                return Store.ListPlaylists();

            case ("POST", "/api/playlists"):
                return Store.SavePlaylist(Body());

            case ("DELETE", _) when path.StartsWith("/api/playlists/"):
                Store.DeletePlaylist(path["/api/playlists/".Length..]);
                return new { ok = true };
        }
        throw new KeyNotFoundException("Not found");
    }
}
