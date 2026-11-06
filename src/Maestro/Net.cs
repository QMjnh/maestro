using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>An error from another website (shown to the user, returned as HTTP 502).</summary>
sealed class UpstreamException(string message, int status = 0) : Exception(message)
{
    public int Status { get; } = status;
}

static class Net
{
    const string UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

    public static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        UseCookies = false, // we send YouTube's consent cookie by hand
    })
    {
        Timeout = TimeSpan.FromSeconds(15),
    };

    public static Task<string> GetText(string url, IDictionary<string, string>? headers = null) =>
        Send(new HttpRequestMessage(HttpMethod.Get, url), headers);

    public static async Task<JsonNode> PostJson(string url, JsonNode body, IDictionary<string, string>? headers = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json") };
        return JsonNode.Parse(await Send(req, headers)) ?? throw new UpstreamException("Empty response from " + new Uri(url).Host);
    }

    static async Task<string> Send(HttpRequestMessage req, IDictionary<string, string>? headers)
    {
        using var _ = req;
        req.Headers.TryAddWithoutValidation("User-Agent", UA);
        req.Headers.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
        if (headers != null)
            foreach (var (k, v) in headers) req.Headers.TryAddWithoutValidation(k, v);
        using var res = await Client.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
            throw new UpstreamException($"{req.RequestUri!.Host} responded {(int)res.StatusCode}", (int)res.StatusCode);
        return text;
    }

    public static async Task<JsonNode> GetJson(string url, IDictionary<string, string>? headers = null) =>
        JsonNode.Parse(await GetText(url, headers)) ?? throw new UpstreamException("Empty response from " + new Uri(url).Host);

    /// <summary>Pull an embedded JSON blob (e.g. <c>var ytInitialData = {...};</c>) out of an HTML page.</summary>
    public static JsonNode? ExtractJson(string html, Regex re)
    {
        var m = re.Match(html);
        if (!m.Success) return null;
        try { return JsonNode.Parse(m.Groups[1].Value); }
        catch (JsonException) { return null; }
    }

    /// <summary>Depth-first search for every value stored under <paramref name="key"/>, in document order.</summary>
    public static List<JsonNode> FindAll(JsonNode? node, string key)
    {
        var found = new List<JsonNode>();
        Walk(node);
        return found;

        void Walk(JsonNode? n)
        {
            if (n is JsonObject obj)
            {
                foreach (var (k, v) in obj)
                {
                    if (k == key) { if (v != null) found.Add(v); }
                    else Walk(v);
                }
            }
            else if (n is JsonArray arr)
            {
                foreach (var v in arr) Walk(v);
            }
        }
    }

    /// <summary>"1:02:03" / "3:45" → milliseconds.</summary>
    public static long? ClockToMs(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        long total = 0;
        foreach (var part in s.Trim().Split(':'))
        {
            if (!long.TryParse(part, out var n)) return null;
            total = total * 60 + n;
        }
        return total * 1000;
    }

    /// <summary>String at a dotted path ("a.b.0.c"), or null.</summary>
    public static string? Str(this JsonNode? node, string path) =>
        node.At(path) is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    /// <summary>Number at a dotted path, or null.</summary>
    public static long? Num(this JsonNode? node, string path) =>
        node.At(path) is JsonValue v && v.TryGetValue<double>(out var d) ? (long)d : null;

    /// <summary>Node at a dotted path ("a.b.0.c"), or null.</summary>
    public static JsonNode? At(this JsonNode? node, string path)
    {
        var cur = node;
        foreach (var seg in path.Split('.'))
        {
            if (cur == null) return null;
            cur = int.TryParse(seg, out var i) && cur is JsonArray a ? (i < a.Count ? a[i] : null) : cur is JsonObject ? cur[seg] : null;
        }
        return cur;
    }
}
