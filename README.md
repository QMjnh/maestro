<img src="public/icon.svg" width="64" height="64" alt="">

# Maestro

One player for **Spotify** and **YouTube**. Search both side by side, paste links from either, and build one
queue or playlist that mixes them. Maestro switches between the two automatically as tracks end.

- **Spotify** plays through your **Spotify desktop app** (SpotX works great), so a free account is all you need.
  There are no API keys and no Premium requirement: Maestro uses the app's own player and search (details below).
- **YouTube** plays in YouTube's embedded player inside Maestro's window. Search needs no API key.

## Run it

Requirements: Windows 10/11, [Node.js 18+](https://nodejs.org), and the Spotify desktop app. No `npm install` needed.

```
Maestro.cmd            (double-click it), or:
npm start
```

Maestro opens in its own app window at <http://localhost:5454>. To use your normal browser instead, run
`npm run serve` and open that URL yourself. Use the `PORT` environment variable to change the port.

**First time:** if Spotify is already open, Maestro asks once to restart it with Maestro support (it reopens minimized).
To skip that step in the future, turn on *Settings → Start Spotify with Maestro support when Windows starts*.

## Using it

| | |
|---|---|
| **Search** | Type to search Spotify and YouTube at once. Use the *All / Spotify / YouTube* filter to show one source. |
| **Paste a link** | Spotify tracks, albums, and playlists, and YouTube videos and playlists. You can play everything, add it to the queue, or save it as a Maestro playlist. |
| **Queue** | Drag to reorder. Includes shuffle and repeat (all / one). |
| **Playlists** | Stored locally in `data/playlists.json`. Add tracks from the ⋯ menu, or drag a track onto a playlist in the sidebar. |
| **Volume** | A single slider controls both YouTube and Spotify. |
| **Keys** | `Space` play/pause · `Ctrl+←/→` previous/next · `Shift+←/→` seek ±10s · `/` or `Ctrl+K` search |

## How the Spotify side works

The Spotify desktop app is a Chromium web page that is already signed in to your account. When Spotify starts with
`--remote-debugging-port=9233`, Maestro can run code inside that page through the Chrome DevTools Protocol and use the
same internal objects Spotify's own UI uses:

- **Player:** play a specific track, pause, resume, seek, set the volume, and read the exact track and position.
  Starting a track takes under a second, and the Spotify window never jumps to the front.
- **Search:** Spotify's own search. The query IDs it needs are read from the installed app's code, so search keeps
  working when Spotify updates.

Maestro starts Spotify with that flag when Spotify isn't running. If Spotify was already started without it, Maestro asks
before restarting it. It never closes Spotify on its own.

**Handoffs.** When a Spotify song is about to end, Maestro moves on about 0.3 s early, so Spotify's autoplay never
starts. If you skip inside Spotify or with your media keys, Maestro sees the track change and follows in its own
queue. When a YouTube video ends, Maestro starts the next Spotify track directly.

**Security note.** While Spotify runs with the debugging port, other programs on *this computer* can control the
Spotify app through it. The port only accepts connections from this machine. If you don't want that, leave the
autostart option off; restarting Spotify normally removes the port.

## Limitations

- Spotify control is Windows-only.
- This relies on Spotify's internal (unofficial) app code. A big Spotify update could change it, and Maestro may need
  a fix when that happens.
- Spotify playlist and album imports from a link include up to 100 tracks.
- Some YouTube videos block embedding. Maestro tells you and skips them.
- The app window uses its own Edge profile (in `data/edge-profile`), so autoplay works when a Spotify track hands
  off to YouTube. You aren't signed in to YouTube there. Use `npm run serve` with your own browser if you prefer.

## Layout

```
server.js               local web server + API (Node, no dependencies)
lib/spotify-app.js      connects to the Spotify app: player, search, volume, restart, autostart
lib/ws.js               tiny WebSocket client for the DevTools connection
lib/launch.js           starts Spotify/Edge without them holding Maestro's port open
lib/spotify.js          Spotify link parsing and metadata (public embed pages)
lib/youtube.js          YouTube link parsing, search, playlists
lib/store.js            settings + playlists in ./data
public/                 the player UI (plain HTML/CSS/JS)
```
