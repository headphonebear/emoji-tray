# 🐻 emoji-tray

A fast, private emoji picker you host yourself. Click an emoji, it's on your
clipboard. That's the whole idea — the rest is about getting to the right
emoji quickly.

- **Click to copy.** Shift+click builds a combo (🌻🐝🍯) you can copy or save.
- **Complete and current:** all of [Emoji 18.0](https://www.unicode.org/emoji/)
  (1923 emojis), straight from Unicode's own data.
- **Skin tones without the clutter:** one switch for all emojis, plus
  right-click for a specific tone — instead of five copies of every hand.
- **Search in English, German and Russian** at the same time
  (`coffee`, `kaffee`, `кофе` → ☕), by word prefix, best matches first.
- **Your tray:** a row of everyday emojis and shared combos, set in a small
  `config.json` — change it without rebuilding anything.
- **Favorites and your own combos**, stored in your browser, with
  export/import.
- **Dark mode** that follows your system (or doesn't, if you say so).
- **Hides what your system can't draw yet.** Brand-new emojis show up as empty
  boxes until your OS updates its emoji font; emoji-tray detects that and hides
  them (with a "show anyway" switch).
- **No tracking, no ads, no cookies, no third-party requests.** One static page,
  a strict Content-Security-Policy, and the emoji pictures come from your own
  system font.

## Run it

```bash
docker run -d --name emoji-tray -p 8080:8080 ghcr.io/headphonebear/emoji-tray:latest
```

Open <http://localhost:8080>. The container runs as an unprivileged user
(nginx-unprivileged, UID 101) on port 8080, and has a health endpoint at
`/healthz`.

> Copying uses the browser's Clipboard API, which needs a *secure context*:
> `https://…` or `localhost`. On plain `http://` over your LAN, emoji-tray
> falls back to the older copy method, which works in current browsers but is
> deprecated — put it behind HTTPS if you can.

## Your own tray and combos

Mount a `config.json` over the default:

```bash
docker run -d -p 8080:8080 \
  -v "$PWD/config.json:/usr/share/nginx/html/config.json:ro" \
  ghcr.io/headphonebear/emoji-tray:latest
```

```json
{
  "title": "Homehill",
  "tray": {
    "label": "Homehill",
    "icon": "🏡",
    "emojis": ["🐻", "😄", "☕️", "🍎", "🦉", "🚀"]
  },
  "combos": [
    "🌻🐝🍯",
    { "emojis": "🐻🎧", "label": "listening" }
  ]
}
```

| Field | Meaning |
|---|---|
| `title` | Shown in the browser tab (`<title> · emoji-tray`). Optional. |
| `tray.label`, `tray.icon` | Section name and its icon in the side navigation. |
| `tray.emojis` | Your everyday emojis, in this order. A bare emoji follows the skin-tone switch; one with a tone (`👋🏽`) stays as written. |
| `combos` | Shared combos: a string, or `{ "emojis": "…", "label": "…" }`. |

The file is re-read on every page load (it's served with `no-cache`). A missing
or broken `config.json` never breaks the page — emoji-tray falls back to
[`web/config.default.json`](web/config.default.json).

**Kubernetes:** put `config.json` in a ConfigMap and mount it with
`subPath: config.json` at `/usr/share/nginx/html/config.json`. The image needs
no write access anywhere (`readOnlyRootFilesystem: true` works with an
`emptyDir` on `/tmp`).

## Keyboard and mouse

| | |
|---|---|
| click | copy |
| shift+click | add to the combo bar |
| right-click | skin tones · ☆ favorite · + combo |
| `/` | jump to search |
| `Esc` | close the menu / clear the search |

## Updating the emoji data

The data comes from two Unicode sources, pinned in
[`tools/build_data.py`](tools/build_data.py):

- `emoji-test.txt` (Emoji 18.0): the emojis, their order and groups, English
  names, skin-tone variants
- CLDR JSON annotations (49.0.0): names and keywords in `en`, `de`, `ru`

```bash
python3 tools/build_data.py          # writes web/data/emoji.json
python3 tools/build_data.py --refresh   # re-download the sources first
```

For a new release, bump `EMOJI_VERSION` / `CLDR_VERSION` (and add a language
to `LANGS` if you like — CLDR has most of them).

## Develop

No build step. Serve `web/` and open it:

```bash
cd web && python3 -m http.server 8080 --bind 127.0.0.1
```

`web/config.json` is gitignored, so your own tray stays out of commits.

## Licence

Code: [MIT](LICENSE). Emoji data: © Unicode, Inc., [Unicode License v3](THIRD_PARTY_NOTICES.md).
