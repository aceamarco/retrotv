#!/usr/bin/env python3
"""Resolve channels.config.json against the archive.org metadata API and
write channels.json (what index.html loads).

Usage:  python3 build_channels.py            # rebuild everything
        python3 build_channels.py --refresh  # ignore the metadata cache
"""
import json, os, re, sys, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".ia_cache")
os.makedirs(CACHE, exist_ok=True)
REFRESH = "--refresh" in sys.argv

def metadata(item):
    path = os.path.join(CACHE, item + ".json")
    if os.path.exists(path) and not REFRESH:
        return json.load(open(path))
    url = "https://archive.org/metadata/" + urllib.parse.quote(item)
    req = urllib.request.Request(url, headers={"User-Agent": "retrotv-build/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    json.dump(data, open(path, "w"))
    return data

def playable_files(meta):
    """Pick one browser-safe mp4 per source video. archive.org makes an
    h.264 derivative (usually *.ia.mp4) for most uploads; prefer that,
    fall back to an original mp4 that is already h.264."""
    files = meta.get("files", [])
    by_name = {f["name"]: f for f in files}
    derived_from = set()
    chosen = []
    for f in files:
        name = f["name"]
        if not name.lower().endswith(".mp4"):
            continue
        fmt = (f.get("format") or "").lower()
        src = f.get("source")
        if src == "derivative" and "h.264" in fmt:
            chosen.append(f)
            if f.get("original"):
                derived_from.add(f["original"])
    for f in files:
        name = f["name"]
        if not name.lower().endswith(".mp4") or f.get("source") != "original":
            continue
        if name in derived_from:
            continue
        # skip an original if a derivative named <base>.ia.mp4 exists
        if name[:-4] + ".ia.mp4" in by_name:
            continue
        fmt = (f.get("format") or "").lower()
        if re.search(r"h\.?265|hevc|x265", name, re.I):
            continue  # HEVC originals do not play in most browsers
        if "h.264" in fmt or "mpeg4" in fmt:
            chosen.append(f)
    out = []
    for f in chosen:
        try:
            length = float(f.get("length") or 0)
        except ValueError:
            length = 0
        if length < 20:
            continue
        out.append({"name": f["name"], "length": round(length, 1),
                    "size": int(f.get("size") or 0)})
    return out

def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

def generic_title(t):
    """DVD rips and capture cards leave names like VTS_01_2 or CaptureA_6."""
    words = [w for w in re.findall(r"[A-Za-z]{3,}", t)]
    if re.match(r"^(VTS|VIDEO TS|CaptureA|tobacco|SatMorn|Part \d+|VIDEO)", t, re.I):
        return True
    return len(words) < 2

def clean_title(name):
    t = re.sub(r"\.ia\.mp4$|\.mp4$", "", name)
    t = t.rsplit("/", 1)[-1]  # drop folder prefixes like "Season 1/"
    t = re.sub(r"-?\b(hevcmp4|x26[45]|hevc|h\.?26[45])\b", "", t, flags=re.I)
    t = re.sub(r"\((?:1080p|720p|480p)[^)]*\)|\[(?:1080p|720p|480p)[^\]]*\]", "", t)
    t = re.sub(r"[._]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -")
    return t

cfg = json.load(open(os.path.join(HERE, "channels.config.json")))
result = {"generated_from": "archive.org", "channels": [], "ads": []}
for ch in cfg["channels"]:
    entries = []
    for s in ch["sources"]:
        try:
            meta = metadata(s["item"])
        except Exception as e:
            print(f"!! {s['item']}: {e}", file=sys.stderr)
            continue
        if not meta.get("files"):
            print(f"!! {s['item']}: no files (item removed?)", file=sys.stderr)
            continue
        if str(meta.get("metadata", {}).get("access-restricted-item", "")).lower() == "true":
            print(f"!! {s['item']}: access-restricted (downloads return 401), skipped", file=sys.stderr)
            continue
        rx = re.compile(s["match"], re.I) if s.get("match") else None
        files = [f for f in playable_files(meta) if not rx or rx.search(f["name"])]
        files.sort(key=lambda f: natural_key(f["name"]))
        item_title = (meta.get("metadata", {}).get("title") or s["item"]).strip()
        for i, f in enumerate(files):
            title = clean_title(f["name"])
            if generic_title(title):
                title = item_title + (" (part %d)" % (i + 1) if len(files) > 1 else "")
            entries.append({
                "url": "https://archive.org/download/%s/%s" % (
                    s["item"], urllib.parse.quote(f["name"])),
                "title": title,
                "length": f["length"],
                "item": s["item"],
            })
        print(f"{ch.get('name'):28s} {s['item'][:50]:50s} {len(files):4d} files")
    if not entries:
        print(f"!! channel {ch.get('name')} is empty, skipped", file=sys.stderr)
        continue
    rec = {"name": ch["name"], "videos": entries,
           "hours": round(sum(e["length"] for e in entries) / 3600, 1)}
    if ch.get("kind") == "ads":
        result["ads"].append(rec)
    else:
        rec["number"] = ch["number"]
        rec["tagline"] = ch.get("tagline", "")
        rec["era"] = ch.get("era", "")
        # group: section heading in the guide; color: the channel's brand color
        rec["group"] = ch.get("group", "")
        rec["color"] = ch.get("color", "")
        # ads: name of an ad pool (or list of names) to cut breaks from; default = all pools
        if ch.get("ads"): rec["ads"] = ch["ads"]
        # breaks: false when the recordings already contain their own commercials
        rec["breaks"] = ch.get("breaks", True)
        # ordered: play files in name order (multi-part games) instead of shuffling
        rec["ordered"] = ch.get("ordered", False)
        result["channels"].append(rec)

json.dump(result, open(os.path.join(HERE, "channels.json"), "w"), indent=0)
print("\nchannels:", len(result["channels"]), " ad pools:", len(result["ads"]),
      " size:", os.path.getsize(os.path.join(HERE, "channels.json")) // 1024, "KB")
