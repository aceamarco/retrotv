# Retro TV

A simulated linear TV, in the spirit of myretrotvs.com, but each channel plays
full-length episodes with commercial breaks streamed directly from the
Internet Archive instead of short YouTube clips.

Every channel has a deterministic schedule derived from the wall clock, so
tuning in drops you mid-episode or mid-commercial, and everyone watching the
same channel sees the same thing.

## Run it

```sh
python3 -m http.server 8080      # any static server works
open http://localhost:8080
```

Static files only. Deploy by copying `index.html`, `style.css`, `app.js` and
`channels.json` anywhere (GitHub Pages, a droplet with nginx, etc).

## Lineup

Channels 2-20 are 2000s kids' TV (Disney Channel 2003-2008 shows, Catscratch,
¡Mucha Lucha!, and more). Channels 21-27 are decade channels (1950s through
1990s, plus off-air 80s and 90s Saturday-morning blocks). Channel 28 is
sports (Monday Night Football, Super Bowls, NBA Finals, 1986 World Series,
NHL, WWF, SportsCenter) and 29 is news (local newscasts, network evening
news, Dateline, 20/20, 48 Hours). Each decade channel cuts its commercial
breaks from an ad pool of the same decade.

## Change the lineup

1. Edit `channels.config.json`. A channel is a list of archive.org item
   identifiers, with an optional `match` regex on file names inside the item.
   Entries with `"kind": "ads"` are named ad pools. Channel options:
   `era` (label), `ads` (pool name or list; default is every pool),
   `breaks: false` (recording already contains its commercials, play it
   straight through), `ordered: true` (play files in name order, for
   multi-part games, instead of shuffling).
2. Rebuild the playlist: `python3 build_channels.py` (add `--refresh` to
   bypass the metadata cache in `.ia_cache/`).

The build script asks the archive.org metadata API for each item, keeps one
browser-safe h.264 MP4 per video (preferring the archive's own `.ia.mp4`
derivatives, skipping HEVC originals), and writes `channels.json`.

## Controls

Up/Down: channel · Left/Right: volume · digits: direct tune · M: mute ·
F: fullscreen · G: guide · P: power · click the screen: next channel.
