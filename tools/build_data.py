#!/usr/bin/env python3
"""Build web/data/emoji.json from the official Unicode sources.

Sources (pinned — bump the two constants below on a new release):
  * emoji-test.txt (Emoji 18.0): which emojis exist, their order, group,
    English name, and which skin-tone variants exist.
  * CLDR JSON annotations (49.0.0): names + search keywords per language.
    `annotations` covers single code points, `annotationsDerived` covers
    sequences (skin tones, ZWJ families, flags, keycaps …).

Only the standard library is used, so this runs with a plain `python3`.
Raw downloads are cached in tools/.cache/ (gitignored); pass --refresh to
re-download.

Output shape (kept small on purpose — the browser loads it in one go):

    {
      "emoji": "18.0", "cldr": "49.0.0",
      "langs": ["en", "de", "ru"],
      "groups": [{"name": "Smileys & Emotion", "items": [ <item>, ... ]}, ...]
    }

    item = {
      "e": "👋",                     # the emoji (fully-qualified)
      "n": "waving hand",            # English name (from emoji-test.txt)
      "v": "0.6",                    # Emoji version it arrived in
      "t": ["👋🏻", "👋🏼", "👋🏽", "👋🏾", "👋🏿"],   # optional: uniform skin tones,
                                     # light → dark; absent = no tones
      "s": {"en": "...", "de": "...", "ru": "..."}   # search text per language:
                                     # name + keywords, lower-cased, "|"-joined
    }

Mixed-tone variants (e.g. 🧑🏻‍🤝‍🧑🏿) are not in the output yet: they need a
two-slot picker, which the UI doesn't have.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

EMOJI_VERSION = "18.0"
CLDR_VERSION = "49.0.0"
LANGS = ["en", "de", "ru"]

# NB: since Unicode 17 the emoji files live under Public/<version>.0/emoji/ —
# the old Public/emoji/<version>/ path 404s for 18.0 (checked 2026-11-04).
EMOJI_TEST_URL = f"https://www.unicode.org/Public/{EMOJI_VERSION}.0/emoji/emoji-test.txt"
CLDR_BASE = f"https://raw.githubusercontent.com/unicode-org/cldr-json/{CLDR_VERSION}/cldr-json"
CLDR_URLS = {
    "annotations": CLDR_BASE + "/cldr-annotations-full/annotations/{lang}/annotations.json",
    "derived": CLDR_BASE + "/cldr-annotations-derived-full/annotationsDerived/{lang}/annotations.json",
}

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
OUT = ROOT / "web" / "data" / "emoji.json"

# The "Component" group holds the bare skin-tone swatches and hair styles.
# They are building blocks, not something you'd paste on their own.
SKIP_GROUPS = {"Component"}

SKIN_TONES = {
    "light skin tone": 0,
    "medium-light skin tone": 1,
    "medium skin tone": 2,
    "medium-dark skin tone": 3,
    "dark skin tone": 4,
}
TONE_CODEPOINTS = {0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF}

# 1F44B ; fully-qualified # 👋 E0.6 waving hand
LINE_RE = re.compile(
    r"^(?P<cps>[0-9A-F ]+?)\s*;\s*(?P<status>[a-z-]+)\s*#\s*(?P<emoji>\S+)\s+E(?P<ver>[\d.]+)\s+(?P<name>.+)$"
)


def fetch(url: str, name: str, refresh: bool) -> bytes:
    """Download once into tools/.cache/, reuse afterwards."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if path.exists() and not refresh:
        return path.read_bytes()
    print(f"  fetching {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "emoji-tray-build"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
    path.write_bytes(data)
    return data


def parse_emoji_test(text: str) -> list[dict]:
    """Return groups with their fully-qualified emojis, in Unicode order."""
    groups: list[dict] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("# group:"):
            groups.append({"name": line.split(":", 1)[1].strip(), "rows": []})
            continue
        if not line or line.startswith("#"):
            continue
        m = LINE_RE.match(line)
        if not m or m["status"] != "fully-qualified":
            continue
        cps = [int(c, 16) for c in m["cps"].split()]
        groups[-1]["rows"].append(
            {"e": m["emoji"], "n": m["name"], "v": m["ver"], "toned": any(c in TONE_CODEPOINTS for c in cps)}
        )
    return groups


def fold_tones(groups: list[dict]) -> list[dict]:
    """Turn the flat list into base emojis carrying their uniform tone variants.

    emoji-test.txt lists every tone variant as its own line right after the
    base ("waving hand", "waving hand: light skin tone", …). We key on the
    name: everything before ": " is the base name, the part after lists one
    tone per person. A variant is "uniform" when all persons share one tone.
    """
    out = []
    for g in groups:
        if g["name"] in SKIP_GROUPS:
            continue
        by_name: dict[str, dict] = {}
        items: list[dict] = []
        for row in g["rows"]:
            if not row["toned"]:
                item = {"e": row["e"], "n": row["n"], "v": row["v"]}
                by_name[row["n"]] = item
                items.append(item)
                continue
            base_name, _, tone_part = row["n"].partition(": ")
            tones = {SKIN_TONES.get(t.strip()) for t in tone_part.split(",")}
            base = by_name.get(base_name)
            if base is None or len(tones) != 1 or None in tones:
                continue  # mixed tones (or an unexpected name) — not supported yet
            base.setdefault("t", [None] * 5)[tones.pop()] = row["e"]
        for item in items:
            # Only keep a tone list if all five exist; drop half-filled ones.
            if "t" in item and None in item["t"]:
                del item["t"]
        out.append({"name": g["name"], "items": items})
    return out


def load_cldr(lang: str, refresh: bool) -> dict[str, list[str]]:
    """Map emoji → [name, keyword, …] for one language (single + derived)."""
    merged: dict[str, list[str]] = {}
    for kind, url in CLDR_URLS.items():
        raw = fetch(url.format(lang=lang), f"cldr-{CLDR_VERSION}-{kind}-{lang}.json", refresh)
        doc = json.loads(raw)
        section = "annotations" if kind == "annotations" else "annotationsDerived"
        for emoji, ann in _annotations(doc, section).items():
            words = list(ann.get("tts", [])) + list(ann.get("default", []))
            merged.setdefault(emoji, []).extend(words)
    return merged


def _annotations(doc: dict, section: str) -> dict:
    """cldr-json nests as {section: {identity: …, annotations: {…}}}."""
    return doc[section]["annotations"]


def lookup(cldr: dict[str, list[str]], emoji: str) -> list[str]:
    """CLDR keys usually drop the FE0F variation selector — try both."""
    return cldr.get(emoji) or cldr.get(emoji.replace("️", "")) or []


def search_text(words: list[str]) -> str:
    seen: list[str] = []
    for w in words:
        w = w.strip().lower()
        if w and w not in seen:
            seen.append(w)
    return "|".join(seen)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="re-download sources")
    args = ap.parse_args()

    test_txt = fetch(EMOJI_TEST_URL, f"emoji-test-{EMOJI_VERSION}.txt", args.refresh).decode("utf-8")
    groups = fold_tones(parse_emoji_test(test_txt))
    cldr = {lang: load_cldr(lang, args.refresh) for lang in LANGS}

    missing = {lang: 0 for lang in LANGS}
    for g in groups:
        for item in g["items"]:
            item["s"] = {}
            for lang in LANGS:
                words = lookup(cldr[lang], item["e"])
                if not words:
                    missing[lang] += 1
                # English always has the emoji-test.txt name as a fallback.
                if lang == "en":
                    words = [item["n"]] + words
                item["s"][lang] = search_text(words)

    doc = {"emoji": EMOJI_VERSION, "cldr": CLDR_VERSION, "langs": LANGS, "groups": groups}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    total = sum(len(g["items"]) for g in groups)
    toned = sum(1 for g in groups for i in g["items"] if "t" in i)
    print(f"wrote {OUT.relative_to(ROOT)}: {total} emojis in {len(groups)} groups, "
          f"{toned} with skin tones, {OUT.stat().st_size // 1024} KiB", file=sys.stderr)
    for lang, n in missing.items():
        print(f"  {lang}: {n} emojis without CLDR annotation", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
