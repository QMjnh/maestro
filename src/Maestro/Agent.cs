using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace Maestro;

/// <summary>
/// Lets AI agents use Maestro the way a person does. The running app listens on a named pipe that only this Windows
/// user can open. Each request names a tool (AgentTools.cs), and agent.js runs it inside the UI, so the window shows
/// the change. Two front ends talk to the pipe: <c>Maestro.exe mcp</c>, an MCP server on stdio for agent apps, and
/// <c>Maestro.exe agent &lt;tool&gt; [args]</c>, which runs one tool from a shell.
/// </summary>
static class Agent
{
    // Named pipes are machine-wide; the session id keeps two signed-in users' Maestros apart.
    static readonly string PipeName = "Maestro.Agent." + Process.GetCurrentProcess().SessionId;

    static readonly JsonSerializerOptions Readable = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The app side: answers requests on the pipe by running them in the page.</summary>
    public sealed class Host(Control ui, CoreWebView2 page)
    {
        readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> pending = new();
        readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Start() => Task.Run(Listen);

        /// <summary>A message from the page: agent.js has loaded, or a tool finished.</summary>
        public void OnMessage(JsonObject msg)
        {
            if (msg["agentReady"] != null) ready.TrySetResult();
            if (msg["agentReply"] is JsonObject reply && pending.TryRemove(reply.Str("id") ?? "", out var call))
            {
                reply.Remove("id");
                call.TrySetResult(reply);
            }
        }

        async Task Listen()
        {
            while (true)
            {
                var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                try
                {
                    await pipe.WaitForConnectionAsync();
                }
                catch (IOException)
                {
                    pipe.Dispose();
                    await Task.Delay(1000);
                    continue;
                }
                _ = Serve(pipe);
            }
        }

        // One JSON request per line, answered by one JSON line, for as long as the client stays connected.
        async Task Serve(NamedPipeServerStream pipe)
        {
            await using var _ = pipe;
            using var reader = new StreamReader(pipe, new UTF8Encoding(false));
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            try
            {
                while (await reader.ReadLineAsync() is { } line)
                {
                    JsonObject reply;
                    try
                    {
                        reply = await Run(JsonNode.Parse(line) as JsonObject ?? throw new JsonException());
                    }
                    catch (JsonException)
                    {
                        reply = Failure("Bad request");
                    }
                    await writer.WriteLineAsync(reply.ToJsonString());
                }
            }
            catch (IOException) { } // the client went away
        }

        async Task<JsonObject> Run(JsonObject request)
        {
            var tool = request.Str("tool");
            if (!AgentTools.Exists(tool)) return Failure($"Unknown tool {tool}");
            try
            {
                await ready.Task.WaitAsync(TimeSpan.FromSeconds(30));
            }
            catch (TimeoutException)
            {
                return Failure("Maestro's window hasn't finished loading.");
            }
            var id = Guid.NewGuid().ToString("N");
            var call = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending[id] = call;
            var msg = new JsonObject { ["agent"] = new JsonObject { ["id"] = id, ["tool"] = tool, ["args"] = request["args"]?.DeepClone() } };
            ui.BeginInvoke(() => page.PostWebMessageAsJson(msg.ToJsonString()));
            try
            {
                return await call.Task.WaitAsync(TimeSpan.FromSeconds(90));
            }
            catch (TimeoutException)
            {
                return Failure($"{tool} took too long.");
            }
            finally
            {
                pending.TryRemove(id, out _);
            }
        }
    }

    static JsonObject Failure(string error) => new() { ["ok"] = false, ["error"] = error };

    // ---- the client side, used by `mcp` and `agent` ----

    /// <summary>Run a tool in the running Maestro, opening Maestro first if it isn't running.</summary>
    static async Task<JsonObject> Call(string tool, JsonNode? args)
    {
        try
        {
            await using var pipe = await Connect();
            using var reader = new StreamReader(pipe, new UTF8Encoding(false));
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            await writer.WriteLineAsync(new JsonObject { ["tool"] = tool, ["args"] = args?.DeepClone() }.ToJsonString());
            var line = await reader.ReadLineAsync() ?? throw new IOException("Maestro closed the connection.");
            return JsonNode.Parse(line) as JsonObject ?? Failure("Bad reply from Maestro");
        }
        catch (Exception e) when (e is IOException or TimeoutException or UnauthorizedAccessException)
        {
            return Failure(e.Message);
        }
    }

    static async Task<NamedPipeClientStream> Connect()
    {
        var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await pipe.ConnectAsync(1000);
            return pipe;
        }
        catch (TimeoutException)
        {
            // Not running: open it like the user would. Shell-started, so it doesn't hold on to our stdin/stdout.
            Process.Start(new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true })?.Dispose();
        }
        try
        {
            await pipe.ConnectAsync(30000);
            return pipe;
        }
        catch (TimeoutException)
        {
            pipe.Dispose();
            throw new TimeoutException("Couldn't reach Maestro. If an older version of Maestro is open, close it and try again.");
        }
    }

    // ---- `Maestro.exe mcp`: a Model Context Protocol server on stdin/stdout ----

    static readonly string[] ProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

    public static async Task<int> ServeMcp()
    {
        // Raw streams: this is a GUI app, so there may be no console to set an encoding on.
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        await using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        var writing = new SemaphoreSlim(1);
        var calls = new List<Task>();
        while (await input.ReadLineAsync() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            calls.Add(Task.Run(async () =>
            {
                JsonNode? reply;
                try
                {
                    reply = await HandleMcp(JsonNode.Parse(line) as JsonObject ?? throw new JsonException());
                }
                catch (JsonException)
                {
                    reply = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = null, ["error"] = new JsonObject { ["code"] = -32700, ["message"] = "Parse error" } };
                }
                if (reply == null) return;
                await writing.WaitAsync();
                try { await output.WriteLineAsync(reply.ToJsonString()); }
                finally { writing.Release(); }
            }));
        }
        await Task.WhenAll(calls);
        return 0;
    }

    static async Task<JsonNode?> HandleMcp(JsonObject msg)
    {
        if (msg["id"] is not { } id) return null; // a notification; nothing to answer
        var p = msg["params"];
        JsonObject Result(JsonNode result) => new() { ["jsonrpc"] = "2.0", ["id"] = id.DeepClone(), ["result"] = result };
        JsonObject Error(int code, string message) =>
            new() { ["jsonrpc"] = "2.0", ["id"] = id.DeepClone(), ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

        switch (msg.Str("method"))
        {
            case "initialize":
                var asked = p.Str("protocolVersion");
                return Result(new JsonObject
                {
                    ["protocolVersion"] = ProtocolVersions.Contains(asked) ? asked : ProtocolVersions[1],
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject
                    {
                        ["name"] = "maestro",
                        ["title"] = "Maestro",
                        ["version"] = typeof(Agent).Assembly.GetName().Version?.ToString(3),
                    },
                    ["instructions"] = AgentTools.Instructions,
                });

            case "ping":
                return Result(new JsonObject());

            case "tools/list":
                return Result(new JsonObject { ["tools"] = new JsonArray([.. AgentTools.All.Select(t => t.DeepClone())]) });

            case "tools/call":
                var name = p.Str("name");
                if (!AgentTools.Exists(name)) return Error(-32602, $"Unknown tool: {name}");
                var reply = await Call(name!, p?["arguments"]);
                var ok = reply["ok"]?.GetValue<bool>() == true;
                var text = ok ? reply["result"]?.ToJsonString(Readable) ?? "null" : reply.Str("error") ?? "Failed";
                return Result(new JsonObject
                {
                    ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
                    ["isError"] = !ok,
                });

            default:
                return Error(-32601, "Method not found");
        }
    }

    // ---- `Maestro.exe agent <tool> [args]`: one tool from a shell ----

    const string Usage = """
        Usage: Maestro.exe agent <tool> [key=value ...]
               Maestro.exe agent <tool> '{"key": "value"}'

        Values are read as JSON when they parse (numbers, true/false, arrays), otherwise as text:
          Maestro.exe agent search query="daft punk" source=spotify limit=5
          Maestro.exe agent set_player_options volume=40 shuffle=true
          Maestro.exe agent add_to_queue urls='["https://youtu.be/dQw4w9WgXcQ"]'

        Prints the result as JSON. Exit code 1 means the tool failed (the reason is on stderr).
        For agent apps, `Maestro.exe mcp` serves the same tools over MCP.

        Tools:
        """;

    public static async Task<int> RunCommand(string[] args)
    {
        NativeMethods.AttachToParentConsole(); // a GUI app gets no console of its own
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        var stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };

        if (args.Length == 0 || args[0] is "-h" or "--help" or "help" || !AgentTools.Exists(args[0]))
        {
            if (args.Length > 0 && args[0] is not ("-h" or "--help" or "help")) await stderr.WriteLineAsync($"Unknown tool: {args[0]}\n");
            await stdout.WriteLineAsync(Usage);
            foreach (var t in AgentTools.All)
            {
                var props = (t.At("inputSchema.properties") as JsonObject)?.Select(kv => kv.Key) ?? [];
                await stdout.WriteLineAsync($"  {t.Str("name")} {string.Join(" ", props.Select(k => k + "=")).TrimEnd()}");
                await stdout.WriteLineAsync($"      {t.Str("description")}");
            }
            return args.Length == 0 || args[0] is "-h" or "--help" or "help" ? 0 : 2;
        }

        JsonObject toolArgs;
        try
        {
            toolArgs = ParseArgs(args[1..]);
        }
        catch (FormatException e)
        {
            await stderr.WriteLineAsync(e.Message);
            return 2;
        }

        var reply = await Call(args[0], toolArgs);
        if (reply["ok"]?.GetValue<bool>() != true)
        {
            await stderr.WriteLineAsync(reply.Str("error") ?? "Failed");
            return 1;
        }
        // Non-ASCII stays \u-escaped: shells decode a program's output with all sorts of code pages.
        await stdout.WriteLineAsync(reply["result"]?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? "null");
        return 0;
    }

    static JsonObject ParseArgs(string[] args)
    {
        if (args is [var json] && json.TrimStart().StartsWith('{'))
        {
            try { return JsonNode.Parse(json) as JsonObject ?? throw new JsonException(); }
            catch (JsonException) { throw new FormatException("The arguments aren't a valid JSON object."); }
        }
        var o = new JsonObject();
        foreach (var arg in args)
        {
            var eq = arg.IndexOf('=');
            if (eq <= 0) throw new FormatException($"Expected key=value, got: {arg}");
            var value = arg[(eq + 1)..];
            try { o[arg[..eq]] = JsonNode.Parse(value); }
            catch (JsonException) { o[arg[..eq]] = value; }
        }
        return o;
    }
}
