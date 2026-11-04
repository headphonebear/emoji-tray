// emoji-tray — the whole app. Plain JS, no build step, no dependencies.
//
// Flow: load data/emoji.json → render one section per Unicode group →
// click copies, right-click picks a specific skin tone, the search box
// filters across all languages in the data (en/de/ru) at once.
"use strict";

// ── Small helpers ──────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);

/** localStorage can be missing or throw (private windows, blocked storage).
 *  Preferences are a convenience, so failures just fall back to defaults. */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem("emoji-tray:" + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("emoji-tray:" + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

/** Fold text for matching, applied to both the query and the data:
 *  lower-case, ё→е (Russian users type "е" for both), German umlauts and ß
 *  spelled out (so "bär" and "baer" both work). We deliberately do NOT strip
 *  accents wholesale — "bär" must not turn into "bar". */
function fold(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

/** Split folded search text into words. "|" separates names/keywords in the
 *  data; spaces and hyphens split multi-word names ("red heart"). */
function tokens(text) {
  return fold(text).split(/[|\s\-:,.()]+/).filter(Boolean);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

// ── State ──────────────────────────────────────────────────────────────────

// -1 = the default yellow, 0..4 = light → dark (same order as the data).
const TONE_PREVIEW = ["👋", "👋🏻", "👋🏼", "👋🏽", "👋🏾", "👋🏿"];
const TONE_NAMES = ["default yellow", "light", "medium-light", "medium", "medium-dark", "dark"];

// Short labels + icons for the side navigation, keyed by Unicode group name.
const GROUP_META = {
  "Smileys & Emotion": { icon: "😀", label: "Smileys" },
  "People & Body": { icon: "🧑", label: "People" },
  "Animals & Nature": { icon: "🐻", label: "Animals & Nature" },
  "Food & Drink": { icon: "🍎", label: "Food & Drink" },
  "Travel & Places": { icon: "🌍", label: "Travel & Places" },
  "Activities": { icon: "⚽", label: "Activities" },
  "Objects": { icon: "💡", label: "Objects" },
  "Symbols": { icon: "💟", label: "Symbols" },
  "Flags": { icon: "🏁", label: "Flags" },
};

const state = {
  tone: store.get("tone", -1),
  theme: store.get("theme", "auto"),
  items: [],        // flat list of every emoji, index = data-i on its tile
};

/** The emoji to show/copy for an item, honouring the chosen skin tone. */
function display(item) {
  return state.tone >= 0 && item.t ? item.t[state.tone] : item.e;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function tile(item) {
  return el("button", {
    type: "button",
    class: item.t ? "tile has-tones" : "tile",
    title: item.n,
    textContent: display(item),
    dataset: { i: String(item.i) },
  });
}

function slug(name) {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderGroups(data) {
  const nav = $(".sidenav");
  const groups = $(".groups");
  for (const g of data.groups) {
    const id = slug(g.name);
    const meta = GROUP_META[g.name] || { icon: "•", label: g.name };
    nav.append(el("a", { href: "#" + id, dataset: { section: id } }, [
      el("span", { class: "nav-icon", textContent: meta.icon, "aria-hidden": "true" }),
      el("span", { class: "nav-label", textContent: meta.label }),
      el("span", { class: "nav-count", textContent: String(g.items.length) }),
    ]));
    const grid = el("div", { class: "grid" }, g.items.map(tile));
    groups.append(el("section", { class: "group", id }, [
      el("h2", { class: "section-title" }, [
        el("span", { textContent: g.name }),
        el("span", { class: "count", textContent: String(g.items.length) }),
      ]),
      grid,
    ]));
  }
}

function refreshTiles() {
  for (const node of document.querySelectorAll(".tile.has-tones")) {
    const item = state.items[Number(node.dataset.i)];
    if (item) node.textContent = display(item);
  }
}

// ── Copy + toast ───────────────────────────────────────────────────────────

async function copy(text, label) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Clipboard API needs a secure context (https or localhost). Fall back to
    // the old selection trick so plain-http LAN setups still work.
    const ta = el("textarea", { value: text, readOnly: true, class: "visually-hidden" });
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? text : null, label);
}

let toastTimer;
function toast(emoji, label) {
  const box = $(".toast");
  box.replaceChildren();
  if (emoji) {
    box.append(el("span", { class: "toast-emoji", textContent: emoji }), " copied",
      label ? el("span", { textContent: " · " + label }) : "");
  } else {
    box.append("Couldn't copy — your browser blocked clipboard access.");
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 1600);
}

// ── Skin-tone picker (top bar) + per-emoji popover (right-click) ──────────

function renderTonePicker() {
  const box = $(".tones");
  TONE_PREVIEW.forEach((e, idx) => {
    const tone = idx - 1;
    box.append(el("button", {
      type: "button", role: "radio", textContent: e,
      title: "Skin tone: " + TONE_NAMES[idx],
      "aria-checked": String(tone === state.tone),
      dataset: { tone: String(tone) },
    }));
  });
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-tone]");
    if (!btn) return;
    state.tone = Number(btn.dataset.tone);
    store.set("tone", state.tone);
    for (const b of box.children) b.setAttribute("aria-checked", String(b === btn));
    refreshTiles();
  });
}

function openPopover(item, anchor) {
  const pop = $(".popover");
  const grid = $(".popover-grid", pop);
  grid.replaceChildren(...[item.e, ...item.t].map((e, idx) => el("button", {
    type: "button", class: "tile", textContent: e,
    title: item.n + " — " + TONE_NAMES[idx],
    dataset: { copy: e },
  })));
  pop.hidden = false;
  // Place it just above the tile, kept inside the viewport.
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  pop.style.top = (r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6) + "px";
  grid.firstChild.focus();
}

function closePopover() { $(".popover").hidden = true; }

// ── Search ─────────────────────────────────────────────────────────────────

function runSearch(query) {
  const results = $("#results");
  const groups = $(".groups");
  const words = tokens(query);
  if (!words.length) {
    results.hidden = true;
    groups.hidden = false;
    return;
  }
  // Every query word must START some word of the item (any language) —
  // prefix, not substring, or "eule" would find 😭 via "heulen".
  // Score: exact word beats prefix, and a hit in the emoji's own NAME beats a
  // keyword hit, so 🦉 "owl" ranks above things merely tagged "bird".
  const hits = [];
  for (const it of state.items) {
    let score = 0;
    for (const w of words) {
      let best = 0;
      for (const t of it.nameWords) best = Math.max(best, t === w ? 4 : t.startsWith(w) ? 3 : 0);
      if (best < 3) for (const t of it.words) best = Math.max(best, t === w ? 2 : t.startsWith(w) ? 1 : 0);
      if (!best) { score = 0; break; }
      score += best;
    }
    if (score) hits.push([score, it]);
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].i - b[1].i);
  const found = hits.map(([, it]) => it);
  const grid = $(".grid", results);
  grid.replaceChildren(...found.map(tile));
  $(".results-count", results).textContent =
    found.length ? `${found.length} result${found.length === 1 ? "" : "s"} for “${query.trim()}”` : `Nothing found for “${query.trim()}”`;
  results.hidden = false;
  groups.hidden = true;
  window.scrollTo({ top: 0 });
}

// ── Theme ──────────────────────────────────────────────────────────────────

const THEMES = ["auto", "light", "dark"];
function applyTheme() {
  if (state.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  $(".theme-label").textContent = state.theme;
}

// ── Side-nav highlight ─────────────────────────────────────────────────────

function watchSections() {
  const links = new Map([...document.querySelectorAll(".sidenav a")].map((a) => [a.dataset.section, a]));
  const visible = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
    // The first group (in page order) that's on screen wins.
    const current = [...links.keys()].find((id) => visible.has(id));
    for (const [id, a] of links) a.setAttribute("aria-current", String(id === current));
  }, { rootMargin: "-80px 0px -60% 0px" });
  for (const s of document.querySelectorAll(".group")) io.observe(s);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

async function main() {
  applyTheme();
  renderTonePicker();

  let data;
  try {
    const resp = await fetch("data/emoji.json");
    if (!resp.ok) throw new Error(resp.status + " " + resp.statusText);
    data = await resp.json();
  } catch (err) {
    $(".loading").textContent = "Couldn't load the emoji data (" + err.message + ").";
    return;
  }

  for (const g of data.groups) {
    for (const it of g.items) {
      it.i = state.items.length;
      // Pre-split once: all words, plus the words of each language's NAME
      // (the first "|"-entry of every language in the data).
      it.words = [...new Set(tokens(Object.values(it.s).join("|")))];
      it.nameWords = [...new Set(Object.values(it.s).flatMap((s) => tokens(s.split("|")[0])))];
      state.items.push(it);
    }
  }
  renderGroups(data);
  $(".loading").remove();
  $(".data-version").textContent =
    `Emoji ${data.emoji} · CLDR ${data.cldr} · ${state.items.length} emojis · search in ${data.langs.join(", ")}`;
  watchSections();

  // Click anywhere on a tile (groups, results, popover) copies it.
  document.addEventListener("click", (ev) => {
    const pop = $(".popover");
    const inPopover = pop.contains(ev.target);
    const t = ev.target.closest(".tile");
    if (t && inPopover) { copy(t.dataset.copy); closePopover(); return; }
    if (!inPopover) closePopover();
    if (!t || !t.dataset.i) return;
    const item = state.items[Number(t.dataset.i)];
    copy(display(item));
  });

  // Right-click a toned emoji → choose one specific tone without changing
  // the global setting.
  document.addEventListener("contextmenu", (ev) => {
    const t = ev.target.closest(".tile.has-tones");
    if (!t || !t.dataset.i) return;
    ev.preventDefault();
    openPopover(state.items[Number(t.dataset.i)], t);
  });

  const q = $("#q");
  let timer;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(q.value), 80);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!$(".popover").hidden) { closePopover(); return; }
      if (q.value) { q.value = ""; runSearch(""); }
      q.blur();
    }
    // "/" jumps to the search box (unless you're already typing somewhere).
    if (ev.key === "/" && document.activeElement !== q) {
      ev.preventDefault();
      q.focus();
      q.select();
    }
  });

  $(".theme-toggle").addEventListener("click", () => {
    state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
    store.set("theme", state.theme);
    applyTheme();
  });

  window.addEventListener("scroll", closePopover, { passive: true });
}

main();
