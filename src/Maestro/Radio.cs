using System.Text.Json;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>
/// Recommendations for autoplay: Spotify's song radio and YouTube's Mix. In "both" mode the
/// same song is looked up on the other service too, and the two lists are interleaved.
/// </summary>
sealed partial class Radio(SpotifyApp spotify)
{
    [GeneratedRegex(@"\s*[(\[].*?[)\]]|\b(official|music|lyrics?|video|audio|visualizer|mv|hd|4k)\b|\s+[-–|]\s+", RegexOptions.IgnoreCase)]
    private static partial Regex VideoNoise();

    public async Task<List<Track>> For(string source, string id, string title, string artist, bool both, Store.Settings settings)
    {
        var same = source == "spotify" ? SpotifyRadio(id, settings) : YouTube.Mix(id);
        if (!both) return await same;

        var other = source == "spotify" ? YouTubeLike(title, artist, settings) : SpotifyLike(title, artist, settings);
        var a = await same;
        List<Track> b;
        try { b = await other; }
        catch (Exception e) when (e is AppException or UpstreamException or HttpRequestException or TaskCanceledException) { b = []; }
        return Interleave(a, b);
    }

    async Task<List<Track>> SpotifyRadio(string id, Store.Settings settings)
    {
        await spotify.Ensure(settings.SpotifyExePath);
        var items = await spotify.Call("radio", "spotify:track:" + id);
        return items.Deserialize<List<Track>>(Store.Json) ?? [];
    }

    /// <summary>YouTube Mix seeded from the YouTube version of a Spotify song.</summary>
    static async Task<List<Track>> YouTubeLike(string title, string artist, Store.Settings settings)
    {
        var match = (await YouTube.Search($"{artist} {title}", settings.YoutubeApiKey)).FirstOrDefault();
        return match == null ? [] : await YouTube.Mix(match.Id);
    }

    /// <summary>Spotify radio seeded from the Spotify version of a YouTube video.</summary>
    async Task<List<Track>> SpotifyLike(string title, string artist, Store.Settings settings)
    {
        var q = VideoNoise().Replace(title, " ").Trim();
        if (!q.Contains(artist, StringComparison.OrdinalIgnoreCase)) q = $"{artist} {q}";
        await spotify.Ensure(settings.SpotifyExePath);
        var hits = (await spotify.Call("search", q, 1)).Deserialize<List<Track>>(Store.Json) ?? [];
        return hits.Count == 0 ? [] : await SpotifyRadio(hits[0].Id, settings);
    }

    static List<Track> Interleave(List<Track> a, List<Track> b)
    {
        var all = new List<Track>(a.Count + b.Count);
        for (int i = 0; i < Math.Max(a.Count, b.Count); i++)
        {
            if (i < a.Count) all.Add(a[i]);
            if (i < b.Count) all.Add(b[i]);
        }
        return all;
    }
}
