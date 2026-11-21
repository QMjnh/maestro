using System.Text.Json.Nodes;

namespace Maestro;

/// <summary>
/// What the Agent panel's agent may do besides Maestro's own tools. The user picks a level in the panel: Minimal
/// (Maestro only), Recommended (adds web search, sub-agents, and images), Full access (the agent's whole tool set,
/// without prompts), or Custom (any mix of the capabilities below). This file turns that choice into each agent's
/// own settings: Claude's session options and Codex's config.
/// </summary>
static class AgentAccess
{
    public sealed record Capability(string Id, string Name, string Description, bool Risky, string[] Agents);

    static readonly string[] Both = ["claude-acp", "codex-acp"];

    public static readonly Capability[] Capabilities =
    [
        new("web", "Web search", "Search the web and read pages, e.g. to find the song someone describes.", false, Both),
        new("subagents", "Sub-agents", "Hand parts of a request to helper agents.", false, Both),
        new("images", "Image generation", "Create images.", false, ["codex-acp"]),
        new("files_read", "Read files", "Read files on this PC.", true, Both),
        new("files_edit", "Edit files", "Create and change files on this PC.", true, Both),
        new("shell", "Run commands", "Run terminal commands on this PC.", true, Both),
        new("browser", "Browser and desktop control", "Use a browser or control apps on your desktop.", true, ["codex-acp"]),
        new("schedule", "Scheduled tasks", "Set up tasks that run later or in the cloud.", true, Both),
        new("setup", "Your agent setup", "Your MCP servers, connected apps (like Gmail and Google Drive), plugins, hooks, and instructions.", true, Both),
    ];

    public static readonly string[] Levels = ["minimal", "recommended", "full", "custom"];
    static readonly string[] Recommended = ["web", "subagents", "images"];

    /// <summary>The level and capabilities in effect now.</summary>
    public static (string Level, HashSet<string> On) Current()
    {
        var s = Store.GetSettings();
        var level = Levels.Contains(s.AgentAccess) ? s.AgentAccess : "recommended";
        IEnumerable<string> on = level switch
        {
            "minimal" => [],
            "recommended" => Recommended,
            "full" => Capabilities.Select(c => c.Id),
            _ => s.AgentCustom,
        };
        return (level, on.Where(id => Capabilities.Any(c => c.Id == id)).ToHashSet());
    }

    public static JsonObject Describe()
    {
        var s = Store.GetSettings();
        var (level, _) = Current();
        return new JsonObject
        {
            ["level"] = level,
            ["custom"] = new JsonArray([.. s.AgentCustom.Select(id => (JsonNode)id)]),
            ["recommended"] = new JsonArray([.. Recommended.Select(id => (JsonNode)id)]),
            ["capabilities"] = new JsonArray([.. Capabilities.Select(c => (JsonNode)new JsonObject
            {
                ["id"] = c.Id,
                ["name"] = c.Name,
                ["description"] = c.Description,
                ["risky"] = c.Risky,
                ["agents"] = new JsonArray([.. c.Agents.Select(a => (JsonNode)a)]),
            })]),
        };
    }

    public static void Save(string level, IEnumerable<string>? custom)
    {
        if (!Levels.Contains(level)) throw new ArgumentException("level must be minimal, recommended, full, or custom");
        var s = Store.GetSettings();
        s.AgentAccess = level;
        if (custom != null) s.AgentCustom = [.. custom.Where(id => Capabilities.Any(c => c.Id == id)).Distinct()];
        Store.SaveSettings(s);
    }

    // ---- instructions --------------------------------------------------------------------------------------------

    const string Base = """
        You are the music assistant built into Maestro, a Windows app that plays Spotify, YouTube, and SoundCloud in
        one player with one shared queue. The listener chats with you in a panel beside the player.

        Use the maestro tools to do what they ask: find and play music, control playback, manage the queue, like
        songs, build playlists, and explore their home page recommendations. They can see the player, so every change
        you make shows up right away.

        - Act on clear requests without asking first. Before deleting a playlist, clearing the queue, or restarting
          Spotify, check with them unless they asked for exactly that.
        - When you choose songs yourself, prefer official uploads and mix services freely. For "more like this",
          start from get_state.
        - Reply in one or two short sentences, in the language the listener writes in. Say what you did, not how.
          Plain text: no tables or headings.
        """;

    public static string Instructions()
    {
        var (level, on) = Current();
        var line = level switch
        {
            "minimal" => "- You can only use the maestro tools. You can't browse the web, read files, or run commands. If asked for something outside Maestro, say so briefly.",
            "full" => "- You also have your full tool set, including commands and files on this PC. Use those only when the listener asks for something that needs them.",
            _ when on.Count == 0 => "- You can only use the maestro tools. If asked for something outside Maestro, say so briefly.",
            _ => $"- Besides the maestro tools you may have: {string.Join(", ", Capabilities.Where(c => on.Contains(c.Id)).Select(c => c.Name.ToLowerInvariant()))}. Use them when they help, for example web search to work out which song the listener means.",
        };
        return Base + "\n" + line;
    }

    // ---- Claude --------------------------------------------------------------------------------------------------

    // Claude Code's own tools, by capability. Names a given version doesn't have are ignored.
    static readonly Dictionary<string, string[]> ClaudeTools = new()
    {
        ["web"] = ["WebSearch", "WebFetch"],
        ["subagents"] = ["Task", "Agent", "TaskStop", "SendMessage", "ListAgents"],
        ["files_read"] = ["Read", "Glob", "Grep"],
        ["files_edit"] = ["Write", "Edit", "NotebookEdit"],
        ["shell"] = ["Bash", "PowerShell", "BashOutput", "KillShell"],
        ["schedule"] = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "PushNotification"],
    };

    /// <summary>The <c>_meta.claudeCode.options</c> for a session (Claude Agent SDK options).</summary>
    public static JsonObject ClaudeOptions()
    {
        var (level, on) = Current();
        var options = new JsonObject { ["promptSuggestions"] = false };
        if (level == "full") return options; // Claude Code as the user has it set up
        var setup = on.Contains("setup");
        var tools = on.SelectMany(id => ClaudeTools.GetValueOrDefault(id) ?? []).ToList();
        if (tools.Count > 0 || setup) tools.Add("ToolSearch"); // finds tools Claude Code loads on demand
        options["tools"] = new JsonArray([.. tools.Select(t => (JsonNode)t)]);
        options["settingSources"] = setup ? new JsonArray("user") : new JsonArray();
        options["strictMcpConfig"] = !setup;
        options["allowedTools"] = new JsonArray([.. new[] { "mcp__maestro" }.Concat(tools).Select(t => (JsonNode)t)]);
        return options;
    }

    /// <summary>Claude's permission mode: no prompts at all with Full access, default otherwise.</summary>
    public static string ClaudeMode() => Current().Level == "full" ? "bypassPermissions" : "default";

    // ---- Codex ---------------------------------------------------------------------------------------------------

    // Codex feature flags, by capability. Flags for capabilities that are off get turned off.
    static readonly Dictionary<string, string[]> CodexFeatures = new()
    {
        ["shell"] = ["shell_tool", "unified_exec", "code_mode_host", "code_mode_host_grpc", "shell_snapshot"],
        ["subagents"] = ["multi_agent", "multi_agent_v2", "collaboration_modes"],
        ["images"] = ["image_generation"],
        ["browser"] = ["browser_use", "browser_use_external", "in_app_browser", "computer_use"],
        ["schedule"] = ["goals"],
        ["setup"] = ["apps", "plugins", "hooks", "memories", "skill_search", "tool_suggest", "skill_mcp_dependency_install", "tool_call_mcp_elicitation"],
    };

    /// <summary>The Codex config for Maestro's sessions; the adapter merges it into each session (CODEX_CONFIG).</summary>
    public static JsonObject CodexConfig(IEnumerable<string> userMcpServers)
    {
        var (level, on) = Current();
        var config = new JsonObject { ["developer_instructions"] = Instructions() };
        if (level == "full") return config; // Codex as the user has it set up
        var off = CodexFeatures.Where(kv => !on.Contains(kv.Key)).SelectMany(kv => kv.Value).ToList();
        if (on.Count == 0) off.Add("sleep_tool");
        config["features"] = new JsonObject(off.Select(f => KeyValuePair.Create(f, (JsonNode?)false)));
        config["web_search"] = on.Contains("web") ? "live" : "disabled";
        config["tools"] = new JsonObject { ["view_image"] = on.Contains("files_read") };
        if (!on.Contains("setup"))
        {
            var servers = new JsonObject();
            foreach (var name in userMcpServers) servers[name] = new JsonObject { ["enabled"] = false };
            config["mcp_servers"] = servers;
        }
        return config;
    }

    /// <summary>
    /// Codex's sandbox: read-only unless the agent may edit files ("agent": it can change files and asks for anything
    /// beyond its folder, which Maestro approves at this level), and none at all with Full access.
    /// </summary>
    public static string CodexMode()
    {
        var (level, on) = Current();
        return level == "full" ? "agent-full-access" : on.Contains("files_edit") ? "agent" : "read-only";
    }

    /// <summary>Whether to approve a permission request the agent makes. Maestro's tools always pass; at Minimal
    /// nothing else passes; at Full access everything passes; otherwise check the requested tool/kind against the
    /// enabled capabilities as defense in depth.</summary>
    public static bool Approves(JsonNode? call)
    {
        var names = new[] { call.Str("name"), call.Str("title"), call.Str("_meta.claudeCode.toolName") }
            .Where(s => s != null)
            .ToArray();
        if (names.Any(s => s!.Contains("maestro", StringComparison.OrdinalIgnoreCase))) return true;
        var (level, on) = Current();
        if (level == "full") return true;
        if (level == "minimal" || on.Count == 0) return false;
        var kind = call.Str("kind");
        if (kind == "execute" && !on.Contains("shell")) return false;
        if (kind is "edit" or "delete" or "move" && !on.Contains("files_edit")) return false;
        if (kind == "read" && !on.Contains("files_read")) return false;
        var toolName = call.Str("_meta.claudeCode.toolName") ?? call.Str("name");
        if (toolName != null)
        {
            foreach (var (cap, tools) in ClaudeTools)
                if (tools.Contains(toolName, StringComparer.OrdinalIgnoreCase) && !on.Contains(cap))
                    return false;
        }
        return true;
    }
}
