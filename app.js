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
  const video = $("video"), staticCanvas = $("static"), osd = $("osd"), osdText = $("osdText");
  const volOsd = $("volOsd"), volBar = $("volBar"), boot = $("boot"), info = $("info");
  const guide = $("guide"), guideList = $("guideList");

  let DATA, channels = [], adPools = {}, allAds = [];
  let chIndex = 0, on = false, slot = null, tickTimer = null, osdTimer = null, volTimer = null;
  let typed = "", typedTimer = null, lastNudge = 0;
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
  function currentSlot(ch, now) {
    const elapsed = now - EPOCH;
    const nominal = nominalLength(ch);
    let idx = Math.floor(elapsed / nominal);
    // cycles are laid end-to-end with their true lengths starting from cycle idx's nominal start
    let cycleStart = idx * nominal;
    let cyc = getCycle(ch, idx);
    while (elapsed >= cycleStart + cyc.length) { cycleStart += cyc.length; idx++; cyc = getCycle(ch, idx); }
    const pos = elapsed - cycleStart;
    let i = cyc.slots.findIndex((s) => pos < s.at + s.dur);
    if (i < 0) i = cyc.slots.length - 1;
    const s = cyc.slots[i];
    const next = cyc.slots[i + 1] || getCycle(ch, idx + 1).slots[0];
    return { ...s, offset: pos - s.at, endsAt: now + (s.dur - (pos - s.at)), next };
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
      video.play().catch(() => {});
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
    if (video.paused && video.readyState >= 2) video.play().catch(() => {});
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
    showOsd(String(ch.number).padStart(2, "0"));
    if (!opts.silent) showStatic(STATIC_MS);
    sync();
    renderGuideCurrent();
  }

  /* ---------- UI ---------- */
  function showOsd(text) {
    osdText.textContent = text; osd.classList.add("show");
    clearTimeout(osdTimer); osdTimer = setTimeout(() => osd.classList.remove("show"), 2600);
  }
  function showVol() {
    volBar.style.width = (video.muted ? 0 : video.volume * 100) + "%";
    volOsd.classList.add("show");
    clearTimeout(volTimer); volTimer = setTimeout(() => volOsd.classList.remove("show"), 1800);
  }
  function fmt(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); }
  function renderInfo() {
    const ch = channels[chIndex];
    $("infoCh").textContent = ch.number + " · " + ch.name;
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
  function renderGuide() {
    guideList.innerHTML = "";
    channels.forEach((ch, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.innerHTML = `<span class="num">${ch.number}</span><span><div class="nm">${esc(ch.name)}</div><div class="tg">${ch.era ? "<b>" + esc(ch.era) + "</b> · " : ""}${esc(ch.tagline || "")} · ${ch.videos.length} videos · ${ch.hours} h</div></span>`;
      b.addEventListener("click", () => { powerOn(); tune(i); toggleGuide(false); });
      li.appendChild(b); guideList.appendChild(li);
    });
    renderGuideCurrent();
  }
  function renderGuideCurrent() {
    [...guideList.querySelectorAll("button")].forEach((b, i) => b.classList.toggle("current", i === chIndex));
  }
  function toggleGuide(force) {
    const show = force === undefined ? guide.hidden : force;
    guide.hidden = !show;
  }

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

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key >= "0" && e.key <= "9") {
      typed += e.key; showOsd(typed.padStart(2, "-"));
      clearTimeout(typedTimer);
      const commit = () => { const n = Number(typed); typed = ""; const i = channels.findIndex((c) => c.number === n); if (i >= 0) { powerOn(); tune(i); } else showOsd("--"); };
      if (typed.length >= 2) commit(); else typedTimer = setTimeout(commit, 1200);
      return;
    }
    if (e.key === "t" || e.key === "T") { cycleFrame(e.shiftKey ? -1 : 1); return; }
    const map = { ArrowUp: "chup", ArrowDown: "chdown", ArrowRight: "volup", ArrowLeft: "voldown", m: "mute", f: "full", g: "guide", p: "power", Escape: null };
    if (e.key === "Escape") { toggleGuide(false); return; }
    if (e.key in map) { e.preventDefault(); act(map[e.key]); }
  });

  /* ---------- TV set frames ---------- */
  let frames = [];
  const tvEl = $("tv"), stage = $("stage"), bezel = $("bezel"), frameImg = $("frameImg"), frameSel = $("frameSel"), frameCredit = $("frameCredit");
  function applyFrame(id) {
    const f = frames.find((x) => x.id === id);
    try { localStorage.setItem("retrotv.frame", id); } catch (e) {}
    frameSel.value = f ? id : "classic";
    if (!f) {
      tvEl.classList.remove("photo"); frameImg.hidden = true; frameImg.removeAttribute("src");
      stage.style.aspectRatio = ""; bezel.style.cssText = ""; frameCredit.textContent = "";
      return;
    }
    tvEl.classList.add("photo");
    stage.style.aspectRatio = String(f.aspect);
    const o = 0.6; // overscan so the picture tucks under the bezel's rounded corners
    const sc = f.screen;
    bezel.style.cssText = `left:${sc.left - o}%;top:${sc.top - o}%;width:${sc.width + 2 * o}%;height:${sc.height + 2 * o}%;`;
    frameImg.src = f.src; frameImg.hidden = false;
    const c = f.credit;
    frameCredit.innerHTML = ` TV set: <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> by ${esc(c.artist)}` +
      (c.license_url ? `, <a href="${esc(c.license_url)}" target="_blank" rel="noopener">${esc(c.license)}</a>` : `, ${esc(c.license)}`) + ", via Wikimedia Commons.";
  }
  function cycleFrame(dir = 1) {
    const ids = ["classic", ...frames.map((f) => f.id)];
    const i = ids.indexOf(frameSel.value);
    applyFrame(ids[(i + dir + ids.length) % ids.length]);
  }
  frameSel.addEventListener("change", () => applyFrame(frameSel.value));
  fetch("frames/frames.json").then((r) => r.json()).then((list) => {
    frames = list;
    for (const f of frames) { const op = document.createElement("option"); op.value = f.id; op.textContent = f.name; frameSel.appendChild(op); }
    let saved = "classic";
    try { saved = localStorage.getItem("retrotv.frame") || "classic"; } catch (e) {}
    const q = new URLSearchParams(location.search).get("tv");
    applyFrame(q || saved);
  }).catch(() => {});

  /* ---------- boot ---------- */
  fetch("channels.json").then((r) => r.json()).then((d) => {
    DATA = d;
    channels = d.channels.slice().sort((a, b) => a.number - b.number);
    d.ads.forEach((p) => { adPools[p.name] = p.videos; });
    allAds = d.ads.flatMap((p) => p.videos);
    video.volume = 0.6;
    renderGuide();
    const want = Number(new URLSearchParams(location.search).get("ch"));
    if (want) {
      const i = channels.findIndex((c) => c.number === want);
      if (i >= 0) {
        video.muted = true;               // autoplay without a gesture must be muted
        powerOn(); tune(i, { silent: true });
        const unmute = () => { video.muted = false; showVol(); };
        document.addEventListener("pointerdown", unmute, { once: true });
        document.addEventListener("keydown", unmute, { once: true });
      }
    }
  }).catch((e) => {
    boot.querySelector("p").textContent = "Could not load channels.json. Serve this folder over HTTP (e.g. python3 -m http.server).";
    $("powerBtn").disabled = true;
    console.error(e);
  });
})();
