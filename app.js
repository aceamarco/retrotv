/* Retro TV: simulated linear television over archive.org files.
   Every channel has a deterministic schedule derived from the wall clock, so
   tuning in lands you mid-episode (or mid-commercial) like a real broadcast. */
(() => {
  "use strict";

  const EPOCH = Date.UTC(2024, 0, 1) / 1000;   // schedule origin (seconds)
  const AD_BREAK_MIN = 90, AD_BREAK_MAX = 180; // seconds per break
  const AD_CLIP_MIN = 30, AD_CLIP_MAX = 75;    // window into a compilation
  const STATIC_MS = 650;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  // ?mode=tv: full-bleed picture driven by a remote's d-pad (what the Android TV app loads)
  const TV = params.get("mode") === "tv";
  if (TV) document.documentElement.classList.add("tvmode");
  const video = $("video"), staticCanvas = $("static"), osd = $("osd"), osdText = $("osdText");
  const volOsd = $("volOsd"), volBar = $("volBar"), boot = $("boot"), info = $("info");
  const guide = $("guide"), guideList = $("guideList");

  let DATA, channels = [], adPools = {}, allAds = [];
  let chIndex = 0, on = false, slot = null, tickTimer = null, osdTimer = null, volTimer = null;
  let typed = "", typedTimer = null, lastNudge = 0;
  let guideSel = 0, bannerTimer = null;
  let audioCtx = null, noiseNode = null;

  /* ---------- seeded randomness ---------- */
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /* ---------- schedule ----------
     A "cycle" is one shuffled pass through the channel's episodes, each split in
     two by a mid-episode ad break and followed by another break. The cycle index
     seeds the shuffle, so the schedule is stable for everyone and repeats never
     line up the same way twice. */
  function adsFor(ch) {
    if (!ch.ads) return allAds;
    const names = Array.isArray(ch.ads) ? ch.ads : [ch.ads];
    const list = names.flatMap((n) => adPools[n] || []);
    return list.length ? list : allAds;
  }
  function buildAdBreak(rnd, target, ads) {
    const out = []; let total = 0;
    while (total < target && out.length < 8) {
      const ad = ads[Math.floor(rnd() * ads.length)];
      let start = 0, dur = ad.length;
      if (ad.length > AD_CLIP_MAX) {
        dur = AD_CLIP_MIN + rnd() * (AD_CLIP_MAX - AD_CLIP_MIN);
        start = rnd() * (ad.length - dur);
      }
      out.push({ type: "ad", video: ad, start, dur });
      total += dur;
    }
    return out;
  }
  function buildCycle(ch, cycleIdx) {
    const rnd = mulberry32(ch.number * 7919 + cycleIdx * 104729 + 17);
    const eps = ch.ordered ? ch.videos : shuffle(ch.videos, rnd);
    const ads = adsFor(ch);
    const slots = [];
    for (const ep of eps) {
      if (ch.breaks === false || !ads.length) {
        // recording already has its commercials: play it straight through
        slots.push({ type: "show", video: ep, start: 0, dur: ep.length, part: 0 });
        continue;
      }
      const mid = ep.length * (0.45 + rnd() * 0.1);
      slots.push({ type: "show", video: ep, start: 0, dur: mid, part: 1 });
      slots.push(...buildAdBreak(rnd, AD_BREAK_MIN + rnd() * (AD_BREAK_MAX - AD_BREAK_MIN), ads));
      slots.push({ type: "show", video: ep, start: mid, dur: ep.length - mid, part: 2 });
      slots.push(...buildAdBreak(rnd, AD_BREAK_MIN + rnd() * (AD_BREAK_MAX - AD_BREAK_MIN), ads));
    }
    let t = 0;
    for (const s of slots) { s.at = t; t += s.dur; }
    return { slots, length: t };
  }
  const cycleCache = new Map();
  function getCycle(ch, idx) {
    const key = ch.number + ":" + idx;
    if (!cycleCache.has(key)) cycleCache.set(key, buildCycle(ch, idx));
    return cycleCache.get(key);
  }
  // Cycle lengths vary a little with the seed, so walk forward from the epoch
  // using the nominal length (episodes + average breaks) as the stride.
  function nominalLength(ch) {
    const perEp = ch.breaks === false ? 0 : AD_BREAK_MIN + AD_BREAK_MAX;
    return ch.videos.reduce((s, v) => s + v.length, 0) + ch.videos.length * perEp;
  }
  function locate(ch, now) {
    const elapsed = now - EPOCH;
    const nominal = nominalLength(ch);
    let idx = Math.floor(elapsed / nominal);
    // cycles are laid end-to-end with their true lengths starting from cycle idx's nominal start
    let cycleStart = idx * nominal;
    let cyc = getCycle(ch, idx);
    while (elapsed >= cycleStart + cyc.length) { cycleStart += cyc.length; idx++; cyc = getCycle(ch, idx); }
    return { idx, cycleStart, cyc, pos: elapsed - cycleStart };
  }
  function currentSlot(ch, now) {
    const { idx, cyc, pos } = locate(ch, now);
    let i = cyc.slots.findIndex((s) => pos < s.at + s.dur);
    if (i < 0) i = cyc.slots.length - 1;
    const s = cyc.slots[i];
    const next = cyc.slots[i + 1] || getCycle(ch, idx + 1).slots[0];
    return { ...s, offset: pos - s.at, endsAt: now + (s.dur - (pos - s.at)), next };
  }
  // Programs (an episode plus the ad breaks glued to it) overlapping [from, to],
  // with absolute start/end times. Used by the grid guide.
  function programsBetween(ch, from, to) {
    let { idx, cycleStart, cyc } = locate(ch, from);
    const out = []; let cur = null;
    for (let guard = 0; guard < 50; guard++) {
      for (const s of cyc.slots) {
        const at = EPOCH + cycleStart + s.at, end = at + s.dur;
        if (at >= to) return out.filter((p) => p.end > from);
        if (s.type === "show" && s.part !== 2) { cur = { video: s.video, start: at, end }; out.push(cur); }
        else if (cur) cur.end = end;
      }
      cycleStart += cyc.length; idx++; cyc = getCycle(ch, idx);
    }
    return out.filter((p) => p.end > from);
  }

  /* ---------- static noise ---------- */
  const sctx = staticCanvas.getContext("2d", { alpha: false });
  let staticRaf = null;
  function drawStatic() {
    const w = 160, h = 120;
    if (staticCanvas.width !== w) { staticCanvas.width = w; staticCanvas.height = h; }
    const img = sctx.createImageData(w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    sctx.putImageData(img, 0, 0);
    staticRaf = requestAnimationFrame(drawStatic);
  }
  function noiseAudio(onOff) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (noiseNode) { try { noiseNode.stop(); } catch (e) {} noiseNode = null; }
      if (onOff) {
        const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
        noiseNode = audioCtx.createBufferSource(); noiseNode.buffer = buf; noiseNode.loop = true;
        const g = audioCtx.createGain(); g.gain.value = video.muted ? 0 : 0.08 * video.volume;
        noiseNode.connect(g).connect(audioCtx.destination); noiseNode.start();
      }
    } catch (e) { /* audio is optional */ }
  }
  function showStatic(ms) {
    staticCanvas.classList.add("on");
    if (!staticRaf) drawStatic();
    noiseAudio(true);
    clearTimeout(showStatic.t);
    showStatic.t = setTimeout(hideStatic, ms);
  }
  function hideStatic() {
    staticCanvas.classList.remove("on");
    cancelAnimationFrame(staticRaf); staticRaf = null;
    noiseAudio(false);
  }

  /* ---------- playback ---------- */
  let loadToken = 0;
  function play(slotNow) {
    slot = slotNow;
    const target = slot.video.url;
    const seekTo = slot.start + slot.offset;
    const token = ++loadToken;
    const seekAndPlay = () => {
      if (token !== loadToken) return;          // a newer tune() superseded this one
      try { video.currentTime = Math.min(seekTo, Math.max(0, (video.duration || Infinity) - 1)); } catch (e) {}
      video.play().catch((e) => {
        // TV mode powers on without a gesture; a plain browser only allows that muted
        if (TV && e.name === "NotAllowedError" && !video.muted) { muteUntilGesture(); video.play().catch(() => {}); }
      });
    };
    if (video.getAttribute("src") === target && video.readyState >= 1) {
      seekAndPlay();
    } else {
      video.addEventListener("loadedmetadata", seekAndPlay, { once: true });
      video.src = target;
      video.load();
    }
    video.classList.toggle("fill", slot.type === "ad");
    renderInfo();
  }
  function muteUntilGesture() {
    video.muted = true;
    const unmute = () => { video.muted = false; showVol(); };
    document.addEventListener("pointerdown", unmute, { once: true });
    document.addEventListener("keydown", unmute, { once: true });
  }
  function sync() {
    const ch = channels[chIndex];
    play(currentSlot(ch, Date.now() / 1000));
  }
  function tick() {
    if (!on || !slot) return;
    const now = Date.now() / 1000;
    if (now >= slot.endsAt - 0.25) { sync(); return; }
    // keep the video roughly on the broadcast clock (buffering drifts it)
    const want = slot.start + (now - (slot.endsAt - slot.dur));
    if (video.readyState >= 3 && !video.paused && !video.seeking && Math.abs(video.currentTime - want) > 8 && now - lastNudge > 4) {
      lastNudge = now;
      try { video.currentTime = want; } catch (e) {}
    }
    if (video.paused && video.readyState >= 2 && !document.hidden) video.play().catch(() => {});
  }
  video.addEventListener("error", () => {
    // file gone or unplayable: skip forward to the next slot after a beat
    console.warn("video error", slot && slot.video.url);
    setTimeout(() => { if (on) { showStatic(400); sync(); } }, 1500);
  });
  video.addEventListener("ended", () => { if (on) sync(); });

  function tune(idx, opts = {}) {
    if (!channels.length) return;
    chIndex = ((idx % channels.length) + channels.length) % channels.length;
    const ch = channels[chIndex];
    try { localStorage.setItem("retrotv.channel", String(ch.number)); } catch (e) {}
    showOsd(String(ch.number).padStart(2, "0"), ch);
    if (frameMode === "auto" && frames.length) showFrame(frameForChannel(ch));
    if (!opts.silent) showStatic(STATIC_MS);
    sync();
    renderGuideCurrent();
    showBanner();
  }

  /* ---------- UI ---------- */
  function showOsd(text, ch) {
    osdText.textContent = text;
    $("osdName").textContent = ch ? ch.name : "";
    osd.style.setProperty("--brand", (ch && ch.color) || "var(--osd)");
    osd.classList.add("show");
    clearTimeout(osdTimer); osdTimer = setTimeout(() => osd.classList.remove("show"), 2600);
  }
  function showVol() {
    volBar.style.width = (video.muted ? 0 : video.volume * 100) + "%";
    volOsd.classList.add("show");
    clearTimeout(volTimer); volTimer = setTimeout(() => volOsd.classList.remove("show"), 1800);
  }
  // TV mode: the now/next strip is a banner over the picture that fades out
  function showBanner() {
    if (!TV) return;
    info.classList.add("show");
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => info.classList.remove("show"), 6000);
  }
  function fmt(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); }
  function renderInfo() {
    const ch = channels[chIndex];
    $("infoCh").textContent = ch.number + " · " + ch.name;
    $("infoCh").style.color = ch.color || "";
    document.querySelector(".info .now").style.borderColor = ch.color || "";
    if (slot.type === "ad") {
      $("infoTitle").textContent = "Commercial break";
      $("infoMeta").innerHTML = `clip from <a href="https://archive.org/details/${slot.video.item}" target="_blank" rel="noopener">${esc(slot.video.title)}</a>`;
    } else {
      $("infoTitle").textContent = slot.video.title;
      $("infoMeta").innerHTML = `${slot.part ? "part " + slot.part + " of 2 · " : ""}${fmt(slot.video.length)} · <a href="https://archive.org/details/${slot.video.item}" target="_blank" rel="noopener">archive.org</a>`;
    }
    const n = slot.next;
    $("infoNext").textContent = n ? (n.type === "ad" ? "Commercial break" : n.video.title + (n.part === 2 ? " (cont.)" : "")) + " · in " + fmt(slot.endsAt - Date.now() / 1000) : "";
  }
  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  /* ---------- grid guide ----------
     Rows are channels, columns are half hours. Blocks are positioned by wall
     clock time, so what's on the grid is exactly what tuning in would play. */
  const SLOT = 30 * 60;                                   // one column, seconds
  let guideStart = null;                                  // window start (seconds), null = follow the clock
  let guideTimer = null;
  const guideCols = () => (window.innerWidth < 720 ? 3 : 4);
  const floorHalf = (t) => Math.floor(t / SLOT) * SLOT;
  const timeFmt = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
  function guideWindow() {
    const now = Date.now() / 1000;
    const start = guideStart === null ? floorHalf(now) : guideStart;
    return { now, start, end: start + guideCols() * SLOT, len: guideCols() * SLOT };
  }
  function renderGuide() {
    const w = guideWindow();
    // time bar
    const times = $("guideTimes");
    times.style.setProperty("--cols", guideCols());
    times.innerHTML = `<div class="corner">${dateFmt.format(w.start * 1000)}</div>`;
    for (let i = 0; i < guideCols(); i++) {
      const d = document.createElement("div"); d.className = "tk";
      d.textContent = timeFmt.format((w.start + i * SLOT) * 1000);
      times.appendChild(d);
    }
    // rows
    const line = $("guideNowLine");
    guideList.innerHTML = "";
    let group = null;
    channels.forEach((ch, i) => {
      if (ch.group && ch.group !== group) {
        group = ch.group;
        const h = document.createElement("div"); h.className = "grp"; h.textContent = group;
        guideList.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "row"; row.dataset.index = i;
      row.style.setProperty("--brand", ch.color || "var(--accent)");
      const chan = document.createElement("button");
      chan.className = "chan"; chan.title = ch.tagline || ch.name;
      chan.innerHTML = `<span class="num">${ch.number}</span><span class="nm">${esc(ch.name)}</span>`;
      chan.addEventListener("click", () => { powerOn(); tune(i); toggleGuide(false); });
      const lane = document.createElement("div"); lane.className = "lane";
      for (const p of programsBetween(ch, w.start, w.end)) {
        const b = document.createElement("button");
        b.className = "prog";
        const s = Math.max(p.start, w.start), e = Math.min(p.end, w.end);
        b.style.left = ((s - w.start) / w.len * 100) + "%";
        b.style.width = ((e - s) / w.len * 100) + "%";
        if ((e - s) / w.len < 0.035) b.classList.add("tiny");   // too narrow for a label
        if (p.start < w.start) b.classList.add("cl");
        if (p.end > w.end) b.classList.add("cr");
        if (w.now >= p.start && w.now < p.end) b.classList.add("live");
        b.title = `${esc(p.video.title)}\n${timeFmt.format(p.start * 1000)} – ${timeFmt.format(p.end * 1000)}`;
        b.innerHTML = `<span>${esc(p.video.title)}</span>`;
        b.addEventListener("click", () => { powerOn(); tune(i); toggleGuide(false); });
        lane.appendChild(b);
      }
      row.append(chan, lane);
      guideList.appendChild(row);
    });
    // now line (unitless fraction of the lane width)
    const inWin = w.now >= w.start && w.now < w.end;
    line.hidden = !inWin;
    if (inWin) line.style.setProperty("--x", String((w.now - w.start) / w.len));
    guideList.appendChild(line);
    $("guideNow").classList.toggle("on", guideStart === null);
    renderGuideCurrent();
  }
  function renderGuideCurrent() {
    guideList.querySelectorAll(".row").forEach((r) => {
      r.classList.toggle("current", Number(r.dataset.index) === chIndex);
      r.classList.toggle("sel", TV && Number(r.dataset.index) === guideSel);
    });
  }
  function moveGuideSel(dir) {
    guideSel = (guideSel + dir + channels.length) % channels.length;
    renderGuideCurrent();
    const row = guideList.querySelector(".row.sel");
    if (row) row.scrollIntoView({ block: "nearest" });
  }
  function shiftGuide(dir) {
    const w = guideWindow();
    guideStart = w.start + dir * SLOT;
    if (guideStart === floorHalf(Date.now() / 1000)) guideStart = null;   // back on the live window
    renderGuide();
  }
  function toggleGuide(force) {
    const show = force === undefined ? guide.hidden : force;
    guide.hidden = !show;
    clearInterval(guideTimer); guideTimer = null;
    if (show) {
      guideStart = null; guideSel = chIndex;
      renderGuide();
      guideTimer = setInterval(renderGuide, 30000);
      const cur = guideList.querySelector(".row.current");
      if (cur) cur.scrollIntoView({ block: "center" });
    }
  }
  $("guidePrev").addEventListener("click", () => shiftGuide(-1));
  $("guideNext").addEventListener("click", () => shiftGuide(1));
  $("guideNow").addEventListener("click", () => { guideStart = null; renderGuide(); });
  window.addEventListener("resize", () => { if (!guide.hidden) renderGuide(); });

  function powerOn() {
    if (on) return;
    on = true; boot.hidden = true; info.hidden = false;
    try { if (audioCtx) audioCtx.resume(); } catch (e) {}
    let start = 0;
    try { const saved = Number(localStorage.getItem("retrotv.channel")); const i = channels.findIndex((c) => c.number === saved); if (i >= 0) start = i; } catch (e) {}
    tune(start);
    tickTimer = setInterval(tick, 500);
    setInterval(() => { if (on && slot) renderInfo(); }, 1000);
  }
  function powerOff() {
    on = false; slot = null; clearInterval(tickTimer);
    video.pause(); video.removeAttribute("src"); video.load();
    hideStatic(); boot.hidden = false; info.hidden = true;
  }

  function act(name) {
    switch (name) {
      case "power": on ? powerOff() : powerOn(); break;
      case "chup": powerOn(); tune(chIndex + 1); break;
      case "chdown": powerOn(); tune(chIndex - 1); break;
      case "volup": video.muted = false; video.volume = Math.min(1, video.volume + 0.1); showVol(); break;
      case "voldown": video.volume = Math.max(0, video.volume - 0.1); showVol(); break;
      case "mute": video.muted = !video.muted; $("muteBtn").classList.toggle("on", video.muted); showVol(); break;
      case "guide": toggleGuide(); break;
      case "full": {
        const el = tvEl.classList.contains("photo") ? stage : $("screen");
        if (document.fullscreenElement) document.exitFullscreen();
        else if (el.requestFullscreen) el.requestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        break;
      }
    }
  }
  document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
  $("powerBtn").addEventListener("click", () => act("power"));
  $("guideClose").addEventListener("click", () => toggleGuide(false));
  $("screen").addEventListener("click", (e) => { if (on && e.target !== boot && !boot.contains(e.target)) act("chup"); });

  /* Remote control (TV mode). The d-pad drives the guide while it is open and
     the channels otherwise. */
  function tvKey(k) {
    if (!guide.hidden) {
      if (k === "ArrowUp" || k === "ArrowDown") moveGuideSel(k === "ArrowUp" ? -1 : 1);
      else if (k === "ArrowLeft" || k === "ArrowRight") shiftGuide(k === "ArrowLeft" ? -1 : 1);
      else if (k === "Enter") { powerOn(); tune(guideSel); toggleGuide(false); }
      else if (k === "Back" || k === "Guide") toggleGuide(false);
      else return false;
      return true;
    }
    if (k === "Enter" || k === "Guide") toggleGuide(true);
    else if (k === "ArrowLeft" || k === "ArrowRight" || k === "Info") showBanner();
    else if (k === "ChannelUp" || k === "PageUp") act("chup");
    else if (k === "ChannelDown" || k === "PageDown") act("chdown");
    else return false;
    return true;
  }
  if (TV) {
    // The Android app forwards remote keys here; true means the page handled it
    // (the app exits on a Back that comes back false).
    window.retroTV = { key: (k) => !document.dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true })) };
    $("guideKeys").textContent = "▲▼ channel · ◀▶ time · OK tune · BACK close";
    // the app going to the background must not keep playing audio
    document.addEventListener("visibilitychange", () => {
      if (!on) return;
      if (document.hidden) video.pause(); else sync();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (TV && tvKey(e.key)) { e.preventDefault(); return; }
    if (e.key >= "0" && e.key <= "9") {
      typed += e.key; showOsd(typed.padStart(2, "-"));
      clearTimeout(typedTimer);
      const commit = () => { const n = Number(typed); typed = ""; const i = channels.findIndex((c) => c.number === n); if (i >= 0) { powerOn(); tune(i); } else showOsd("--"); };
      if (typed.length >= 2) commit(); else typedTimer = setTimeout(commit, 1200);
      return;
    }
    if (!TV && (e.key === "t" || e.key === "T")) { cycleFrame(e.shiftKey ? -1 : 1); return; }
    const map = { ArrowUp: "chup", ArrowDown: "chdown", ArrowRight: "volup", ArrowLeft: "voldown", m: "mute", f: "full", g: "guide", p: "power", Escape: null };
    if (e.key === "Escape") { toggleGuide(false); return; }
    if (e.key in map) { e.preventDefault(); act(map[e.key]); }
  });

  /* ---------- TV set frames ---------- */
  let frames = [];
  const tvEl = $("tv"), stage = $("stage"), bezel = $("bezel"), frameImg = $("frameImg"), frameSel = $("frameSel"), frameCredit = $("frameCredit");
  let frameMode = "classic";   // "auto" follows the channel's decade; otherwise a fixed frame id
  function decadeOf(ch) {
    // era strings look like "1950s", "1990s-2000s", "1971-2008": take the first year
    const m = /(\d{4})/.exec(ch.era || "");
    return m ? Math.floor(Number(m[1]) / 10) * 10 + "s" : null;
  }
  function frameForChannel(ch) {
    const d = ch && decadeOf(ch);
    if (d && frames.some((f) => f.id === d)) return d;
    return "2000s";                             // sensible default for anything undated
  }
  function applyFrame(id) {
    if (id === "auto") {
      frameMode = "auto";
      try { localStorage.setItem("retrotv.frame", "auto"); } catch (e) {}
      frameSel.value = "auto";
      showFrame(channels.length ? frameForChannel(channels[chIndex]) : "classic");
      return;
    }
    frameMode = id;
    try { localStorage.setItem("retrotv.frame", id); } catch (e) {}
    frameSel.value = frames.some((x) => x.id === id) ? id : "classic";
    showFrame(id);
  }
  function showFrame(id) {
    const f = frames.find((x) => x.id === id);
    if (!f) {
      tvEl.classList.remove("photo"); frameImg.hidden = true; frameImg.removeAttribute("src");
      stage.style.cssText = ""; bezel.style.cssText = ""; frameCredit.textContent = "";
      return;
    }
    tvEl.classList.add("photo");
    stage.style.aspectRatio = String(f.aspect);
    stage.style.maxWidth = `calc(86vh * ${f.aspect})`;   // tall sets (antennas, pedestals) stay on screen
    stage.style.margin = "0 auto";
    const o = 0.6; // overscan so the picture tucks under the bezel's rounded corners
    const sc = f.screen;
    bezel.style.cssText = `left:${sc.left - o}%;top:${sc.top - o}%;width:${sc.width + 2 * o}%;height:${sc.height + 2 * o}%;`;
    frameImg.src = f.src; frameImg.hidden = false;
    frameCredit.textContent = " TV set image generated with Gemini.";
  }
  function cycleFrame(dir = 1) {
    const ids = ["auto", "classic", ...frames.map((f) => f.id)];
    const i = ids.indexOf(frameSel.value);
    applyFrame(ids[(i + dir + ids.length) % ids.length]);
  }
  frameSel.addEventListener("change", () => applyFrame(frameSel.value));
  if (!TV) fetch("frames/frames.json").then((r) => r.json()).then((list) => {
    frames = list;
    for (const f of frames) { const op = document.createElement("option"); op.value = f.id; op.textContent = f.name; frameSel.appendChild(op); }
    let saved = "classic";
    try { saved = localStorage.getItem("retrotv.frame") || "classic"; } catch (e) {}
    const q = params.get("tv");
    applyFrame(q || saved);
  }).catch(() => {});

  /* ---------- boot ---------- */
  fetch("channels.json").then((r) => r.json()).then((d) => {
    DATA = d;
    channels = d.channels.slice().sort((a, b) => a.number - b.number);
    d.ads.forEach((p) => { adPools[p.name] = p.videos; });
    allAds = d.ads.flatMap((p) => p.videos);
    video.volume = TV ? 1 : 0.6;          // on a TV the set's own remote is the volume control
    const want = Number(params.get("ch"));
    const i = want ? channels.findIndex((c) => c.number === want) : -1;
    if (i >= 0 && !TV) muteUntilGesture();  // autoplay without a gesture must be muted
    if (i >= 0 || TV) powerOn();
    if (i >= 0) tune(i, { silent: true });
  }).catch((e) => {
    boot.querySelector("p").textContent = "Could not load channels.json. Serve this folder over HTTP (e.g. python3 -m http.server).";
    $("powerBtn").disabled = true;
    console.error(e);
  });
})();
