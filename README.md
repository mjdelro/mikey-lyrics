# mikey lyrics

A desktop lyrics widget for **Rainmeter (Windows)** and **GNOME Shell (Linux)** that displays synchronous (time-synced) and plain lyrics from [LRCLIB](https://github.com/tranxuanthang/lrclib) with media controls.

## Install

### Windows (Rainmeter)

1. Download and install [Rainmeter](https://www.rainmeter.net/).
2. Download the `.rmskin` file from this project's [latest release](https://github.com/mjdelro/mikey-lyrics/releases/latest).
3. Open the file with Rainmeter's skin installer.

The skin works directly with [supported desktop media players](https://github.com/ModernFlyouts-Community/ModernFlyouts/blob/main/docs/GSMTC-Support-And-Popular-Apps.md). For browser playback, install and configure the [WebNowPlaying browser extension](https://wnp.keifufu.dev/extension/getting-started).

### Linux (GNOME Shell Desktop Widget — GNOME 45–51)

1. Download `mikey-lyrics@michaeldelrosar.io.shell-extension.zip` from the [latest release](https://github.com/mjdelro/mikey-lyrics/releases/latest) (or from `gnome-extension/` in this repo).
2. Install and enable it:
   ```bash
   gnome-extensions install --force mikey-lyrics@michaeldelrosar.io.shell-extension.zip
   gnome-extensions enable mikey-lyrics@michaeldelrosar.io
   ```
   *(On Wayland, log out and back in if GNOME Shell doesn't pick up the newly installed extension immediately.)*

The GNOME desktop widget uses native **MPRIS2** over D-Bus, working out of the box with Spotify, Firefox, Chrome/Chromium, Rhythmbox, Amberol, VLC, mpv, and other MPRIS-compatible players. Drag the widget anywhere on your desktop, or use the top-bar icon / Extensions app to adjust sync offset, opacity, size, and lock position.

## Matching lyrics

LRCLIB identifies a song from its artist, track, album, and total duration. Lyrics may not appear if the media player reports any of those values incorrectly.

## Credits

The bundled WebNowPlaying plugin is by keifufu. Lyrics are provided by LRCLIB, created by tranxuanthang.

## Support
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S67WS0V)

## Screenshots
<p align="center">
  <img src="https://i.imgur.com/VHqUr9l.png">
  <br>
  <img src="https://i.imgur.com/8QfY2ij.png" height="400">  
  <img src="https://i.imgur.com/dVxfL3k.png" height="400"> 
</p>
