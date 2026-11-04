// emoji-tray — the whole app. Plain JS, no build step, no dependencies.
//
// Flow: load data/emoji.json + config.json → render the personal sections
// (tray, combos, favourites) and one section per Unicode group.
//   • click            copies the emoji
//   • shift+click      appends it to the combo composer
//   • right-click      menu: skin tones, ☆ favourite, + combo
//   • search box       filters across every language in the data (en/de/ru)
"use strict";

// ── Small helpers ──────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** localStorage can be missing or throw (private windows, blocked storage).
 *  Everything stored is a per-browser convenience, so failures just fall back
 *  to defaults instead of breaking the page. */
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

/** Emoji keys: CLDR and people's configs disagree about the FE0F variation
 *  selector ("☕" vs "☕️"), so lookups ignore it. */
const key = (e) => e.replace(/️/g, "");

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
  favorites: store.get("favorites", []),   // base emojis (item.e), newest first
  myCombos: store.get("combos", []),        // [{ emojis, label? }]
  composer: [],                             // emojis being assembled into a combo
  config: { tray: null, combos: [] },
  items: [],                                // every emoji; index = data-i on its tile
  byKey: new Map(),                         // key(emoji) → item, incl. tone variants
};

/** The emoji to show/copy for an item, honouring the chosen skin tone. */
function display(item) {
  return state.tone >= 0 && item.t ? item.t[state.tone] : item.e;
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** A tile for a known emoji (follows the skin tone, has a right-click menu). */
function tile(item) {
  return el("button", {
    type: "button",
    class: item.t ? "tile has-tones" : "tile",
    title: item.n,
    textContent: display(item),
    dataset: { i: String(item.i) },
  });
}

/** A tile for an emoji we have in the data if possible, else a plain one
 *  (configs may contain sequences the data doesn't list). */
function tileFor(emoji) {
  const item = state.byKey.get(key(emoji));
  // If the config names a specific tone (👋🏽), keep it — only bare base
  // emojis follow the global tone switch.
  if (item && key(item.e) === key(emoji)) return tile(item);
  return el("button", { type: "button", class: "tile", title: item ? item.n : emoji, textContent: emoji, dataset: { copy: emoji } });
}

function comboTile(combo, mine, idx) {
  const btn = el("button", {
    type: "button", class: "combo", title: combo.label ? `${combo.label} — click to copy` : "click to copy",
    dataset: { copy: combo.emojis },
  }, [el("span", { class: "combo-emojis", textContent: combo.emojis })]);
  if (combo.label) btn.append(el("span", { class: "combo-label", textContent: combo.label }));
  if (!mine) return btn;
  return el("div", { class: "combo-wrap" }, [
    btn,
    el("button", { type: "button", class: "combo-del", title: "Delete this combo", textContent: "×", dataset: { delCombo: String(idx) } }),
  ]);
}

function slug(name) {
  return name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sectionTitle(text, count, hint) {
  const h = el("h2", { class: "section-title" }, [el("span", { textContent: text })]);
  if (count !== undefined) h.append(el("span", { class: "count", textContent: String(count) }));
  if (hint) h.append(el("span", { class: "hint", textContent: hint }));
  return h;
}

function navLink(id, icon, label, count) {
  return el("a", { href: "#" + id, dataset: { section: id } }, [
    el("span", { class: "nav-icon", textContent: icon, "aria-hidden": "true" }),
    el("span", { class: "nav-label", textContent: label }),
    el("span", { class: "nav-count", textContent: count === undefined ? "" : String(count) }),
  ]);
}

/** Tray, combos and favourites. Re-rendered whenever one of them changes. */
function renderPersonal() {
  const box = $(".personal");
  const nav = $(".sidenav-personal");
  box.replaceChildren();
  nav.replaceChildren();

  const tray = state.config.tray;
  if (tray && tray.emojis && tray.emojis.length) {
    const label = tray.label || "Tray";
    nav.append(navLink("tray", tray.icon || tray.emojis[0], label));
    box.append(el("section", { class: "group personal-section", id: "tray" }, [
      sectionTitle(label),
      el("div", { class: "grid" }, tray.emojis.map(tileFor)),
    ]));
  }

  const shared = state.config.combos;
  const mine = state.myCombos;
  nav.append(navLink("combos", "🧩", "Combos", shared.length + mine.length));
  box.append(el("section", { class: "group personal-section", id: "combos" }, [
    sectionTitle("Combos", undefined, "shift+click emojis to build one"),
    el("div", { class: "combos" }, [
      ...shared.map((c) => comboTile(c, false)),
      ...mine.map((c, idx) => comboTile(c, true, idx)),
    ]),
  ]));

  nav.append(navLink("favorites", "⭐", "Favorites", state.favorites.length));
  const favGrid = el("div", { class: "grid" }, state.favorites.map(tileFor));
  box.append(el("section", { class: "group personal-section", id: "favorites" }, [
    sectionTitle("Favorites", undefined, state.favorites.length ? "" : "right-click any emoji → ☆ Favorite"),
    favGrid,
  ]));

  watchSections();
}

function renderGroups(data) {
  const nav = $(".sidenav-groups");
  const groups = $(".groups");
  for (const g of data.groups) {
    const id = slug(g.name);
    const meta = GROUP_META[g.name] || { icon: "•", label: g.name };
    nav.append(navLink(id, meta.icon, meta.label, g.items.length));
    groups.append(el("section", { class: "group", id }, [
      sectionTitle(g.name, g.items.length),
      el("div", { class: "grid" }, g.items.map(tile)),
    ]));
  }
}

function refreshTiles() {
  for (const node of $$(".tile.has-tones")) {
    const item = state.items[Number(node.dataset.i)];
    if (item) node.textContent = display(item);
  }
}

// ── Copy + toast ───────────────────────────────────────────────────────────

async function copy(text) {
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
  toast(ok ? [el("span", { class: "toast-emoji", textContent: text }), " copied"]
           : ["Couldn't copy — your browser blocked clipboard access."]);
}

let toastTimer;
function toast(parts) {
  const box = $(".toast");
  box.replaceChildren(...parts);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 1600);
}

// ── Favourites + combos (stored per browser) ──────────────────────────────

function isFavorite(item) { return state.favorites.includes(item.e); }

function toggleFavorite(item) {
  state.favorites = isFavorite(item)
    ? state.favorites.filter((e) => e !== item.e)
    : [item.e, ...state.favorites];
  store.set("favorites", state.favorites);
  renderPersonal();
  toast([el("span", { class: "toast-emoji", textContent: item.e }), isFavorite(item) ? " added to favorites" : " removed from favorites"]);
}

function renderComposer() {
  const bar = $(".composer");
  bar.hidden = state.composer.length === 0;
  $(".composer-emojis", bar).textContent = state.composer.join("");
}

function addToComposer(emoji) {
  state.composer.push(emoji);
  renderComposer();
}

function saveComposer() {
  if (!state.composer.length) return;
  const label = (window.prompt("A label for this combo (optional):", "") || "").trim();
  const combo = { emojis: state.composer.join("") };
  if (label) combo.label = label;
  state.myCombos = [...state.myCombos, combo];
  store.set("combos", state.myCombos);
  state.composer = [];
  renderComposer();
  renderPersonal();
  toast([el("span", { class: "toast-emoji", textContent: combo.emojis }), " saved as combo"]);
}

function deleteCombo(idx) {
  const combo = state.myCombos[idx];
  if (!combo || !window.confirm(`Delete the combo ${combo.emojis}?`)) return;
  state.myCombos = state.myCombos.filter((_, i) => i !== idx);
  store.set("combos", state.myCombos);
  renderPersonal();
}

/** Export/import: favourites + own combos as a small JSON file, so a fresh
 *  browser (or the other person's) can take them over. */
function exportMine() {
  const doc = { app: "emoji-tray", version: 1, favorites: state.favorites, combos: state.myCombos };
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: "emoji-tray-mine.json" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importMine(file) {
  try {
    const doc = JSON.parse(await file.text());
    if (doc.app !== "emoji-tray") throw new Error("not an emoji-tray export");
    const favs = (doc.favorites || []).filter((e) => typeof e === "string");
    const combos = (doc.combos || []).filter((c) => c && typeof c.emojis === "string");
    // Merge, don't replace: importing never loses what this browser already has.
    state.favorites = [...new Set([...state.favorites, ...favs])];
    const known = new Set(state.myCombos.map((c) => c.emojis));
    state.myCombos = [...state.myCombos, ...combos.filter((c) => !known.has(c.emojis))];
    store.set("favorites", state.favorites);
    store.set("combos", state.myCombos);
    renderPersonal();
    toast([`Imported ${favs.length} favorites and ${combos.length} combos`]);
  } catch (err) {
    toast([`Import failed: ${err.message}`]);
  }
}

// ── Skin-tone picker (top bar) ────────────────────────────────────────────

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

// ── Right-click menu ──────────────────────────────────────────────────────

function openMenu(item, anchor) {
  const pop = $(".popover");
  const parts = [];
  if (item.t) {
    parts.push(el("div", { class: "popover-grid" }, [item.e, ...item.t].map((e, idx) => el("button", {
      type: "button", class: "tile", textContent: e,
      title: item.n + " — " + TONE_NAMES[idx],
      dataset: { copy: e },
    }))));
  }
  parts.push(el("div", { class: "popover-title", textContent: item.n }));
  parts.push(el("div", { class: "popover-actions" }, [
    el("button", { type: "button", class: "action", dataset: { action: "fav", i: String(item.i) },
      textContent: isFavorite(item) ? "★ Unfavorite" : "☆ Favorite" }),
    el("button", { type: "button", class: "action", dataset: { action: "combo", i: String(item.i) },
      textContent: "+ Combo" }),
  ]));
  pop.replaceChildren(...parts);
  pop.hidden = false;
  // Place it just above the tile, kept inside the viewport.
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  pop.style.top = (r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6) + "px";
  pop.querySelector("button").focus();
}

function closeMenu() { $(".popover").hidden = true; }

// ── Search ─────────────────────────────────────────────────────────────────

function runSearch(query) {
  const results = $("#results");
  const words = tokens(query);
  const browsing = !words.length;
  results.hidden = browsing;
  $(".groups").hidden = !browsing;
  $(".personal").hidden = !browsing;
  if (browsing) return;
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
  $(".grid", results).replaceChildren(...found.map(tile));
  $(".results-count", results).textContent =
    found.length ? `${found.length} result${found.length === 1 ? "" : "s"} for “${query.trim()}”` : `Nothing found for “${query.trim()}”`;
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

let sectionObserver;
function watchSections() {
  if (sectionObserver) sectionObserver.disconnect();
  const links = new Map($$(".sidenav a").map((a) => [a.dataset.section, a]));
  const visible = new Set();
  sectionObserver = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
    // The first section (in page order) that's on screen wins.
    const current = [...links.keys()].find((id) => visible.has(id));
    for (const [id, a] of links) a.setAttribute("aria-current", String(id === current));
  }, { rootMargin: "-80px 0px -60% 0px" });
  for (const s of $$(".group")) sectionObserver.observe(s);
}

// ── Loading ────────────────────────────────────────────────────────────────

async function loadJSON(url) {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

/** config.json is the deployment's own file (mounted over the default in a
 *  container); config.default.json ships with the app. A broken or missing
 *  config must never take the page down — fall back quietly. */
async function loadConfig() {
  for (const url of ["config.json", "config.default.json"]) {
    try {
      const cfg = await loadJSON(url);
      return {
        title: typeof cfg.title === "string" ? cfg.title : "",
        tray: cfg.tray && Array.isArray(cfg.tray.emojis) ? cfg.tray : null,
        combos: (cfg.combos || [])
          .map((c) => (typeof c === "string" ? { emojis: c } : c))
          .filter((c) => c && typeof c.emojis === "string" && c.emojis),
      };
    } catch { /* try the next one */ }
  }
  return { title: "", tray: null, combos: [] };
}

// ── Wiring ─────────────────────────────────────────────────────────────────

async function main() {
  applyTheme();
  renderTonePicker();

  let data;
  try {
    [data, state.config] = await Promise.all([loadJSON("data/emoji.json"), loadConfig()]);
  } catch (err) {
    $(".loading").textContent = "Couldn't load the emoji data (" + err.message + ").";
    return;
  }
  if (state.config.title) document.title = `${state.config.title} · emoji-tray`;

  for (const g of data.groups) {
    for (const it of g.items) {
      it.i = state.items.length;
      // Pre-split once: all words, plus the words of each language's NAME
      // (the first "|"-entry of every language in the data).
      it.words = [...new Set(tokens(Object.values(it.s).join("|")))];
      it.nameWords = [...new Set(Object.values(it.s).flatMap((s) => tokens(s.split("|")[0])))];
      state.items.push(it);
      state.byKey.set(key(it.e), it);
      for (const v of it.t || []) if (!state.byKey.has(key(v))) state.byKey.set(key(v), it);
    }
  }
  renderGroups(data);
  renderPersonal();
  $(".loading").remove();
  $(".data-version").textContent =
    `Emoji ${data.emoji} · CLDR ${data.cldr} · ${state.items.length} emojis · search in ${data.langs.join(", ")}`;

  document.addEventListener("click", (ev) => {
    const pop = $(".popover");
    const inMenu = pop.contains(ev.target);

    // Menu actions.
    const action = ev.target.closest("[data-action]");
    if (action && inMenu) {
      const item = state.items[Number(action.dataset.i)];
      if (action.dataset.action === "fav") toggleFavorite(item);
      if (action.dataset.action === "combo") addToComposer(display(item));
      closeMenu();
      return;
    }
    if (!inMenu) closeMenu();

    const del = ev.target.closest("[data-del-combo]");
    if (del) { deleteCombo(Number(del.dataset.delCombo)); return; }

    const t = ev.target.closest(".tile, .combo");
    if (!t) return;
    const emoji = t.dataset.copy ?? display(state.items[Number(t.dataset.i)]);
    if (ev.shiftKey && !t.classList.contains("combo")) addToComposer(emoji);
    else copy(emoji);
    if (inMenu) closeMenu();
  });

  // Right-click any known emoji → menu (tones, favourite, add to combo).
  document.addEventListener("contextmenu", (ev) => {
    const t = ev.target.closest(".tile[data-i]");
    if (!t || $(".popover").contains(t)) return;
    ev.preventDefault();
    openMenu(state.items[Number(t.dataset.i)], t);
  });

  // Composer bar.
  $(".composer-copy").addEventListener("click", () => copy(state.composer.join("")));
  $(".composer-save").addEventListener("click", saveComposer);
  $(".composer-undo").addEventListener("click", () => { state.composer.pop(); renderComposer(); });
  $(".composer-clear").addEventListener("click", () => { state.composer = []; renderComposer(); });

  // Export / import.
  $(".export-mine").addEventListener("click", exportMine);
  const file = $(".import-file");
  $(".import-mine").addEventListener("click", () => file.click());
  file.addEventListener("change", () => { if (file.files[0]) importMine(file.files[0]); file.value = ""; });

  const q = $("#q");
  let timer;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(q.value), 80);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!$(".popover").hidden) { closeMenu(); return; }
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

  window.addEventListener("scroll", closeMenu, { passive: true });
}

main();
