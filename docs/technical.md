# Maestro technical guide

The details behind the [README](../README.md): how each service plays, the AI agent features, installer options, and
how to build Maestro from source.

- [How it works](#how-it-works)
- [Installer options](#installer-options)
- [The Agent panel](#the-agent-panel)
- [Connect other AI apps (MCP)](#connect-other-ai-apps-mcp)
- [Limitations](#limitations)
- [Project structure](#project-structure)
- [Build from source](#build-from-source)

## How it works

Maestro is a .NET desktop app. Its UI is plain HTML/CSS/JS embedded in the exe and shown in WebView2. The UI's
`/api/*` requests are answered in-process, so Maestro runs no local web server and opens no network ports.

- **Spotify** plays through your Spotify desktop app. Maestro starts it with `--remote-debugging-port` and uses the
  Chrome DevTools Protocol to run code ([inject.js](../src/Maestro/inject.js)) inside Spotify's own page. That code
  uses the app's own player and search, which is why no developer app or Premium is needed. The Microsoft Store build
  of Spotify isn't supported; use the installer from spotify.com. If Spotify is already running without the flag, Maestro
  asks once to restart it. If Spotify shows its login screen, Maestro brings that window up so you can sign in.
- **YouTube** plays in YouTube's embedded player inside Maestro's window. Search uses YouTube's web client and needs no
  API key. When a video blocks embedding, Maestro plays another upload of the same recording if there is one.
  Otherwise it plays the video from youtube.com in a hidden window ([watch.js](../src/Maestro/watch.js)), which removes
  ads from the video's data before YouTube's player reads it. Only videos that won't play there either
  (age-restricted, private, or taken down) are skipped.
- **SoundCloud** plays in SoundCloud's embedded player. Search uses the client id from SoundCloud's own website, so no
  API registration is needed.
- **Volume leveling.** [normalizer.js](../src/Maestro/normalizer.js) runs inside the YouTube and SoundCloud frames,
  measures each track's loudness, and adjusts it to match Spotify's level. It's on by default and can be turned off
  in Settings.
- **Media keys.** Maestro has one entry in Windows' media controls for all three services, and it takes the
  keyboard's media keys (Play/Pause, Next, Previous) so the hidden Spotify never reacts to them. While another app
  is the one playing (a video in your browser, say), the keys go to that app as usual.
- **Home and autoplay** use Spotify song radio, YouTube Mix, and SoundCloud related tracks.
- **Your data** (settings, playlists, and liked songs) is stored as JSON in `%APPDATA%\Maestro`.

## Installer options

[install.ps1](../install.ps1) installs Maestro to `%LOCALAPPDATA%\Programs\Maestro`, adds a Start menu entry, and puts
`maestro` on your PATH (and on Win+R). It needs no admin rights, and running it again updates Maestro. You can
[read the script](../install.ps1) before running it.

To pass options, use this form:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1))) -DesktopShortcut
```

| Flag | Description |
|---|---|
| `-DesktopShortcut` | Also add a desktop shortcut. |
| `-Version v0.0.4` | Install a specific release instead of the newest. |
| `-InstallDir <path>` | Install somewhere other than `%LOCALAPPDATA%\Programs\Maestro`. |
| `-NoPath` | Don't add the `maestro` command to PATH. |
| `-NoLaunch` | Don't open Maestro when done. |
| `-Uninstall` | Remove Maestro. Add `-Purge` to also delete your settings, playlists, and Maestro's browser data. |
| `-ExePath <path>` | Install a local `Maestro.exe` instead of downloading one. |

The release exe is built from this repo by the [release workflow](../.github/workflows/release.yml) for each `v*` tag.

## The Agent panel

The ✦ button in the player bar (or `Ctrl+J`) opens a chat beside the player. Each step the agent takes shows as a line
in the chat (*Searching "daft punk"*, *Adding 5 songs to the queue*), and the player updates as it goes.

- **Agents come from the [Agent Client Protocol](https://agentclientprotocol.com) registry**, the same way editors like
  Zed run them: Claude, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Antigravity, and any other agent in the
  registry that runs on Windows. Each one uses your existing sign-in for that service. If you aren't signed in, the
  panel shows how.
- **Installing.** Agents aren't downloaded until you click **Install**. Some ship as a binary; others are npm packages
  and need [Node.js](https://nodejs.org). Installed adapters are cached locally, so later starts take a few seconds.
- **Switching agents** mid-conversation keeps the conversation's context.
- **Model and effort pickers** sit under the message box. The lists come from the agent itself, so new models show up
  without a Maestro update. Maestro remembers your picks for each agent.
- **Access levels**, set in the panel or in Settings:

  | Level | What the agent can use |
  |---|---|
  | **Minimal** | Maestro's music tools only. |
  | **Recommended** (default) | Adds web search, sub-agents, and image generation. Files, commands, and desktop control stay blocked. |
  | **Full access** | The agent's full tool set, without permission prompts. |
  | **Custom** | Pick individual capabilities. |

## Connect other AI apps (MCP)

Maestro has a built-in [MCP](https://modelcontextprotocol.io) server (`maestro mcp`, over stdio), so AI apps you already
use can control it with nothing extra to install. Anything you can do in Maestro's window, an agent can do too, and the
window shows each change as it happens. If Maestro isn't open, the agent's first request opens it.

**Claude Code or Codex:**

```powershell
claude mcp add maestro -- maestro mcp
codex mcp add maestro -- maestro mcp
```

**Claude Desktop, Cursor, and other MCP apps:** add this to the app's MCP config. Use the full path to `Maestro.exe`
(this is where the installer puts it; replace `YOU` with your Windows user name), because some apps don't search PATH:

```json
{
  "mcpServers": {
    "maestro": { "command": "C:\\Users\\YOU\\AppData\\Local\\Programs\\Maestro\\Maestro.exe", "args": ["mcp"] }
  }
}
```

If you use the portable exe instead of the installer, point `command` at wherever you saved it.

### From a shell or script

`maestro agent` runs the same tools and prints JSON. Run it with no arguments to list the tools and their parameters.

```powershell
maestro agent search query="daft punk" source=spotify limit=5
maestro agent set_player_options volume=40 shuffle=true
maestro agent add_to_queue urls='["https://youtu.be/dQw4w9WgXcQ"]' playNext=true
```

### Tools

| Area | Tools |
|---|---|
| Find music | `search`, `resolve_link`, `get_home` |
| Playback | `get_state`, `play`, `player_control` (play / pause / next / previous), `seek`, `set_player_options` (volume, mute, shuffle, repeat, autoplay, volume leveling) |
| Queue | `get_queue`, `add_to_queue`, `play_queue_position`, `remove_from_queue`, `move_in_queue`, `clear_queue` |
| Library | `list_playlists`, `get_playlist`, `set_favorite`, `create_playlist`, `add_to_playlist`, `remove_from_playlist`, `move_in_playlist`, `rename_playlist`, `delete_playlist` |
| App | `show_view`, `get_settings`, `update_settings`, `manage_spotify` |

### Security

Requests reach Maestro over a named pipe that only your Windows account can open. Nothing listens on the network.
Programs running as you can use it, just as they could click around Maestro's window.

## Limitations

- Windows 10 / 11 (64-bit) only for now.
- Maestro relies on Spotify's internal (unofficial) app code and on SoundCloud's website client id. A big Spotify or
  SoundCloud update can change those, and Maestro may need a fix when that happens.
- Spotify playlist and album imports, and SoundCloud set imports, include up to 100 tracks.
- SoundCloud Go+ exclusives and tracks that block embedding may not play.
- YouTube videos that are age-restricted, private, or taken down are skipped.

## Project structure

```
src/Maestro/
  MainForm.cs           the window: WebView2 showing the UI; /api/* requests are answered in-process (no server/port)
  Api.cs                the API routes the UI calls
  Agent.cs              AI agent access: the pipe the app listens on, `Maestro.exe mcp` (MCP server), `Maestro.exe agent`
  AgentChat.cs          the Agent panel's backend: installs and runs ACP agents with the chosen access level, streams replies
  AgentAccess.cs        the four access levels (minimal, recommended, full, custom) mapped to each agent's settings
  Acp.cs                a client for the Agent Client Protocol, which the panel's agents speak
  AgentTools.cs         the tools agents get, with their descriptions and parameters
  SpotifyApp.cs         drives the Spotify app: start hidden, connect, player, search, restart, autostart, exit
  inject.js             the code Maestro runs inside Spotify's page
  normalizer.js         the volume normalizer, run inside the YouTube and SoundCloud frames
  YouTubePage.cs        the hidden youtube.com window for videos that block embedding
  watch.js              the code Maestro runs on that youtube.com page
  Radio.cs              autoplay and home page recommendations (Spotify song radio, YouTube Mix, SoundCloud related, or all)
  SpotifyLinks.cs       Spotify link parsing and metadata (public embed pages)
  YouTube.cs            YouTube link parsing, search, playlists
  SoundCloud.cs         SoundCloud link parsing, search, related tracks
  Net.cs                shared HTTP helpers
  Store.cs              settings + playlists in %APPDATA%\Maestro
  MediaControls.cs      Maestro's Windows media session (the media flyout card and its buttons), for all three services
  MediaKeys.cs          hardware media keys, taken as hotkeys so the hidden Spotify never reacts to them
  NativeMethods.cs      Win32 calls (window hiding, single instance, dark title bar)
  wwwroot/              the player UI (plain HTML/CSS/JS), embedded in the exe; agent.js runs agents' tool calls,
                        chat.js is the Agent panel
install.ps1             the one-line installer / updater / uninstaller
docs/                   the website (GitHub Pages) and this guide
.github/workflows/      release.yml: builds Maestro-win-x64.exe for each v* tag
tools/make-icon.ps1     regenerates maestro.ico
```

## Build from source

Needs the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

```powershell
dotnet run --project src\Maestro                 # run it
dotnet publish src\Maestro -c Release -o dist    # build dist\Maestro.exe
.\install.ps1 -ExePath dist\Maestro.exe          # install your build
```

Building and modifying Maestro for personal use is allowed under the [license](../LICENSE).
