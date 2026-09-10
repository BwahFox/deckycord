# AI Disclousre
Tools such as Claude Code were heavily used in the production of this project.

# Deckycord

Discord inside Steam's Gamepad UI, driven entirely with a controller: voice chat, text chat,
notifications, DM calls, friend requests, watching friends' streams, and Go Live screensharing of
the game you are playing. A hidden [Vesktop](https://github.com/Vencord/Vesktop) runs on a virtual
display and the plugin talks to it over the Chrome DevTools protocol; the Quick Access menu widens
into a two-pane chat that feels like Steam's own Friends tab, so replying never means leaving the
game.

Works on the Steam Deck (SteamOS) and on desktop-mode-free HTPCs running Bazzite or similar.

> Deckycord drives a modified Discord client (Vesktop/Vencord). Discord's terms of service forbid
> modified clients. In practice Discord tolerates Vencord, but use it at your own risk.

## Features

- **Overlay chat** in the Quick Access menu: DMs, friends, servers and channels on the left, the
  conversation on the right. L1/R1 switch tabs, L2 jumps to the Call button, R2 to the newest message.
- **Voice**: join/leave channels, DM and group calls (answer from a toast), mute, deafen, speaking
  indicators, mic and output device pickers.
- **Voice / game mix**: a PS5-style slider that balances voice chat against game audio, or mutes
  either. Applied per stream in PipeWire, and re-applied to games launched later.
- **Mic level stays put**: Discord's WebRTC is prevented from changing the microphone volume, so
  Steam's mic slider is the only control (toggle in Audio if you want Discord's auto gain back).
- **Notifications**: Steam toasts for DMs, mentions, calls, friend requests and friends going live.
  Clicking one opens the conversation in the overlay.
- **Go Live**: share the whole screen with game audio (720p30 by default). The stream pauses while
  a game launches and resumes 20 s later.
- **Watch streams and cameras** from friends in your voice channel, full screen.
- **Friend requests**: accept, decline, cancel, and add by username.
- **Login by QR code** with the Discord phone app.

## Requirements

- [Decky Loader](https://decky.xyz/)
- The Vesktop flatpak, installed **per user**: `flatpak install --user flathub dev.vencord.Vesktop`
- ffmpeg with `kmsgrab` and VAAPI, GStreamer (`v4l2src`/`ximagesink`), PipeWire. SteamOS and
  Bazzite ship these.
- Optional: `v4l2loopback` (camera-mode sharing fallback on distros that have it).

The plugin runs as root (Decky's `root` flag) because screen capture via `kmsgrab` needs it.

## Install

1. Download `deckycord.zip` from the latest [release](https://github.com/BwahFox/deckycord/releases).
2. In Decky's settings enable developer mode, then **Install plugin from zip/URL**.
3. Install the Vesktop flatpak (see above) if you have not already.
4. Open the Deckycord tab in the Quick Access menu and scan the QR code with Discord on your phone.

## Controls

| Where | Button | Action |
| --- | --- | --- |
| Overlay | L1 / R1 | Previous / next tab (DMs, Friends, Servers, Voice, Settings) |
| Overlay | L2 | Call button (DM) or top of the conversation |
| Overlay | R2 | Newest message |
| Overlay, Friends | A / X | Accept / decline a request; A on a friend opens the DM |
| Overlay, Servers | A / X | Join voice / open the voice channel's text chat |
| Full page | L1 / R1 | Move between panes |
| Full page | Y | Jump to the voice controls |

The full-page chat (Settings → Open full page) is where streams and cameras are watched.

## Building from source

```
pnpm install
pnpm build
```

`./deploy.sh user@host` installs onto a machine with passwordless sudo; `./deploy-deck.sh deck@host`
installs onto a Steam Deck through Decky's own installer (no sudo needed on the Deck).

## How it works

- `main.py` (Decky backend): process management for Xvfb + Vesktop as transient systemd user
  units, a minimal DevTools client, screenshare orchestration, PipeWire volume control.
- `py_modules/bridge.js`: injected into the Vesktop page; exposes `window.__dc` over Discord's
  internal stores (found through Vencord's webpack helpers) and forwards events to the backend.
- `src/`: the React frontend. `Overlay.tsx` is the Quick Access chat, `ChatPage.tsx` the full page,
  `useChat.ts` the shared logic, `qam.ts` the trick that widens the Quick Access menu (it flips the
  same "friends chat expanded" state Steam's own Friends tab uses).
- `py_modules/capture.sh` + `grabloop.py`: `kmsgrab` capture of the real display, VAAPI scaled,
  fed to Vesktop either as a v4l2 camera or drawn onto the hidden display.

## Please report issues

Deckycord leans on Discord's and Vesktop's internals, which change without notice. If something
stops working after a Discord or Vesktop update, or on hardware I do not have, **please open an
[issue](https://github.com/BwahFox/deckycord/issues)** with what you did, what happened, and the
plugin log from `~/homebrew/logs/deckycord/`. Reports are what keep this working.

## Known limitations

- Vesktop's software H.264 encoder is the main CPU cost while streaming. 720p30 is the default;
  lower it if your game suffers.
- Viewers see a laggy minute after a game launch while the encoder ramps back up.
- Only the newest 50 messages load at first; older history loads as you scroll up.
- Go Live and stream watching use a few of Discord's DOM elements (matched by text, never by
  position); a Discord redesign could require an update.

## Licence

GPL-3.0. See [LICENSE](LICENSE).
