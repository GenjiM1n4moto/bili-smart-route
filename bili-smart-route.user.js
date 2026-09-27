// ==UserScript==
// @name         B站智能选路 Bilibili Smart Route
// @name:en      Bilibili Smart Route
// @name:ja      Bilibili Smart Route
// @namespace    bili-smart-route
// @version      1.1.0
// @description  海外看 B 站冷门视频不再卡：按文件实测海外节点有没有缓存，有就直连；没有就改走大陆镜像，多镜像并行 + 预读，高码率 4K 也跑得动。
// @description:en  Smoother Bilibili playback abroad: measures per file whether the overseas edge has it cached. Cached files stay on the native edge; cold ones switch to mainland mirrors, fetched from several mirrors in parallel with read-ahead.
// @description:ja  海外から見る Bilibili のマイナー動画・4K の再生停止を解消：ファイルごとに海外ノードのキャッシュを実測し、あればそのまま直結、なければ中国本土ミラーに切り替えて複数ミラー並列取得 + 先読みで再生します。
// @author       bili-smart-route contributors
// @license      MIT
// @homepageURL  https://github.com/GenjiM1n4moto/bili-smart-route
// @supportURL   https://github.com/GenjiM1n4moto/bili-smart-route/issues
// @downloadURL  https://github.com/GenjiM1n4moto/bili-smart-route/releases/latest/download/bili-smart-route.user.js
// @updateURL    https://github.com/GenjiM1n4moto/bili-smart-route/releases/latest/download/bili-smart-route.user.js
// @match        https://*.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const W = window;
  if (W.__BAX__) return;
  // Bilibili Accelerator (realzza) stays out when it finds this flag, so if
  // this script runs first the two never both patch XHR. If it runs second,
  // turn one of them off in the userscript manager.
  try { W.__BILI_ACCELERATOR_INSTALLED__ = true; } catch (_) {}

  const VERSION = '1.1.0';
  const CFG_KEY = 'bax.cfg.v1';
  const STATS_KEY = 'bax.stats.v1';
  const KB = 1024;
  const MB = 1024 * 1024;

  // Mainland UPOS mirrors: they always hold the full file (origin side), but
  // every request pays cross-border latency. Until a mirror has been measured
  // (three segments), it is ranked by list order at a neutral default rate;
  // after that, by its own decayed record on this browser.
  const MAINLAND = [
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-tf-all-hw.bilivideo.com',
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-tf-all-tx.bilivideo.com'
  ];
  const DEFAULT_MBPS = 20;
  const prior = h => DEFAULT_MBPS - Math.max(0, MAINLAND.indexOf(h)) * 0.1; // tie-break by list order

  const DEFAULTS = {
    enabled: true,
    ui: true,
    lang: 'auto',          // panel language: auto (browser) | zh | en | ja
    raceMinMbps: 1,        // files below this bitrate (audio, low-res) skip pre-probing
    hotMinMbps: 12,        // a native edge probing above this is "cached"; cold edges do 0.7–6
    raceTimeoutMs: 1500,   // longest a segment waits for the probe race
    probeBytes: 512 * KB,
    lookBytes: 256 * KB,
    aheadSec: 15,          // how far past the player's fetch position to probe
    recheckMs: 30000,      // while on mainland, how often to re-test the native edge
    multi: true,           // mainland route: 2 MB blocks from several mirrors + read-ahead
    multiHosts: 3,
    perHost: 2,            // concurrent blocks per mirror (HTTP/2 overlaps their TTFB)
    readAheadSec: 20,      // how far past the player's request the store keeps fetching
    readAheadMaxMB: 64,
    storeCapMB: 192,       // memory for fetched blocks, per tab
    stallMs: 3000,         // a block with no bytes for this long is re-fetched elsewhere
    mainland: MAINLAND
  };

  function loadJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  const cfg = Object.assign({}, DEFAULTS, loadJson(CFG_KEY) || {});
  if (!Array.isArray(cfg.mainland) || !cfg.mainland.length) cfg.mainland = MAINLAND;

  const nativeFetch = W.fetch;
  const nativeParse = JSON.parse;
  const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
  const xOpen = XP.open;
  const xSend = XP.send;
  const xSetHeader = XP.setRequestHeader;
  const xAbort = XP.abort;
  const now = () => performance.now();

  // ---- i18n -----------------------------------------------------------------

  const I18N = {
    zh: {
      brand: 'B站智能选路', idle: '智能选路', paused: '已暂停',
      native: '原生', mainland: '大陆', direct: '直连',
      files: '当前文件', noVideo: '还没有视频请求',
      mirrors: '大陆镜像（实测有效吞吐，含首包延迟）', untested: '未测', ttfb: '首包',
      log: '切换记录', none: '暂无',
      autoOff: '本页已自动停用多镜像：',
      pause: '暂停脚本（刷新）', resume: '启用脚本（刷新）',
      multi: '多镜像并行：', on: '开', off: '关', reset: '清空镜像统计',
      ev: { native: '原生', mainland: '大陆', fail: '失败', timeout: '超时', stall: '卡住', storeFail: '并行失败', guard: '保护' },
      stallInfo: mb => '块 @' + mb + 'MB 换源',
      whyFails: () => '一分钟内 3 次并行下载失败',
      whyMedia: code => '播放器报错 (MediaError ' + code + ')',
      guardInfo: r => '本页停用多镜像：' + tr(r)
    },
    en: {
      brand: 'Bilibili Smart Route', idle: 'Smart Route', paused: 'Paused',
      native: 'Native', mainland: 'Mainland', direct: 'Direct',
      files: 'Current files', noVideo: 'No video requests yet',
      mirrors: 'Mainland mirrors (measured effective throughput, incl. first-byte latency)', untested: 'untested', ttfb: 'TTFB',
      log: 'Switch log', none: 'Nothing yet',
      autoOff: 'Parallel mirrors turned off on this page: ',
      pause: 'Pause script (reload)', resume: 'Enable script (reload)',
      multi: 'Parallel mirrors: ', on: 'on', off: 'off', reset: 'Reset mirror stats',
      ev: { native: 'native', mainland: 'mainland', fail: 'failed', timeout: 'timeout', stall: 'stalled', storeFail: 'parallel failed', guard: 'guard' },
      stallInfo: mb => 'block @' + mb + 'MB re-fetched elsewhere',
      whyFails: () => '3 parallel fetch failures within a minute',
      whyMedia: code => 'player error (MediaError ' + code + ')',
      guardInfo: r => 'parallel mirrors off on this page: ' + tr(r)
    },
    ja: {
      brand: 'Bilibili Smart Route', idle: 'スマートルート', paused: '一時停止中',
      native: 'ネイティブ', mainland: '本土', direct: '直結',
      files: '現在のファイル', noVideo: 'まだ動画のリクエストがありません',
      mirrors: '本土ミラー（実測の実効スループット、最初のバイトまでの遅延込み）', untested: '未測定', ttfb: '初回応答',
      log: '切り替え履歴', none: 'まだありません',
      autoOff: 'このページでは複数ミラーを自動停止しました：',
      pause: 'スクリプトを一時停止（再読み込み）', resume: 'スクリプトを有効化（再読み込み）',
      multi: '複数ミラー並列：', on: 'オン', off: 'オフ', reset: 'ミラー統計をリセット',
      ev: { native: 'ネイティブ', mainland: '本土', fail: '失敗', timeout: 'タイムアウト', stall: '停滞', storeFail: '並列失敗', guard: '保護' },
      stallInfo: mb => 'ブロック @' + mb + 'MB を別ミラーで再取得',
      whyFails: () => '1 分以内に並列取得が 3 回失敗',
      whyMedia: code => 'プレーヤーエラー (MediaError ' + code + ')',
      guardInfo: r => 'このページでは複数ミラーを停止：' + tr(r)
    }
  };

  // Explicit choice wins; otherwise the first of the browser's preferred
  // languages that we have, falling back to English.
  function uiLang() {
    if (I18N[cfg.lang]) return cfg.lang;
    const prefs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])
      .map(s => String(s).toLowerCase());
    for (const p of prefs) {
      if (p.indexOf('zh') === 0) return 'zh';
      if (p.indexOf('ja') === 0) return 'ja';
      if (p.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }
  const L = () => I18N[uiLang()];

  // Log entries keep keys, not text, so switching language re-renders old ones.
  function tr(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    const v = L()[x.k];
    return typeof v === 'function' ? v.apply(null, x.a || []) : (v || x.k);
  }

  // ---- log ------------------------------------------------------------------

  const logs = [];
  function log(fs, ev, host, info) {
    logs.push({
      t: new Date().toLocaleTimeString('en-GB'),
      f: fs ? fs.label || fs.path.split('/').pop() : '',
      ev,
      h: host ? shortHost(host) : '',
      info: info || ''
    });
    if (logs.length > 120) logs.shift();
  }

  function shortHost(h) {
    return String(h)
      .replace(/^upos-(sz|hz|tf)-/, '')
      .replace(/\.(bilivideo\.(com|cn|net)|akamaized\.net)(:\d+)?$/, '')
      .replace(/^mirror/, '');
  }

  // ---- URL helpers ----------------------------------------------------------

  function toURL(s) {
    try { return new URL(s, location.href); } catch (_) { return null; }
  }

  function isMedia(u) {
    const p = u.pathname;
    return /\.(m4s|mp4|flv)$/i.test(p) &&
      (p.indexOf('/upgcxcode/') !== -1 || p.indexOf('/v1/resource/') !== -1) &&
      p.indexOf('/live-bvc/') === -1;
  }

  function isPlayurl(u) {
    return /playurl|playview/i.test(u.pathname);
  }

  const isAkamai = h => /\.akamaized\.net(:\d+)?$/.test(h);
  // A URL whose signature a different UPOS host also accepts. Verified: cosov-
  // and akamai-signed URLs both return 206 on the mainland mirrors. PCDN
  // (mcdn / ports / os=mcdn) URLs carry their own signing and are not swappable.
  const isSwappable = u => !u.port && (isAkamai(u.host) ||
    (/^upos-/.test(u.hostname) && /\.bilivideo\.com$/.test(u.hostname) && u.hostname.split('.')[0].indexOf('302') === -1));

  function parseRange(v) {
    const m = /bytes=(\d+)-(\d*)/.exec(v || '');
    if (!m) return null;
    const start = +m[1];
    const end = m[2] ? +m[2] : start + 4 * MB - 1;
    return { start, end, size: end - start + 1 };
  }

  function headerOf(list, name) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (String(list[i][0]).toLowerCase() === name) return list[i][1];
    }
    return null;
  }

  // ---- host stats (mainland ranking) ---------------------------------------

  const stats = loadJson(STATS_KEY) || {};
  let statsDirty = false;

  // Bytes-weighted, exponentially decayed effective throughput, TTFB included:
  // that is the real cost of a segment request, and it is what separates a
  // mainland mirror with 1 s of latency from one with 0.2 s.
  function recordStat(host, bytes, durMs, ttfbMs) {
    const s = stats[host] || (stats[host] = { b: 0, d: 0, ttfb: null, n: 0, at: 0 });
    if (durMs > 0) {
      s.b = s.b * 0.85 + bytes;
      s.d = s.d * 0.85 + durMs;
      s.n += 1;
    }
    if (ttfbMs != null) s.ttfb = s.ttfb == null ? ttfbMs : s.ttfb * 0.8 + ttfbMs * 0.2;
    s.at = Date.now();
    statsDirty = true;
  }

  function statRate(host) {
    const s = stats[host];
    return s && s.d > 0 ? s.b * 8 / s.d / 1000 : null;
  }

  function hostScore(host) {
    const s = stats[host];
    const fresh = s && s.n >= 3 && Date.now() - s.at < 3 * 86400e3;
    return fresh ? statRate(host) : prior(host);
  }

  setInterval(function () {
    if (statsDirty) { statsDirty = false; saveJson(STATS_KEY, stats); }
  }, 5000);

  // ---- file registry --------------------------------------------------------

  const files = new Map(); // pathname -> file state (aliases share one object)

  function newFile(path) {
    const audio = /-30(2\d\d)\.m4s$/.test(path);
    return {
      path,
      kind: audio ? 'audio' : 'video',
      bw: null,
      label: '',
      native: new Map(),   // host -> signed URL from playurl / player
      order: [],           // native hosts in B站's preference order
      route: null,         // { host, cls: 'native' | 'mainland', why }
      failed: new Map(),   // host -> performance.now() until which it is skipped
      verified: new Set(), // hosts that answered 206 for this file
      probed: [],          // [host, start, end] — our probes warm the edge, never re-probe them
      tried: {},
      samples: [],
      pending: null,
      switching: false,
      lastStart: -1,
      lastEnd: -1,
      hotUntil: -1,        // native edge verified cached up to this byte
      lastLookAt: -Infinity,
      looking: false,
      recheckAt: 0,
      lastReroute: 0,
      lastUrl: null,
      lastUsed: 0,
      bytes: 0
    };
  }

  function addNative(fs, u) {
    if (!fs.native.has(u.host)) fs.order.push(u.host);
    fs.native.set(u.host, u.href);
  }

  function fileFor(u) {
    let fs = files.get(u.pathname);
    if (!fs) {
      fs = newFile(u.pathname);
      files.set(u.pathname, fs);
    }
    addNative(fs, u);
    return fs;
  }

  const isFailed = (fs, h) => (fs.failed.get(h) || 0) > now();
  function markFailed(fs, h, ms, why) {
    fs.failed.set(h, now() + ms);
    fs.verified.delete(h);
    log(fs, 'fail', h, why);
  }

  function codecName(c) {
    c = String(c || '');
    if (/^av01/.test(c)) return 'AV1';
    if (/^(hev|hvc)/.test(c)) return 'HEVC';
    if (/^avc/.test(c)) return 'AVC';
    if (/^(mp4a|ec-3|fLaC|flac)/i.test(c)) return 'audio';
    return c.split('.')[0];
  }

  function regStream(entry, kind) {
    if (!entry || typeof entry !== 'object') return;
    const base = entry.baseUrl || entry.base_url || entry.url;
    const backs = entry.backupUrl || entry.backup_url || [];
    const urls = [base].concat(Array.isArray(backs) ? backs : []).filter(x => typeof x === 'string');
    const parsed = urls.map(toURL).filter(u => u && isMedia(u));
    if (!parsed.length) return;
    let fs = null;
    for (const u of parsed) {
      if (files.has(u.pathname)) { fs = files.get(u.pathname); break; }
    }
    fs = fs || newFile(parsed[0].pathname);
    for (const u of parsed) {
      files.set(u.pathname, fs);
      addNative(fs, u);
    }
    fs.kind = kind;
    if (entry.bandwidth > 0) fs.bw = entry.bandwidth;
    const h = entry.height ? entry.height + 'p' : '';
    fs.label = kind === 'audio'
      ? 'audio ' + (entry.id || '')
      : [h, codecName(entry.codecs || entry.codecid)].filter(Boolean).join(' ');
  }

  function register(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 6) return;
    const dash = obj.dash;
    if (dash && typeof dash === 'object') {
      (dash.video || []).forEach(e => regStream(e, 'video'));
      (dash.audio || []).forEach(e => regStream(e, 'audio'));
      if (dash.dolby && Array.isArray(dash.dolby.audio)) dash.dolby.audio.forEach(e => regStream(e, 'audio'));
      if (dash.flac && dash.flac.audio) regStream(dash.flac.audio, 'audio');
    }
    if (Array.isArray(obj.durl)) {
      obj.durl.forEach(function (e) {
        regStream(e, 'video');
        const u = e && typeof e.url === 'string' && toURL(e.url);
        const fs = u && files.get(u.pathname);
        if (fs && e.size > 0 && e.length > 0) fs.bw = e.size * 8 / (e.length / 1000);
      });
    }
    ['data', 'result', 'video_info', 'playurl_info', 'playurl'].forEach(function (k) {
      if (obj[k] && typeof obj[k] === 'object') register(obj[k], depth + 1);
    });
  }

  // ---- thresholds -----------------------------------------------------------

  const bwMbps = fs => (fs.bw || (fs.kind === 'audio' ? 0.2e6 : 2e6)) / 1e6;
  // Rate at which the native edge is good enough to keep. Low bitrates are fine
  // even from a cold edge (8 Mbps is 40x a 360P stream); for 1080P and up it
  // takes a properly cached edge, which probes at 50+ Mbps against 0.7–6 cold.
  const hotMin = fs => Math.max(1.5 * bwMbps(fs), Math.min(cfg.hotMinMbps, 4 * bwMbps(fs)));
  const needMbps = fs => Math.max(0.25, 1.25 * bwMbps(fs));
  const important = fs => bwMbps(fs) >= cfg.raceMinMbps;
  const aheadBytes = fs => Math.max(MB, bwMbps(fs) * 1e6 / 8 * cfg.aheadSec);

  // ---- candidates -----------------------------------------------------------

  function nativeCandidates(fs) {
    return fs.order.filter(h => !isFailed(fs, h)).slice(0, 2);
  }

  function mainlandList(fs, avoidRecent) {
    const natives = new Set(fs.order);
    const list = cfg.mainland.filter(h => !isFailed(fs, h) && !natives.has(h) &&
      !(avoidRecent && fs.tried[h] && now() - fs.tried[h] < 120000));
    list.sort((a, b) => hostScore(b) - hostScore(a));
    return list;
  }

  function urlForHost(fs, host, reqU) {
    if (reqU && reqU.host === host) return reqU.href;
    const known = fs.native.get(host);
    if (known) return known;
    if (isAkamai(host)) return null; // akamai needs its own hdnts signature
    let base = reqU && isSwappable(reqU) && !isAkamai(reqU.host) ? reqU : null;
    if (!base) {
      for (const href of fs.native.values()) {
        const u = toURL(href);
        if (u && isSwappable(u) && !isAkamai(u.host)) { base = u; break; }
      }
    }
    if (!base) {
      for (const href of fs.native.values()) {
        const u = toURL(href);
        if (u && isSwappable(u)) { base = u; break; }
      }
    }
    if (!base) return null;
    const next = new URL(base.href);
    next.protocol = 'https:';
    next.host = host;
    return next.href;
  }

  // ---- probing --------------------------------------------------------------

  function wasProbed(fs, host, s, e) {
    return fs.probed.some(p => p[0] === host && p[1] <= e && s <= p[2]);
  }

  // onTick runs on every chunk and at the end. Decisions ride on network
  // callbacks because Chrome throttles timers in background tabs (to once a
  // minute for a silent tab), and a race waiting on setInterval would hold the
  // player's segment for that long.
  function probe(fs, url, start, len, timeoutMs, onTick) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const host = toURL(url).host;
    const tick = typeof onTick === 'function' ? onTick : function () {};
    const r = { url, host, status: 0, bytes: 0, t0: now(), tHead: 0, tLast: 0, done: false, finished: false, ok: false };
    if (fs) {
      fs.probed.push([host, start, start + len - 1]);
      if (fs.probed.length > 80) fs.probed.shift();
    }
    const timer = setTimeout(() => r.abort(), timeoutMs);
    r.abort = function () { try { ac && ac.abort(); } catch (_) {} };
    r.rate = function () {
      if (!r.tHead || !r.bytes) return 0;
      const end = r.finished || r.done ? r.tLast : now();
      return r.bytes * 8 / Math.max(end - r.tHead, 4) / 1000;
    };
    r.promise = nativeFetch.call(W, url, {
      headers: { Range: 'bytes=' + start + '-' + (start + len - 1) },
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: ac ? ac.signal : undefined
    }).then(function (res) {
      r.status = res.status;
      r.tHead = now();
      if (!(res.status === 206 || res.status === 200) || !res.body) { r.abort(); return; }
      const reader = res.body.getReader();
      function pump() {
        return reader.read().then(function (c) {
          if (c.value) { r.bytes += c.value.length; r.tLast = now(); }
          if (c.done || r.bytes >= len) {
            r.done = true;
            try { reader.cancel(); } catch (_) {}
            return;
          }
          tick();
          return pump();
        });
      }
      return pump();
    }).catch(function () {}).then(function () {
      clearTimeout(timer);
      r.finished = true;
      if (!r.tLast) r.tLast = now();
      r.ok = (r.status === 206 || r.status === 200) && r.bytes > 0;
      if (fs && r.ok) fs.verified.add(host);
      tick();
      return r;
    });
    return r;
  }

  // Race the native edges on the END of the range the player is about to fetch
  // (4K segments are 10–18 MB; an edge often holds a segment's head but not its
  // tail, so a head probe reads 500+ Mbps and the segment still crawls). A
  // cached edge answers in ~100–300 ms at 50+ Mbps and wins immediately; a cold
  // one trickles at 0.7–6 Mbps while it pulls from mainland origin. Mainland
  // probes are not raced on rate — TCP slow start over a 150–900 ms RTT makes
  // their first bytes look slow even though they sustain 30–80 Mbps — so the
  // mainland probe only proves the swapped signature works and warms the socket.
  function race(fs, reqU, range) {
    const need = hotMin(fs);
    const start = range ? range.start : 0;
    const tail = range ? Math.max(start, range.end - cfg.probeBytes + 1) : 0;
    let onTick = function () {};
    const ping = () => onTick();
    const natives = nativeCandidates(fs).map(function (h) {
      const url = urlForHost(fs, h, reqU);
      return url ? { h, p: probe(fs, url, tail, cfg.probeBytes, cfg.raceTimeoutMs + 800, ping) } : null;
    }).filter(Boolean);
    const ml = mainlandList(fs)[0] || null;
    const mlUrl = ml && urlForHost(fs, ml, reqU);
    const warm = mlUrl ? probe(fs, mlUrl, start, 64 * KB, 8000, ping) : null;
    const t0 = now();

    return new Promise(function (resolve) {
      let settled = false;
      onTick = tick;
      const iv = setInterval(tick, 40);
      function finish(win, why) {
        if (settled) return;
        settled = true;
        clearInterval(iv);
        natives.forEach(x => { if (x !== win) x.p.abort(); });
        resolve({ win, why, natives, ml, warm });
      }
      function tick() {
        if (settled) return;
        for (const x of natives) {
          if (x.p.done && x.p.rate() >= need) return finish(x, 'hot');
        }
        const coldNow = natives.every(function (x) {
          if (x.p.finished && !x.p.ok) return true;
          if (x.p.done) return x.p.rate() < need;
          return x.p.tHead && now() - x.p.tHead > 400 && x.p.rate() < need / 3;
        });
        if (coldNow || now() - t0 > cfg.raceTimeoutMs) {
          let best = null;
          for (const x of natives) {
            const rate = x.p.rate();
            if (x.p.status < 400 && rate >= need && (!best || rate > best.rate)) best = { x, rate };
          }
          finish(best ? best.x : null, best ? 'hot-late' : 'cold');
        }
      }
      tick();
    });
  }

  function setRoute(fs, host, cls, why) {
    const prev = fs.route;
    fs.route = { host, cls, why, at: Date.now() };
    if (cls === 'mainland') {
      fs.recheckAt = now() + cfg.recheckMs;
      fs.hotUntil = -1;
    } else {
      fs.lastLookAt = -Infinity; // look ahead on the very next request
      if (fs.store) fs.store.raEnd = -1; // stop mainland read-ahead
    }
    if (!prev || prev.host !== host) log(fs, cls, host, why);
  }

  function startRace(fs, reqU, range, reason) {
    fs.pending = race(fs, reqU, range).then(function (res) {
      res.natives.forEach(x => {
        if (x.p.finished && x.p.status >= 400) markFailed(fs, x.h, 10 * 60e3, 'probe HTTP ' + x.p.status);
      });
      if (res.win) {
        setRoute(fs, res.win.h, 'native', reason + ':' + res.why + ' ' + res.win.p.rate().toFixed(0) + 'M');
        fs.hotUntil = Math.max(fs.hotUntil, range ? range.end : cfg.probeBytes - 1);
        return;
      }
      const rates = res.natives.map(x => shortHost(x.h) + ' ' + x.p.rate().toFixed(1) + 'M').join(', ');
      let ml = res.ml;
      if (ml && res.warm) {
        if (res.warm.finished && !res.warm.ok) {
          markFailed(fs, ml, 10 * 60e3, 'probe ' + (res.warm.status || 'network'));
          ml = mainlandList(fs)[0] || null;
        } else if (res.warm.tHead) {
          recordStat(ml, 0, 0, res.warm.tHead - res.warm.t0);
        }
      }
      if (ml) {
        setRoute(fs, ml, 'mainland', reason + ':cold (' + rates + ')');
      } else if (res.natives.length) {
        setRoute(fs, res.natives[0].h, 'native', 'no-mainland');
      }
    }).catch(function () {}).then(function () { fs.pending = null; });
    return fs.pending;
  }

  // Switch to a mainland mirror only after a 64 KB probe proves it accepts this
  // file's swapped signature; until then the current route stays in place.
  function switchToMainland(fs, candidates, why) {
    if (fs.switching) return;
    const list = candidates.filter(h => !isFailed(fs, h));
    const h = list[0];
    if (!h) return;
    if (fs.verified.has(h)) return setRoute(fs, h, 'mainland', why);
    const url = urlForHost(fs, h, toURL(fs.lastUrl));
    if (!url) { markFailed(fs, h, 10 * 60e3, 'no-url'); return switchToMainland(fs, list.slice(1), why); }
    fs.switching = true;
    probe(fs, url, Math.max(0, fs.lastEnd + 1), 64 * KB, 6000).promise.then(function (p) {
      fs.switching = false;
      if (p.ok) {
        if (p.tHead) recordStat(h, 0, 0, p.tHead - p.t0);
        setRoute(fs, h, 'mainland', why);
      } else {
        markFailed(fs, h, 10 * 60e3, 'verify ' + (p.status || 'network'));
        switchToMainland(fs, list.slice(1), why);
      }
    });
  }

  // Non-blocking: probe a slice ahead of the player on the native edge so a cold
  // region is found while the buffer still has seconds in it, not after a
  // multi-MB segment has already started trickling at 1 Mbps.
  function lookahead(fs) {
    if (!fs.route || fs.route.cls !== 'native' || fs.looking || !important(fs)) return;
    const ahead = aheadBytes(fs);
    if (fs.lastEnd < fs.lastLookAt + ahead / 2) return;
    const host = fs.route.host;
    const url = urlForHost(fs, host, toURL(fs.lastUrl));
    if (!url) return;
    let at = fs.lastEnd + 1 + Math.floor(ahead);
    for (let i = 0; i < 8 && wasProbed(fs, host, at, at + cfg.lookBytes - 1); i += 1) at += cfg.lookBytes;
    fs.lastLookAt = fs.lastEnd;
    fs.looking = true;
    probe(fs, url, at, cfg.lookBytes, 3000).promise.then(function (p) {
      fs.looking = false;
      if (p.status === 416 || !fs.route || fs.route.host !== host) return;
      if (p.status >= 400) { markFailed(fs, host, 10 * 60e3, 'look HTTP ' + p.status); reroute(fs, 'error'); return; }
      const rate = p.rate();
      if (rate < hotMin(fs)) reroute(fs, 'ahead-cold ' + rate.toFixed(1) + 'M @' + (at / MB).toFixed(0) + 'MB');
      else fs.hotUntil = Math.max(fs.hotUntil, at + cfg.lookBytes - 1);
    });
  }

  function recheck(fs) {
    if (!fs.route || fs.route.cls !== 'mainland' || fs.looking || now() < fs.recheckAt || fs.lastEnd < 0) return;
    fs.recheckAt = now() + cfg.recheckMs;
    const h = nativeCandidates(fs)[0];
    const url = h && urlForHost(fs, h, toURL(fs.lastUrl));
    if (!url) return;
    const at = fs.lastEnd + 1;
    // A region we probed earlier is warm because of that probe, not because
    // other viewers pulled it — it would read hot and lure us back to a cold edge.
    if (wasProbed(fs, h, at, at + cfg.probeBytes - 1)) return;
    fs.looking = true;
    probe(fs, url, at, cfg.probeBytes, 3000).promise.then(function (p) {
      fs.looking = false;
      if (p.ok && p.rate() >= hotMin(fs) && fs.route && fs.route.cls === 'mainland') {
        setRoute(fs, h, 'native', 'recheck-hot ' + p.rate().toFixed(0) + 'M');
        fs.hotUntil = at + cfg.probeBytes - 1;
      }
    });
  }

  function reroute(fs, why, curRate) {
    const isErr = why === 'error';
    if (!isErr && now() - fs.lastReroute < 8000) return;
    fs.lastReroute = now();
    const cur = fs.route;
    if (!cur || cur.cls === 'native') {
      const list = mainlandList(fs);
      if (list.length) return switchToMainland(fs, list, why);
      const nat = nativeCandidates(fs).find(h => !cur || h !== cur.host);
      if (nat) setRoute(fs, nat, 'native', why);
      return;
    }
    // Already on mainland: only move to a mirror expected to do clearly better,
    // otherwise stay put (the best we have) and re-test the native edge soon.
    fs.tried[cur.host] = now();
    const better = mainlandList(fs, true).filter(h => h !== cur.host &&
      (isErr || hostScore(h) > (curRate || hostScore(cur.host)) * 1.2));
    if (better.length) return switchToMainland(fs, better, why);
    fs.recheckAt = 0;
    if (isErr) {
      const nat = nativeCandidates(fs)[0];
      if (nat) setRoute(fs, nat, 'native', why);
    }
  }

  // ---- routing --------------------------------------------------------------

  // Returns the host to use, or a Promise of it when this request must wait for
  // a probe race (first sizeable segment of a file, or after a seek).
  function decide(fs, reqU, range) {
    if (fs.pending) return fs.pending.then(() => decide(fs, reqU, range));
    const r = fs.route;
    const start = range ? range.start : 0;
    const sizeable = !range || range.size >= 64 * KB;
    const ahead = aheadBytes(fs);
    // Retries and the player's duplicate fetches step back a segment or two;
    // only a jump beyond the lookahead window counts as a seek.
    const seek = range && fs.lastEnd >= 0 &&
      (start < fs.lastStart - ahead || start > fs.lastEnd + ahead);

    if (!r) {
      if (important(fs) && sizeable) return startRace(fs, reqU, range, 'start').then(() => fs.route && fs.route.host);
      return reqU.host;
    }
    if (isFailed(fs, r.host)) {
      const nat = nativeCandidates(fs)[0];
      return nat || reqU.host;
    }
    if (seek) {
      if (r.cls === 'native' && important(fs) && sizeable) {
        return startRace(fs, reqU, range, 'seek').then(() => fs.route && fs.route.host);
      }
      if (r.cls === 'mainland') fs.recheckAt = 0;
    }
    // On a native edge, a segment reaching past what probes have shown to be
    // cached gets its own tail checked first — otherwise one cold 18 MB segment
    // sits there until the player's 10 s timeout.
    if (r.cls === 'native' && important(fs) && sizeable && range && range.end > fs.hotUntil) {
      return startRace(fs, reqU, range, 'extend').then(() => fs.route && fs.route.host);
    }
    return r.host;
  }

  function routeRequest(m) {
    const u = m.u;
    const fs = fileFor(u);
    const range = parseRange(headerOf(m.headers, 'range'));
    m.fs = fs;
    m.range = range;
    fs.lastUsed = Date.now();
    if (fs.kind === 'video') current.video = fs;
    else current.audio = fs;

    function toTarget(host) {
      let url = null;
      if (host && host !== u.host) url = urlForHost(fs, host, u);
      if (!url) { url = m.url; host = u.host; }
      if (range) {
        fs.lastStart = range.start;
        fs.lastEnd = range.end;
      }
      fs.lastUrl = u.href;
      // Microtask, not setTimeout: background tabs throttle timers.
      Promise.resolve().then(function () { lookahead(fs); recheck(fs); });
      return { url, host };
    }

    const d = decide(fs, u, range);
    return d && typeof d.then === 'function' ? d.then(toTarget, () => toTarget(null)) : toTarget(d);
  }

  // Segment finished: feed the mainland ranking and move off a host that can no
  // longer keep ahead of the bitrate. The player gives each segment 10 s, so a
  // slow host shows up as a timeout (status 0), not as an HTTP error.
  function onSegmentDone(m, status, loaded) {
    const fs = m.fs;
    if (!fs || m.aborted) return;
    const host = m.host;
    const dur = m.tEnd - m.tSend;
    const onRoute = fs.route && fs.route.host === host;

    if (m.timedOut || (status === 0 && loaded > 0)) {
      recordStat(host, loaded, dur, m.tHead ? m.tHead - m.tSend : null);
      log(fs, 'timeout', host, (loaded / MB).toFixed(1) + 'MB/' + (dur / 1000).toFixed(1) + 's');
      // Judged on the host's decayed record (this timeout already dragged it
      // down): one cross-border hiccup must not push a 60 Mbps mirror aside
      // for one that cannot finish a 4K segment inside the player's 10 s.
      if (onRoute) reroute(fs, 'timeout');
      return;
    }
    if (status === 0 || status >= 400) {
      markFailed(fs, host, status >= 400 ? 10 * 60e3 : 60e3, 'HTTP ' + status);
      if (onRoute) reroute(fs, 'error');
      return;
    }
    fs.verified.add(host);
    if (loaded < 8 * KB || dur < 15) return; // browser cache hit or init segment
    fs.bytes += loaded;
    const eff = loaded * 8 / dur / 1000;
    fs.samples.push({ host, bytes: loaded, dur });
    if (fs.samples.length > 12) fs.samples.shift();
    recordStat(host, loaded, dur, m.tHead ? m.tHead - m.tSend : null);

    if (!onRoute) return;
    const need = needMbps(fs);
    const recent = fs.samples.filter(s => s.host === host).slice(-4);
    const agg = recent.reduce((a, s) => a + s.bytes, 0) * 8 / recent.reduce((a, s) => a + s.dur, 0) / 1000;
    if ((dur > 3000 && eff < need * 0.6) || (recent.length >= 3 && agg < need)) {
      reroute(fs, 'slow ' + agg.toFixed(1) + '/' + need.toFixed(1) + 'M', agg);
    }
  }

  const current = { video: null, audio: null };

  // ---- mainland block store: parallel mirrors + read-ahead ------------------
  //
  // Cold content has to come across the border from the mainland mirrors,
  // where one connection carries 10–75 Mbps depending on the hour and every
  // request pays 0.2–1 s before its first byte. The player asks for one
  // segment at a time, so plain requests leave the link idle between segments
  // and pay that latency on each one. On the mainland route the video file is
  // instead fetched as fixed 2 MB blocks:
  //   - from several mirrors at once — each mirror is its own connection;
  //     parallel requests to one host share an HTTP/2 connection and gain
  //     nothing,
  //   - reading ahead of the player, so its requests are mostly answered from
  //     memory and the link never sits idle,
  //   - re-fetching a block elsewhere when it stops moving,
  //   - serving the player's duplicate fetch of each segment from the same
  //     blocks.
  // The player's XHR is answered through a shim (see storeSend).

  const BLOCK = 2 * MB;
  const storeCap = () => Math.max(32, +cfg.storeCapMB || 192) * MB;
  let storeMem = 0;

  function storeOf(fs) {
    if (!fs.store) {
      fs.store = { blocks: new Map(), eof: Infinity, low: 0, raEnd: -1, hosts: [], waiters: new Set(), iv: 0, hist: [] };
    }
    return fs.store;
  }

  function refreshHosts(fs, first, reqU) {
    const st = storeOf(fs);
    const want = [];
    [first].concat(mainlandList(fs)).forEach(function (h) {
      if (!h || want.indexOf(h) !== -1 || isFailed(fs, h) || want.length >= cfg.multiHosts) return;
      if (want.length && hostScore(h) < 6) return; // a crawling mirror only adds stalls
      want.push(h);
    });
    want.forEach(function (h) {
      let x = st.hosts.find(o => o.h === h);
      if (!x) st.hosts.push(x = { h, url: null, active: 0, strikes: 0, dead: false, bytes: 0 });
      if (x.dead && !isFailed(fs, h)) { x.dead = false; x.strikes = 0; }
      x.url = urlForHost(fs, h, reqU) || x.url;
    });
    st.hosts.forEach(x => { x.want = want.indexOf(x.h) !== -1; });
  }

  function blockAt(st, idx) {
    let b = st.blocks.get(idx);
    if (!b) {
      b = { idx, s: idx * BLOCK, data: null, done: false, runs: [], need: 0 };
      st.blocks.set(idx, b);
    }
    return b;
  }

  function dropBlock(st, b) {
    if (b.data) storeMem -= b.data.length;
    st.blocks.delete(b.idx);
  }

  function evict() {
    if (storeMem <= storeCap()) return;
    const all = Array.from(new Set(files.values())).filter(f => f.store);
    all.forEach(function (f) {
      if (Date.now() - f.lastUsed > 60e3) {
        f.store.blocks.forEach(b => { if (!b.runs.length) dropBlock(f.store, b); });
        f.store.raEnd = -1;
      }
    });
    all.forEach(function (f) {
      const st = f.store;
      Array.from(st.blocks.values())
        .filter(b => b.done && !b.need && b.s + BLOCK < st.low - 8 * MB)
        .sort((a, b) => a.idx - b.idx)
        .forEach(b => { if (storeMem > storeCap() * 0.8) dropBlock(st, b); });
    });
  }

  function storeRate(fs) {
    const st = fs.store;
    if (!st) return null;
    const t = now();
    st.hist = st.hist.filter(h => t - h.t < 8000);
    if (!st.hist.length) return null;
    const span = Math.max(1000, t - Math.min.apply(null, st.hist.map(h => h.t0)));
    return st.hist.reduce((a, h) => a + h.bytes, 0) * 8 / span / 1000;
  }

  function nextBlock(fs, x) {
    const st = storeOf(fs);
    const pending = Array.from(st.blocks.values()).filter(b => !b.done).sort((a, b) => a.idx - b.idx);
    for (const b of pending) {
      if (b.need && !b.runs.length) return b;
    }
    // Read ahead, in order, up to raEnd.
    if (storeMem < storeCap() && st.raEnd >= 0) {
      const from = Math.floor(st.low / BLOCK);
      const to = Math.floor(Math.min(st.raEnd, st.eof - 1) / BLOCK);
      for (let i = from; i <= to; i += 1) {
        const b = blockAt(st, i);
        if (!b.done && !b.runs.length) return b;
      }
    }
    // Endgame: a block the player is waiting on, running only on another
    // mirror for over 1.5 s, gets a second copy here; the first to land wins.
    let hedge = null;
    for (const b of pending) {
      if (!b.need || !b.runs.length || b.runs.some(r => r.x === x)) continue;
      const age = now() - Math.min.apply(null, b.runs.map(r => r.t0));
      if (age > 1500 && (!hedge || age > hedge.age)) hedge = { b, age };
    }
    return hedge && hedge.b;
  }

  function schedule(fs) {
    const st = storeOf(fs);
    st.hosts.forEach(function (x) {
      while (x.want && !x.dead && x.url && x.active < cfg.perHost) {
        const b = nextBlock(fs, x);
        if (!b) break;
        runBlock(fs, x, b);
      }
    });
    const busy = st.waiters.size > 0 || st.hosts.some(x => x.active > 0);
    if (busy && !st.iv) st.iv = setInterval(() => watchStore(fs), 250);
    if (!busy && st.iv) { clearInterval(st.iv); st.iv = 0; }
    if (st.waiters.size && st.hosts.every(x => x.dead || !x.want || !x.url)) {
      Array.from(st.waiters).forEach(w => failWaiter(fs, w, 'no-mirror'));
    }
  }

  function runBlock(fs, x, b) {
    const st = storeOf(fs);
    const ac = new AbortController();
    const r = { x, ac, t0: now(), last: now(), head: 0, bytes: 0, aborted: false };
    b.runs.push(r);
    x.active += 1;
    let released = false;
    const release = function () {
      if (released) return;
      released = true;
      x.active -= 1;
      b.runs = b.runs.filter(o => o !== r);
    };
    let buf = null;
    let off = 0;
    nativeFetch.call(W, x.url, {
      headers: { Range: 'bytes=' + b.s + '-' + (b.s + BLOCK - 1) },
      mode: 'cors', credentials: 'omit', signal: ac.signal
    }).then(function (res) {
      if (res.status === 416) { st.eof = Math.min(st.eof, b.s); return; }
      if (res.status !== 206 || !res.body) throw new Error('HTTP ' + res.status);
      r.head = now();
      const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
      if (cr) st.eof = Math.min(st.eof, +cr[1]);
      st.waiters.forEach(w => { if (b.idx >= w.i0 && b.idx <= w.i1) headWaiter(w); });
      buf = new Uint8Array(BLOCK);
      const reader = res.body.getReader();
      function step() {
        return reader.read().then(function (c) {
          if (c.done) return;
          if (b.done) { try { reader.cancel(); } catch (_) {} return; }
          if (off + c.value.length > BLOCK) throw new Error('overflow');
          buf.set(c.value, off);
          off += c.value.length;
          r.bytes += c.value.length;
          r.last = now();
          return step();
        });
      }
      return step();
    }).then(function () {
      release();
      if (b.done) return schedule(fs);
      if (buf && off < Math.min(BLOCK, st.eof - b.s)) throw new Error('short');
      b.done = true;
      b.data = buf ? buf.subarray(0, off) : new Uint8Array(0);
      if (buf && off < BLOCK) st.eof = Math.min(st.eof, b.s + off);
      storeMem += b.data.length;
      x.bytes += b.data.length;
      x.strikes = 0;
      b.runs.forEach(o => { o.aborted = true; o.ac.abort(); });
      if (buf) {
        recordStat(x.h, off, now() - r.t0, r.head ? r.head - r.t0 : null);
        st.hist.push({ t: now(), t0: r.t0, bytes: off });
      }
      fs.verified.add(x.h);
      fs.multiHosts = st.hosts.filter(o => o.bytes > 0 && !o.dead).map(o => o.h);
      fs.multiAt = now();
      fs.multiUsed = st.hosts.map(o => shortHost(o.h) + ' ' + (o.bytes / MB).toFixed(0) + 'MB' + (o.dead ? '(dead)' : '')).join(' + ');
      Array.from(st.waiters).forEach(w => checkWaiter(fs, w));
      evict();
      schedule(fs);
    }).catch(function (err) {
      release();
      if (!r.aborted && !b.done) {
        x.strikes += 1;
        if (x.strikes >= 3) { x.dead = true; markFailed(fs, x.h, 60e3, 'block ' + (err && err.message)); }
      }
      schedule(fs);
    });
  }

  function watchStore(fs) {
    const st = storeOf(fs);
    const t = now();
    st.blocks.forEach(function (b) {
      b.runs.forEach(function (r) {
        const limit = r.head ? cfg.stallMs : cfg.stallMs + 1000; // allow for 1–2 s cross-border TTFB
        if (!b.done && !r.aborted && t - r.last > limit) {
          r.aborted = true;
          r.ac.abort();
          r.x.strikes += 1;
          if (r.x.strikes >= 3) { r.x.dead = true; markFailed(fs, r.x.h, 60e3, 'stalls'); }
          recordStat(r.x.h, r.bytes, t - r.t0, null);
          if (b.need) log(fs, 'stall', r.x.h, { k: 'stallInfo', a: [(b.s / MB).toFixed(0)] });
        }
      });
    });
    Array.from(st.waiters).forEach(function (w) {
      if (t - w.t0 > w.deadline) failWaiter(fs, w, 'deadline');
    });
    schedule(fs);
  }

  function headWaiter(w) {
    if (!w.headSent) { w.headSent = true; try { w.onHead(); } catch (_) {} }
  }

  function releaseNeed(st, w) {
    for (let i = w.i0; i <= w.i1; i += 1) {
      const b = st.blocks.get(i);
      if (b) b.need = Math.max(0, b.need - 1);
    }
  }

  function checkWaiter(fs, w) {
    const st = storeOf(fs);
    for (let i = w.i0; i <= w.i1; i += 1) {
      if (i * BLOCK >= st.eof) continue;
      const b = st.blocks.get(i);
      if (!b || !b.done) return;
    }
    const end = Math.min(w.b, st.eof - 1);
    const out = new Uint8Array(Math.max(0, end - w.a + 1));
    for (let i = w.i0; i <= w.i1; i += 1) {
      const b = st.blocks.get(i);
      if (!b || !b.data) continue;
      const from = Math.max(w.a, b.s);
      const to = Math.min(end, b.s + b.data.length - 1);
      if (to >= from) out.set(b.data.subarray(from - b.s, to - b.s + 1), from - w.a);
    }
    st.waiters.delete(w);
    releaseNeed(st, w);
    headWaiter(w);
    try { w.onDone(out.buffer); } catch (_) {}
  }

  function failWaiter(fs, w, why) {
    const st = storeOf(fs);
    if (!st.waiters.has(w)) return;
    st.waiters.delete(w);
    releaseNeed(st, w);
    log(fs, 'storeFail', '', why);
    storeFails.push(now());
    while (storeFails.length && now() - storeFails[0] > 60e3) storeFails.shift();
    if (storeFails.length >= 3) autoOffMulti({ k: 'whyFails' });
    try { w.onFail(why); } catch (_) {}
  }

  // Safety net. Answering the player's XHR ourselves depends on how B站's
  // player reads it; if that ever changes, or the store keeps failing, stop
  // doing it for the rest of this page and let every request go out natively.
  let lastStoreServe = -Infinity;
  let multiAutoOff = null; // { k, a } reason, rendered in the current language
  const storeFails = [];

  function autoOffMulti(reason) {
    if (!cfg.multi) return;
    cfg.multi = false; // this page only; the saved setting is untouched
    multiAutoOff = reason;
    log(null, 'guard', '', { k: 'guardInfo', a: [reason] });
  }

  try {
    document.addEventListener('error', function (e) {
      const t = e.target;
      if (t && t.tagName === 'VIDEO' && t.error && now() - lastStoreServe < 30e3) {
        autoOffMulti({ k: 'whyMedia', a: [t.error.code] });
      }
    }, true);
  } catch (_) {}

  function storeRequest(fs, reqU, host, range, deadline, hooks) {
    const st = storeOf(fs);
    refreshHosts(fs, host, reqU);
    const w = {
      a: range.start, b: range.end, i0: Math.floor(range.start / BLOCK), i1: Math.floor(range.end / BLOCK),
      t0: now(), deadline, headSent: false, onHead: hooks.head, onDone: hooks.done, onFail: hooks.fail
    };
    for (let i = w.i0; i <= w.i1; i += 1) blockAt(st, i).need += 1;
    const ahead = Math.max(8 * MB, Math.min(cfg.readAheadMaxMB * MB, bwMbps(fs) * 1e6 / 8 * cfg.readAheadSec));
    const seek = range.start < st.low - 8 * MB || range.start > st.raEnd + BLOCK;
    st.low = range.start;
    st.raEnd = seek ? range.end + ahead : Math.max(st.raEnd, range.end + ahead);
    st.waiters.add(w);
    schedule(fs);
    // Never answer inside send(): the player sets up its bookkeeping right
    // after send() returns, and a real XHR never fires load synchronously.
    Promise.resolve().then(function () {
      if (!st.waiters.has(w)) return;
      for (let i = w.i0; i <= w.i1; i += 1) {
        const b = st.blocks.get(i);
        if (b && (b.done || b.runs.some(r => r.head))) { headWaiter(w); break; }
      }
      checkWaiter(fs, w);
    });
    return w;
  }

  function installShim(xhr, st) {
    const defs = {
      readyState: () => st.rs,
      status: () => st.status,
      statusText: () => st.statusText,
      response: () => st.response,
      responseURL: () => st.url
    };
    Object.keys(defs).forEach(k => Object.defineProperty(xhr, k, { configurable: true, get: defs[k] }));
    xhr.getAllResponseHeaders = () => st.rs >= 2 ? 'content-length: ' + st.len + '\r\ncontent-type: video/mp4\r\n' : '';
    xhr.getResponseHeader = function (n) {
      n = String(n).toLowerCase();
      if (st.rs < 2) return null;
      return n === 'content-length' ? String(st.len) : n === 'content-type' ? 'video/mp4' : null;
    };
    shimmed.add(xhr);
  }

  function removeShim(xhr) {
    ['readyState', 'status', 'statusText', 'response', 'responseURL', 'getAllResponseHeaders', 'getResponseHeader']
      .forEach(k => { try { delete xhr[k]; } catch (_) {} });
    shimmed.delete(xhr);
  }

  function fireEv(xhr, type, loaded, total) {
    try {
      xhr.dispatchEvent(type === 'readystatechange' ? new Event(type)
        : new ProgressEvent(type, { lengthComputable: total > 0, loaded: loaded || 0, total: total || 0 }));
    } catch (_) {}
  }

  // Answer the player's XHR from the block store. Returns false when the
  // request should just go out natively instead.
  function storeSend(xhr, m, target, args) {
    const fs = m.fs;
    const range = m.range;
    if (!cfg.multi || !range || range.size < 64 * KB || fs.kind !== 'video' || xhr.responseType !== 'arraybuffer' ||
        !fs.route || fs.route.cls !== 'mainland' || target.host !== fs.route.host) return false;

    const st = { rs: 1, status: 0, statusText: '', response: null, url: target.url, len: range.size };
    installShim(xhr, st);
    m.shim = { st };
    m.deferred = false;
    const t0 = now();
    const timeout = xhr.timeout > 0 ? xhr.timeout : 20000;
    const toHeaders = function () {
      if (st.rs >= 2 || m.aborted) return;
      st.rs = 2; st.status = 206; st.statusText = 'Partial Content';
      fireEv(xhr, 'readystatechange');
      st.rs = 3;
      fireEv(xhr, 'readystatechange');
    };
    m.shim.waiter = storeRequest(fs, m.u, target.host, range, timeout - 400, {
      head: toHeaders,
      done: function (buf) {
        if (m.aborted) return;
        toHeaders();
        st.len = buf.byteLength;
        st.response = buf;
        st.rs = 4;
        m.shimDone = true;
        lastStoreServe = now();
        fs.bytes += buf.byteLength;
        fireEv(xhr, 'progress', buf.byteLength, buf.byteLength);
        fireEv(xhr, 'readystatechange');
        fireEv(xhr, 'load', buf.byteLength, buf.byteLength);
        fireEv(xhr, 'loadend', buf.byteLength, buf.byteLength);
      },
      fail: function () {
        if (m.aborted) return;
        reroute(fs, 'timeout');
        if (st.rs < 2 && now() - t0 < timeout / 2) {
          // Nothing shown to the player yet: fall back to one plain request.
          m.shim = null;
          removeShim(xhr);
          const host = fs.route ? fs.route.host : m.u.host;
          fire(xhr, m, { url: urlForHost(fs, host, m.u) || m.url, host }, args);
          return;
        }
        st.rs = 4; st.status = 0;
        m.shimDone = true;
        fireEv(xhr, 'readystatechange');
        fireEv(xhr, 'timeout');
        fireEv(xhr, 'loadend');
      }
    });
    return true;
  }

  // The player gave up on (aborted / reused) a request the store is answering.
  function cancelShim(m) {
    m.aborted = true;
    const fs = m.fs;
    const w = m.shim && m.shim.waiter;
    if (fs && fs.store && w && fs.store.waiters.has(w)) {
      fs.store.waiters.delete(w);
      releaseNeed(fs.store, w);
    }
  }

  function dispatchRequest(xhr, m, target, args) {
    try {
      if (target && storeSend(xhr, m, target, args)) return undefined;
    } catch (_) {
      if (m.shim) { cancelShim(m); m.aborted = false; m.shim = null; removeShim(xhr); }
    }
    return fire(xhr, m, target, args);
  }

  // ---- XHR ------------------------------------------------------------------

  // Per-request state lives in closures, not on the XHR object, so nothing a
  // page or another userscript does to the object can collide with it.
  const metaOf = new WeakMap();
  const hooked = new WeakSet();
  const shimmed = new WeakSet(); // XHRs currently answered by a multi-source job

  function onReadyState() {
    const m = metaOf.get(this);
    if (m && m.media && this.readyState === 2 && !m.tHead) m.tHead = now();
  }

  function onTimeout() {
    const m = metaOf.get(this);
    if (m && m.media) m.timedOut = true;
  }

  function onLoadEnd(e) {
    const m = metaOf.get(this);
    if (!m || !m.media || !m.sent) return;
    m.tEnd = now();
    try { onSegmentDone(m, this.status, e && typeof e.loaded === 'number' ? e.loaded : 0); } catch (_) {}
  }

  function onPlayurlLoad() {
    try {
      let v = null;
      if (this.responseType === 'json') v = this.response;
      else if (this.responseType === '' || this.responseType === 'text') v = nativeParse(this.responseText);
      if (v) register(v);
    } catch (_) {}
  }

  XP.open = function (method, url) {
    const prev = metaOf.get(this);
    if (prev && prev.shim && !prev.shimDone) cancelShim(prev);
    if (shimmed.has(this)) removeShim(this);
    const s = typeof url === 'string' ? url : (url && url.href) || String(url);
    const m = { method, url: s, async: arguments.length < 3 || arguments[2] !== false, user: arguments[3], pass: arguments[4], headers: [] };
    metaOf.set(this, m);
    if (cfg.enabled) {
      const u = toURL(s);
      if (u && isMedia(u)) { m.media = true; m.u = u; }
      else if (u && isPlayurl(u)) m.playurl = true;
    }
    return xOpen.apply(this, arguments);
  };

  XP.setRequestHeader = function (k, v) {
    const m = metaOf.get(this);
    if (m) m.headers.push([k, v]);
    return xSetHeader.apply(this, arguments);
  };

  function fire(xhr, m, target, args) {
    m.deferred = false;
    if (target && target.url && target.url !== m.url) {
      try {
        xOpen.call(xhr, m.method, target.url, true, m.user, m.pass);
        m.headers.forEach(h => xSetHeader.call(xhr, h[0], h[1]));
      } catch (_) {
        target = null;
      }
    }
    m.host = target ? target.host : m.u.host;
    m.tSend = now();
    m.tHead = 0;
    m.sent = true;
    return xSend.apply(xhr, args);
  }

  XP.send = function () {
    const m = metaOf.get(this);
    if (!m || !cfg.enabled) return xSend.apply(this, arguments);
    if (!hooked.has(this)) {
      hooked.add(this);
      this.addEventListener('readystatechange', onReadyState);
      this.addEventListener('timeout', onTimeout);
      this.addEventListener('loadend', onLoadEnd);
    }
    if (m.playurl) this.addEventListener('load', onPlayurlLoad, { once: true });
    if (!m.media || !m.async) return xSend.apply(this, arguments);

    const xhr = this;
    const args = arguments;
    let target;
    try { target = routeRequest(m); } catch (_) { return xSend.apply(this, args); }
    if (target && typeof target.then === 'function') {
      m.deferred = true;
      target.then(function (t) { if (!m.aborted) dispatchRequest(xhr, m, t, args); },
        function () { if (!m.aborted) fire(xhr, m, null, args); });
      return undefined;
    }
    return dispatchRequest(xhr, m, target, args);
  };

  XP.abort = function () {
    const m = metaOf.get(this);
    if (m && m.shim && !m.shimDone && !m.aborted) {
      // Emulate abort() for a request we are answering ourselves.
      cancelShim(m);
      const st = m.shim.st;
      st.rs = 4; st.status = 0;
      fireEv(this, 'readystatechange');
      fireEv(this, 'abort');
      fireEv(this, 'loadend');
      st.rs = 0;
      return undefined;
    }
    if (m) {
      m.aborted = true;
      // Aborted while we were holding it for a probe: start and cancel it for
      // real so the player still gets the abort/loadend events it expects.
      if (m.deferred) {
        m.deferred = false;
        try { xSend.call(this, null); } catch (_) {}
      }
    }
    return xAbort.apply(this, arguments);
  };

  // ---- fetch / JSON.parse / __playinfo__ (read-only playurl capture) --------

  if (nativeFetch) {
    W.fetch = function (input, init) {
      if (!cfg.enabled) return nativeFetch.apply(this, arguments);
      let s = null;
      try { s = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url; } catch (_) {}
      const u = s && toURL(s);
      if (u && isPlayurl(u)) {
        return nativeFetch.apply(this, arguments).then(function (res) {
          try {
            res.clone().text().then(function (t) { try { register(nativeParse(t)); } catch (_) {} }, function () {});
          } catch (_) {}
          return res;
        });
      }
      if (u && isMedia(u)) {
        try {
          const hdrs = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
          const m = { url: u.href, u, headers: [['range', hdrs.get('range')]] };
          const go = function (t) {
            if (!t || t.url === u.href) return nativeFetch.call(W, input, init);
            return nativeFetch.call(W, input instanceof Request ? new Request(t.url, input) : t.url, init);
          };
          const t = routeRequest(m);
          return t && typeof t.then === 'function' ? t.then(go) : go(t);
        } catch (_) {
          return nativeFetch.apply(this, arguments);
        }
      }
      return nativeFetch.apply(this, arguments);
    };
  }

  JSON.parse = function (text) {
    const v = nativeParse.apply(this, arguments);
    try {
      if (cfg.enabled && typeof text === 'string' && text.length > 200 && text.indexOf('upgcxcode') !== -1) register(v);
    } catch (_) {}
    return v;
  };

  try {
    const d = Object.getOwnPropertyDescriptor(W, '__playinfo__');
    let playinfo = d && d.value;
    if (playinfo) register(playinfo);
    if (!d || d.configurable) {
      Object.defineProperty(W, '__playinfo__', {
        configurable: true,
        enumerable: true,
        get: function () { return playinfo; },
        set: function (v) { playinfo = v; try { register(v); } catch (_) {} }
      });
    }
  } catch (_) {}

  // ---- UI -------------------------------------------------------------------

  let host = null;
  let root = null;
  let panelOpen = false;

  function fsRate(fs) {
    if (fs.store && fs.route && fs.route.cls === 'mainland') {
      const sr = storeRate(fs);
      if (sr) return sr;
    }
    const r = fs.samples.slice(-4);
    if (!r.length) return null;
    return r.reduce((a, s) => a + s.bytes, 0) * 8 / r.reduce((a, s) => a + s.dur, 0) / 1000;
  }

  function routeName(fs) {
    if (fs.route && fs.route.cls === 'mainland' && fs.multiHosts && fs.multiHosts.length > 1 && now() - fs.multiAt < 60e3) {
      return fs.multiHosts.map(shortHost).join('+');
    }
    return shortHost(fs.route ? fs.route.host : fs.order[0] || '');
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function buildUi() {
    if (!cfg.ui || !document.body) return;
    if (host) {
      if (!host.isConnected) document.body.appendChild(host); // body replaced (SPA / document.write)
      return;
    }
    host = document.createElement('div');
    host.id = 'bax-host';
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' +
      ':host{all:initial}' +
      '.pill{font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif;color:#fff;background:rgba(20,24,30,.78);border-radius:999px;padding:5px 10px;cursor:pointer;opacity:.35;transition:opacity .2s;user-select:none;white-space:nowrap;display:inline-flex;gap:6px;align-items:center}' +
      '.pill:hover,.open .pill{opacity:1}' +
      '.dot{width:8px;height:8px;border-radius:50%;background:#8a95a1}' +
      '.native .dot{background:#2ed3a0}.mainland .dot{background:#f0a838}' +
      '.panel{display:none;position:absolute;left:0;bottom:34px;width:460px;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;background:rgba(22,26,32,.97);color:#e8edf2;border-radius:10px;padding:10px 12px;font:12px/1.45 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)}' +
      '.open .panel{display:block}' +
      'h4{margin:8px 0 4px;font-size:12px;color:#93a0ac;font-weight:600}' +
      'table{border-collapse:collapse;width:100%}td{padding:1px 6px 1px 0;white-space:nowrap}' +
      '.muted{color:#93a0ac}.good{color:#2ed3a0}.warn{color:#f0a838}' +
      'button{font:12px system-ui,"Microsoft YaHei",sans-serif;background:#2b323d;color:#e8edf2;border:0;border-radius:6px;padding:4px 10px;margin-right:6px;cursor:pointer}' +
      'button:hover{background:#38414d}' +
      '.log{font:11px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;color:#b9c3ce}' +
      '.hd{display:flex;align-items:center;gap:6px}' +
      '.lang{margin-left:auto;display:inline-flex;gap:2px}' +
      '.lang button{margin:0;padding:1px 7px;font-size:11px;border-radius:5px}' +
      '.lang button.on{background:#00aeec;color:#fff}' +
      '.btns{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}.btns button{margin:0}' +
      '</style><div class="wrap"><div class="panel"></div><div class="pill"><span class="dot"></span><span class="txt"></span></div></div>';
    root.querySelector('.txt').textContent = '⚡ ' + L().idle;
    root.querySelector('.pill').addEventListener('click', function () {
      panelOpen = !panelOpen;
      render();
    });
    root.querySelector('.panel').addEventListener('click', function (e) {
      const lang = e.target && e.target.getAttribute && e.target.getAttribute('data-lang');
      if (lang && I18N[lang]) {
        saveJson(CFG_KEY, Object.assign({}, loadJson(CFG_KEY) || {}, { lang }));
        cfg.lang = lang;
        render();
        return;
      }
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'toggle') {
        const next = Object.assign({}, loadJson(CFG_KEY) || {}, { enabled: !cfg.enabled });
        saveJson(CFG_KEY, next);
        location.reload();
      } else if (act === 'multi') {
        const saved = loadJson(CFG_KEY) || {};
        const next = saved.multi === false; // toggle the saved value
        saveJson(CFG_KEY, Object.assign({}, saved, { multi: next }));
        cfg.multi = next;
        multiAutoOff = null;
        render();
      } else if (act === 'reset') {
        Object.keys(stats).forEach(k => delete stats[k]);
        saveJson(STATS_KEY, stats);
        render();
      }
    });
    document.body.appendChild(host);
    document.addEventListener('fullscreenchange', function () {
      host.style.display = document.fullscreenElement ? 'none' : '';
    });
  }

  function render() {
    if (!root) return;
    const wrap = root.querySelector('.wrap');
    const fs = current.video;
    const cls = fs && fs.route ? fs.route.cls : '';
    wrap.className = 'wrap ' + cls + (panelOpen ? ' open' : '');
    const rate = fs && fsRate(fs);
    const T = L();
    root.querySelector('.txt').textContent = !cfg.enabled ? '⚡ ' + T.paused
      : !fs ? '⚡ ' + T.idle
        : '⚡ ' + (cls === 'mainland' ? T.mainland + ' ' : cls === 'native' ? T.native + ' ' : '') + routeName(fs) +
          (rate ? ' · ' + rate.toFixed(0) + ' Mbps' : '');
    if (!panelOpen) return;

    const recentFiles = Array.from(new Set(files.values()))
      .filter(f => f.lastUsed && Date.now() - f.lastUsed < 10 * 60e3)
      .sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 6);
    const rows = recentFiles.map(function (f) {
      const r = fsRate(f);
      const c = f.route ? f.route.cls : '';
      return '<tr><td>' + esc(f.label || f.path.split('/').pop()) + '</td>' +
        '<td class="muted">' + (f.bw ? (f.bw / 1e6).toFixed(1) + 'M' : '?') + '</td>' +
        '<td class="' + (c === 'native' ? 'good' : c === 'mainland' ? 'warn' : 'muted') + '">' +
        (c === 'native' ? T.native : c === 'mainland' ? T.mainland : T.direct) + ' ' + esc(routeName(f)) + '</td>' +
        '<td>' + (r ? r.toFixed(1) + ' Mbps' : '') + '</td></tr>';
    }).join('');
    const ml = cfg.mainland.map(function (h) {
      const r = statRate(h);
      const s = stats[h];
      return '<tr><td>' + shortHost(h) + '</td><td>' + (s && s.n >= 3 ? r.toFixed(1) + ' Mbps' : T.untested) +
        '</td><td class="muted">' + (s && s.ttfb != null ? T.ttfb + ' ' + s.ttfb.toFixed(0) + ' ms' : '') + '</td></tr>';
    }).join('');
    const lg = logs.slice(-14).reverse()
      .map(l => esc(l.t + ' ' + (T.ev[l.ev] || l.ev) + ' ' + l.h + '  ' + l.f + '  ' + tr(l.info))).join('\n');
    const cur = uiLang();
    const langs = [['zh', '中'], ['en', 'EN'], ['ja', '日']]
      .map(p => '<button data-lang="' + p[0] + '"' + (p[0] === cur ? ' class="on"' : '') + '>' + p[1] + '</button>').join('');
    root.querySelector('.panel').innerHTML =
      '<div class="hd"><b>' + T.brand + '</b> <span class="muted">v' + VERSION + '</span><span class="lang">' + langs + '</span></div>' +
      '<h4>' + T.files + '</h4><table>' + (rows || '<tr><td class="muted">' + T.noVideo + '</td></tr>') + '</table>' +
      '<h4>' + T.mirrors + '</h4><table>' + ml + '</table>' +
      '<h4>' + T.log + '</h4><div class="log">' + (lg || '<span class="muted">' + T.none + '</span>') + '</div>' +
      (multiAutoOff ? '<div class="warn" style="margin-top:6px">' + T.autoOff + esc(tr(multiAutoOff)) + '</div>' : '') +
      '<div class="btns"><button data-act="toggle">' + (cfg.enabled ? T.pause : T.resume) + '</button>' +
      '<button data-act="multi">' + T.multi + ((loadJson(CFG_KEY) || {}).multi === false ? T.off : T.on) + '</button>' +
      '<button data-act="reset">' + T.reset + '</button></div>';
  }

  function uiLoop() {
    buildUi();
    if (root && (current.video || !cfg.enabled)) render();
  }
  setInterval(uiLoop, 1000);

  // ---- diagnostics ----------------------------------------------------------

  W.__BAX__ = {
    version: VERSION,
    cfg,
    files,
    stats,
    logs,
    register,
    dump: function () {
      const uniq = Array.from(new Set(files.values()));
      return {
        version: VERSION,
        enabled: cfg.enabled,
        files: uniq.filter(f => f.lastUsed).map(f => ({
          label: f.label, kind: f.kind, bwMbps: f.bw ? +(f.bw / 1e6).toFixed(2) : null,
          route: f.route && { host: shortHost(f.route.host), cls: f.route.cls, why: f.route.why },
          natives: f.order.map(shortHost),
          failed: Array.from(f.failed.keys()).filter(h => isFailed(f, h)).map(shortHost),
          verified: Array.from(f.verified).map(shortHost),
          rate: fsRate(f) && +fsRate(f).toFixed(1), MB: +(f.bytes / MB).toFixed(1), multi: f.multiUsed || null
        })),
        mainland: cfg.mainland.map(h => ({ h: shortHost(h), rate: statRate(h) && +statRate(h).toFixed(1), n: stats[h] ? stats[h].n : 0, ttfb: stats[h] && stats[h].ttfb && Math.round(stats[h].ttfb) })),
        log: logs.slice(-30)
      };
    }
  };
})();
