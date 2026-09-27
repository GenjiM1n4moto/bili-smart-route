# Bilibili Smart Route · B站智能选路

[简体中文](README.md) | **English** | [日本語](README.ja.md)

**Smooth Bilibili playback outside mainland China — no more stalls on obscure videos or high-bitrate 4K.** A Tampermonkey / Violentmonkey userscript that measures, for each video file, whether the CDN edge has it cached. Cached files stay on Bilibili's native overseas edge; cold ones switch to mainland mirrors, fetched from several mirrors in parallel with read-ahead to make full use of the cross-border link.

MIT License

---

## Who it's for

People watching Bilibili from outside mainland China whose popular videos play fine but **obscure videos, old uploads and 4K keep buffering**. The developer builds and tests this in **Japan**; other regions may be assigned different edges and see different results — reports are welcome. It has not been tested on networks inside mainland China, where it is usually not needed.

## Why obscure videos stall

Bilibili serves viewers abroad from overseas CDN edges (e.g. `upos-sz-mirrorcosov`, Akamai):

| Edge state | Measured speed |
|---|---|
| Overseas edge **has it cached** (popular, recently watched) | 100–280 Mbps, first byte in 30–80 ms |
| Overseas edge **cache miss** (obscure, unwatched parts) | 0.7–6 Mbps, fetched across the border from origin |
| Mainland mirrors (hw / ali / cos …, origin side, always have the file) | 10–75 Mbps per connection, first byte in 0.1–2 s, varies a lot by hour |

4K needs 7–30 Mbps. So an obscure video on an overseas edge is bound to stall, while forcing a popular video onto a mainland mirror only makes it slower.

Typical accelerator scripts either probe only the **start** of a file (which is almost always cached, so everything looks "fast"), or force every video onto one node (slowing down the ones that were already fast).

## How it works

1. **Per-file decision, probing the end, not the start.** Before the first large segment of a file, it probes the **end** of that exact range on the native edges Bilibili assigned. Cached → stay on the native edge; popular videos are untouched.
2. **Lookahead.** While on a native edge, it keeps probing about 15 s ahead of playback and switches before a cold region stalls the player.
3. **Mainland fallback.** Candidates are Bilibili's official UPOS mirrors (they accept the same signed URLs), ranked by measured effective throughput including first-byte latency, and verified with a small request before switching.
4. **Parallel mirrors + read-ahead.** On the mainland route, the video file is fetched in 2 MB blocks from up to 3 mirrors at once, reading about 20 s ahead (up to 64 MB); the player's requests are answered from memory. A block that stops moving for 3 s is re-fetched from another mirror.
5. **Safety net.** If the player errors, or parallel fetches fail 3 times within a minute, that page falls back to plain requests.

## Test environment

- **Region:** Japan, home broadband. All development and testing was done by the developer in Japan.
- **Browser:** Chrome + Tampermonkey 5.5, signed in with a premium account (4K available).
- **Native edges assigned by Bilibili:** Japanese IPs get `upos-sz-mirrorcosov` (Tencent Cloud overseas) + `upos-hz-mirrorakam` (Akamai); no PCDN/P2P nodes were seen during testing.
- **Mainland mirrors:** 10–75 Mbps per connection, first byte in 0.1–2 s. Tests ran late at night mainland time (about 23:00–02:00), and the same mirror dropped from 60–75 Mbps to 10–30 Mbps within an hour — the cross-border link fluctuates a lot.

Other regions (North America, Europe, Southeast Asia, Hong Kong / Macau / Taiwan) may be assigned different native edges and cross-border routes. If you use it elsewhere, panel screenshots in Issues help tune the defaults.

## Results

In the Japanese environment above (mainland mirrors were at about 10–30 Mbps per connection at the time):

| Video | Without the script / single-node switching | This script |
|---|---|---|
| Obscure 4K AV1 (7.7 Mbps) | Native edge at 0–6 Mbps, stalls from the start | Switched to mainland, ~40 Mbps, 50 s+ buffered ahead |
| Obscure 4K AVC (29.7 Mbps) | A single mainland mirror barely keeps up; buffer drops from 19 s to 3 s | Parallel mirrors: **0 stalls, 0 of 1822 frames dropped, 30 s+ buffered ahead** |
| Popular video | — | Native edge has it cached; direct, same as without the script |

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. **Required on Chrome / Edge 138 and later:** open `chrome://extensions` (Edge: `edge://extensions`) → Tampermonkey → **Details** → turn on **"Allow User Scripts"**. With this switch off, no userscript runs at all (the Tampermonkey icon also shows a warning).
3. Click **[Install latest](https://github.com/GenjiM1n4moto/bili-smart-route/releases/latest/download/bili-smart-route.user.js)** and the userscript manager opens its install page. Installed this way, the script auto-updates with each [Release](https://github.com/GenjiM1n4moto/bili-smart-route/releases). You can also create a new script in the manager and paste the file in, but then it will not auto-update.
4. If you use Bilibili Accelerator (realzza) or another script that rewrites Bilibili video requests, turn it off and keep only one.

## Usage

Open any video and a translucent **⚡** label appears at the bottom left. The on-page label and panel are in Chinese:

- 🟢 **原生** (native): the overseas edge has it cached; direct.
- 🟠 **大陆** (mainland): switched to mainland mirrors; with several mirrors it shows e.g. `hw+ali`.

Click it to open the panel: the current file's route and speed, measured throughput of each mainland mirror, the switch log, and three buttons — 「暂停脚本」 (pause script), 「多镜像并行 开/关」 (parallel mirrors on/off) and 「清空镜像统计」 (reset mirror stats). The label hides in fullscreen.

**4K tip:** in the player settings, set the preferred video codec to AV1 or HEVC. The same 4K video needs 17–30 Mbps in AVC but only 6–13 Mbps in AV1/HEVC.

## FAQ

**No ⚡ label at the bottom left?** Check, in order:

1. **Is "Allow User Scripts" on?** On Chrome / Edge 138 and later, if "Allow User Scripts" is off on the extension's Details page, the script does not run at all. See step 2 of Install.
2. **Is the script enabled?** On a Bilibili video page, click the Tampermonkey icon in the toolbar; the menu should list "B站智能选路 Bilibili Smart Route" with its switch on (green).
3. **Right site?** The script runs only on `bilibili.com`; the international site `bilibili.tv` is not supported.
4. **Still not sure?** On a video page, press F12 to open the console and enter `window.__BAX__ && __BAX__.version`:
   - prints a version number: the script is running; the label is just faint and becomes clear when you hover the bottom-left corner;
   - prints `undefined`: the script is not running; go back to steps 1 and 2.

## Settings

**No configuration is needed.** The values below are the defaults and apply as soon as the script is installed. To change one, set only that key, e.g. `JSON.stringify({ readAheadMaxMB: 128 })`. Settings are stored in the Bilibili site's browser storage and survive reinstalling or updating the script.

Run in the console on `www.bilibili.com`, then reload:

```js
localStorage.setItem('bax.cfg.v1', JSON.stringify({
  multi: true,          // parallel mirrors + read-ahead on the mainland route
  multiHosts: 3,        // mainland mirrors used at the same time
  readAheadSec: 20,     // seconds to read ahead
  readAheadMaxMB: 64,   // read-ahead cap (MB)
  storeCapMB: 192,      // memory per tab for fetched video blocks (MB)
  hotMinMbps: 12,       // a native edge probing above this (and enough for the bitrate) counts as cached
  ui: true              // show the bottom-left label
}));
```

`{"enabled": false}` turns the script off completely (the panel can also pause it with one click).

## Traffic and resources

- About 0.5–1 MB of extra probing when a large file starts; on a native edge, an extra 256 KB probe roughly every half probe window of progress.
- The mainland route reads up to 64 MB ahead, with up to 2 requests to each of up to 3 mirrors at once.
- Each tab uses at most about 192 MB of memory for fetched blocks; beyond that, already-played parts are dropped first.

## Privacy

- Collects and uploads nothing; talks only to Bilibili's own CDN hosts.
- Mirror speed stats stay in your browser (`localStorage`, key `bax.stats.v1`).
- The diagnostic command `__BAX__.dump()` prints only host names and stats, never signed video URLs, so it is safe to paste into an issue.

## Limitations and known issues

- Tested mainly abroad on regular uploads at 1080p–4K; bangumi (anime), courses, players embedded on other sites and networks inside mainland China are not well tested. Live streams are left alone.
- Depends on the current web player loading segments via main-thread XHR; a Bilibili player update could break it (the safety net falls back to plain requests).
- Bilibili only loads video while the tab is visible; stalls in background tabs are unrelated to this script.
- The mainland mirror list is hard-coded and needs updating if a host goes away.
- The on-page label and panel are Chinese only.

## Reporting issues

Please open an [issue](https://github.com/GenjiM1n4moto/bili-smart-route/issues) with the video's BV id, the quality and codec, and a screenshot of the panel's switch log (「切换记录」) or the output of `JSON.stringify(__BAX__.dump())` from the console.

## Acknowledgements

Inspired by [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator) (MIT); the code of this project is written independently.

## License

[MIT](LICENSE)
