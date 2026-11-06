using System.Text.Json;
using System.Text.Json.Nodes;

namespace Maestro;

/// <summary>A playable song from either source — the shape the UI works with.</summary>
record Track(string Source, string Id, string Title, string Artist, string Art, long? Duration);

record Playlist(string Id, string Name, List<Track> Items, long UpdatedAt, long CreatedAt);

/// <summary>Settings and playlists, stored as JSON in %APPDATA%\Maestro.</summary>
static class Store
{
    public static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Maestro");
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    static readonly Lock Gate = new();
    const string Mask = "••••••••";

    static Store() => Directory.CreateDirectory(Dir);

    static T Read<T>(string name, T fallback)
    {
        try { return JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(Dir, name)), Json) ?? fallback; }
        catch (Exception e) when (e is IOException or JsonException) { return fallback; }
    }

    static void Write<T>(string name, T value)
    {
        var path = Path.Combine(Dir, name);
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(value, Json));
        File.Move(path + ".tmp", path, overwrite: true);
    }

    // ---- settings ------------------------------------------------------------

    public sealed class Settings
    {
        public string YoutubeApiKey { get; set; } = "";
        public string SpotifyExePath { get; set; } = "";
        /// <summary>Keep Spotify's own window out of sight; Maestro is the only window you use.</summary>
        public bool HideSpotify { get; set; } = true;
        /// <summary>Quit Spotify on exit — only if Maestro was the one that started it.</summary>
        public bool CloseSpotifyOnExit { get; set; } = true;
        public WindowPlacement? Window { get; set; }
    }

    public sealed record WindowPlacement(int X, int Y, int Width, int Height, bool Maximized);

    static Settings? settings; // cached: read every second by the Spotify window check

    public static Settings GetSettings()
    {
        lock (Gate) return settings ??= Read("settings.json", new Settings());
    }

    public static void SaveSettings(Settings s)
    {
        lock (Gate)
        {
            Write("settings.json", s);
            settings = s;
        }
    }

    /// <summary>Settings as shown to the UI: the API key is reduced to "is set".</summary>
    public static JsonObject PublicSettings()
    {
        var s = GetSettings();
        return new JsonObject
        {
            ["youtubeApiKey"] = s.YoutubeApiKey.Length > 0 ? Mask : "",
            ["spotifyExePath"] = s.SpotifyExePath,
            ["hideSpotify"] = s.HideSpotify,
            ["closeSpotifyOnExit"] = s.CloseSpotifyOnExit,
        };
    }

    public static JsonObject UpdateSettings(JsonNode? patch)
    {
        lock (Gate)
        {
            var s = GetSettings();
            if (patch.Str("youtubeApiKey") is { } key && key != Mask) s.YoutubeApiKey = key.Trim();
            if (patch.Str("spotifyExePath") is { } exe) s.SpotifyExePath = exe.Trim();
            if (patch?["hideSpotify"] is JsonValue h && h.TryGetValue<bool>(out var hide)) s.HideSpotify = hide;
            if (patch?["closeSpotifyOnExit"] is JsonValue c && c.TryGetValue<bool>(out var close)) s.CloseSpotifyOnExit = close;
            SaveSettings(s);
        }
        return PublicSettings();
    }

    // ---- playlists -----------------------------------------------------------

    public static List<Playlist> ListPlaylists()
    {
        lock (Gate) return Read("playlists.json", new List<Playlist>());
    }

    public static Playlist SavePlaylist(JsonNode? body)
    {
        lock (Gate)
        {
            var all = ListPlaylists();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var id = body.Str("id") is { Length: > 0 } given ? given : Guid.NewGuid().ToString();
            var name = body.Str("name") is { Length: > 0 } n ? n[..Math.Min(n.Length, 200)] : "Untitled playlist";
            var items = (body?["items"] as JsonArray ?? [])
                .Select(CleanTrack)
                .OfType<Track>()
                .ToList();
            var idx = all.FindIndex(p => p.Id == id);
            var entry = new Playlist(id, name, items, now, idx >= 0 ? all[idx].CreatedAt : now);
            if (idx >= 0) all[idx] = entry;
            else all.Add(entry);
            Write("playlists.json", all);
            return entry;
        }
    }

    public static void DeletePlaylist(string id)
    {
        lock (Gate) Write("playlists.json", ListPlaylists().Where(p => p.Id != id).ToList());
    }

    static Track? CleanTrack(JsonNode? n)
    {
        if (n.Str("id") is not { Length: > 0 } id) return null;
        return new Track(
            n.Str("source") == "spotify" ? "spotify" : "youtube",
            id,
            n.Str("title") ?? "",
            n.Str("artist") ?? "",
            n.Str("art") ?? "",
            n.Num("duration"));
    }
}
