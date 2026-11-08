using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>Spotify links → tracks, via Spotify's public embed pages (no account needed).</summary>
static partial class SpotifyLinks
{
    [GeneratedRegex(@"^spotify:(track|album|playlist):([A-Za-z0-9]{22})$")]
    private static partial Regex UriForm();

    [GeneratedRegex(@"/(track|album|playlist)/([A-Za-z0-9]{22})")]
    private static partial Regex PathForm();

    [GeneratedRegex(@"<script id=""__NEXT_DATA__"" type=""application/json"">(.*?)</script>", RegexOptions.Singleline)]
    private static partial Regex NextData();

    // Spotify's own editorial playlists, shown on the home page.
    static readonly string[] FeaturedIds =
    [
        "37i9dQZF1DXcBWIGoYBM5M", // Today's Top Hits
        "37i9dQZF1DX0XUsuxWHRQd", // RapCaviar
        "37i9dQZF1DWXRqgorJj26U", // Rock Classics
        "37i9dQZF1DX10zKzsJ2jva", // Viva Latino
        "37i9dQZF1DX4dyzvuaRJ0n", // mint
        "37i9dQZF1DX9tPFwDMOaN1", // K-Pop ON!
        "37i9dQZF1DWWQRwui0ExPn", // lofi beats
        "37i9dQZF1DWZeKCadgRdKQ", // Deep Focus
        "37i9dQZF1DX4sWSpwq3LiO", // Peaceful Piano
        "37i9dQZF1DX76Wlfdnj7AP", // Beast Mode
        "37i9dQZF1DX2sUQwD7tbmL", // Feel-Good Indie Rock
        "37i9dQZF1DX4o1oenSJRJd", // All Out 2000s
    ];

    /// <summary>Parse open.spotify.com links and spotify: URIs.</summary>
    public static (string Kind, string Id)? ParseUrl(string input)
    {
        var s = input.Trim();
        if (UriForm().Match(s) is { Success: true } m) return (m.Groups[1].Value, m.Groups[2].Value);
        if (!Uri.TryCreate(s, UriKind.Absolute, out var url)) return null;
        var host = url.Host.ToLowerInvariant();
        if (host != "spotify.com" && !host.EndsWith(".spotify.com")) return null;
        return PathForm().Match(url.AbsolutePath) is { Success: true } p ? (p.Groups[1].Value, p.Groups[2].Value) : null;
    }

    static string BestImage(JsonNode? images)
    {
        var list = (images as JsonArray ?? []).OfType<JsonNode>()
            .Select(i => (Url: i.Str("url") ?? "", Width: i.Num("maxWidth") ?? i.Num("width") ?? 0))
            .OrderByDescending(i => i.Width)
            .ToList();
        if (list.Count == 0) return "";
        return list.FirstOrDefault(i => i.Width <= 300 && i.Width > 0).Url is { Length: > 0 } small ? small : list[0].Url;
    }

    /// <summary>Cards for the featured playlists. One that can't be read is left out.</summary>
    public static async Task<List<PlaylistCard>> Featured()
    {
        var cards = await Task.WhenAll(FeaturedIds.Select(Card));
        return cards.OfType<PlaylistCard>().ToList();

        static async Task<PlaylistCard?> Card(string id)
        {
            try
            {
                var (title, items, _) = await Resolve("playlist", id);
                if (items.Count == 0) return null;
                var artists = string.Join(", ", items.Select(t => t.Artist).Distinct().Take(3));
                return new PlaylistCard("spotify", id, title, artists, items[0].Art, "https://open.spotify.com/playlist/" + id);
            }
            catch (Exception e) when (e is UpstreamException or HttpRequestException or TaskCanceledException) { return null; }
        }
    }

    public static async Task<(string Title, List<Track> Items, bool Truncated)> Resolve(string kind, string id)
    {
        var html = await Net.GetText($"https://open.spotify.com/embed/{kind}/{id}");
        var e = Net.ExtractJson(html, NextData()).At("props.pageProps.state.data.entity")
                ?? throw new UpstreamException($"Couldn't read that Spotify {kind}.");

        if (kind == "track")
        {
            var artists = string.Join(", ", (e["artists"] as JsonArray ?? []).Select(a => a.Str("name")));
            var t = new Track("spotify", e.Str("id") ?? id, e.Str("name") ?? e.Str("title") ?? "", artists, BestImage(e.At("visualIdentity.image")), e.Num("duration"));
            return (t.Title, [t], false);
        }

        var art = BestImage(e.At("coverArt.sources") ?? e.At("visualIdentity.image"));
        var items = (e["trackList"] as JsonArray ?? [])
            .Where(t => t.Str("uri")?.StartsWith("spotify:track:") == true)
            .Select(t => new Track("spotify", t.Str("uri")!.Split(':')[2], t.Str("title") ?? "", t.Str("subtitle") ?? "", art, t.Num("duration")))
            .ToList();
        // The embed page lists at most ~100 tracks; the UI says so.
        return (e.Str("name") ?? e.Str("title") ?? "", items, items.Count >= 100);
    }
}
