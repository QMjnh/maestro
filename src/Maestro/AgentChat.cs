using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Maestro;

/// <summary>
/// The backend of the Agent panel: a chat with an AI agent that controls Maestro through its own tools (Agent.cs).
/// Agents are driven over the Agent Client Protocol (Acp.cs) through the official ACP registry (Claude, Codex,
/// Cursor, Antigravity, OpenCode, Gemini CLI, GitHub Copilot, and any other Windows-compatible registry agent).
/// Nothing is downloaded automatically: uninstalled agents prompt the user to install explicitly. What the agent
/// may do besides Maestro's tools is up to the user (AgentAccess.cs). Events stream as {chat: event} messages.
/// </summary>
sealed partial class AgentChat(Action<JsonNode> post) : IDisposable
{
    sealed record BinaryDist(string Archive, string Cmd, string[] Args, Dictionary<string, string> Env, string? Sha256);
    sealed record NpxDist(string Package, string[] Args, Dictionary<string, string> Env);
    sealed record AgentInfo(
        string Id,
        string Name,
        string Version,
        string Description,
        string SignIn,
        bool Featured,
        BinaryDist? Binary,
        NpxDist? Npx,
        string[]? LoginArgs = null,
        string[]? PathCommands = null,
        string[]? NativeCli = null);

    // Built-in featured agents (with offline fallback distributions). RefreshRegistry() updates them from the live
    // ACP registry and appends all other Windows-compatible registry agents.
    static readonly AgentInfo[] BuiltIn =
    [
        new("claude-acp", "Claude", "0.109.1", "Anthropic's Claude coding agent",
            "Open a terminal, run claude, and sign in.", true, null,
            new("@agentclientprotocol/claude-agent-acp@0.109.1", [], []),
            null, ["claude-agent-acp.cmd", "claude-agent-acp.exe"], ["claude.exe", "claude.cmd"]),
        new("codex-acp", "Codex", "2.9.0", "OpenAI's Codex coding agent",
            "Open a terminal and run codex login.", true, null,
            new("@agentclientprotocol/codex-acp@2.9.0", [], []),
            null, ["codex-acp.cmd", "codex-acp.exe"], ["codex.exe", "codex.cmd"]),
        new("cursor", "Cursor", "2026.11.19", "Cursor's coding agent",
            "Sign in with Cursor Login, or open a terminal to sign in.", true,
            new("https://downloads.cursor.com/lab/2026.11.19-f005e9d/windows/x64/agent-cli-package.zip",
                @"./dist-package\cursor-agent.cmd", ["acp"], [], null), null,
            ["login"], ["cursor-agent.cmd", "cursor-agent.exe"], ["cursor.cmd", "cursor.exe"]),
        new("antigravity-acp", "Antigravity", "1.5.2", "Google Antigravity coding agent",
            "Sign in to Google Antigravity.", true,
            new("https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-x86_64.zip",
                "./agy_acp_server.exe", [], [], "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6"), null,
            null, ["agy_acp_server.exe"]),
        new("opencode", "OpenCode", "2.3.2", "The open source coding agent",
            "Open a terminal and run opencode auth login.", true,
            new("https://github.com/anomalyco/opencode/releases/download/v2.3.2/opencode-windows-x64.zip",
                "./opencode.exe", ["acp"], [], "8ad59f1992a0594d8bd72b5ed3be1f5bfffcd9d1756853eec7e5d3141c25be1f"), null,
            ["auth", "login"], ["opencode.exe", "opencode.cmd"]),
        new("gemini", "Gemini CLI", "0.70.0", "Google's official CLI for Gemini",
            "Open a terminal and run gemini to sign in.", true, null,
            new("@google/gemini-cli@0.70.0", ["--acp"], []), []),
        new("github-copilot-cli", "GitHub Copilot", "1.0.114", "GitHub's AI pair programmer",
            "Open a terminal and run copilot to sign in with GitHub.", true, null,
            new("@github/copilot@1.0.114", ["--acp"], []), ["login"]),
    ];

    const string Registry = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

    // An empty folder to run agents in, so no project instructions or files are picked up.
    static readonly string Workspace = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maestro", "agent");
    // Installed adapters (binary or npm), cached by agent id and version.
    static readonly string AgentCache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maestro", "agents");

    readonly SemaphoreSlim gate = new(1);
    readonly SemaphoreSlim registryGate = new(1);
    List<AgentInfo>? catalog;
    AcpConnection? conn;
    AgentInfo? agent;
    JsonNode? capabilities;
    JsonArray authMethods = [];
    string? account;
    string? sessionId;
    JsonArray? configOptions;
    string? resumeError;
    bool inlineInstructions; // the agent can't take a system prompt, so the first message carries it
    volatile bool busy;

    // ---- what the page calls (through Api.cs) ----------------------------------------------------------------------

    public async Task<JsonNode> List()
    {
        await RefreshRegistry();
        var node = FindNode() != null;
        return new JsonObject
        {
            ["agents"] = new JsonArray([.. Catalog().Select(a =>
            {
                var installed = FindInstalled(a) != null;
                var needsNode = a.Binary == null;
                var available = installed || !needsNode || node;
                return (JsonNode)new JsonObject
                {
                    ["id"] = a.Id,
                    ["name"] = a.Name,
                    ["description"] = a.Description,
                    ["featured"] = a.Featured,
                    ["installed"] = installed,
                    ["available"] = available,
                    ["problem"] = available ? null : "Needs Node.js (nodejs.org)",
                    ["distribution"] = a.Binary != null ? "binary" : "npx",
                };
            })]),
            ["current"] = Snapshot(),
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

    /// <summary>Explicitly install an agent's binary or npm package into Maestro's local cache.</summary>
    public async Task<JsonNode> Install(string agentId)
    {
        await RefreshRegistry();
        var info = Catalog().FirstOrDefault(a => a.Id == agentId) ?? throw new ArgumentException("Unknown agent " + agentId);
        await gate.WaitAsync();
        try
        {
            if (info.Binary is { } bin)
                await InstallBinary(info, bin);
            else if (info.Npx is { } npx)
                await InstallNpm(info, npx);
            else
                throw new InvalidOperationException($"{info.Name} has no Windows package in the ACP registry.");
            return new JsonObject { ["ok"] = true, ["id"] = info.Id, ["installed"] = true };
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>Start (or keep) a chat with an agent, resuming an earlier session when one is given.
    /// Never downloads automatically: returns <c>needsInstall</c> when the agent isn't installed yet.</summary>
    public async Task<JsonNode> Connect(string agentId, string? resume)
    {
        // Featured agents start from the built-in definitions; only other registry agents wait for the registry.
        var info = Catalog().FirstOrDefault(a => a.Id == agentId);
        if (info == null)
        {
            await RefreshRegistry();
            info = Catalog().FirstOrDefault(a => a.Id == agentId) ?? throw new ArgumentException("Unknown agent " + agentId);
        }
        await gate.WaitAsync();
        try
        {
            // By id: the registry may have refreshed the definition since this agent started.
            if (conn is { Alive: true } && agent?.Id == info.Id && sessionId != null && (resume == null || resume == sessionId))
                return Snapshot();

            var installed = FindInstalled(info);
            if (installed == null)
            {
                await Stop();
                agent = info;
                return InstallNeeded(info);
            }

            if (conn is not { Alive: true } || agent?.Id != info.Id)
            {
                await Stop();
                await Start(info, installed);
            }
            sessionId = null;
            resumeError = null;
            try
            {
                var resumed = false;
                if (resume != null)
                {
                    if (capabilities?.At("sessionCapabilities.resume") != null)
                        resumed = await TryResume(resume, "session/resume");
                    else if (capabilities?["loadSession"] is JsonValue lv && lv.TryGetValue<bool>(out var canLoad) && canLoad)
                        resumed = await TryResume(resume, "session/load");
                }
                if (!resumed) await NewSessionLocked();
                var snap = Snapshot();
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
            return Snapshot();
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

    public void Prompt(string text, string? handoff = null)
    {
        var c = conn;
        var session = sessionId;
        if (c is not { Alive: true } || session == null) throw new InvalidOperationException("The agent isn't connected.");
        if (busy) throw new InvalidOperationException("The agent is still working on your last message.");
        busy = true;
        var body = string.IsNullOrWhiteSpace(handoff)
            ? text
            : $"[Conversation handoff from previous agent — continue seamlessly from here]\n{handoff.Trim()}\n[End of previous conversation]\n\n{text}";
        var content = inlineInstructions ? $"{AgentAccess.Instructions()}\n\n---\n\n{body}" : body;
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
        if (configId == "__legacy_model")
        {
            await c.Request("session/set_model", new JsonObject { ["sessionId"] = sessionId, ["modelId"] = value?.DeepClone() }, TimeSpan.FromSeconds(30));
            UpdateOptionValue(configId, value);
            return Snapshot();
        }
        if (configId == "__legacy_mode")
        {
            await c.Request("session/set_mode", new JsonObject { ["sessionId"] = sessionId, ["modeId"] = value?.DeepClone() }, TimeSpan.FromSeconds(30));
            UpdateOptionValue(configId, value);
            return Snapshot();
        }
        var p = new JsonObject { ["sessionId"] = sessionId, ["configId"] = configId };
        if (value is JsonValue v && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False)
        {
            p["type"] = "boolean";
            p["value"] = v.GetValue<bool>();
        }
        else p["value"] = value?.DeepClone();
        var result = await c.Request("session/set_config_option", p, TimeSpan.FromSeconds(30));
        if (result?["configOptions"] is JsonArray options) configOptions = options.DeepClone() as JsonArray;
        return Snapshot();
    }

    /// <summary>Sign in with one of the agent's methods. Terminal methods open a console window running the agent's login.</summary>
    public async Task<JsonNode> SignIn(string methodId)
    {
        if (conn is not { Alive: true } c || agent == null) throw new InvalidOperationException("The agent isn't running.");
        var installed = FindInstalled(agent) ?? throw new InvalidOperationException($"{agent.Name} isn't installed.");
        if (methodId == "__terminal_login" && agent.LoginArgs != null)
        {
            var command = BuildTerminalCommand(installed, agent.LoginArgs);
            Process.Start(new ProcessStartInfo("cmd.exe", $"/k \"{command}\"") { UseShellExecute = true })?.Dispose();
            return new JsonObject { ["terminal"] = true };
        }
        var method = authMethods.OfType<JsonObject>().FirstOrDefault(m => m.Str("id") == methodId)
            ?? throw new ArgumentException("Unknown sign-in method");
        if (method.Str("type") == "terminal")
        {
            var extra = (method["args"] as JsonArray)?.Select(a => a?.GetValue<string>() ?? "").ToArray();
            var command = BuildTerminalCommand(installed, extra is { Length: > 0 } ? extra : null);
            Process.Start(new ProcessStartInfo("cmd.exe", $"/k \"{command}\"") { UseShellExecute = true })?.Dispose();
            return new JsonObject { ["terminal"] = true };
        }
        await c.Request("authenticate", new JsonObject { ["methodId"] = methodId }, TimeSpan.FromMinutes(5));
        return new JsonObject { ["ok"] = true };
    }

    // ---- connection --------------------------------------------------------------------------------------------------

    async Task Start(AgentInfo info, InstalledLaunch installed)
    {
        Directory.CreateDirectory(Workspace);
        var start = CreateStartInfo(installed);
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
            }, TimeSpan.FromMinutes(2));
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
        configOptions = ExtractConfigOptions(result);
        await AfterSession();
    }

    async Task<bool> TryResume(string id, string method, bool retry = true)
    {
        var p = SessionParams();
        p["sessionId"] = id;
        try
        {
            JsonNode? result;
            try
            {
                result = await conn!.Request(method, p, TimeSpan.FromMinutes(2));
            }
            catch (AcpException e) when (retry && e.Message.Contains("in use", StringComparison.OrdinalIgnoreCase))
            {
                // The run before may still be letting go of it.
                await Task.Delay(2000);
                return await TryResume(id, method, retry: false);
            }
            sessionId = id;
            configOptions = ExtractConfigOptions(result);
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
        var wanted = agent?.Id switch
        {
            "codex-acp" => AgentAccess.CodexMode(),
            "claude-acp" => AgentAccess.ClaudeMode(),
            _ => null,
        };
        if (wanted == null) return;
        var mode = Option("mode");
        if (mode == null || mode.Str("currentValue") == wanted) return;
        try { await SetOption(mode.Str("id") ?? "mode", wanted); }
        catch (Exception e) when (e is AcpException or TimeoutException) { }
    }

    JsonObject? Option(string categoryOrId) =>
        configOptions?.OfType<JsonObject>().FirstOrDefault(o => o.Str("category") == categoryOrId || o.Str("id") == categoryOrId);

    /// <summary>Normalize ACP configOptions, synthesizing standard options for agents that still return legacy
    /// <c>models</c> or <c>modes</c> fields on session creation.</summary>
    static JsonArray ExtractConfigOptions(JsonNode? sessionResult)
    {
        var list = sessionResult?["configOptions"]?.DeepClone() as JsonArray ?? [];
        var hasModel = list.OfType<JsonObject>().Any(o => o.Str("category") == "model" || o.Str("id") == "model");
        if (!hasModel && sessionResult?["models"] is JsonObject models && models["availableModels"] is JsonArray availModels && availModels.Count > 0)
        {
            list.Add(new JsonObject
            {
                ["id"] = "__legacy_model",
                ["category"] = "model",
                ["name"] = "Model",
                ["type"] = "select",
                ["currentValue"] = models.Str("currentModelId"),
                ["options"] = new JsonArray([.. availModels.OfType<JsonObject>().Select(m => (JsonNode)new JsonObject
                {
                    ["value"] = m.Str("modelId") ?? m.Str("id") ?? "",
                    ["name"] = m.Str("name") ?? m.Str("modelId") ?? "",
                    ["description"] = m.Str("description"),
                })]),
            });
        }
        var hasMode = list.OfType<JsonObject>().Any(o => o.Str("category") == "mode" || o.Str("id") == "mode");
        if (!hasMode && sessionResult?["modes"] is JsonObject modes && modes["availableModes"] is JsonArray availModes && availModes.Count > 0)
        {
            list.Add(new JsonObject
            {
                ["id"] = "__legacy_mode",
                ["category"] = "mode",
                ["name"] = "Mode",
                ["type"] = "select",
                ["currentValue"] = modes.Str("currentModeId"),
                ["options"] = new JsonArray([.. availModes.OfType<JsonObject>().Select(m => (JsonNode)new JsonObject
                {
                    ["value"] = m.Str("id") ?? "",
                    ["name"] = m.Str("name") ?? m.Str("id") ?? "",
                    ["description"] = m.Str("description"),
                })]),
            });
        }
        return list;
    }

    void UpdateOptionValue(string id, JsonNode? value)
    {
        if (configOptions?.OfType<JsonObject>().FirstOrDefault(o => o.Str("id") == id) is { } opt)
            opt["currentValue"] = value?.DeepClone();
    }

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

    // ---- local install detection & explicit installation -----------------------------------------------------------

    sealed record InstalledLaunch(string File, string[] PrefixArgs, string[] Args, Dictionary<string, string> Env);

    /// <summary>Locate an already-installed adapter (Maestro's local cache, npm's _npx cache, global npm
    /// packages, or a known native ACP CLI on PATH). Returns null if not installed — never downloads.</summary>
    static InstalledLaunch? FindInstalled(AgentInfo info)
    {
        // 1. Maestro's own cache (%LOCALAPPDATA%\Maestro\agents\<id>\<version>).
        var agentDir = Path.Combine(AgentCache, SafeSegment(info.Id));
        if (Directory.Exists(agentDir))
        {
            var candidates = new List<string>();
            var exact = Path.Combine(agentDir, SafeSegment(info.Version));
            if (Directory.Exists(exact)) candidates.Add(exact);
            foreach (var d in Directory.GetDirectories(agentDir).OrderByDescending(Directory.GetLastWriteTimeUtc))
                if (!Path.GetFullPath(d).Equals(Path.GetFullPath(exact), StringComparison.OrdinalIgnoreCase))
                    candidates.Add(d);

            foreach (var dir in candidates)
            {
                if (!File.Exists(Path.Combine(dir, ".ready"))) continue;
                if (info.Binary is { } bin && ResolveBinaryPath(dir, bin.Cmd) is { } binExe)
                    return new InstalledLaunch(binExe, [], bin.Args, bin.Env);
                if (info.Npx is { } npx && ResolveNpmLaunch(dir, npx) is { } npmLaunch)
                    return npmLaunch;
            }
        }

        // 2. Existing npm installs (npx cache and global node_modules), preferring the newest matching package version.
        if (info.Npx is { } npmDist)
        {
            var best = FindExistingNpmPackage(npmDist);
            if (best != null) return best;
        }

        // 3. Native ACP CLIs already installed by the user on PATH (e.g. opencode, cursor-agent, claude-agent-acp).
        if (info.PathCommands is { Length: > 0 })
        {
            var args = info.Binary?.Args ?? info.Npx?.Args ?? [];
            var env = info.Binary?.Env ?? info.Npx?.Env ?? [];
            foreach (var cmd in info.PathCommands)
            {
                if (FindOnPath(cmd) is { } found)
                    return new InstalledLaunch(found, [], args, env);
            }
        }
        return null;
    }

    /// <summary>Search npm's _npx cache and global node_modules for an already-installed copy of the package,
    /// without invoking npm or downloading anything.</summary>
    static InstalledLaunch? FindExistingNpmPackage(NpxDist npx)
    {
        var pkgName = PackageName(npx.Package);
        var pkgRel = pkgName.Replace('/', Path.DirectorySeparatorChar);
        var roots = new List<string>();

        // _npx cache directories (each hashed subdirectory has its own node_modules/).
        foreach (var cacheDir in NpmCacheDirs())
        {
            var npxDir = Path.Combine(cacheDir, "_npx");
            if (!Directory.Exists(npxDir)) continue;
            try
            {
                foreach (var hashDir in Directory.GetDirectories(npxDir))
                    roots.Add(hashDir);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        // Global npm prefix directories (prefix/node_modules/<pkg>).
        foreach (var prefix in NpmPrefixDirs())
            roots.Add(prefix);

        InstalledLaunch? best = null;
        Version? bestVer = null;
        foreach (var root in roots)
        {
            var pkgJson = Path.Combine(root, "node_modules", pkgRel, "package.json");
            if (!File.Exists(pkgJson)) continue;
            var launch = ResolveNpmLaunch(root, npx);
            if (launch == null) continue;
            var ver = ReadPackageVersion(pkgJson);
            if (best == null || (ver != null && (bestVer == null || ver > bestVer)))
            {
                best = launch;
                bestVer = ver;
            }
        }
        return best;
    }

    static Version? ReadPackageVersion(string pkgJsonPath)
    {
        try
        {
            var s = JsonNode.Parse(File.ReadAllText(pkgJsonPath)).Str("version");
            if (string.IsNullOrEmpty(s)) return null;
            var core = s.Split('-', '+')[0];
            return Version.TryParse(core, out var v) ? v : null;
        }
        catch (Exception e) when (e is IOException or JsonException) { return null; }
    }

    static IEnumerable<string> NpmCacheDirs()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var candidates = new[]
        {
            Environment.GetEnvironmentVariable("NPM_CONFIG_CACHE"),
            Environment.GetEnvironmentVariable("npm_config_cache"),
            ReadNpmrc("cache"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm-cache"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm-cache"),
        };
        foreach (var c in candidates)
            if (!string.IsNullOrWhiteSpace(c) && Directory.Exists(c) && seen.Add(Path.GetFullPath(c)))
                yield return c;
    }

    static IEnumerable<string> NpmPrefixDirs()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var candidates = new List<string?>
        {
            Environment.GetEnvironmentVariable("NPM_CONFIG_PREFIX"),
            Environment.GetEnvironmentVariable("npm_config_prefix"),
            ReadNpmrc("prefix"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"),
        };
        if (FindOnPath("npm.cmd") is { } npmCmd) candidates.Add(Path.GetDirectoryName(npmCmd));
        foreach (var c in candidates)
            if (!string.IsNullOrWhiteSpace(c) && Directory.Exists(Path.Combine(c, "node_modules")) && seen.Add(Path.GetFullPath(c)))
                yield return c;
    }

    static string? ReadNpmrc(string key)
    {
        var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".npmrc");
        try
        {
            if (!File.Exists(path)) return null;
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] is '#' or ';') continue;
                var eq = line.IndexOf('=');
                if (eq <= 0) continue;
                if (!line[..eq].Trim().Equals(key, StringComparison.OrdinalIgnoreCase)) continue;
                return line[(eq + 1)..].Trim().Trim('"', '\'');
            }
        }
        catch (IOException) { }
        return null;
    }

    static ProcessStartInfo CreateStartInfo(InstalledLaunch launch)
    {
        var allArgs = launch.PrefixArgs.Concat(launch.Args).ToArray();
        ProcessStartInfo start;
        if (launch.File.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || launch.File.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
        {
            var cmdLine = string.Join(" ", new[] { launch.File }.Concat(allArgs).Select(Quote));
            start = new ProcessStartInfo("cmd.exe", $"/d /s /c \"{cmdLine}\"") { WorkingDirectory = Workspace };
        }
        else
        {
            start = new ProcessStartInfo(launch.File) { WorkingDirectory = Workspace };
            foreach (var a in allArgs) start.ArgumentList.Add(a);
        }
        foreach (var (k, v) in launch.Env) start.Environment[k] = v;
        return start;
    }

    static string BuildTerminalCommand(InstalledLaunch launch, string[]? overrideArgs)
    {
        var args = overrideArgs ?? launch.Args;
        return string.Join(" ", new[] { launch.File }.Concat(launch.PrefixArgs).Concat(args).Select(Quote));
    }

    async Task InstallBinary(AgentInfo info, BinaryDist bin)
    {
        var agentDir = Path.Combine(AgentCache, SafeSegment(info.Id));
        var dir = Path.Combine(agentDir, SafeSegment(info.Version));
        if (File.Exists(Path.Combine(dir, ".ready")) && ResolveBinaryPath(dir, bin.Cmd) != null) return;

        Status("installing", $"Downloading {info.Name}…");
        Directory.CreateDirectory(agentDir);
        var tmpArchive = Path.Combine(agentDir, $"download-{Guid.NewGuid():N}");
        var tmpDir = Path.Combine(agentDir, $"extract-{Guid.NewGuid():N}");
        try
        {
            await Net.DownloadFile(bin.Archive, tmpArchive);
            if (!string.IsNullOrEmpty(bin.Sha256))
            {
                await using var fs = File.OpenRead(tmpArchive);
                var hash = Convert.ToHexString(await SHA256.HashDataAsync(fs));
                if (!hash.Equals(bin.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Download verification failed for {info.Name}.");
            }

            Directory.CreateDirectory(tmpDir);
            var urlPath = new Uri(bin.Archive).AbsolutePath;
            if (urlPath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                ZipFile.ExtractToDirectory(tmpArchive, tmpDir, overwriteFiles: true);
            }
            else if (urlPath.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase) || urlPath.EndsWith(".tgz", StringComparison.OrdinalIgnoreCase))
            {
                await using var fs = File.OpenRead(tmpArchive);
                await using var gz = new GZipStream(fs, CompressionMode.Decompress);
                await TarFile.ExtractToDirectoryAsync(gz, tmpDir, overwriteFiles: true);
            }
            else
            {
                var rel = CleanRelPath(bin.Cmd);
                var dest = Path.GetFullPath(Path.Combine(tmpDir, rel));
                if (!dest.StartsWith(Path.GetFullPath(tmpDir) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Invalid binary path for {info.Name}.");
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Move(tmpArchive, dest, overwrite: true);
            }

            if (ResolveBinaryPath(tmpDir, bin.Cmd) == null)
                throw new InvalidOperationException($"Couldn't find {Path.GetFileName(bin.Cmd)} inside {info.Name}'s download.");

            CommitCacheDir(agentDir, tmpDir, dir, info.Version);
        }
        finally
        {
            try { if (File.Exists(tmpArchive)) File.Delete(tmpArchive); } catch (IOException) { }
            try { if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, recursive: true); } catch (IOException) { }
        }
    }

    async Task InstallNpm(AgentInfo info, NpxDist npx)
    {
        var node = FindNode() ?? throw new InvalidOperationException($"{info.Name} needs Node.js. Install it from nodejs.org, then try again.");
        var agentDir = Path.Combine(AgentCache, SafeSegment(info.Id));
        var dir = Path.Combine(agentDir, SafeSegment(info.Version));
        if (File.Exists(Path.Combine(dir, ".ready")) && ResolveNpmLaunch(dir, npx) != null) return;

        Status("installing", $"Installing {info.Name}…");
        Directory.CreateDirectory(agentDir);
        var tmpDir = Path.Combine(agentDir, $"npm-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tmpDir);
        try
        {
            string[] npmArgs = ["install", "--prefix", tmpDir, "--no-audit", "--no-fund", "--loglevel=error", npx.Package];
            ProcessStartInfo start;
            if (node.NpmCli != null)
            {
                start = new ProcessStartInfo(node.NodeExe) { WorkingDirectory = tmpDir };
                start.ArgumentList.Add(node.NpmCli);
                foreach (var a in npmArgs) start.ArgumentList.Add(a);
            }
            else if (node.NpmCmd != null)
            {
                var cmdLine = string.Join(" ", new[] { node.NpmCmd }.Concat(npmArgs).Select(Quote));
                start = new ProcessStartInfo("cmd.exe", $"/d /s /c \"{cmdLine}\"") { WorkingDirectory = tmpDir };
            }
            else
            {
                throw new InvalidOperationException("Couldn't find npm next to Node.js.");
            }
            start.RedirectStandardOutput = start.RedirectStandardError = true;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;

            using var proc = Process.Start(start) ?? throw new InvalidOperationException("Couldn't start npm.");
            var stderrTask = proc.StandardError.ReadToEndAsync();
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(4));
            try { await proc.WaitForExitAsync(cts.Token); }
            catch (OperationCanceledException)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                throw new InvalidOperationException($"Timed out installing {info.Name}.");
            }
            var stderr = (await stderrTask).Trim();
            _ = await stdoutTask;
            if (proc.ExitCode != 0)
            {
                var lastLine = stderr.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0);
                throw new InvalidOperationException($"Couldn't install {info.Name}: {lastLine ?? $"npm exited with code {proc.ExitCode}"}");
            }

            if (ResolveNpmLaunch(tmpDir, npx) == null)
                throw new InvalidOperationException($"Installed {info.Name}, but couldn't find its executable.");

            CommitCacheDir(agentDir, tmpDir, dir, info.Version);
        }
        finally
        {
            try { if (Directory.Exists(tmpDir)) Directory.Delete(tmpDir, recursive: true); } catch (IOException) { }
        }
    }

    static void CommitCacheDir(string agentDir, string tmpDir, string dir, string version)
    {
        File.WriteAllText(Path.Combine(tmpDir, ".ready"), version);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        Directory.Move(tmpDir, dir);

        foreach (var old in Directory.GetDirectories(agentDir))
        {
            if (Path.GetFullPath(old).Equals(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase)) continue;
            try { Directory.Delete(old, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>Resolve an installed npm package's runnable entry point directly (no npx, zero auto-download).</summary>
    static InstalledLaunch? ResolveNpmLaunch(string dir, NpxDist npx)
    {
        var pkgName = PackageName(npx.Package);
        var pkgDir = Path.Combine(dir, "node_modules", pkgName.Replace('/', Path.DirectorySeparatorChar));
        var pkgJsonPath = Path.Combine(pkgDir, "package.json");
        if (File.Exists(pkgJsonPath))
        {
            try
            {
                var pkg = JsonNode.Parse(File.ReadAllText(pkgJsonPath));
                string? binRel = null;
                if (pkg?["bin"] is JsonValue sv && sv.TryGetValue<string>(out var s)) binRel = s;
                else if (pkg?["bin"] is JsonObject obj)
                    binRel = obj.Select(kv => kv.Value is JsonValue v && v.TryGetValue<string>(out var b) ? b : null).FirstOrDefault(b => !string.IsNullOrEmpty(b));

                if (!string.IsNullOrEmpty(binRel))
                {
                    var target = Path.GetFullPath(Path.Combine(pkgDir, CleanRelPath(binRel)));
                    if (File.Exists(target))
                    {
                        if (target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
                            target.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
                            target.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
                            return new InstalledLaunch(target, [], npx.Args, npx.Env);

                        var node = FindNode();
                        if (node?.NodeExe != null)
                            return new InstalledLaunch(node.NodeExe, [target], npx.Args, npx.Env);
                    }
                }
            }
            catch (Exception e) when (e is IOException or JsonException) { }
        }

        var binDir = Path.Combine(dir, "node_modules", ".bin");
        if (Directory.Exists(binDir))
        {
            var cmd = Directory.EnumerateFiles(binDir, "*.cmd").FirstOrDefault();
            if (cmd != null) return new InstalledLaunch(cmd, [], npx.Args, npx.Env);
        }
        return null;
    }

    static string PackageName(string spec)
    {
        var at = spec.LastIndexOf('@');
        return at > 0 ? spec[..at] : spec;
    }

    static string CleanRelPath(string p)
    {
        var s = p.Trim().Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
        while (s.StartsWith("." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) s = s[2..];
        return s.TrimStart(Path.DirectorySeparatorChar);
    }

    static string? ResolveBinaryPath(string root, string cmd)
    {
        var rootFull = Path.GetFullPath(root);
        var rel = CleanRelPath(cmd);
        var exact = Path.GetFullPath(Path.Combine(rootFull, rel));
        if (exact.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(exact))
            return exact;
        var fileName = Path.GetFileName(rel);
        if (string.IsNullOrEmpty(fileName)) return null;
        return Directory.EnumerateFiles(rootFull, fileName, SearchOption.AllDirectories).FirstOrDefault();
    }

    static string SafeSegment(string s) =>
        string.Concat(s.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.' ? c : '_'));

    static string? FindOnPath(string fileName)
    {
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Append(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "bin"));
        foreach (var dir in dirs)
        {
            var path = Path.Combine(dir, fileName);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    sealed record NodeInstall(string NodeExe, string? NpmCli, string? NpmCmd);

    /// <summary>Node.js on PATH (with npm-cli.js beside it or npm.cmd on PATH).</summary>
    static NodeInstall? FindNode()
    {
        var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Append(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"));
        string? nodeExe = null;
        string? npmCli = null;
        string? npmCmd = null;
        foreach (var dir in dirs)
        {
            var n = Path.Combine(dir, "node.exe");
            var cli = Path.Combine(dir, "node_modules", "npm", "bin", "npm-cli.js");
            if (File.Exists(n) && File.Exists(cli)) return new NodeInstall(n, cli, null);
            if (nodeExe == null && File.Exists(n)) nodeExe = n;
            if (npmCmd == null && File.Exists(Path.Combine(dir, "npm.cmd"))) npmCmd = Path.Combine(dir, "npm.cmd");
        }
        return nodeExe != null ? new NodeInstall(nodeExe, npmCli, npmCmd) : null;
    }

    List<AgentInfo> Catalog() => catalog ?? [.. BuiltIn];

    /// <summary>Load all Windows-compatible agents from the ACP registry (once per run), merging into our featured
    /// list and falling back to built-in definitions when offline.</summary>
    public async Task RefreshRegistry()
    {
        if (catalog != null) return;
        await registryGate.WaitAsync();
        try
        {
            if (catalog != null) return;
            var registry = await Net.GetJson(Registry);
            var byId = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in (registry["agents"] as JsonArray ?? []).OfType<JsonObject>())
                if (item.Str("id") is { Length: > 0 } id) byId[id] = item;

            var result = new List<AgentInfo>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var b in BuiltIn)
            {
                seen.Add(b.Id);
                if (byId.TryGetValue(b.Id, out var raw))
                {
                    var bin = ParseBinary(raw["distribution"]?["binary"] as JsonObject) ?? b.Binary;
                    var npx = ParseNpx(raw["distribution"]?["npx"] as JsonObject) ?? b.Npx;
                    var ver = raw.Str("version") is { Length: > 0 } v ? v : b.Version;
                    var desc = raw.Str("description") is { Length: > 0 } d ? d : b.Description;
                    result.Add(b with { Version = ver, Description = desc, Binary = bin, Npx = npx });
                }
                else
                {
                    result.Add(b);
                }
            }

            var extras = new List<AgentInfo>();
            foreach (var (id, raw) in byId)
            {
                if (seen.Contains(id) || id.Equals("opencode-v2", StringComparison.OrdinalIgnoreCase)) continue;
                var bin = ParseBinary(raw["distribution"]?["binary"] as JsonObject);
                var npx = ParseNpx(raw["distribution"]?["npx"] as JsonObject);
                if (bin == null && npx == null) continue;
                var name = raw.Str("name") ?? id;
                var ver = raw.Str("version") ?? "latest";
                var desc = raw.Str("description") ?? "";
                extras.Add(new AgentInfo(id, name, ver, desc, $"Sign in to {name} and try again.", false, bin, npx));
            }
            extras.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
            result.AddRange(extras);
            catalog = result;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or UpstreamException or JsonException)
        {
            catalog = [.. BuiltIn]; // offline: use built-in definitions
        }
        finally
        {
            registryGate.Release();
        }
    }

    static BinaryDist? ParseBinary(JsonObject? binObj)
    {
        if (binObj == null) return null;
        var keys = RuntimeInformation.OSArchitecture == Architecture.Arm64
            ? new[] { "windows-aarch64", "windows-x86_64" }
            : new[] { "windows-x86_64" };
        JsonObject? entry = null;
        foreach (var k in keys)
        {
            if (binObj[k] is JsonObject o) { entry = o; break; }
        }
        if (entry == null) return null;
        var archive = entry.Str("archive");
        var cmd = entry.Str("cmd");
        if (string.IsNullOrEmpty(archive) || string.IsNullOrEmpty(cmd)) return null;
        return new BinaryDist(archive, cmd, ReadStringArray(entry["args"]), ReadStringMap(entry["env"]), entry.Str("sha256"));
    }

    static NpxDist? ParseNpx(JsonObject? npxObj)
    {
        if (npxObj == null) return null;
        var pkg = npxObj.Str("package");
        if (string.IsNullOrEmpty(pkg)) return null;
        return new NpxDist(pkg, ReadStringArray(npxObj["args"]), ReadStringMap(npxObj["env"]));
    }

    static string[] ReadStringArray(JsonNode? node) =>
        (node as JsonArray)?.Select(n => n?.GetValue<string>()).Where(s => s != null).Cast<string>().ToArray() ?? [];

    static Dictionary<string, string> ReadStringMap(JsonNode? node)
    {
        var map = new Dictionary<string, string>();
        if (node is JsonObject obj)
            foreach (var (k, v) in obj)
                if (v is JsonValue jv && jv.TryGetValue<string>(out var s)) map[k] = s;
        return map;
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
                if (update["configOptions"] is JsonArray options) configOptions = options.DeepClone() as JsonArray;
                post(new JsonObject { ["type"] = "options", ["configOptions"] = configOptions?.DeepClone() });
                break;
            case "current_mode_update":
                if (update.Str("currentModeId") is { } modeId && Option("mode") is { } modeOpt)
                {
                    modeOpt["currentValue"] = modeId;
                    post(new JsonObject { ["type"] = "options", ["configOptions"] = configOptions?.DeepClone() });
                }
                break;
            case "agent_message_chunk" or "agent_thought_chunk" or "plan" or "notice":
                post(new JsonObject { ["type"] = "update", ["update"] = update.DeepClone() });
                break;
            case "tool_call" or "tool_call_update":
                if (busy) post(new JsonObject { ["type"] = "update", ["update"] = ToolCall(update) });
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

    JsonObject Snapshot() => new()
    {
        ["agent"] = agent?.Id,
        ["agentName"] = agent?.Name,
        ["connected"] = conn is { Alive: true } && sessionId != null,
        ["sessionId"] = sessionId,
        ["account"] = account,
        ["busy"] = busy,
        ["configOptions"] = configOptions?.DeepClone(),
    };

    JsonObject InstallNeeded(AgentInfo info)
    {
        var needsNode = info.Binary == null;
        var hasNode = !needsNode || FindNode() != null;
        var hasNativeCli = info.NativeCli is { Length: > 0 } && info.NativeCli.Any(c => FindOnPath(c) != null);
        var message = hasNativeCli
            ? $"{info.Name}'s ACP adapter isn't installed yet."
            : $"{info.Name} isn't installed yet.";
        var detail = !hasNode
            ? $"{info.Name} needs Node.js to install. Install Node.js first, then try again."
            : hasNativeCli
                ? $"{info.Name} is installed on this PC. Install its ACP adapter into Maestro's local folder so Maestro can connect to it."
                : info.Binary != null
                    ? $"Downloads {info.Name} ({info.Version}) into Maestro's local folder."
                    : $"Installs {info.Npx!.Package} into Maestro's local folder.";
        return new JsonObject
        {
            ["agent"] = info.Id,
            ["agentName"] = info.Name,
            ["needsInstall"] = new JsonObject
            {
                ["message"] = message,
                ["detail"] = detail,
                ["buttonLabel"] = hasNativeCli ? "Install adapter" : $"Install {info.Name}",
                ["available"] = hasNode,
                ["needsNode"] = !hasNode,
            },
        };
    }

    JsonObject SignInNeeded(string message)
    {
        var methods = new JsonArray([.. authMethods.OfType<JsonObject>().Select(m => (JsonNode)new JsonObject
        {
            ["id"] = m.Str("id"),
            ["name"] = m.Str("name"),
            ["description"] = m.Str("description"),
        })]);
        if (agent?.LoginArgs != null && !authMethods.OfType<JsonObject>().Any(m => m.Str("type") == "terminal"))
        {
            methods.Add(new JsonObject
            {
                ["id"] = "__terminal_login",
                ["name"] = "Sign in in terminal",
                ["description"] = $"Open a terminal to sign in to {agent.Name}.",
            });
        }
        return new JsonObject
        {
            ["agent"] = agent?.Id,
            ["agentName"] = agent?.Name,
            ["signIn"] = new JsonObject
            {
                ["message"] = $"{agent?.Name} needs you to sign in. {agent?.SignIn}",
                ["detail"] = message,
                ["methods"] = methods,
            },
        };
    }

    void Status(string state, string? message) => post(new JsonObject { ["type"] = "status", ["state"] = state, ["message"] = message });

    public void Dispose() => Stop().Wait(TimeSpan.FromSeconds(4));
}
