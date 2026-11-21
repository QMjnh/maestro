<p align="center">
  <img src="src/Maestro/wwwroot/icon.png" width="80" height="80" alt="Maestro logo">
</p>

# Maestro: Spotify, YouTube, SoundCloud & more in one music player

**Your music, all in one place.** Maestro is a Windows music player that brings **Spotify**, **YouTube**, and
**SoundCloud** together. Search everywhere, queue anything, and listen without switching apps.

**No API keys** · **Ad-free** · **Windows 10 / 11**

[![Download for Windows](https://img.shields.io/badge/Download-Maestro%20for%20Windows-1db954?style=for-the-badge&logo=windows)](https://github.com/QMjnh/maestro/releases/latest/download/Maestro-win-x64.exe)
[![Website](https://img.shields.io/badge/Website-qmjnh.github.io%2Fmaestro-333?style=for-the-badge)](https://qmjnh.github.io/maestro/)

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-blue?style=flat-square)](#install)
[![Latest release](https://img.shields.io/github/v/release/QMjnh/maestro?style=flat-square)](https://github.com/QMjnh/maestro/releases/latest)
[![License](https://img.shields.io/badge/license-BUSL%201.1%20(personal%20use%20free)-yellow?style=flat-square)](LICENSE)

- **Three services, one player.** Play Spotify, YouTube, and SoundCloud from one window.
- **One search for everything.** Results from all three, side by side.
- **Mixed playlists and one queue.** Put songs from any service together; Maestro hands off between them as each
  song ends.
- **No developer API keys.** No Spotify developer app, no YouTube API key, nothing to configure.
- **Ad-free.** No ads in Maestro. Patch Spotify with [SpotX](https://github.com/SpotX-Official/SpotX) and Spotify
  plays ad-free too, even on a free account.
- **Even volume.** One slider for everything, with YouTube and SoundCloud leveled to match Spotify.
- **Works with AI agents.** A built-in MCP server lets Claude, Codex, and other agents search, play, queue, like, and
  build playlists for you ([details](#use-it-from-an-ai-agent)).

How each service plays:

- **Spotify** plays through your **Spotify desktop app**. Maestro uses the app's own player and search (details
  [below](#how-the-spotify-side-works)), so there are no API keys and no Premium requirement.
- **YouTube** plays in YouTube's embedded player inside Maestro's window. Search needs no API key.
- **SoundCloud** plays in SoundCloud's embedded player inside Maestro's window. Search needs no API key.

**You only open Maestro.** It starts Spotify in the background and closes it again when you quit. Want Spotify's own
window? Open Spotify like you normally would: it shows up, and from then on it's yours (Maestro won't hide or close it).

## Install

**Download:** [Maestro-win-x64.exe](https://github.com/QMjnh/maestro/releases/latest/download/Maestro-win-x64.exe)
from the [latest release](https://github.com/QMjnh/maestro/releases/latest). It's a single portable exe with
nothing else to install. It isn't code-signed yet, so Windows SmartScreen may warn the first time: choose
*More info › Run anyway*. The exe is built from this repo by the [release workflow](.github/workflows/release.yml).

**Or install with PowerShell** to get a Start menu entry, a `maestro` command, and one-command updates
(Windows 10/11, no admin needed; you can [read the script](install.ps1) first):

```powershell
irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1 | iex
```

That's it. Maestro is now in the Start menu (search "Maestro"), on Win+R as `maestro`, and on your PATH as `maestro`.
Run the same command again to update. You also need the [Spotify desktop app](https://www.spotify.com/download)
(or SpotX) for Spotify songs; YouTube and SoundCloud work without it.

**Options.** To pass flags, use this form instead:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/QMjnh/maestro/main/install.ps1))) -DesktopShortcut
```

| Flag | |
|---|---|
| `-DesktopShortcut` | Also add a desktop shortcut. |
| `-Version v0.0.2` | Install a specific release instead of the newest. |
| `-InstallDir <path>` | Install somewhere other than `%LOCALAPPDATA%\Programs\Maestro`. |
| `-NoPath` | Don't add the `maestro` command to PATH. |
| `-NoLaunch` | Don't open Maestro when done. |
| `-Uninstall` | Remove Maestro. Add `-Purge` to also delete your settings and playlists. |

You can also uninstall from **Settings › Apps**.

**First time:** if Spotify is already open without Maestro support, Maestro asks once to restart it. If Spotify
shows its login screen, Maestro brings that window up so you can sign in.

## Using it

| | |
|---|---|
| **Home** | Recommendations made from your own taste, ready to click and play: your real Spotify home feed (Daily Mixes, radios, "More like ..."), songs, mixes, and playlists from Spotify, YouTube, and SoundCloud based on the artists you play most, and what you played recently. *New picks* rotates which artists and songs they're based on. Global charts appear only until Maestro has something to go on. Your listening history stays on this computer. Hover a playlist and press play to start it, or click it to see its tracks. |
| **Search** | Type to search Spotify, YouTube, and SoundCloud at once. Use the *All / Spotify / YouTube / SoundCloud* filter to show one source. |
| **Paste a link** | Spotify tracks, albums, and playlists; YouTube videos and playlists; SoundCloud tracks and sets. You can play everything, add it to the queue, or save it as a Maestro playlist. |
| **Queue** | Drag to reorder. Includes shuffle and repeat (all / one). |
| **Autoplay** | When the queue runs low, Maestro adds recommendations so the music never stops: Spotify's song radio, YouTube's Mix, SoundCloud related tracks, or all of them interleaved (*Queue → Autoplay: Off / Same app / All apps*). Songs you add always play before autoplay's picks. |
| **Favorites** | Tap the heart beside the current song in the player bar or Now Playing panel, or on a track row. Open **Favorites** in the sidebar to play, shuffle, or queue your saved songs from all three sources. Saved locally in `%APPDATA%\Maestro\favorites.json`. |
| **Playlists** | Stored in `%APPDATA%\Maestro\playlists.json`. Use the **+** beside the current song to add it to a playlist or Favorites, use a track's ⋯ menu, or drag a track onto a playlist in the sidebar. |
| **Volume** | A single slider controls YouTube, Spotify, and SoundCloud. *Even out volume between sources* (Settings, on by default) measures each YouTube and SoundCloud track and turns it up or down to match Spotify's level. It settles in the first few seconds of a track. |
| **Keys** | `Space` play/pause · `Ctrl+←/→` previous/next · `Shift+←/→` seek ±10s · `/` or `Ctrl+K` search |

Settings has switches for *Keep Spotify's window hidden* and *Close Spotify when Maestro closes* (both on by default).
Both only apply to a Spotify that Maestro started and that you haven't opened yourself. A Spotify you start is never
hidden or closed by Maestro.

## Use it from an AI agent

Anything you can do in Maestro's window, an AI agent can do too: search, play, pause, skip, seek, change the volume,
shuffle, repeat, and autoplay, edit the queue, like songs, create and edit playlists, open home recommendations,
and change settings. The window shows each change as it happens. Maestro has an
[MCP](https://modelcontextprotocol.io) server built in, so there's nothing extra to install.

**Claude Code** (or **Codex**: `codex mcp add maestro -- maestro mcp`):

```powershell
claude mcp add maestro -- maestro mcp
```

**Claude Desktop, Cursor, and other MCP apps:** add this to the app's MCP config. Use the full path to `Maestro.exe`
(this one is where the installer puts it), because some apps don't search PATH:

```json
{
  "mcpServers": {
    "maestro": { "command": "C:\\Users\\YOU\\AppData\\Local\\Programs\\Maestro\\Maestro.exe", "args": ["mcp"] }
  }
}
```

Then ask for things like *"play some Daft Punk"*, *"queue the rest of this album after this song"*, *"like this
song"*, or *"make a playlist from my queue called Road trip"*. If Maestro isn't open, the agent's first request opens it.

**From a shell or script**, `maestro agent` runs the same tools and prints JSON. Run `maestro agent` with no arguments
to list the tools and their parameters.

```powershell
maestro agent search query="daft punk" source=spotify limit=5
maestro agent set_player_options volume=40 shuffle=true
maestro agent add_to_queue urls='["https://youtu.be/dQw4w9WgXcQ"]' playNext=true
```

| Area | Tools |
|---|---|
| Find music | `search`, `resolve_link`, `get_home` |
| Playback | `get_state`, `play`, `player_control` (play / pause / next / previous), `seek`, `set_player_options` (volume, mute, shuffle, repeat, autoplay, volume leveling) |
| Queue | `get_queue`, `add_to_queue`, `play_queue_position`, `remove_from_queue`, `move_in_queue`, `clear_queue` |
| Library | `list_playlists`, `get_playlist`, `set_favorite`, `create_playlist`, `add_to_playlist`, `remove_from_playlist`, `move_in_playlist`, `rename_playlist`, `delete_playlist` |
| App | `show_view`, `get_settings`, `update_settings`, `manage_spotify` |

Requests reach Maestro over a named pipe that only your Windows account can open. Nothing listens on the network.
Programs running as you can use it, just as they could click around Maestro's window.

## How the Spotify side works

The Spotify desktop app is a Chromium web page that is already signed in to your account. When Spotify starts with
`--remote-debugging-port=9233`, Maestro can run code inside that page through the Chrome DevTools Protocol and use the
same internal objects Spotify's own UI uses:

- **Player:** play a specific track, pause, resume, seek, set the volume, and read the exact track and position.
  Starting a track takes under a second.
- **Search:** Spotify's own search. The query IDs it needs are read from the installed app's code, so search keeps
  working when Spotify updates.

Maestro starts Spotify with that flag when Spotify isn't running. If Spotify was already started without it, Maestro asks
before restarting it.

**Handoffs.** When a Spotify song is about to end, Maestro moves on about 0.3 s early, so Spotify's autoplay never
starts. If you skip inside Spotify or with your media keys, Maestro sees the track change and follows in its own
queue. When a YouTube or SoundCloud track ends, Maestro starts the next song directly, even if it's on Spotify.

**Security note.** While Spotify runs with the debugging port, other programs on *this computer* can control the
Spotify app through it. The port only accepts connections from this machine. If you don't want that, leave the
autostart option off; restarting Spotify normally removes the port.

## Limitations

- Windows for now; macOS and Linux support isn't available yet.
- This relies on Spotify's internal (unofficial) app code, and on SoundCloud's own site client id for search. A big
  Spotify or SoundCloud update could change those, and Maestro may need a fix when that happens.
- Spotify playlist and album imports, and SoundCloud set imports, currently include up to 100 tracks.
- Some YouTube videos block embedding. Maestro plays another upload of the same recording if there is one, and
  otherwise plays the video from youtube.com in a hidden window. It only skips videos that don't play there either
  (age-restricted, private, or taken down).
- SoundCloud Go+ exclusives and tracks that block embedding may not play.
- The window uses its own WebView2 profile (in `%LOCALAPPDATA%\Maestro`), so you aren't signed in to YouTube there.

## How it compares

| | Maestro | Soundiiz / SongShift | Nuclear | Spotube |
|---|---|---|---|---|
| **What it is** | Live streaming aggregator and player | Playlist migration tool | Open-source player | Spotify's UI with YouTube streams |
| **Plays from several services at once** | **Yes — Spotify, YouTube, SoundCloud** | No (syncs playlist metadata only) | YouTube + SoundCloud | YouTube audio only |
| **Drives the real Spotify desktop app** | **Yes** | No | No | No |
| **One queue mixed across services** | **Yes** | No | Partial | No |
| **Works with a free Spotify account** | **Yes** | Yes | — | Yes (needs a client ID) |
| **Volume normalization across sources** | **Yes** | — | Basic | Basic |
| **No API keys needed** | **Yes** | No | Yes | No |

## Frequently asked questions

### What is a music streaming aggregator app?
A music streaming aggregator app connects several streaming services in one player: you search their catalogs side by side, queue tracks from any of them together, and play everything from a single window instead of switching between apps or browser tabs. Maestro is such an app for Spotify, YouTube, and SoundCloud.

### What is Maestro?
Maestro is a universal music streaming aggregator app for Windows, free for personal use. It brings Spotify, YouTube, and SoundCloud into one desktop player with unified search, one shared queue, and automatic volume leveling across sources.

### Do I need API keys or a developer account?
No. Maestro needs no Spotify developer app, no YouTube Data API key, and no SoundCloud API registration. Install it, open it, and search.

### Do I need Spotify Premium to use Maestro?
No. Maestro plays Spotify songs through your local Spotify desktop app (via the Chrome DevTools Protocol), so a free Spotify account is enough. Use Spotify's installer from [spotify.com](https://www.spotify.com/download); the Microsoft Store version isn't supported.

### Is Maestro ad-free?
Yes. Maestro shows no ads of its own. Spotify plays through your Spotify desktop app, so patch it with [SpotX](https://github.com/SpotX-Official/SpotX) and Spotify's ads are gone too. YouTube videos that Maestro plays from youtube.com have their ads removed before they load.

### Can I mix Spotify and YouTube songs in the same playlist?
Yes. Search all three services side by side or paste links from any of them, and add every track to one queue or one Maestro playlist. Playback switches sources automatically as tracks end.

### Is Maestro free? Is it open source? Can I use it commercially?
Free for personal, noncommercial use. Maestro is source-available under [BUSL 1.1](LICENSE) rather than an OSI open-source license: its source is fully available on GitHub, but production use by a business (internal or external) requires a separate license from the author. Every release also converts automatically to GPL-2.0-or-later four years after its release — version 0.0.2 does so on 2030-11-10.

### How does Maestro handle volume differences between services?
Maestro measures the loudness of each YouTube and SoundCloud track and evens it out to match Spotify's level, so you stop reaching for the volume slider between songs.

## License

Maestro is licensed under the [Business Source License 1.1](LICENSE) (BUSL-1.1), the same license used by Terraform, CockroachDB, and Sentry:

- **Personal use is free**, permanently, including copying, modifying, and building from source.
- **Business/production use requires a separate license** from the author — [open an issue](https://github.com/QMjnh/maestro/issues) or email to request one.
- **Every release becomes GPL-2.0-or-later automatically** four years after its release. Version 0.0.2 converts on **2030-11-10**; future versions get their own Change Date.

## Project structure

```
src/Maestro/
  MainForm.cs           the window: WebView2 showing the UI; /api/* requests are answered in-process (no server/port)
  Api.cs                the API routes the UI calls
  Agent.cs              AI agent access: the pipe the app listens on, `Maestro.exe mcp` (MCP server), `Maestro.exe agent`
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
  Store.cs              settings + playlists in %APPDATA%\Maestro
  NativeMethods.cs      Win32 calls (window hiding, single instance, dark title bar)
  wwwroot/              the player UI (plain HTML/CSS/JS), embedded in the exe; agent.js runs agents' tool calls
install.ps1             the one-line installer / updater / uninstaller
.github/workflows/      release.yml: builds Maestro-win-x64.exe for each v* tag
tools/make-icon.ps1     regenerates maestro.ico
```

## Build from source

Needs the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

```
dotnet run --project src\Maestro                               # run it
dotnet publish src\Maestro -c Release -o dist                  # build dist\Maestro.exe
.\install.ps1 -ExePath dist\Maestro.exe                        # install your build
```

To publish a release: push a tag like `v0.0.2` (or run the *Release* workflow from the Actions tab).
