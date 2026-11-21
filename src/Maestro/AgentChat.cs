using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>
/// The backend of the Agent panel: a chat with an AI agent that controls Maestro through its own tools (Agent.cs).
/// Agents are driven over the Agent Client Protocol (Acp.cs) through the adapters listed in the ACP registry, so
/// they run on the user's own Claude or ChatGPT sign-in and need no API keys. What the agent may do besides using
/// Maestro's tools is up to the user (AgentAccess.cs). Events stream to the page as {chat: event} messages.
/// </summary>
sealed partial class AgentChat(Action<JsonNode> post) : IDisposable
{
    /// <summary>An agent the panel offers. Package is the adapter's npm package, used when the registry can't be read.</summary>
    sealed record AgentInfo(string Id, string Name, string Package, string SignIn);

    static readonly AgentInfo[] Agents =
    [
        new("claude-acp", "Claude", "@agentclientprotocol/claude-agent-acp@0.109.1", "Open a terminal, run claude, and sign in."),
        new("codex-acp", "Codex", "@agentclientprotocol/codex-acp@2.9.0", "Open a terminal and run codex login."),
    ];

    const string Registry = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

    // An empty folder to run agents in, so no project instructions or files are picked up.
    static readonly string Workspace = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maestro", "agent");

    readonly SemaphoreSlim gate = new(1);
    Dictionary<string, string>? packages; // agent id -> npm package@version, from the registry
    AcpConnection? conn;
    AgentInfo? agent;
    JsonNode? capabilities;
    JsonArray authMethods = [];
    string? account;
    string? sessionId;
    JsonNode? configOptions;
    string? resumeError;
    bool inlineInstructions; // the agent can't take a system prompt, so the first message carries it
    volatile bool busy;

    // ---- what the page calls (through Api.cs) ----------------------------------------------------------------------

    public async Task<JsonNode> List()
    {
        var node = FindNode() != null;
        return new JsonObject
        {
            ["agents"] = new JsonArray([.. Agents.Select(a => (JsonNode)new JsonObject
            {
                ["id"] = a.Id,
                ["name"] = a.Name,
                ["available"] = node,
                ["problem"] = node ? null : "Needs Node.js (nodejs.org)",
            })]),
            ["current"] = await Snapshot(),
            ["access"] = AgentAccess.Describe(),
        };
    }

    /// <summary>Change what the agent may do. A running agent is stopped so the next connection starts it with the new
    /// settings and continues the same conversation.</summary>
    public async Task<JsonNode> SetAccess(string level, IEnumerable<string>? custom)
    {
        AgentAccess.Save(level, custom);
        await gate.WaitAsync();
        try
        {
            if (conn != null) await Stop();
        }
        finally
        {
            gate.Release();
        }
        return AgentAccess.Describe();
    }

    /// <summary>Start (or keep) a chat with an agent, resuming an earlier session when one is given.</summary>
    public async Task<JsonNode> Connect(string agentId, string? resume)
    {
        var info = Agents.FirstOrDefault(a => a.Id == agentId) ?? throw new ArgumentException("Unknown agent " + agentId);
        await gate.WaitAsync();
        try
        {
            if (conn is { Alive: true } && agent == info && sessionId != null && (resume == null || resume == sessionId))
                return await Snapshot();
            if (conn is not { Alive: true } || agent != info)
            {
                await Stop();
                await Start(info);
            }
            sessionId = null;
            resumeError = null;
            try
            {
                var resumed = resume != null && capabilities?.At("sessionCapabilities.resume") != null && await TryResume(resume);
                if (!resumed) await NewSessionLocked();
                var snap = await Snapshot();
                snap["resumed"] = resumed;
                if (resume != null && !resumed) snap["resumeError"] = resumeError ?? "This agent can't continue earlier chats.";
                return snap;
            }
            catch (AcpException e) when (e.Code == -32000)
            {
                return SignInNeeded(e.Message);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<JsonNode> NewChat()
    {
        await gate.WaitAsync();
        try
        {
            if (conn is not { Alive: true } || agent == null) throw new InvalidOperationException("No agent is running.");
            if (sessionId != null && capabilities?.At("sessionCapabilities.close") != null)
            {
                try { await conn.Request("session/close", new JsonObject { ["sessionId"] = sessionId }, TimeSpan.FromSeconds(10)); }
                catch (Exception e) when (e is AcpException or TimeoutException) { }
            }
            await NewSessionLocked();
            return await Snapshot();
        }
        catch (AcpException e) when (e.Code == -32000)
        {
            return SignInNeeded(e.Message);
        }
        finally
        {
            gate.Release();
        }
    }

    public void Prompt(string text)
    {
        var c = conn;
        var session = sessionId;
        if (c is not { Alive: true } || session == null) throw new InvalidOperationException("The agent isn't connected.");
        if (busy) throw new InvalidOperationException("The agent is still working on your last message.");
        busy = true;
        var content = inlineInstructions ? $"{AgentAccess.Instructions()}\n\n---\n\n{text}" : text;
        inlineInstructions = false;
        _ = Task.Run(async () =>
        {
            var end = new JsonObject { ["type"] = "turn_end" };
            try
            {
                var result = await c.Request("session/prompt", new JsonObject
                {
                    ["sessionId"] = session,
                    ["prompt"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = content }),
                });
                end["stopReason"] = result.Str("stopReason");
            }
            catch (Exception e)
            {
                end["error"] = e is AcpException { Code: -32000 } ? $"{agent?.Name} needs you to sign in. {agent?.SignIn}" : e.Message;
            }
            if (conn != c) return;
            busy = false;
            post(end);
        });
    }

    public async Task Cancel()
    {
        if (conn is { Alive: true } c && sessionId != null)
            await c.Notify("session/cancel", new JsonObject { ["sessionId"] = sessionId });
    }

    public async Task<JsonNode> SetOption(string configId, JsonNode? value)
    {
        if (conn is not { Alive: true } c || sessionId == null) throw new InvalidOperationException("The agent isn't connected.");
        var p = new JsonObject { ["sessionId"] = sessionId, ["configId"] = configId };
        if (value is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
        {
            p["type"] = "boolean";
            p["value"] = v.GetValue<bool>();
        }
        else p["value"] = value?.DeepClone();
        var result = await c.Request("session/set_config_option", p, TimeSpan.FromSeconds(30));
        if (result?["configOptions"] is JsonArray options) configOptions = options.DeepClone();
        return await Snapshot();
    }

    /// <summary>Sign in with one of the agent's methods. Terminal methods open a console window running the agent's login.</summary>
    public async Task<JsonNode> SignIn(string methodId)
    {
        if (conn is not { Alive: true } c || agent == null) throw new InvalidOperationException("The agent isn't running.");
        var method = authMethods.OfType<JsonObject>().FirstOrDefault(m => m.Str("id") == methodId)
            ?? throw new ArgumentException("Unknown sign-in method");
        if (method.Str("type") == "terminal")
        {
            var (file, args) = Launch(agent);
            var extra = (method["args"] as JsonArray)?.Select(a => a?.GetValue<string>() ?? "") ?? [];
            var command = string.Join(" ", new[] { file }.Concat(args).Concat(extra).Select(Quote));
            Process.Start(new ProcessStartInfo("cmd.exe", $"/k \"{command}\"") { UseShellExecute = true })?.Dispose();
            return new JsonObject { ["terminal"] = true };
        }
        await c.Request("authenticate", new JsonObject { ["methodId"] = methodId }, TimeSpan.FromMinutes(5));
        return new JsonObject { ["ok"] = true };
    }

    // ---- connection --------------------------------------------------------------------------------------------------

    async Task Start(AgentInfo info)
    {
        Directory.CreateDirectory(Workspace);
        await RefreshRegistry();
        var (file, args) = Launch(info);
        var start = new ProcessStartInfo(file) { WorkingDirectory = Workspace };
        foreach (var a in args) start.ArgumentList.Add(a);
        if (info.Id == "codex-acp") start.Environment["CODEX_CONFIG"] = AgentAccess.CodexConfig(CodexMcpServers()).ToJsonString();

        agent = info;
        account = null;
        authMethods = [];
        Status("starting", $"Starting {info.Name}…");
        var c = new AcpConnection(start);
        conn = c;
        c.Notified += (method, p) => OnNotification(c, method, p);
        c.HandleRequest = OnRequest;
        c.Exited += tail =>
        {
            if (conn != c) return;
            conn = null;
            sessionId = null;
            busy = false;
            var last = tail.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0);
            Status("stopped", $"{info.Name} stopped." + (last != null ? " " + last : ""));
        };

        try
        {
            // The first start downloads the adapter, which can take a while.
            var init = await c.Request("initialize", new JsonObject
            {
                ["protocolVersion"] = 1,
                ["clientCapabilities"] = new JsonObject
                {
                    ["fs"] = new JsonObject { ["readTextFile"] = false, ["writeTextFile"] = false },
                    ["terminal"] = false,
                },
                ["clientInfo"] = new JsonObject
                {
                    ["name"] = "maestro",
                    ["title"] = "Maestro",
                    ["version"] = typeof(AgentChat).Assembly.GetName().Version?.ToString(3),
                },
            }, TimeSpan.FromMinutes(3));
            capabilities = init?["agentCapabilities"]?.DeepClone();
            authMethods = init?["authMethods"]?.DeepClone() as JsonArray ?? [];
        }
        catch (Exception e) when (e is TimeoutException or IOException or AcpException)
        {
            await Stop();
            throw new InvalidOperationException($"Couldn't start {info.Name}: {(e is IOException ? c.StderrTail() : e.Message)}".Trim());
        }
        Status("ready", null);
    }

    /// <summary>Close the session and stop the agent. Closing matters: Codex won't let a later run resume a session
    /// that another client still holds.</summary>
    async Task Stop()
    {
        var c = conn;
        var session = sessionId;
        conn = null;
        sessionId = null;
        configOptions = null;
        busy = false;
        if (c == null) return;
        if (session != null && c.Alive && capabilities?.At("sessionCapabilities.close") != null)
        {
            try { await c.Request("session/close", new JsonObject { ["sessionId"] = session }, TimeSpan.FromSeconds(3)).ConfigureAwait(false); }
            catch (Exception e) when (e is AcpException or TimeoutException or IOException) { }
        }
        c.Dispose();
    }

    async Task NewSessionLocked()
    {
        var result = await conn!.Request("session/new", SessionParams(), TimeSpan.FromMinutes(2));
        sessionId = result.Str("sessionId") ?? throw new InvalidOperationException("The agent didn't start a session.");
        configOptions = result?["configOptions"]?.DeepClone();
        await AfterSession();
    }

    async Task<bool> TryResume(string id, bool retry = true)
    {
        var p = SessionParams();
        p["sessionId"] = id;
        try
        {
            JsonNode? result;
            try
            {
                result = await conn!.Request("session/resume", p, TimeSpan.FromMinutes(2));
            }
            catch (AcpException e) when (retry && e.Message.Contains("in use", StringComparison.OrdinalIgnoreCase))
            {
                // The run before may still be letting go of it.
                await Task.Delay(2000);
                return await TryResume(id, retry: false);
            }
            sessionId = id;
            configOptions = result?["configOptions"]?.DeepClone();
            inlineInstructions = false; // it saw them when the session began
            await AfterSession();
            return true;
        }
        catch (Exception e) when (e is AcpException or TimeoutException)
        {
            resumeError = e.Message;
            return false;
        }
    }

    JsonObject SessionParams()
    {
        var p = new JsonObject
        {
            ["cwd"] = Workspace,
            ["mcpServers"] = new JsonArray(new JsonObject
            {
                ["name"] = "maestro",
                ["command"] = Environment.ProcessPath,
                ["args"] = new JsonArray("mcp"),
                ["env"] = new JsonArray(),
            }),
        };
        if (capabilities?.At("sessionCapabilities.systemPrompt") is JsonObject sp)
        {
            p["systemPrompt"] = new JsonObject
            {
                ["mode"] = sp.At("mode.override") != null ? "override" : "append",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = AgentAccess.Instructions() }),
            };
            inlineInstructions = false;
        }
        else inlineInstructions = agent?.Id != "codex-acp"; // Codex gets them as developer_instructions (AgentAccess.CodexConfig)

        // Claude: only the tools, settings, and MCP servers the access level allows.
        if (agent?.Id == "claude-acp")
            p["_meta"] = new JsonObject { ["claudeCode"] = new JsonObject { ["options"] = AgentAccess.ClaudeOptions() } };
        return p;
    }

    /// <summary>The permission mode the access level asks for, once a session exists.</summary>
    async Task AfterSession()
    {
        var wanted = agent?.Id == "codex-acp" ? AgentAccess.CodexMode() : AgentAccess.ClaudeMode();
        if (wanted == null || Option("mode") is not JsonObject mode || mode.Str("currentValue") == wanted) return;
        try { await SetOption("mode", wanted); }
        catch (Exception e) when (e is AcpException or TimeoutException) { }
    }

    JsonNode? Option(string id) => (configOptions as JsonArray)?.OfType<JsonObject>().FirstOrDefault(o => o.Str("id") == id);

    /// <summary>The MCP servers in the user's Codex config, so they can be turned off for Maestro's sessions.</summary>
    static IEnumerable<string> CodexMcpServers()
    {
        var home = Environment.GetEnvironmentVariable("CODEX_HOME") is { Length: > 0 } h
            ? h
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        try
        {
            return McpServerTable().Matches(File.ReadAllText(Path.Combine(home, "config.toml"))).Select(m => m.Groups[1].Value.Trim('"', '\'')).Distinct().ToList();
        }
        catch (IOException) { return []; }
        catch (UnauthorizedAccessException) { return []; }
    }

    [GeneratedRegex(@"^\s*\[mcp_servers\.(""[^""]+""|'[^']+'|[A-Za-z0-9_-]+)\]", RegexOptions.Multiline)]
    private static partial Regex McpServerTable();

    // ---- launching adapters ----------------------------------------------------------------------------------------

    /// <summary>The command that runs an agent's adapter: npx, through Node.js.</summary>
    (string File, string[] Args) Launch(AgentInfo info)
    {
        var package = Package(info);
        var node = FindNode() ?? throw new InvalidOperationException($"{info.Name} needs Node.js. Install it from nodejs.org, then try again.");
        return node.Cli != null
            ? (node.Exe, [node.Cli, "-y", "--prefer-offline", package])
            : ("cmd.exe", ["/d", "/c", node.Exe, "-y", "--prefer-offline", package]);
    }

    string Package(AgentInfo info) => packages != null && packages.TryGetValue(info.Id, out var p) ? p : info.Package;

    /// <summary>Node.js on PATH: node.exe with npm's npx script beside it, or else an npx.cmd to run through cmd.</summary>
    static (string Exe, string? Cli)? FindNode()
    {
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Append(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        string? npxCmd = null;
        foreach (var dir in dirs)
        {
            var node = Path.Combine(dir, "node.exe");
            var cli = Path.Combine(dir, "node_modules", "npm", "bin", "npx-cli.js");
            if (File.Exists(node) && File.Exists(cli)) return (node, cli);
            if (npxCmd == null && File.Exists(Path.Combine(dir, "npx.cmd"))) npxCmd = Path.Combine(dir, "npx.cmd");
        }
        return npxCmd != null ? (npxCmd, null) : null;
    }

    /// <summary>Use the newest adapter versions from the ACP registry (read once per run).</summary>
    public async Task RefreshRegistry()
    {
        if (packages != null) return;
        try
        {
            var registry = await Net.GetJson(Registry);
            var found = new Dictionary<string, string>();
            foreach (var a in registry["agents"] as JsonArray ?? [])
                if (a.Str("id") is { } id && a.Str("distribution.npx.package") is { } pkg && Agents.Any(x => x.Id == id))
                    found[id] = pkg;
            packages = found;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or UpstreamException or JsonException)
        {
            packages = []; // offline: the versions built in
        }
    }

    static string Quote(string s) => s.Contains(' ') || s.Contains('"') ? "\"" + s.Replace("\"", "\\\"") + "\"" : s;

    // ---- messages from the agent -----------------------------------------------------------------------------------

    void OnNotification(AcpConnection c, string method, JsonNode? p)
    {
        if (conn != c) return;
        if (method is "auth/status_update" && p?["accounts"] is JsonArray accounts)
        {
            account = accounts.OfType<JsonObject>().FirstOrDefault(a => a["active"]?.GetValue<bool>() == true)?.Str("label");
            post(new JsonObject { ["type"] = "account", ["account"] = account });
            return;
        }
        if (method != "session/update" || p.Str("sessionId") != sessionId || p?["update"] is not JsonObject update) return;
        switch (update.Str("sessionUpdate"))
        {
            case "config_option_update":
                if (update["configOptions"] is JsonArray options) configOptions = options.DeepClone();
                post(new JsonObject { ["type"] = "options", ["configOptions"] = configOptions?.DeepClone() });
                break;
            case "agent_message_chunk" or "agent_thought_chunk" or "plan" or "notice":
                post(new JsonObject { ["type"] = "update", ["update"] = update.DeepClone() });
                break;
            case "tool_call" or "tool_call_update":
                post(new JsonObject { ["type"] = "update", ["update"] = ToolCall(update) });
                break;
        }
    }

    /// <summary>A tool call, without its (large) output unless it failed.</summary>
    static JsonObject ToolCall(JsonObject u)
    {
        var o = new JsonObject
        {
            ["sessionUpdate"] = u.Str("sessionUpdate"),
            ["toolCallId"] = u.Str("toolCallId"),
            ["name"] = u.Str("name") ?? u.Str("_meta.claudeCode.toolName"),
            ["title"] = u.Str("title"),
            ["status"] = u.Str("status"),
            ["rawInput"] = u["rawInput"]?.DeepClone(),
        };
        if (u.Str("status") == "failed")
            o["error"] = (u["content"] as JsonArray)?.Select(c => c.Str("content.text") ?? c.Str("text")).FirstOrDefault(t => t != null) ?? u["rawOutput"]?.ToJsonString();
        return o;
    }

    /// <summary>Requests from the agent: only permission prompts are expected, answered by the access level.</summary>
    Task<JsonNode?> OnRequest(string method, JsonNode? p)
    {
        if (method != "session/request_permission") throw new AcpException(-32601, "Maestro doesn't offer " + method);
        var allow = AgentAccess.Approves(p?["toolCall"]);
        var options = (p?["options"] as JsonArray)?.OfType<JsonObject>().ToList() ?? [];
        var pick = allow
            ? options.FirstOrDefault(o => o.Str("kind") == "allow_once") ?? options.FirstOrDefault(o => o.Str("kind") == "allow_always")
            : options.FirstOrDefault(o => o.Str("kind") == "reject_once") ?? options.FirstOrDefault(o => o.Str("kind") == "reject_always");
        JsonNode outcome = pick != null
            ? new JsonObject { ["outcome"] = "selected", ["optionId"] = pick.Str("optionId") }
            : new JsonObject { ["outcome"] = "cancelled" };
        return Task.FromResult<JsonNode?>(new JsonObject { ["outcome"] = outcome });
    }

    // ---- state for the page ----------------------------------------------------------------------------------------

    async Task<JsonObject> Snapshot()
    {
        await RefreshRegistry();
        return new JsonObject
        {
            ["agent"] = agent?.Id,
            ["agentName"] = agent?.Name,
            ["connected"] = conn is { Alive: true } && sessionId != null,
            ["sessionId"] = sessionId,
            ["account"] = account,
            ["busy"] = busy,
            ["configOptions"] = configOptions?.DeepClone(),
        };
    }

    JsonObject SignInNeeded(string message) => new()
    {
        ["agent"] = agent?.Id,
        ["agentName"] = agent?.Name,
        ["signIn"] = new JsonObject
        {
            ["message"] = $"{agent?.Name} needs you to sign in. {agent?.SignIn}",
            ["detail"] = message,
            ["methods"] = new JsonArray([.. authMethods.OfType<JsonObject>().Select(m => (JsonNode)new JsonObject
            {
                ["id"] = m.Str("id"),
                ["name"] = m.Str("name"),
                ["description"] = m.Str("description"),
            })]),
        },
    };

    void Status(string state, string? message) => post(new JsonObject { ["type"] = "status", ["state"] = state, ["message"] = message });

    public void Dispose() => Stop().Wait(TimeSpan.FromSeconds(4));
}
