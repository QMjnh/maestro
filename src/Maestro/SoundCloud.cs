using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>SoundCloud links, search and related tracks. Works without an API key by using SoundCloud's own site client id.</summary>
static partial class SoundCloud
{
    static readonly Lock Gate = new();
    static string? clientId;

    [GeneratedRegex(@"<script[^>]+src=""([^""]+)""", RegexOptions.IgnoreCase)]
    private static partial Regex ScriptSrc();

    [GeneratedRegex(@"client_id\s*:\s*""([0-9a-zA-Z]{32})""")]
    private static partial Regex ClientIdPat();

    static readonly Dictionary<string, string> Web = new()
    {
        ["Accept"] = "application/json",
        ["Origin"] = "https://soundcloud.com",
        ["Referer"] = "https://soundcloud.com/",
    };

    public static bool IsUrl(string input)
    {
        var s = input.Trim();
        if (!Uri.TryCreate(s, UriKind.Absolute, out var url) && !Uri.TryCreate("https://" + s, UriKind.Absolute, out url))
            return false;
        var host = url.Host.ToLowerInvariant();
        return host == "soundcloud.com" || host.EndsWith(".soundcloud.com");
    }

    // ---- search / related -----------------------------------------------------

    public static async Task<List<Track>> Search(string q)
    {
        var data = await Api("search/tracks?limit=25&q=" + Uri.EscapeDataString(q));
        return Collection(data).Select(ToTrack).OfType<Track>().Take(25).ToList();
    }

    public static async Task<List<PlaylistCard>> SearchPlaylists(string q)
    {
        var data = await Api("search/playlists_without_albums?limit=12&q=" + Uri.EscapeDataString(q));
        return Collection(data)
            .Where(p => p.Num("track_count") > 0 && p.Str("permalink_url") != null && p.Num("id") != null)
            .Select(p => new PlaylistCard("soundcloud", p.Num("id")!.Value.ToString(), p.Str("title") ?? "SoundCloud playlist", p.Str("user.username") ?? "",
                LargeArt(p.Str("artwork_url") ?? p.Str("tracks.0.artwork_url") ?? p.Str("user.avatar_url") ?? ""), p.Str("permalink_url")!))
            .ToList();
    }

    public static async Task<List<Track>> Related(string id)
    {
        var data = await Api("tracks/" + Uri.EscapeDataString(id) + "/related?limit=25");
        return Collection(data).Select(ToTrack).OfType<Track>().Where(t => t.Id != id).ToList();
    }

    // ---- link resolution ------------------------------------------------------

    public static async Task<(string Title, List<Track> Items, bool Truncated)> Resolve(string input)
    {
        var s = input.Trim();
        if (!s.Contains("://", StringComparison.Ordinal)) s = "https://" + s;
        var data = await Api("resolve?url=" + Uri.EscapeDataString(s));
        var kind = data.Str("kind");
        if (kind == "track")
        {
            var t = ToTrack(data) ?? throw new UpstreamException("That SoundCloud track isn't playable.");
            return (t.Title, [t], false);
        }
        if (kind == "playlist")
        {
            var raw = data["tracks"] as JsonArray;
            var items = await Hydrate(raw);
            var total = data.Num("track_count") ?? raw?.Count ?? items.Count;
            return (data.Str("title") ?? "SoundCloud playlist", items, total > items.Count);
        }
        throw new UpstreamException("Paste a SoundCloud track or playlist (set) link.");
    }

    static async Task<List<Track>> Hydrate(JsonArray? tracks)
    {
        var nodes = (tracks ?? new JsonArray()).Take(100).ToList();
        var missing = nodes
            .Select(n => (Node: n, Id: TrackId(n)))
            .Where(x => x.Id != null && x.Node.Str("title") == null)
            .Select(x => x.Id!)
            .Distinct()
            .ToList();
        var extra = new Dictionary<string, JsonNode>();
        foreach (var chunk in missing.Chunk(30))
        {
            foreach (var t in AsList(await Api("tracks?ids=" + string.Join(',', chunk))))
                if (TrackId(t) is { } id) extra[id] = t;
        }
        var items = new List<Track>();
        foreach (var n in nodes)
        {
            var node = n.Str("title") != null ? n : extra.GetValueOrDefault(TrackId(n) ?? "");
            if (ToTrack(node) is { } t) items.Add(t);
        }
        return items;
    }

    // ---- client id + api ------------------------------------------------------

    static async Task<JsonNode> Api(string path)
    {
        async Task<JsonNode> Call(string cid)
        {
            var sep = path.Contains('?') ? '&' : '?';
            return await Net.GetJson($"https://api-v2.soundcloud.com/{path}{sep}client_id={Uri.EscapeDataString(cid)}", Web);
        }

        try { return await Call(await ClientId()); }
        catch (UpstreamException e) when (e.Status is 401 or 403)
        {
            lock (Gate) clientId = null;
            return await Call(await ClientId());
        }
    }

    static async Task<string> ClientId()
    {
        lock (Gate)
        {
            if (clientId != null) return clientId;
        }
        var id = await FetchClientId();
        lock (Gate)
        {
            return clientId ??= id;
        }
    }

    static async Task<string> FetchClientId()
    {
        var html = await Net.GetText("https://soundcloud.com/");
        var scripts = ScriptSrc().Matches(html).Select(m => m.Groups[1].Value)
            .Where(s => s.Contains("/assets/", StringComparison.Ordinal) && s.EndsWith(".js", StringComparison.Ordinal))
            .Reverse();
        foreach (var src in scripts)
        {
            var url = src.StartsWith("//", StringComparison.Ordinal) ? "https:" + src : src;
            try
            {
                if (ClientIdPat().Match(await Net.GetText(url)) is { Success: true } m) return m.Groups[1].Value;
            }
            catch (UpstreamException) { /* try the next bundle */ }
        }
        throw new UpstreamException("Could not read SoundCloud search (page format changed?)");
    }

    // ---- mapping --------------------------------------------------------------

    static IEnumerable<JsonNode> Collection(JsonNode data) =>
        data["collection"] is JsonArray arr ? arr.OfType<JsonNode>() : [];

    static IEnumerable<JsonNode> AsList(JsonNode data) => data switch
    {
        JsonArray arr => arr.OfType<JsonNode>(),
        JsonObject obj when obj["collection"] is JsonArray c => c.OfType<JsonNode>(),
        JsonObject obj => [obj],
        _ => [],
    };

    static string? TrackId(JsonNode? n) => n.Num("id")?.ToString() ?? n.Str("id");

    static Track? ToTrack(JsonNode? n)
    {
        if (n == null || TrackId(n) is not { } id) return null;
        if (n.Str("kind") is { } k && k != "track") return null;
        if (n.Str("policy") is "BLOCK" or "SNIP") return null;
        if (n["streamable"] is JsonValue v && v.TryGetValue<bool>(out var s) && !s) return null;
        var art = LargeArt(n.Str("artwork_url") ?? n.Str("user.avatar_url") ?? "");
        return new Track("soundcloud", id, n.Str("title") ?? "", n.Str("user.username") ?? "", art,
            n.Num("full_duration") ?? n.Num("duration"), n.Str("permalink_url"));
    }

    static string LargeArt(string art) => art.Replace("-large.", "-t500x500.", StringComparison.Ordinal);
}
