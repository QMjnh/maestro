<img src="src/Maestro/wwwroot/icon.svg" width="64" height="64" alt="">

# Maestro

One player for **Spotify**, **YouTube**, and **SoundCloud**. Search all three side by side, paste links from any of
them, and build one queue or playlist that mixes them. Maestro switches between sources automatically as tracks end.

- **Spotify** plays through your **Spotify desktop app** (SpotX works great), so a free account is all you need.
  There are no API keys and no Premium requirement: Maestro uses the app's own player and search (details below).
- **YouTube** plays in YouTube's embedded player inside Maestro's window. Search needs no API key.
- **SoundCloud** plays in SoundCloud's embedded player inside Maestro's window. Search needs no API key.

**You only open Maestro.** It starts Spotify in the background and closes it again when you quit. Want Spotify's own
window? Open Spotify like you normally would: it shows up, and from then on it's yours (Maestro won't hide or close it).

## Install

Paste this into PowerShell (Windows 10/11, no admin needed):

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
| **Search** | Type to search Spotify, YouTube, and SoundCloud at once. Use the *All / Spotify / YouTube / SoundCloud* filter to show one source. |
| **Paste a link** | Spotify tracks, albums, and playlists; YouTube videos and playlists; SoundCloud tracks and sets. You can play everything, add it to the queue, or save it as a Maestro playlist. |
| **Queue** | Drag to reorder. Includes shuffle and repeat (all / one). |
| **Autoplay** | When the queue runs low, Maestro adds recommendations so the music never stops: Spotify's song radio, YouTube's Mix, SoundCloud related tracks, or all of them interleaved (*Queue → Autoplay: Off / Same app / All apps*). Songs you add always play before autoplay's picks. |
| **Playlists** | Stored in `%APPDATA%\Maestro\playlists.json`. Add tracks from the ⋯ menu, or drag a track onto a playlist in the sidebar. |
| **Volume** | A single slider controls YouTube, Spotify, and SoundCloud. |
| **Keys** | `Space` play/pause · `Ctrl+←/→` previous/next · `Shift+←/→` seek ±10s · `/` or `Ctrl+K` search |

Settings has switches for *Keep Spotify's window hidden* and *Close Spotify when Maestro closes* (both on by default).
Both only apply to a Spotify that Maestro started and that you haven't opened yourself. A Spotify you start is never
hidden or closed by Maestro.

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

- Windows only.
- This relies on Spotify's internal (unofficial) app code, and on SoundCloud's own site client id for search. A big
  Spotify or SoundCloud update could change those, and Maestro may need a fix when that happens.
- Spotify playlist and album imports, and SoundCloud set imports, include up to 100 tracks.
- Some YouTube videos block embedding. Maestro tells you and skips them.
- SoundCloud Go+ exclusives and tracks that block embedding may not play.
- The window uses its own WebView2 profile (in `%LOCALAPPDATA%\Maestro`), so you aren't signed in to YouTube there.

## Layout

```
src/Maestro/
  MainForm.cs           the window: WebView2 showing the UI; /api/* requests are answered in-process (no server/port)
  Api.cs                the API routes the UI calls
  SpotifyApp.cs         drives the Spotify app: start hidden, connect, player, search, restart, autostart, exit
  inject.js             the code Maestro runs inside Spotify's page
  Radio.cs              autoplay recommendations (Spotify song radio, YouTube Mix, SoundCloud related, or all)
  SpotifyLinks.cs       Spotify link parsing and metadata (public embed pages)
  YouTube.cs            YouTube link parsing, search, playlists
  SoundCloud.cs         SoundCloud link parsing, search, related tracks
  Store.cs              settings + playlists in %APPDATA%\Maestro
  NativeMethods.cs      Win32 calls (window hiding, single instance, dark title bar)
  wwwroot/              the player UI (plain HTML/CSS/JS), embedded in the exe
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
