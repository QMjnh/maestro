using System.Text.Json.Nodes;

namespace Maestro;

/// <summary>
/// The tools Maestro offers AI agents, described for MCP's tools/list and `Maestro.exe agent`. Each one is run by the
/// handler of the same name in wwwroot/agent.js.
/// </summary>
static class AgentTools
{
    public const string Instructions = """
        Maestro is the user's music player for Spotify, YouTube, and SoundCloud, with one shared queue. These tools do
        what the user can do in Maestro's window, and the window shows each change.

        Tracks are objects like {"source":"youtube","id":"dQw4w9WgXcQ","title":...}. Get them from search, resolve_link,
        get_home, get_queue, or get_playlist, and pass them back as they are (only source and id are needed). Queue and
        playlist positions start at 0 and come from get_queue / get_playlist; read them again after changing a list.
        Playlists are named by id or name; "favorites" is the user's liked songs. Searching Spotify, or playing a
        Spotify track, starts the Spotify desktop app in the background if it isn't running.
        """;

    static JsonObject Text(string description, params string[] options)
    {
        var o = new JsonObject { ["type"] = "string", ["description"] = description };
        if (options.Length > 0) o["enum"] = new JsonArray([.. options.Select(s => (JsonNode)s)]);
        return o;
    }

    static JsonObject Int(string description) => new() { ["type"] = "integer", ["description"] = description };
    static JsonObject Bool(string description) => new() { ["type"] = "boolean", ["description"] = description };

    static JsonObject Positions(string what) => new()
    {
        ["type"] = "array",
        ["items"] = new JsonObject { ["type"] = "integer" },
        ["description"] = $"0-based positions, from {what}.",
    };

    static JsonObject Track() => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["source"] = Text("Which service.", "spotify", "youtube", "soundcloud"),
            ["id"] = Text("The track's id on that service."),
            ["title"] = Text("Optional."),
            ["artist"] = Text("Optional."),
        },
        ["required"] = new JsonArray("source", "id"),
    };

    /// <summary>The ways to say which tracks a call is about. Any combination adds up, in this order.</summary>
    static (string, JsonNode)[] Pick(string usage) =>
    [
        ("tracks", new JsonObject
        {
            ["type"] = "array",
            ["items"] = Track(),
            ["description"] = "Track objects from search, resolve_link, get_home, get_queue, or get_playlist.",
        }),
        ("urls", new JsonObject
        {
            ["type"] = "array",
            ["items"] = new JsonObject { ["type"] = "string" },
            ["description"] = "Spotify track/album/playlist, YouTube video/playlist, or SoundCloud track/set links. Each adds all of its tracks.",
        }),
        ("fromPlaylist", Text("All tracks of a Maestro playlist (id or name), \"favorites\", or a home page card (its ref from get_home).")),
        ("fromQueue", Bool("All tracks in the queue.")),
        ("current", Bool("The track playing now." + usage)),
    ];

    static JsonObject Tool(string name, string description, (string Name, JsonNode Schema)[]? props = null, string[]? required = null,
        bool readOnly = false, bool destructive = false)
    {
        var properties = new JsonObject();
        foreach (var (key, schema) in props ?? []) properties[key] = schema;
        var input = new JsonObject { ["type"] = "object", ["properties"] = properties };
        if (required is { Length: > 0 }) input["required"] = new JsonArray([.. required.Select(r => (JsonNode)r)]);
        return new JsonObject
        {
            ["name"] = name,
            ["description"] = description,
            ["inputSchema"] = input,
            ["annotations"] = new JsonObject
            {
                ["readOnlyHint"] = readOnly,
                ["destructiveHint"] = destructive,
                ["openWorldHint"] = false,
            },
        };
    }

    public static readonly JsonObject[] All =
    [
        // ---- what's playing, and finding music ----
        Tool("get_state",
            "What's playing now and how the player is set: the current track, playing/paused, position, volume, " +
            "shuffle, repeat, autoplay, the next few tracks, whether the current track is a favorite, and Spotify's connection.",
            readOnly: true),
        Tool("search",
            "Search Spotify, YouTube, and SoundCloud for songs, like the search box. Returns tracks per service to pass to " +
            "play, add_to_queue, add_to_playlist, or set_favorite. A link as the query is resolved like resolve_link.",
            [
                ("query", Text("What to search for, e.g. \"bohemian rhapsody queen\".")),
                ("source", Text("Which service to search (default all).", "all", "spotify", "youtube", "soundcloud")),
                ("limit", Int("Results per service, 1-25 (default 10).")),
            ], ["query"], readOnly: true),
        Tool("resolve_link",
            "List the tracks behind a Spotify (track, album, playlist), YouTube (video, playlist), or SoundCloud (track, set) link, like pasting it into search.",
            [("url", Text("The link."))], ["url"], readOnly: true),
        Tool("get_home",
            "The home page: recommendations built from the user's listening (songs, mixes, YouTube and SoundCloud " +
            "playlists), their Spotify home feed, recently played, and their playlists. Playlist cards have a ref to " +
            "pass as fromPlaylist (to play, queue, or save them) or to get_playlist (to see their tracks).",
            [
                ("refresh", Bool("Get new picks, like the New picks button (slower).")),
                ("limit", Int("Most items per shelf (default 10).")),
            ], readOnly: true),

        // ---- playback ----
        Tool("play",
            "Play tracks now. By default one track is inserted after the current song and the rest of the queue is kept, " +
            "like pressing play on a song; several tracks (or a playlist) replace the queue, like pressing Play on a playlist. " +
            "To resume or pause, use player_control.",
            [
                .. Pick(""),
                ("startIndex", Int("When replacing the queue, which of the tracks to start at (default 0).")),
                ("shuffle", Bool("Shuffle the tracks.")),
                ("replaceQueue", Bool("Override the default: true replaces the queue, false inserts after the current song.")),
            ]),
        Tool("player_control",
            "Play, pause, or skip. previous restarts the current song if it's more than 3 seconds in, otherwise goes back one.",
            [("action", Text("What to do.", "play", "pause", "toggle", "next", "previous"))], ["action"]),
        Tool("seek", "Jump within the current song.",
            [
                ("positionMs", Int("Go to this point, in milliseconds from the start.")),
                ("offsetMs", Int("Or move by this much from where it is now (negative goes back).")),
            ]),
        Tool("set_player_options", "Change volume, mute, shuffle, repeat, autoplay, or volume leveling. Only the options given change.",
            [
                ("volume", Int("0-100.")),
                ("muted", Bool("Mute or unmute.")),
                ("shuffle", Bool("Shuffle the upcoming tracks, or put them back in order.")),
                ("repeat", Text("Repeat nothing, the whole queue, or the current song.", "off", "all", "one")),
                ("autoplay", Text("When the queue runs low, add recommendations: off, from the same service as the last song, or from all three.", "off", "same", "both")),
                ("normalizeVolume", Bool("Even out YouTube and SoundCloud loudness to match Spotify.")),
            ]),

        // ---- queue ----
        Tool("get_queue",
            "Every track in the queue with its position. Tracks before queuePosition have played; autoplay: true marks recommendations autoplay added.",
            readOnly: true),
        Tool("add_to_queue", "Add tracks to the queue, after the user's own queued songs and before autoplay's picks, or right after the current song.",
            [.. Pick(""), ("playNext", Bool("Put them right after the current song, like Play next."))]),
        Tool("play_queue_position", "Jump to a track already in the queue.",
            [("position", Int("Its position from get_queue."))], ["position"]),
        Tool("remove_from_queue", "Remove tracks from the queue. Removing the current song moves on to the next one.",
            [("positions", Positions("get_queue"))], ["positions"], destructive: true),
        Tool("move_in_queue", "Move one track to a new place in the queue.",
            [("from", Int("Its position now.")), ("to", Int("The position it should end up at."))], ["from", "to"]),
        Tool("clear_queue", "Remove everything from the queue except the song playing now.", destructive: true),

        // ---- favorites and playlists ----
        Tool("list_playlists", "The user's Maestro playlists with track counts. The first entry, id \"favorites\", is their liked songs.",
            readOnly: true),
        Tool("get_playlist", "The tracks in a playlist, with positions.",
            [("playlist", Text("A playlist id or name, \"favorites\", or a home page card ref from get_home."))], ["playlist"], readOnly: true),
        Tool("set_favorite", "Like or unlike tracks (the heart button). With no tracks given, applies to the song playing now.",
            [.. Pick(" (the default)"), ("favorite", Bool("true to like (default), false to unlike."))]),
        Tool("create_playlist", "Make a new Maestro playlist, optionally with tracks, e.g. fromQueue: true to save the queue.",
            [("name", Text("The playlist's name.")), .. Pick("")], ["name"]),
        Tool("add_to_playlist", "Add tracks to the end of a playlist. \"favorites\" likes them instead.",
            [("playlist", Text("A playlist id or name.")), .. Pick("")], ["playlist"]),
        Tool("remove_from_playlist", "Remove tracks from a playlist (or unlike them, for \"favorites\").",
            [("playlist", Text("A playlist id or name, or \"favorites\".")), ("positions", Positions("get_playlist"))], ["playlist", "positions"],
            destructive: true),
        Tool("move_in_playlist", "Move one track to a new place in a playlist.",
            [("playlist", Text("A playlist id or name.")), ("from", Int("Its position now.")), ("to", Int("The position it should end up at."))],
            ["playlist", "from", "to"]),
        Tool("rename_playlist", "Rename a playlist.",
            [("playlist", Text("A playlist id or name.")), ("name", Text("The new name."))], ["playlist", "name"]),
        Tool("delete_playlist", "Delete a Maestro playlist. The songs stay on their services. Can't be undone.",
            [("playlist", Text("A playlist id or name."))], ["playlist"], destructive: true),

        // ---- the window and settings ----
        Tool("show_view", "Show a page in Maestro's window, e.g. so the user can see a playlist or search results.",
            [
                ("view", Text("The page.", "home", "search", "queue", "favorites", "playlist")),
                ("playlist", Text("For view playlist: its id or name.")),
                ("query", Text("For view search: what to search for.")),
            ], ["view"]),
        Tool("get_settings", "Maestro's settings and Spotify's connection status.", readOnly: true),
        Tool("update_settings", "Change settings. Only the ones given change.",
            [
                ("hideSpotify", Bool("Keep the Spotify window hidden when Maestro started it.")),
                ("closeSpotifyOnExit", Bool("Close Spotify when Maestro closes, if Maestro started it.")),
                ("normalizeVolume", Bool("Even out YouTube and SoundCloud loudness to match Spotify.")),
                ("spotifyExePath", Text("Path to Spotify.exe; empty to auto-detect.")),
                ("youtubeApiKey", Text("Optional YouTube Data API key; empty to remove.")),
            ]),
        Tool("manage_spotify",
            "Fix or set up the Spotify connection. restart closes the user's Spotify app (stopping anything playing there) " +
            "and reopens it with Maestro support; only do it when get_state says Spotify needs a restart. show_login brings " +
            "Spotify's window up so the user can sign in. The autostart actions make Spotify always start with Maestro support.",
            [("action", Text("What to do.", "restart", "show_login", "enable_autostart", "disable_autostart"))], ["action"], destructive: true),
    ];

    public static bool Exists(string? name) => All.Any(t => t.Str("name") == name);
}
