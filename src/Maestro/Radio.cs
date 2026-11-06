using System.Text.Json;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>
/// Recommendations for autoplay: Spotify's song radio, YouTube's Mix, and SoundCloud related
/// tracks. In "both" mode the same song is looked up on the other services too, and the lists
/// are interleaved.
/// </summary>
sealed partial class Radio(SpotifyApp spotify)
{
    [GeneratedRegex(@"\s*[(\[].*?[)\]]|\b(official|music|lyrics?|video|audio|visualizer|mv|hd|4k)\b|\s+[-–|]\s+", RegexOptions.IgnoreCase)]
    private static partial Regex VideoNoise();

    static readonly string[] Sources = ["spotify", "youtube", "soundcloud"];

    public async Task<List<Track>> For(string source, string id, string title, string artist, bool both, Store.Settings settings)
    {
        var same = Native(source, id, settings);
        if (!both) return await same;

        var otherTasks = Sources.Where(s => s != source).Select(s => Like(s, title, artist, settings)).ToList();
        var a = await same;
        var rest = new List<List<Track>>();
        foreach (var task in otherTasks)
        {
            try { rest.Add(await task); }
            catch (Exception e) when (e is AppException or UpstreamException or HttpRequestException or TaskCanceledException) { rest.Add([]); }
        }
        return Interleave([a, .. rest]);
    }

    Task<List<Track>> Native(string source, string id, Store.Settings settings) => source switch
    {
        "spotify" => SpotifyRadio(id, settings),
        "youtube" => YouTube.Mix(id),
        "soundcloud" => SoundCloud.Related(id),
        _ => Task.FromResult<List<Track>>([]),
    };

    Task<List<Track>> Like(string source, string title, string artist, Store.Settings settings) => source switch
    {
        "spotify" => SpotifyLike(title, artist, settings),
        "youtube" => YouTubeLike(title, artist, settings),
        "soundcloud" => SoundCloudLike(title, artist),
        _ => Task.FromResult<List<Track>>([]),
    };

    async Task<List<Track>> SpotifyRadio(string id, Store.Settings settings)
    {
        await spotify.Ensure(settings.SpotifyExePath);
        var items = await spotify.Call("radio", "spotify:track:" + id);
        return items.Deserialize<List<Track>>(Store.Json) ?? [];
    }

    /// <summary>YouTube Mix seeded from the YouTube version of a song.</summary>
    static async Task<List<Track>> YouTubeLike(string title, string artist, Store.Settings settings)
    {
        var match = (await YouTube.Search($"{artist} {title}", settings.YoutubeApiKey)).FirstOrDefault();
        return match == null ? [] : await YouTube.Mix(match.Id);
    }

    /// <summary>Spotify radio seeded from the Spotify version of a video or SoundCloud track.</summary>
    async Task<List<Track>> SpotifyLike(string title, string artist, Store.Settings settings)
    {
        var q = Query(title, artist);
        await spotify.Ensure(settings.SpotifyExePath);
        var hits = (await spotify.Call("search", q, 1)).Deserialize<List<Track>>(Store.Json) ?? [];
        return hits.Count == 0 ? [] : await SpotifyRadio(hits[0].Id, settings);
    }

    /// <summary>SoundCloud related tracks seeded from the SoundCloud version of a song.</summary>
    static async Task<List<Track>> SoundCloudLike(string title, string artist)
    {
        var match = (await SoundCloud.Search(Query(title, artist))).FirstOrDefault();
        return match == null ? [] : await SoundCloud.Related(match.Id);
    }

    static string Query(string title, string artist)
    {
        var q = VideoNoise().Replace(title, " ").Trim();
        if (q.Length == 0) q = title.Trim();
        if (artist.Length > 0 && !q.Contains(artist, StringComparison.OrdinalIgnoreCase)) q = $"{artist} {q}";
        return q.Trim();
    }

    static List<Track> Interleave(IReadOnlyList<List<Track>> lists)
    {
        var max = 0;
        foreach (var l in lists) if (l.Count > max) max = l.Count;
        var all = new List<Track>(lists.Sum(l => l.Count));
        for (int i = 0; i < max; i++)
            foreach (var l in lists)
                if (i < l.Count) all.Add(l[i]);
        return all;
    }
}
