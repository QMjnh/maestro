using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>YouTube links, search and playlists. Works without an API key by reading YouTube's own pages.</summary>
static partial class YouTube
{
    static readonly Dictionary<string, string> ConsentCookie = new() { ["Cookie"] = "SOCS=CAI; CONSENT=YES+1" }; // skip the EU consent wall

    [GeneratedRegex(@"var ytInitialData = (\{.*?\});</script>", RegexOptions.Singleline)]
    private static partial Regex InitialData();

    [GeneratedRegex(@"^/(?:shorts|embed|live|v)/([\w-]{11})")]
    private static partial Regex VideoPath();

    [GeneratedRegex(@"^[\w-]{11}$")]
    private static partial Regex VideoId();

    [GeneratedRegex(@"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$")]
    private static partial Regex IsoDuration();

    static string Thumb(string id) => $"https://i.ytimg.com/vi/{id}/hqdefault.jpg";
    static string Clean(string artist) => artist.EndsWith(" - Topic") ? artist[..^8] : artist;

    public enum Kind { Video, Playlist }

    /// <summary>Parse any YouTube / YouTube Music URL.</summary>
    public static (Kind Kind, string Id)? ParseUrl(string input)
    {
        if (!Uri.TryCreate(input.Trim(), UriKind.Absolute, out var url)) return null;
        var host = url.Host.ToLowerInvariant();
        bool isYt = host == "youtube.com" || host.EndsWith(".youtube.com") || host == "youtu.be" || host.EndsWith(".youtu.be")
                    || host == "youtube-nocookie.com" || host.EndsWith(".youtube-nocookie.com");
        if (!isYt) return null;

        var query = System.Web.HttpUtility.ParseQueryString(url.Query);
        var list = query["list"];
        var video = query["v"];
        if (video == null && host.EndsWith("youtu.be")) video = url.AbsolutePath.TrimStart('/').Split('/')[0];
        if (video == null && VideoPath().Match(url.AbsolutePath) is { Success: true } m) video = m.Groups[1].Value;

        // A plain playlist link imports the playlist; "watch?v=..&list=.." is just the video.
        if (list != null && (video == null || url.AbsolutePath == "/playlist")) return (Kind.Playlist, list);
        if (video != null && VideoId().IsMatch(video)) return (Kind.Video, video);
        return null;
    }

    // ---- search ---------------------------------------------------------------

    public static Task<List<Track>> Search(string q, string apiKey) => apiKey.Length > 0 ? SearchApi(q, apiKey) : SearchScrape(q);

    static async Task<List<Track>> SearchScrape(string q)
    {
        var html = await Net.GetText("https://www.youtube.com/results?sp=EgIQAQ%253D%253D&search_query=" + Uri.EscapeDataString(q), ConsentCookie);
        var data = Net.ExtractJson(html, InitialData()) ?? throw new UpstreamException("Could not read YouTube search results (page format changed?)");
        return Net.FindAll(data, "videoRenderer")
            .Where(v => v.Str("videoId") != null && v["lengthText"] != null) // drop live streams
            .Take(25)
            .Select(v =>
            {
                var id = v.Str("videoId")!;
                var title = string.Concat((v.At("title.runs") as JsonArray ?? []).Select(r => r.Str("text")));
                return new Track("youtube", id, title, v.Str("ownerText.runs.0.text") ?? "", Thumb(id), Net.ClockToMs(v.Str("lengthText.simpleText")));
            })
            .ToList();
    }

    static long? IsoToMs(string? iso)
    {
        var m = IsoDuration().Match(iso ?? "");
        if (!m.Success) return null;
        int G(int i) => m.Groups[i].Success ? int.Parse(m.Groups[i].Value) : 0;
        return (G(1) * 3600L + G(2) * 60 + G(3)) * 1000;
    }

    static async Task<List<Track>> VideosApi(List<string> ids, string apiKey)
    {
        var tracks = new List<Track>();
        foreach (var chunk in ids.Chunk(50))
        {
            var data = await Net.GetJson($"https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id={string.Join(',', chunk)}&key={Uri.EscapeDataString(apiKey)}");
            foreach (var v in data["items"] as JsonArray ?? [])
            {
                var id = v.Str("id")!;
                tracks.Add(new Track("youtube", id, v.Str("snippet.title") ?? "", Clean(v.Str("snippet.channelTitle") ?? ""), Thumb(id), IsoToMs(v.Str("contentDetails.duration"))));
            }
        }
        return tracks;
    }

    static async Task<List<Track>> SearchApi(string q, string apiKey)
    {
        var data = await Net.GetJson($"https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=25&q={Uri.EscapeDataString(q)}&key={Uri.EscapeDataString(apiKey)}");
        var ids = (data["items"] as JsonArray ?? []).Select(i => i.Str("id.videoId")).OfType<string>().ToList();
        return await VideosApi(ids, apiKey);
    }

    // ---- link resolution ------------------------------------------------------

    public static async Task<Track> Video(string id, string apiKey)
    {
        if (apiKey.Length > 0 && (await VideosApi([id], apiKey)).FirstOrDefault() is { } v) return v;
        try
        {
            var o = await Net.GetJson("https://www.youtube.com/oembed?format=json&url=" + Uri.EscapeDataString("https://www.youtube.com/watch?v=" + id));
            return new Track("youtube", id, o.Str("title") ?? "", Clean(o.Str("author_name") ?? ""), Thumb(id), null);
        }
        catch (UpstreamException)
        {
            // Private / embed-disabled videos have no oEmbed; still let the user try.
            return new Track("youtube", id, $"YouTube video {id}", "", Thumb(id), null);
        }
    }

    public static async Task<(string Title, List<Track> Items)> Playlist(string id, string apiKey)
    {
        if (apiKey.Length > 0) return await PlaylistApi(id, apiKey);
        var html = await Net.GetText("https://www.youtube.com/playlist?list=" + Uri.EscapeDataString(id), ConsentCookie);
        var data = Net.ExtractJson(html, InitialData()) ?? throw new UpstreamException("Could not read that YouTube playlist (is it private?)");
        var title = data.Str("metadata.playlistMetadataRenderer.title") ?? "YouTube playlist";
        var items = new List<Track>();

        // Old layout
        foreach (var v in Net.FindAll(data, "playlistVideoRenderer"))
        {
            if (v.Str("videoId") is not { } vid) continue;
            var t = string.Concat((v.At("title.runs") as JsonArray ?? []).Select(r => r.Str("text")));
            var secs = long.TryParse(v.Str("lengthSeconds"), out var s) ? s * 1000 : (long?)null;
            items.Add(new Track("youtube", vid, t, v.Str("shortBylineText.runs.0.text") ?? "", Thumb(vid), secs));
        }
        // New "lockup" layout
        foreach (var l in Net.FindAll(data, "lockupViewModel"))
        {
            if (l.Str("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO" || l.Str("contentId") is not { } vid) continue;
            var meta = l.At("metadata.lockupMetadataViewModel");
            var badge = Net.FindAll(l["contentImage"], "thumbnailBadgeViewModel").FirstOrDefault();
            items.Add(new Track("youtube", vid, meta.Str("title.content") ?? "",
                meta.Str("metadata.contentMetadataViewModel.metadataRows.0.metadataParts.0.text.content") ?? "",
                Thumb(vid), Net.ClockToMs(badge.Str("text"))));
        }
        return (title, items);
    }

    static async Task<(string, List<Track>)> PlaylistApi(string id, string apiKey)
    {
        var key = Uri.EscapeDataString(apiKey);
        var meta = await Net.GetJson($"https://www.googleapis.com/youtube/v3/playlists?part=snippet&id={Uri.EscapeDataString(id)}&key={key}");
        var ids = new List<string>();
        string? page = null;
        do
        {
            var data = await Net.GetJson($"https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId={Uri.EscapeDataString(id)}&key={key}" + (page != null ? "&pageToken=" + page : ""));
            ids.AddRange((data["items"] as JsonArray ?? []).Select(i => i.Str("contentDetails.videoId")).OfType<string>());
            page = data.Str("nextPageToken");
        } while (page != null && ids.Count < 500);
        return (meta.Str("items.0.snippet.title") ?? "YouTube playlist", await VideosApi(ids, apiKey));
    }
}
