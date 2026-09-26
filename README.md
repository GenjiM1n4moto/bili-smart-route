# B站智能选路 · Bilibili Smart Route

**海外看 B 站，冷门视频和高码率 4K 不再卡。** 一个 Tampermonkey / Violentmonkey 用户脚本：按每个视频文件实测 CDN 缓存的冷热，有缓存就走 B 站原生海外节点，没有就改走大陆镜像，并用多镜像并行 + 预读把跨境带宽用满。

[English](#english) · MIT License

---

## 适合谁

在海外看 B 站、热门视频流畅但**冷门视频、老视频、4K 经常转圈**的人。开发者本人在**日本**开发和测试；其他地区 B 站分配的节点可能不同，效果也可能不同，欢迎反馈。国内网络下没有测试过，通常也不需要。

## 为什么冷门视频会卡

B 站给海外用户分配的是海外 CDN 节点（例如 `upos-sz-mirrorcosov`、Akamai）：

| 节点状态 | 实测速度 |
|---|---|
| 海外节点**有缓存**（热门、有人看过） | 100–280 Mbps，首包 30–80 ms |
| 海外节点**没缓存**（冷门、没人看过的片段） | 0.7–6 Mbps，要跨境回源 |
| 大陆镜像（hw / ali / cos …，源站侧，一定有货） | 单连接 10–75 Mbps，首包 0.1–2 s，随时段波动大 |

4K 需要 7–30 Mbps。所以冷门视频落在海外节点上就必卡；而热门视频如果被强行换到大陆，反而更慢。

常见的加速脚本要么只测文件**开头**一小段（开头几乎总有缓存，于是误判"很快"），要么一刀切强制换节点（把本来很快的也换慢了）。

## 这个脚本怎么做

1. **按文件判断，测末尾不测开头。** 播放器要下载某个文件的第一大段时，先对 B 站给的原生节点测这一段的**末尾**。有缓存就直连原生节点，热门视频完全不受影响。
2. **提前探测。** 走原生节点时，持续探测播放位置前方约 15 秒的位置；发现冷区，在卡住之前就切走。
3. **冷了走大陆镜像。** 候选是 B 站官方的 upos 镜像（签名通用），按本机实测的有效吞吐（含首包延迟）排序，切换前先发小请求验证可用。
4. **多镜像并行 + 预读。** 大陆线路上的视频文件按 2 MB 分块，同时从最多 3 个镜像下载，并提前读约 20 秒（最多 64 MB），播放器来要数据时直接从内存交付。某一块 3 秒没进度就换镜像重下。
5. **自动保护。** 播放器报错，或一分钟内并行下载失败 3 次，本页自动退回普通请求。

## 测试环境

- **地区**：日本，家庭宽带。开发者本人在日本完成全部开发和测试。
- **浏览器**：Chrome + Tampermonkey 5.5，已登录大会员账号（可播 4K）。
- **B 站分配的原生节点**：日本 IP 拿到的是 `upos-sz-mirrorcosov`（腾讯云海外）+ `upos-hz-mirrorakam`（Akamai），测试期间没有遇到 PCDN / P2P 节点。
- **大陆镜像**：单连接 10–75 Mbps，首包 0.1–2 s。测试时段是大陆时间深夜（约 23:00–02:00），同一个镜像一小时内就从 60–75 Mbps 掉到 10–30 Mbps，跨境线路波动很大。

其他地区（北美、欧洲、东南亚、港澳台）B 站给的原生节点、跨境线路都可能不一样。如果你在别的地区用，欢迎在 Issues 里反馈面板截图，帮助调整默认参数。

## 实测

在上面的日本环境里（大陆各镜像当时单连接约 10–30 Mbps）：

| 视频 | 不装脚本 / 只换单个节点 | 本脚本 |
|---|---|---|
| 冷门 4K AV1（7.7 Mbps） | 原生节点 0–6 Mbps，起播就卡 | 切到大陆，约 40 Mbps，缓冲领先 50 s+ |
| 冷门 4K AVC（29.7 Mbps） | 单个大陆镜像只能勉强持平，缓冲从 19 s 掉到 3 s | 多镜像并行：**0 次卡顿，1822 帧 0 掉帧，缓冲稳定领先 30 s+** |
| 热门视频 | — | 原生节点有缓存，直连，和不装一样 |

## 安装

1. 装好 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。Chrome 138+ 需要在扩展详情页打开「允许用户脚本」。
2. 点 **[安装最新版](https://github.com/GenjiM1n4moto/bili-smart-route/releases/latest/download/bili-smart-route.user.js)**，脚本管理器会弹出安装页。这样装的脚本会跟着 [Releases](https://github.com/GenjiM1n4moto/bili-smart-route/releases) 自动更新。也可以在管理器里「新建脚本」，把文件内容粘贴进去保存，但这样不会自动更新。
3. 如果装了 Bilibili Accelerator（realzza）之类同样改写视频请求的脚本，请关掉它，只留一个。

## 使用

打开任意视频，左下角会出现半透明的 **⚡** 标签：

- 🟢 **原生**：B 站海外节点有缓存，直连。
- 🟠 **大陆**：已改走大陆镜像；同时用多个镜像时显示为 `hw+ali`。

点一下展开面板：当前文件的路线和速度、各大陆镜像的实测吞吐、切换记录，以及「暂停脚本」「多镜像并行 开/关」「清空镜像统计」三个按钮。全屏时标签自动隐藏。

**4K 建议：** 在播放器设置里把视频编码偏好改成 AV1 或 HEVC。同一个 4K 视频，AVC 要 17–30 Mbps，AV1/HEVC 只要 6–13 Mbps。

## 设置

在 `www.bilibili.com` 的控制台里执行，然后刷新：

```js
localStorage.setItem('bax.cfg.v1', JSON.stringify({
  multi: true,          // 大陆线路多镜像并行 + 预读
  multiHosts: 3,        // 同时使用的大陆镜像数
  readAheadSec: 20,     // 预读多少秒
  readAheadMaxMB: 64,   // 预读上限
  storeCapMB: 192,      // 每个标签页用于缓存视频块的内存上限
  hotMinMbps: 12,       // 原生节点测速高于此值（且足够当前码率）才算"有缓存"
  ui: true              // 是否显示左下角标签
}));
```

只写想改的项即可。`{"enabled": false}` 可完全停用（面板里也能一键暂停）。

## 流量与资源

- 每个大文件起播时额外测速约 0.5–1 MB；走原生节点时，每前进约半个探测窗口额外探测 256 KB。
- 大陆线路会预读，最多超前 64 MB；同时对最多 3 个镜像各开 2 个请求。
- 每个标签页最多占用约 192 MB 内存缓存视频块，超出会先丢弃已播放过的部分。

## 隐私

- 不收集、不上传任何数据，只访问 B 站自己的 CDN 域名。
- 镜像测速统计只存在浏览器本地（`localStorage` 的 `bax.stats.v1`）。
- 诊断命令 `__BAX__.dump()` 只输出主机名和统计，不含带签名的视频地址，可以放心贴到 issue 里。

## 局限和已知问题

- 主要在海外网络、普通投稿视频、1080P–4K 下测过；番剧、课程、外站嵌入播放器、国内网络没有充分测试。直播流不做任何处理。
- 依赖 B 站播放器当前"主线程 XHR 分段加载"的实现方式；B 站改版可能导致失效（有自动退回保护）。
- B 站只在标签页可见时加载视频，后台标签的卡顿与本脚本无关。
- 大陆镜像名单写在代码里，个别域名失效时需要更新。

## 反馈问题

请在 [Issues](https://github.com/GenjiM1n4moto/bili-smart-route/issues) 附上：视频 BV 号、画质和编码、面板里「切换记录」的截图，或控制台里 `JSON.stringify(__BAX__.dump())` 的输出。

## 致谢

思路受 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）启发，本项目代码独立编写。

---

<a id="english"></a>

## English

**Bilibili Smart Route** is a userscript for watching Bilibili from outside mainland China. Popular videos are usually fine abroad; obscure ones and high-bitrate 4K stall. The cause is edge caching: Bilibili's overseas CDN edges deliver 100+ Mbps for cached content but only 0.7–6 Mbps on a cache miss, while mainland mirrors always have the file but pay cross-border latency (0.1–2 s per request, 10–75 Mbps per connection).

What the script does:

1. **Per-file decision, probing the end of the range.** Before the first large segment of a file, it probes the *tail* of that exact range on the native edges. Cached → stay native (popular videos are untouched).
2. **Lookahead.** While on a native edge, it keeps probing ~15 s ahead of playback and switches before a cold region stalls the player.
3. **Mainland fallback.** Official UPOS mirrors (shared signatures), ranked by measured effective throughput including TTFB, verified before use.
4. **Parallel mirrors + read-ahead.** On the mainland route, the video file is fetched in 2 MB blocks from up to 3 mirrors at once with ~20 s (≤64 MB) read-ahead; the player's requests are answered from memory. Blocks that stall for 3 s are re-fetched elsewhere.
5. **Safety net.** If the player errors or parallel fetches keep failing, the page falls back to plain requests.

**Test environment.** Developed and tested in **Japan** on a home broadband connection, with Chrome + Tampermonkey 5.5 and a premium account (4K). For Japanese IPs, Bilibili assigns `upos-sz-mirrorcosov` (Tencent Cloud overseas) and `upos-hz-mirrorakam` (Akamai); no PCDN/P2P nodes were seen. Mainland mirrors gave 10–75 Mbps per connection with 0.1–2 s first-byte latency; tests ran late at night mainland time (about 23:00–02:00), and the same mirror dropped from 60–75 to 10–30 Mbps within an hour. Other regions may be assigned different edges and see different results — reports from elsewhere are welcome in Issues.

Measured in that environment, on a cold 29.7 Mbps AVC 4K video: 0 stalls, 0 of 1822 frames dropped, 30 s+ buffer ahead.

Install with Tampermonkey or Violentmonkey (on Chrome 138+, enable "Allow User Scripts" for the extension), then open the [latest release](https://github.com/GenjiM1n4moto/bili-smart-route/releases/latest/download/bili-smart-route.user.js); installs from there auto-update with each release. Disable other scripts that rewrite Bilibili video requests. Settings live in `localStorage['bax.cfg.v1']` on `www.bilibili.com` (see the Chinese section for keys). The script collects nothing and only talks to Bilibili's own CDN hosts; `__BAX__.dump()` prints host names and stats only, no signed URLs.

Known limits: tested mainly abroad on regular uploads at 1080p–4K; bangumi, courses, embedded players and mainland networks are not well tested; live streams are left alone. It depends on the current web player's main-thread XHR segment loading.

Inspired by [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator) (MIT); the code is written independently. Licensed under MIT.
