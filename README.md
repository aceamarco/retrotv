# Retro TV

A simulated linear TV, in the spirit of myretrotvs.com, but each channel plays
full-length episodes with commercial breaks streamed directly from the
Internet Archive instead of short YouTube clips.

Every channel has a deterministic schedule derived from the wall clock, so
tuning in drops you mid-episode or mid-commercial, and everyone watching the
same channel sees the same thing.

Live at **https://aceamarco.github.io/retrotv/** (GitHub Pages, deployed from
the `main` branch root; every push to `main` redeploys). Deep-link a channel
with `?ch=8`.

## Run it locally

```sh
python3 -m http.server 8080      # any static server works
open http://localhost:8080
```

Static files only. Deploy by copying `index.html`, `style.css`, `app.js` and
`channels.json` anywhere (GitHub Pages, a droplet with nginx, etc).

## Lineup

Channels are themed brands rather than networks or single shows, the way
satellite radio names its music stations. Each has a brand color that shows
in the guide and the on-screen channel display.

| # | Brand | Theme |
|---|---|---|
| 2 | Laugh Track | 2000s live-action tween sitcoms |
| 3 | Ink & Paint | 2000s cartoons |
| 4 | Latchkey | 1990s weekday-afternoon cartoons |
| 5 | The 1950s | The 1950s |
| 6 | The 1960s | The 1960s |
| 7 | The 1970s | The 1970s |
| 8 | The 1980s | The 1980s |
| 9 | The 1990s | The 1990s |
| 10 | Cereal Bowl | 1980s Saturday mornings, off-air with original commercials |
| 11 | Sugar Rush | 1990s Saturday mornings, off-air with original commercials |
| 12 | Tape Deck | 2000-2005 after-school action blocks, off-air |
| 13 | Power Level | Shonen action anime dubs |
| 14 | Starlight | Magical-girl and space anime dubs |
| 15 | Graveyard Shift | Anthology horror and Halloween blocks |
| 16 | Cheap Seats | Classic games: NFL, NBA, MLB, NHL, wrestling |
| 17 | Eleven O'Clock | Off-air local and network newscasts, newsmagazines |
| 18 | Morphin Time | Power Rangers, Mighty Morphin through Time Force |
| 19 | Cul-de-Sac | Ed, Edd n Eddy, all seasons, specials and the movie |
| 20 | Cartoon Cartoons | Cartoon Network originals: Powerpuff Girls, Johnny Bravo, Courage, Cow and Chicken, I Am Weasel, Billy & Mandy |

The decade channels sit on the matching dial position (the 1950s on 5, the
1960s on 6, and so on) and cut their commercial breaks from an ad pool of
the same decade. Off-air channels play the recordings straight through since
the tapes already contain their commercials.

## Change the lineup

1. Edit `channels.config.json`. A channel is a list of archive.org item
   identifiers, with an optional `match` regex on file names inside the item.
   Entries with `"kind": "ads"` are named ad pools. Channel options:
   `era` (label), `group` (guide section), `color` (brand color),
   `ads` (pool name or list; default is every pool),
   `breaks: false` (recording already contains its commercials, play it
   straight through), `ordered: true` (play files in name order, for
   multi-part games, instead of shuffling).
2. Rebuild the playlist: `python3 build_channels.py` (add `--refresh` to
   bypass the metadata cache in `.ia_cache/`).

The build script asks the archive.org metadata API for each item, keeps one
browser-safe h.264 MP4 per video (preferring the archive's own `.ia.mp4`
derivatives, skipping HEVC originals), and writes `channels.json`.

## TV sets

The picker in the control panel (or the T key) swaps the CSS cabinet for a
television set image, one per decade from the 1950s to the 2000s. "Auto"
switches the set to match the decade of whatever channel is tuned. The
default is the classic CSS cabinet. `?tv=1980s` deep-links a set.

The set images were generated with Gemini against a green backdrop with a
flat magenta screen (see the prompts in the project history). To add or
replace one, drop the image in `frames/src/<id>.jpeg` and run
`python3 frames/build_frames.py`: it keys the backdrop, finds the screen,
cuts a transparent hole, and rewrites `frames/frames.json` with each set's
aspect ratio and screen rectangle.

## Android TV / Google TV app

`android/` is a small app that opens the live site in TV mode (`?mode=tv`:
full-bleed picture, no cabinet, remote-only controls) in a full-screen
WebView. Lineup changes pushed to `main` reach the TV without a reinstall;
only changes under `android/` need a new APK.

```sh
android/build.sh                 # builds in Docker, no JDK or Android SDK needed
adb connect <tv-ip>              # TV: developer options > USB debugging on
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Remote: Up/Down channel · OK guide · digits direct tune · Left/Right show
now/next. In the guide: Up/Down pick a channel · Left/Right move through
time · OK tune · Back close. Back outside the guide exits.

To try a local copy of the site on an emulator, build with
`android/build.sh -PstartUrl=http://10.0.2.2:8080/?mode=tv`.

## Controls

Up/Down: channel · Left/Right: volume · digits: direct tune · M: mute ·
F: fullscreen · G: guide · P: power · T: next TV set (Shift+T previous) ·
click the screen: next channel.
