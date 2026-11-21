<p align="center">
  <img src="src/Maestro/wwwroot/icon.png" width="80" height="80" alt="Maestro logo">
</p>

# Maestro

**Spotify, YouTube, and SoundCloud in one Windows music player.** Search everywhere, queue anything, and listen without switching apps.

**No API keys** · **Ad-free** · **Windows 10 / 11**

[![Download for Windows](https://img.shields.io/badge/Download-Maestro%20for%20Windows-1db954?style=for-the-badge&logo=windows)](https://github.com/QMjnh/maestro/releases/latest/download/Maestro-win-x64.exe)
[![Website](https://img.shields.io/badge/Website-qmjnh.github.io%2Fmaestro-333?style=for-the-badge)](https://qmjnh.github.io/maestro/)

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-blue?style=flat-square)](#install)
[![Latest release](https://img.shields.io/github/v/release/QMjnh/maestro?style=flat-square)](https://github.com/QMjnh/maestro/releases/latest)
[![License](https://img.shields.io/badge/license-BUSL%201.1%20(personal%20use%20free)-yellow?style=flat-square)](LICENSE)

- **Three services, one player.** Play Spotify, YouTube, and SoundCloud from one window with one shared queue.
- **Unified search & links.** Search all three services side by side, or paste any Spotify, YouTube, or SoundCloud link.
- **Mixed playlists & favorites.** Combine tracks from any service in your playlists and Favorites — stored locally on your PC.
- **No API keys or Spotify Premium required.** Spotify plays through your local Spotify desktop app (works with free accounts and [SpotX](https://github.com/SpotX-Official/SpotX)).
- **Even volume.** One volume slider across every service, with automatic loudness leveling for YouTube and SoundCloud.
- **Built-in AI agent.** Press `Ctrl+J` to ask Claude, Codex, Cursor, Antigravity, OpenCode, Gemini CLI, GitHub Copilot, and more to play, queue, like, or organize your music.

## Install

**Portable `.exe`:** Download [Maestro-win-x64.exe](https://github.com/QMjnh/maestro/releases/latest/download/Maestro-win-x64.exe) from the [latest release](https://github.com/QMjnh/maestro/releases/latest) and run it. *(If Windows SmartScreen warns on first launch, click More info → Run anyway.)*

**Or install with PowerShell** (adds Start menu entry, `maestro` command, and one-command updates — no admin needed):

```powershell
irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1 | iex
```

Run the same command again to update. Uninstall anytime from **Settings → Apps**.

<details>
<summary>Installer options</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1))) -DesktopShortcut
```

| Flag | Description |
|---|---|
| `-DesktopShortcut` | Add a desktop shortcut. |
| `-Version v0.0.4` | Install a specific release. |
| `-InstallDir <path>` | Custom install folder (default: `%LOCALAPPDATA%\Programs\Maestro`). |
| `-NoPath` | Don't add `maestro` to PATH. |
| `-NoLaunch` | Don't open Maestro after installing. |
| `-Uninstall` | Remove Maestro (add `-Purge` to also delete local settings and playlists). |

</details>

## Using Maestro

| Feature | What it does |
|---|---|
| **Home** | Personalized picks from your Spotify home feed, listening history, and related mixes across all three services. |
| **Search & links** | Search Spotify, YouTube, and SoundCloud at once, or paste any track, album, or playlist URL. |
| **Queue & autoplay** | Drag to reorder, shuffle, repeat, and auto-continue with recommendations from the same service or all services. |
| **Favorites & playlists** | Save songs from any service with the heart or `+` button, or drag tracks onto playlists in the sidebar. |
| **Volume leveling** | Enabled in Settings by default to match YouTube and SoundCloud loudness to Spotify. |
| **Spotify background mode** | Maestro starts Spotify hidden in the background and closes it on exit (configurable in Settings). Opening Spotify yourself leaves it visible. |
| **Shortcuts** | `Space` play/pause · `Ctrl+←/→` previous/next · `Shift+←/→` seek ±10s · `/` or `Ctrl+K` search · `Ctrl+J` Agent |

## AI Agent

### Agent panel (`Ctrl+J`)

Open the ✦ panel in the player bar to chat with an AI agent that can search, play, queue, like, and build playlists directly in Maestro:

- **Use your own sign-in, no API keys.** Supports **Claude**, **Codex**, **Cursor**, **Antigravity**, **OpenCode**, **Gemini CLI**, **GitHub Copilot**, and more via the [ACP registry](https://agentclientprotocol.com). Uninstalled agents show an **Install** button instead of downloading automatically.
- **Switch agents mid-conversation.** Conversation context carries over when you switch between agents.
- **Configurable access levels.** Choose **Minimal** (Maestro tools only), **Recommended** (adds web search, sub-agents, and images), **Full access**, or **Custom** right in the panel or in Settings.

### Connect external agents (MCP)

Maestro includes a built-in [MCP](https://modelcontextprotocol.io) server so external agents can control it too:

```powershell
claude mcp add maestro -- maestro mcp
codex mcp add maestro -- maestro mcp
```

For Claude Desktop, Cursor, or other MCP apps:

```json
{
  "mcpServers": {
    "maestro": { "command": "C:\\Users\\YOU\\AppData\\Local\\Programs\\Maestro\\Maestro.exe", "args": ["mcp"] }
  }
}
```

You can also run any tool from a terminal with `maestro agent` (run with no arguments to see available commands).

## Notes & limitations

- **Windows 10 / 11 (64-bit)** only for now.
- **Spotify playback** requires the desktop installer from [spotify.com](https://www.spotify.com/download) (not the Microsoft Store version). YouTube and SoundCloud work without Spotify.
- **SoundCloud Go+** exclusives and tracks that disable embedding may not play.
- **Playlist imports** from Spotify and SoundCloud currently load up to 100 tracks.

## License

Licensed under [BUSL 1.1](LICENSE) — **free for personal, noncommercial use**, including building and modifying from source. Commercial/business use requires a separate license. Every release converts automatically to GPL-2.0-or-later four years after release.

## Build from source

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

```powershell
dotnet run --project src\Maestro                 # run in debug mode
dotnet publish src\Maestro -c Release -o dist    # build portable dist\Maestro.exe
.\install.ps1 -ExePath dist\Maestro.exe          # install your local build
```
