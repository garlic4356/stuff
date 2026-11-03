"use strict";

/* --------------------------------------------------------------------------
 * Three-page frontend served by airsoft-ops (default) or any static host:
 *   /      (index.html, data-page="home")  — MAIN page: Carte → Calendrier →
 *                                            Tableaux (Leaflet loads here)
 *   /agent (agent.html, data-page="agent") — historique + activité de l'agent
 *   /chat  (chat.html, data-page="chat")   — discussion avec l'agent (chat
 *                                            runs only through the
 *                                            same-origin API: POSTs never
 *                                            carry CORS; assistant transcript
 *                                            records may carry an `activity`
 *                                            array → a collapsed tool-activity
 *                                            block inside their bubble)
 * The old /associations page is gone: the server 301-redirects it to /.
 * Routing knobs come from web/config.js (window.AIRSOFT_SITE, loaded before
 * this script): dataUrl points at the data JSON ("/api/data" on the server,
 * "./data.json" on a static host), apiBase prefixes every other API call
 * ("" = same-origin; a static deploy points it at the VPS). The home page
 * needs only the data file — status is fetched for the pill and fails
 * silently. No framework, no build. All displayed values come from the data:
 * display only, never modified in language or meaning.
 * ------------------------------------------------------------------------ */

/* ------------------------------ Site configuration ------------------------------ */

/** Runtime routing knobs (web/config.js). Defaults (or absent/invalid config)
 *  reproduce the same-origin behavior served by the Rust server. */
const SITE = window.AIRSOFT_SITE || {};
/** Where the data JSON lives — fetched with cache:"no-cache" so a fresh
 *  publish shows up without a hard reload. */
const DATA_URL = (typeof SITE.dataUrl === "string" && SITE.dataUrl) || "/api/data";
/** Base URL of the VPS API for every non-data call; "" = same-origin. */
const API_BASE = (typeof SITE.apiBase === "string" ? SITE.apiBase : "").replace(/\/+$/, "");
const apiUrl = (p) => API_BASE + p;          // API endpoint under apiBase
const REMOTE_MODE = API_BASE.length > 0;     // static site, API on another origin
const STATIC_DATA = DATA_URL !== "/api/data"; // data is a published file, not the server API

const STATUS_ORDER = { actif: 0, a_verifier: 1, ferme: 2 };
const STATUS_LABEL = { actif: "Actif", a_verifier: "À vérifier", ferme: "Fermé" };
const STATUS_COLOR = { actif: "#4e9a4e", a_verifier: "#d29422", ferme: "#c14a3a" };

/** "Soon" window, in days from today (inclusive) — shared by the timeline cards,
 *  the "Prochaines parties" column and the pulsing map markers. */
const SOON_DAYS = 14;

/** Timeline-filter anchors (map geometry, a legitimate hard-code): each entry's
 *  pinned coords are measured against these. Keys match the data-zone attributes. */
const ANCHORS = {
  rennes: { lat: 48.1173, lon: -1.6778, label: "Rennes" },
  caen: { lat: 49.1829, lon: -0.3707, label: "Caen" },
  nanterre: { lat: 48.8919, lon: 2.2060, label: "Nanterre" },
};

/** Canonical region list — order matches the data root keys
 *  (data.json root order rennes → caen → nanterre). Every loop over the
 *  entry buckets uses this array instead of a duplicated literal. */
const REGIONS = ["rennes", "caen", "nanterre"];
/** French display labels per region id. */
const REGION_LABELS = { rennes: "Rennes", caen: "Caen", nanterre: "Nanterre" };

/** Default max distance (km) for the timeline zone filter. */
const DEFAULT_MAX_KM = 150;

/** History entries requested from GET /api/history. */
const HISTORY_LIMIT = 30;

/** Polling while the update agent runs. */
const AGENT_POLL_MS = 5000;
const AGENT_POLL_MAX_MS = 15 * 60 * 1000;

/** Live agent-activity block (GET /api/agent/workflow + SSE stream). */
const WORKFLOW_PATH = "/api/agent/workflow";
const WORKFLOW_STREAM_PATH = "/api/agent/workflow/stream";
const WORKFLOW_POLL_MS = 2000;                 // fallback polling cadence
const WORKFLOW_POLL_MAX_MS = 50 * 60 * 1000;   // bound mirrors the server run-timeout (45 m default + margin)
const WORKFLOW_ERR_LIMIT = 2;                  // consecutive SSE errors → polling fallback
const WORKFLOW_COLLAPSE_MS = 4000;             // finished live view → collapsed details
const WORKFLOW_PREVIEW_MAX = 160;              // toolResult preview inline vs expandable

/* Écran de l'agent (agent page): live viewport screenshot the server captures
 * after every browser tool command. Same stream shape as the workflow (named
 * snapshot frame, then one unnamed frame per capture) and the same SSE +
 * poll-fallback machinery — it reuses the workflow constants above. The
 * backend serves these endpoints SAME-ORIGIN ONLY (deliberately not
 * CORS-readable): a static deploy degrades to a French note instead. */
const SCREEN_PATH = "/api/agent/browser/screen";
const SCREEN_STREAM_PATH = SCREEN_PATH + "/stream";

/* Prise en main (operator takeover): POST /api/agent/browser/input carries
 * one input to the agent's browser (kind goto|click|drag|type|key). Same
 * same-origin-only posture as the screen channels above (no CORS, no auth
 * token client-side) and REMOTE_MODE-hidden like every UI POST. Frame clicks
 * map onto the frame's NATURAL pixel space, which the server guarantees to
 * be the page viewport 1:1 (content-area mapping). */
const SCREEN_INPUT_PATH = "/api/agent/browser/input";

/* Interactive chat with the agent (chat page): the conversation transcript is
 * GET /api/agent/chat, POST starts a chat run through the shared single-run
 * guard (409 while a run is active) and POST /clear wipes it idempotently.
 * POSTs never work on a static deploy (no auth token, no CORS) → the whole
 * section stays hidden there (REMOTE_MODE). The waiting watch reuses the
 * workflow SSE + poll-fallback constants above. */
const CHAT_PATH = "/api/agent/chat";
const CHAT_CLEAR_PATH = "/api/agent/chat/clear";
/** Operator stop of the watched run (POST — same-origin page only). */
const AGENT_STOP_PATH = "/api/agent/stop";
const CHAT_ACTIVITY_MAX = 120;                 // argsPreview chars kept in an activity line
const CHAT_REWATCH_LIMIT = 3;                  // finish→rewatch cycles before stopping (hot-loop guard)

/* Chat usage & cost display (chat page): GET /api/agent/chat carries a
 * constant "usage" totals object (plus an optional "usage" on each assistant
 * record) — in-memory server-side data, lost on restart, reset by a chat
 * clear. costSource values are pinned upstream (see AGENTS.md): the tooltip
 * names where the USD figure comes from (server-reported, rig catalog list
 * price, operator rates, or none → tokens-only display). */
const USAGE_SOURCE_TITLES = {
  provider: "coût signalé par le fournisseur",
  catalog: "prix catalogue standard (estimation)",
  operator: "estimation opérateur (--price-in/--price-out)",
  mixed: "coûts mêlés — plusieurs sources au fil de la session",
};
const USAGE_SOURCE_TITLE_NONE = "coût inconnu (compteurs tokens seulement)";

/* Weekday schedule editor (agent page): POST /api/agent/schedule is a partial
 * update ({disabled?, days?, time?} — absent keys keep the server values), 200
 * → {ok, schedule, nextRunAt}, 400 (0 day while enabled / bad time), 401, 503.
 * No 409: saving during a running agent is safe by contract. Like the update
 * trigger, the editor POSTs same-origin only (REMOTE_MODE hides it — no auth
 * token ships with the static site). */
const SCHEDULE_PATH = "/api/agent/schedule";

/* Connexions (agent credentials, agent page): GET /api/agent/credentials lists
 * the stored connections {name, hasLogin, hasPassword, hasTotp} — names +
 * field presence only, never values. POST upserts ONE credential (a key ABSENT
 * from the body keeps the stored value) and POST /delete removes one
 * (idempotent); both work with or without a configured agent. Like every UI
 * POST they are same-origin only (no auth token ships with the site) and carry
 * no Authorization header. */
const CREDENTIALS_PATH = "/api/agent/credentials";
const CREDENTIALS_DELETE_PATH = CREDENTIALS_PATH + "/delete";

/* Navigateur de l'agent (browser profile reset, agent page): shows the
 * resolved profile path from /api/status (agent.browserProfile — null =
 * transient "off" profile) and POST /api/agent/browser/clear wipes it
 * (closes the browser, deletes the profile dir; stored connexions are
 * kept). Same-origin only like every UI POST (no auth token ships with
 * the static site); the server answers 409 while a run is active. */
const BROWSER_CLEAR_PATH = "/api/agent/browser/clear";

/** Current page, from the server-served <body data-page> (home|agent|chat) —
 *  drives the init dispatcher: home carries map + calendar + tables, agent
 *  carries history, workflow and the update trigger, chat carries the
 *  discussion with the agent. */
const PAGE = document.body.dataset.page;

const state = {
  // Zone filter (calendar chips + max km): drives the timeline AND the unified
  // table; empty = no filter, all shown
  zones: new Set(),
  maxKm: DEFAULT_MAX_KM,
  data: { meta: {}, rennes: [], caen: [], nanterre: [] },
  sort: { key: null, dir: 1 }, // single table → one sort state
  depFilter: "",               // table-local department filter
  search: "",                  // table-local search input
};

/** Known from the latest /api/status answer: drives the history-section
 *  visibility when the history list itself is empty (the section hosts the
 *  "Lancer la mise à jour" button, which must stay reachable). */
let agentConfigured = false;

/** Last successfully fetched /api/status payload (null until the first
 *  success). Used to re-evaluate the run button when a later /api/status
 *  fetch fails, so the button state always derives from known server truth
 *  instead of being stuck on « Exécution en cours… ». */
let lastAgentStatus = null;

const today = (() => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
})();

/* ------------------------------ Utilities ------------------------------ */

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** ISO date "YYYY-MM-DD" → local midnight Date (avoids the UTC-shift of the default parser). */
function parseIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysFromToday(iso) {
  return Math.round((parseIso(iso) - today) / 86400000);
}

/** French locale string: "samedi 24 octobre" ("2026" appended if year ≠ current year). */
function formatDate(iso, { long = true } = {}) {
  const d = parseIso(iso);
  let s = d.toLocaleDateString("fr-FR", {
    weekday: long ? "long" : undefined,
    day: "numeric",
    month: "long",
    year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** French relative labels: "aujourd'hui", "demain", "dans 4 jours", "hier", "il y a 3 jours" */
function relativeDate(iso) {
  const n = daysFromToday(iso);
  if (n === 0) return "aujourd'hui";
  if (n === 1) return "demain";
  if (n === -1) return "hier";
  if (n > 1) return `dans ${n} jours`;
  return `il y a ${-n} jours`;
}

/** French relative time, hour precision below 24 h then days: "il y a 5 h" /
 *  "dans 3 h" / "il y a 2 j" / "dans 1 j". sign > 0 → future, sign < 0 → past.
 *  Used by the agent status pill for lastRunAt / nextRunAt. */
function relativeTimestamp(deltaMs, sign) {
  const ms = Math.abs(deltaMs) * (sign < 0 ? -1 : 1);
  const absHours = Math.abs(ms) / 3600000;
  const future = ms > 0;
  if (absHours < 1) return "à l'instant";
  if (absHours < 24) {
    const h = Math.round(absHours);
    return future ? `dans ${h} h` : `il y a ${h} h`;
  }
  const j = Math.max(1, Math.round(absHours / 24));
  return future ? `dans ${j} j` : `il y a ${j} j`;
}

/** Safe timestamp → ms since epoch, or null when absent/invalid (pill guards). */
function timestampMs(iso) {
  const t = new Date(iso ?? "").getTime();
  return Number.isNaN(t) ? null : t;
}

/** "le 12/10/2026 à 14:05" for history entries — rendered in the monospace date column. */
function formatTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `le ${date} à ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Monday (local midnight) of the week containing the given date. */
function weekStart(date) {
  const d = new Date(date);
  const shift = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - shift);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isPast(iso) {
  return daysFromToday(iso) < 0;
}

/** Great-circle distance in km (Haversine, mean Earth radius). */
function distKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True when an entry is inside the selected anchor zones (distance filter).
 *  No zone selected → keep everything. An entry without coords can't be
 *  measured → hide it as soon as any zone is active. */
function entryWithinZones(entry) {
  if (state.zones.size === 0) return true;
  if (!entry.coords) return false;
  for (const key of state.zones) {
    const a = ANCHORS[key];
    if (a && distKm(entry.coords.lat, entry.coords.lon, a.lat, a.lon) <= state.maxKm) {
      return true;
    }
  }
  return false;
}

/** "à X km de <label>" — distance to the nearest ACTIVE anchor; null when no
 *  zone is active (or no reachable anchor). Annotation shared by the timeline
 *  cards and the table's Distance cells; data values are untouched. */
function nearestZoneTag(coords) {
  if (state.zones.size === 0 || !coords) return null;
  let best = null;
  for (const key of state.zones) {
    const a = ANCHORS[key];
    if (!a) continue;
    const km = distKm(coords.lat, coords.lon, a.lat, a.lon);
    if (!best || km < best.km) best = { km, label: a.label };
  }
  return best ? `à ${Math.round(best.km)} km de ${best.label}` : null;
}

/** First non-past event of an entry (events are date-ascending; today counts as upcoming), or null. */
function nextUpcomingEvent(entry) {
  const events = entry.events || [];
  for (const ev of events) {
    if (daysFromToday(ev.date) >= 0) return ev;
  }
  return null;
}

/** The n.c./empty convention of ncSpan as a predicate (trimmed value, same rule). */
function isNcValue(text) {
  const t = String(text ?? "").trim();
  return t === "" || t === "—" || /^n\.c\./i.test(t);
}

/** Renders text greyed out when it equals / starts with "n.c." (FRENCH data convention — the string itself is data, keep as-is). */
function ncSpan(text) {
  const t = String(text ?? "").trim();
  if (isNcValue(text)) {
    return `<span class="nc">${escapeHtml(t === "" ? "—" : t)}</span>`;
  }
  return escapeHtml(t);
}

/** True for the URL schemes this site is allowed to turn into links — plain
 *  http(s), email and phone. Defense-in-depth: anything else coming from the
 *  data (e.g. a javascript: URL) renders as a grey non-clickable label. */
function isLinkable(url) {
  return typeof url === "string" && /^(https?:|mailto:|tel:)/i.test(url);
}

/* ------------------------------ Markdown (agent page) ------------------------------ */

/** True when the CDN markdown stack finished loading (agent + chat pages). */
function markdownEnabled() {
  return (PAGE === "agent" || PAGE === "chat") && typeof marked !== "undefined" && typeof DOMPurify !== "undefined";
}

/** Link hardening on ALREADY-SANITIZED markdown: http(s) anchors open in a new
 *  tab. Parsing sanitized content in a <template> is inert (no script runs). */
function hardenLinks(sanitizedHtml) {
  const tpl = document.createElement("template");
  tpl.innerHTML = sanitizedHtml;
  for (const a of tpl.content.querySelectorAll("a[href]")) {
    if (/^https?:/i.test(a.getAttribute("href"))) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  }
  return tpl.innerHTML;
}

/** Wrap markdown <table> elements in a horizontal-scroll container: the
 *  home-page table sizing (.table-scroll/table min-width: 1100px) must not
 *  leak into chat bubbles / workflow replies / history summaries, and
 *  genuinely wide tables must scroll instead of spilling across their
 *  container border. Parsing sanitized content in a <template> is inert
 *  (no script runs). */
function wrapTables(sanitizedHtml) {
  const tpl = document.createElement("template");
  tpl.innerHTML = sanitizedHtml;
  for (const table of [...tpl.content.querySelectorAll("table")]) {
    const scroller = document.createElement("div");
    scroller.className = "md-table-scroll";
    table.replaceWith(scroller);
    scroller.appendChild(table);
  }
  return tpl.innerHTML;
}

/** Markdown → sanitized HTML (marked + DOMPurify); the no-CDN/other-page
 *  fallback is the escapeHtml discipline — raw HTML is never produced. */
function renderMarkdown(text) {
  if (!markdownEnabled()) {
    return escapeHtml(text);
  }
  // marked.parse is synchronous by default; sanitize before any DOM touch
  return hardenLinks(wrapTables(DOMPurify.sanitize(marked.parse(String(text ?? "")))));
}

/* ------------------------------ Hero / timeline ------------------------------ */

function allEvents() {
  const out = [];
  for (const region of REGIONS) {
    for (const entry of state.data[region] || []) {
      for (const ev of entry.events || []) {
        out.push({ ...ev, region, entry });
      }
    }
  }
  return out;
}

/** Groups events by week (Monday), sorted chronologically. */
function groupByWeek(events) {
  const groups = new Map();
  for (const ev of events) {
    const start = weekStart(parseIso(ev.date));
    const key = start.getTime();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, evs]) => ({
      monday: new Date(key),
      events: evs.sort((a, b) => a.date.localeCompare(b.date) || a.entry.nom.localeCompare(b.entry.nom, "fr")),
    }));
}

function eventCard(ev) {
  const rel = relativeDate(ev.date);
  const soon = daysFromToday(ev.date) >= 0 && daysFromToday(ev.date) <= SOON_DAYS;
  // With a zone filter active, show the distance to the nearest active anchor
  // instead of the static region tag
  const zoneTag = nearestZoneTag(ev.entry.coords);
  const card = document.createElement("a");
  card.className = "event-card";
  card.href = `#entry-${ev.region}-${ev.entry.id}`;
  card.innerHTML = `
    <span class="ev-date">${escapeHtml(formatDate(ev.date))}</span>
    <span class="ev-rel${soon ? " soon" : ""}">${escapeHtml(rel)}</span>
    <div class="ev-orga">${escapeHtml(ev.entry.nom)}</div>
    <div class="ev-lieu">${escapeHtml(ev.lieu)} · <span class="${zoneTag ? "ev-zone" : "ev-region"}">${zoneTag ? escapeHtml(zoneTag) : escapeHtml(REGION_LABELS[ev.region] || ev.region)}</span></div>
    ${ev.note ? `<div class="ev-note">${escapeHtml(ev.note)}</div>` : ""}`;
  // Tables are on the same page now: reset the filters, then scroll+flash the row
  card.addEventListener("click", (e) => {
    e.preventDefault();
    scrollToEntry(ev.region, ev.entry.id);
  });
  return card;
}

function renderHero() {
  const timeline = document.getElementById("timeline");
  const pastZone = document.getElementById("past-events");
  timeline.innerHTML = "";
  pastZone.innerHTML = "";

  const events = allEvents();
  // Zone filter applies to upcoming games only (the where-to-go list);
  // past events stay unfiltered — they are activity evidence
  const future = events.filter((ev) => !isPast(ev.date) && entryWithinZones(ev.entry));
  // Note: wrapped callback — filter() passes (element, index, array) while isPast expects an ISO string
  const past = events.filter((ev) => isPast(ev.date)).sort((a, b) => b.date.localeCompare(a.date));

  if (future.length === 0) {
    const msg = state.zones.size > 0
      ? `Aucune partie datée à moins de ${state.maxKm} km des zones choisies.`
      : `Aucune partie datée à venir pour ce filtre.`;
    timeline.innerHTML = `<p class="subtitle" style="margin:.2rem 0">${escapeHtml(msg)}</p>`;
  } else {
    for (const group of groupByWeek(future)) {
      const wk = document.createElement("div");
      wk.className = "week-group";
      const label = document.createElement("div");
      label.className = "week-label";
      const sat = new Date(group.monday);
      sat.setDate(sat.getDate() + 5);
      const sun = new Date(group.monday);
      sun.setDate(sun.getDate() + 6);
      const fmt = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      label.textContent = sat.getMonth() === sun.getMonth()
        ? `Week-End du ${sat.getDate()} & ${fmt(sun)}`
        : `Week-End du ${fmt(sat)} & ${fmt(sun)}`;
      wk.appendChild(label);
      group.events.forEach((ev) => wk.appendChild(eventCard(ev)));
      timeline.appendChild(wk);
    }
  }

  if (past.length > 0) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Parties passées (${past.length}) — preuves d'activité`;
    details.appendChild(summary);
    const ul = document.createElement("ul");
    for (const ev of past) {
      const li = document.createElement("li");
      li.innerHTML =
        `${escapeHtml(formatDate(ev.date, { long: false }))} — ${escapeHtml(ev.entry.nom)}` +
        (ev.note ? ` <em>(${escapeHtml(ev.note)})</em>` : "");
      li.appendChild(Object.assign(document.createElement("a"), {
        textContent: " voir la fiche",
        href: `#entry-${ev.region}-${ev.entry.id}`,
      }));
      li.querySelector("a").addEventListener("click", (e) => {
        e.preventDefault();
        scrollToEntry(ev.region, ev.entry.id);
      });
      ul.appendChild(li);
    }
    details.appendChild(ul);
    pastZone.appendChild(details);
  }
}

/** Click from the hero/past games/no-geo list: make sure the filters don't
 *  hide the row — search + dep are cleared, and an active zone filter that
 *  would still hide the target is cleared too (a deep link must always
 *  surface its row) — then scroll+flash it. */
function scrollToEntry(region, id) {
  state.search = "";
  state.depFilter = "";
  const search = document.getElementById("search-all");
  const dep = document.getElementById("dep-all");
  if (search) search.value = "";
  if (dep) dep.value = "";
  // The zone filter (calendar chips) is not a table-local control: a
  // coords-less entry, or one beyond the max-km range, stays hidden after the
  // dep/search reset — clear the zones the same way (chips reset) and let the
  // same rendering path the chip bindings use re-render the table.
  const entry = (state.data[region] || []).find((e) => e.id === id);
  if (state.zones.size > 0 && entry && !entryWithinZones(entry)) {
    state.zones.clear();
    document.querySelectorAll(".filter-controls .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", "false");
    });
    renderFilteredViews();
  }
  renderTable();
  const row = document.getElementById(`entry-${region}-${id}`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 2000);
}

/** Deep-link on load: /…#entry-<region>-<id> (bookmark or external link)
 *  scrolls to the matching row and flashes it once the table renders. */
function handleEntryHash() {
  if (!location.hash.startsWith("#entry-")) return;
  const row = document.getElementById(location.hash.slice(1));
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 2000);
}

/* ------------------------------ Map ------------------------------ */

let map = null;
let markerLayer = null;
/** Decorative highlight ring (one at a time) on its own layer — never mixed
 *  with the data markers, so a highlight can't be confused with the data. */
let highlightLayer = null;
let highlightTimer = null; // pending removal of the highlight ring
/** Entry id → data marker: terrain-cell clicks look up the popup target. */
const markerById = new Map();

function initMap() {
  // Guard: renderData() must be able to call this repeatedly (refresh after an agent run)
  if (map) return true;
  if (typeof L === "undefined") {
    document.getElementById("map").innerHTML =
      '<p style="padding:1rem">Carte indisponible (Leaflet non chargé — vérifiez la connexion).</p>';
    return false;
  }
  map = L.map("map").setView([47.3, -1.5], 7);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  highlightLayer = L.layerGroup().addTo(map);
  return true;
}

function popupHtml(entry) {
  const next = nextUpcomingEvent(entry);
  return `<strong>${escapeHtml(entry.nom)}</strong><br>
          ${escapeHtml(entry.commune)} (${escapeHtml(entry.dep)})<br>
          ${ncSpan(entry.distance)} · ${ncSpan(entry.frequence)}<br>
          ${next ? `Prochaine partie&nbsp;: ${escapeHtml(formatDate(next.date))} (<span class="ev-rel${daysFromToday(next.date) <= SOON_DAYS ? " soon" : ""}">${escapeHtml(relativeDate(next.date))}</span>)<br>` : ""}
          Liens&nbsp;: ${liensInlineHtml(entry)}`;
}

/** All links of an entry joined by " · " (none → "n.c."). Inline version for popups. */
function liensInlineHtml(entry) {
  const liens = entry.liens || [];
  if (liens.length === 0) return `<span class="nc">n.c.</span>`;
  return liens
    .map((l) =>
      // isLinkable: defense-in-depth — a javascript: URL must never become clickable
      isLinkable(l.url)
        ? `<a href="${escapeHtml(l.url)}"${/^https?:/i.test(l.url) ? ` target="_blank" rel="noopener"` : ""}>${escapeHtml(l.texte)}</a>`
        : `<span class="nc">${escapeHtml(l.texte)}</span>`
    )
    .join(" · ");
}

function renderMap() {
  if (!map) return;
  markerLayer.clearLayers();
  markerById.clear();
  const bounds = [];
  for (const region of REGIONS) {
    for (const entry of state.data[region] || []) {
      if (!entry.coords) continue;
      const color = STATUS_COLOR[entry.statut];
      // Game imminent (≤ SOON_DAYS): expanding ring under the main marker (SVG stroke-width animation)
      const next = nextUpcomingEvent(entry);
      if (next && daysFromToday(next.date) >= 0 && daysFromToday(next.date) <= SOON_DAYS) {
        markerLayer.addLayer(L.circleMarker([entry.coords.lat, entry.coords.lon], {
          radius: 8,
          color: color,
          weight: 3,
          fill: false,
          interactive: false,
          className: "map-pulse",
        }));
      }
      const marker = L.circleMarker([entry.coords.lat, entry.coords.lon], {
        radius: 8,
        color: "#000000",
        weight: 2,
        fillColor: color,
        fillOpacity: 0.92,
      });
      marker.bindPopup(popupHtml(entry));
      marker.bindTooltip(entry.nom, { direction: "top", offset: [0, -6] });
      markerLayer.addLayer(marker);
      markerById.set(entry.id, marker);
      bounds.push([entry.coords.lat, entry.coords.lon]);
    }
  }
  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  } else if (bounds.length === 1) {
    map.setView(bounds[0], 12);
  }
  setTimeout(() => map.invalidateSize(), 50);
}

/** Terrain-cell click → map: scroll to the map section, fly to the entry's
 *  spot (no animation under prefers-reduced-motion), open its popup and pulse
 *  a temporary accent ring. One ring at a time: a re-click before expiry
 *  clears the previous ring + timer instead of stacking. */
function highlightOnMap(entry) {
  if (!map || !entry.coords) return;
  const section = document.getElementById("carte");
  if (section) {
    section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }
  const zoom = Math.max(map.getZoom(), 11);
  if (prefersReducedMotion()) {
    map.setView([entry.coords.lat, entry.coords.lon], zoom);
  } else {
    map.flyTo([entry.coords.lat, entry.coords.lon], zoom);
  }
  // Popup on the DATA marker; no-op after a re-render dropped the marker
  const marker = markerById.get(entry.id);
  if (marker) marker.openPopup();
  // Temporary ring, #a3b955 = the accent-bright literal (map SVG colors are
  // code literals, like STATUS_COLOR)
  if (highlightTimer) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
    highlightLayer.clearLayers();
  }
  highlightLayer.addLayer(L.circleMarker([entry.coords.lat, entry.coords.lon], {
    radius: 12,
    weight: 3,
    color: "#a3b955",
    fill: false,
    interactive: false,
    className: "map-pulse",
  }));
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    highlightLayer?.clearLayers();
  }, 4000);
}

/** Entries without coordinates, listed below the map. */
function renderNoGeo() {
  const zone = document.getElementById("no-geo");
  zone.innerHTML = "";
  const missing = REGIONS
    .flatMap((r) => (state.data[r] || []).filter((e) => !e.coords));
  if (missing.length === 0) return;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Lieux non géolocalisés (${missing.length}) — lieux variables / commune inconnue`;
  details.appendChild(summary);
  const ul = document.createElement("ul");
  for (const entry of missing) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(entry.nom)}</strong> — ${escapeHtml(entry.commune)} (${escapeHtml(entry.dep)})`;
    const a = Object.assign(document.createElement("a"), {
      textContent: " voir la fiche", href: `#entry-${entryRegion(entry)}-${entry.id}`,
    });
    li.appendChild(a);
    ul.appendChild(li);
  }
  details.appendChild(ul);
  zone.appendChild(details);
}

/** Bucket key whose array contains the entry id (canonical REGIONS order);
 *  defaults to "rennes" when absent, preserving the no-coords anchor-link
 *  behavior. */
function entryRegion(entry) {
  for (const region of REGIONS) {
    if ((state.data[region] || []).some((e) => e.id === entry.id)) return region;
  }
  return "rennes";
}

/* ------------------------------ Tables ------------------------------ */

function populateDepSelect() {
  const select = document.getElementById("dep-all");
  if (!select) return;
  // Re-population on refresh must not duplicate the "Tous départements" option
  const keep = select.querySelector("option[value='']");
  select.innerHTML = "";
  if (keep) select.appendChild(keep);
  const deps = [...new Set(REGIONS.flatMap((r) => (state.data[r] || []).map((e) => e.dep)))]
    .sort((a, b) => a.localeCompare(b, "fr"));
  for (const dep of deps) {
    const opt = document.createElement("option");
    opt.value = dep;
    opt.textContent = dep;
    select.appendChild(opt);
  }
  // Keep the visible selection in sync with the active filter: after a refresh
  // the previous filter may no longer exist as an option — then clear both the
  // select and the filter state (and re-render so the table agrees).
  const filter = state.depFilter;
  if (filter && deps.includes(filter)) {
    select.value = filter;
  } else if (filter) {
    state.depFilter = "";
    select.value = "";
    renderTable();
  }
}

function sortValue(entry, key) {
  switch (key) {
    case "statut":
      return STATUS_ORDER[entry.statut];
    case "events": {
      // Sort by next upcoming event date (past dates ignored,
      // undefined last) — ranking must reflect upcoming games.
      const dates = (entry.events || []).map((e) => e.date).filter((d) => !isPast(d));
      return dates[0] ?? "9999-99-99";
    }
    default: {
      const v = entry[key];
      return typeof v === "string" ? v : "";
    }
  }
}

function filteredEntries() {
  const search = state.search.trim().toLowerCase();
  const dep = state.depFilter;
  const { key, dir } = state.sort;
  // Regions in canonical order (REGIONS): visual order preserved while unsorted.
  // includes(): handles composite deps like "78 / 95" (AMA France matches filter 78 as well as 95)
  let entries = REGIONS
    .flatMap((r) => state.data[r] || [])
    .filter(
      (e) =>
        entryWithinZones(e) && // calendar filter drives the table too
        (!dep || String(e.dep).includes(dep)) &&
        (!search || `${e.nom} ${e.commune}`.toLowerCase().includes(search))
    );
  if (key) {
    entries = [...entries].sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), "fr", { sensitivity: "base" });
      return cmp * dir;
    });
  }
  return entries;
}

function eventsCellHtml(entry) {
  const events = entry.events || [];
  const next = nextUpcomingEvent(entry);
  let html = "";
  if (events.length > 0) {
    html += `<ul class="ev-inline">` + events
      .map((ev) => {
        const past = isPast(ev.date);
        // Only the first non-past event (nextUpcomingEvent: days >= 0) can be "soon"
        const soon = ev === next && daysFromToday(ev.date) <= SOON_DAYS;
        const cls = past ? ` class="nc"` : soon ? ` class="soon"` : "";
        const dateStr = ev.date.slice(8, 10) + "/" + ev.date.slice(5, 7) +
          (ev.date.slice(0, 4) !== String(today.getFullYear()) ? "/" + ev.date.slice(0, 4) : "");
        return `<li${cls}>` +
          `<span class="d${soon ? " soon" : ""}">${escapeHtml(dateStr)}</span>` +
          (ev === next
            ? ` — <span class="ev-rel${soon ? " soon" : ""}">${escapeHtml(relativeDate(ev.date))}</span>`
            : "") +
          (ev.lieu && !/^n\.c\./i.test(ev.lieu) ? ` ${escapeHtml(ev.lieu)}` : "") +
          (ev.note ? ` — <em>${escapeHtml(ev.note)}</em>` : "") + `</li>`;
      })
      .join("") + `</ul>`;
  }
  if (entry.prochaines) {
    html += `<div class="nc" style="font-size:.78rem">${escapeHtml(entry.prochaines)}</div>`;
  }
  return html || `<span class="nc">—</span>`;
}

function liensCellHtml(entry) {
  const liens = entry.liens || [];
  if (liens.length === 0) return `<span class="nc">—</span>`;
  const items = liens.map((l) =>
    // isLinkable: same scheme guard as the popups (m3)
    isLinkable(l.url)
      ? `<li><a href="${escapeHtml(l.url)}"${/^https?:/i.test(l.url) ? ` target="_blank" rel="noopener"` : ""}>${escapeHtml(l.texte)}</a></li>`
      : `<li class="nc">${escapeHtml(l.texte)}</li>`
  );
  return `<ul class="liens-list">${items.join("")}</ul>`;
}

/** Terrain cell: a geolocated entry with a REAL place value deep-links to the
 *  map (button → highlightOnMap); a non-place — missing coords, empty or n.c.
 *  value — has nothing to highlight and keeps the plain ncSpan rendering.
 *  The button text is the raw data value (escaped), like ncSpan would render. */
function terrainCellHtml(entry) {
  if (!entry.coords || isNcValue(entry.terrain)) return ncSpan(entry.terrain);
  const text = String(entry.terrain ?? "").trim();
  return `<button type="button" class="terrain-link" title="Voir sur la carte">${escapeHtml(text)}</button>`;
}

function renderTable() {
  const tbody = document.querySelector("#table-all tbody");
  const head = document.querySelector("#table-all thead");
  if (!tbody || !head) return;
  // Sort markers
  head.querySelectorAll("th .arrow").forEach((a) => a.remove());
  const { key, dir } = state.sort;
  // aria-sort: "none" everywhere except the active column (th without data-key, like Liens, are inert)
  head.querySelectorAll("th").forEach((th) => {
    if (!th.dataset.key) return;
    th.setAttribute("aria-sort", th.dataset.key === key ? (dir === 1 ? "ascending" : "descending") : "none");
  });
  if (key) {
    const th = head.querySelector(`th[data-key="${key}"]`);
    if (th) {
      const arrow = Object.assign(document.createElement("span"), {
        className: "arrow", textContent: dir === 1 ? " ▲" : " ▼",
      });
      th.appendChild(arrow);
    }
  }
  tbody.innerHTML = "";
  for (const entry of filteredEntries()) {
    const region = entryRegion(entry);
    const tr = document.createElement("tr");
    tr.className = "entry-row";
    // EXTERNAL COMPAT: the timeline cards, past-games links, no-geo links and
    // handleEntryHash() deep-link to #entry-<region>-<id>
    tr.id = `entry-${region}-${entry.id}`;
    const detail = entry.statutDetail
      ? `<span class="status-detail">${escapeHtml(entry.statutDetail)}</span>` : "";
    // Distance annotation: with a calendar zone filter active, a geolocated row
    // also shows the computed km to the nearest active anchor (presentation
    // only — the distance DATA VALUE is untouched)
    const zoneTag = nearestZoneTag(entry.coords);
    tr.innerHTML = `
      <td class="cell-nom">${escapeHtml(entry.nom)}</td>
      <td>${ncSpan(entry.commune)}</td>
      <td>${escapeHtml(entry.dep)}</td>
      <td>${ncSpan(entry.distance)}${zoneTag ? `<span class="ev-zone">${escapeHtml(zoneTag)}</span>` : ""}</td>
      <td>${ncSpan(entry.type)}</td>
      <td><span class="badge ${escapeHtml(entry.statut)}">${escapeHtml(STATUS_LABEL[entry.statut] || entry.statut)}</span>${detail}</td>
      <td>${ncSpan(entry.frequence)}</td>
      <td>${eventsCellHtml(entry)}</td>
      <td>${terrainCellHtml(entry)}</td>
      <td>${ncSpan(entry.cout)}</td>
      <td>${liensCellHtml(entry)}</td>`;
    // Terrain → map fly-to: rows are rebuilt on every render, bind per row
    const terrainBtn = tr.querySelector(".terrain-link");
    if (terrainBtn) terrainBtn.addEventListener("click", () => highlightOnMap(entry));
    tbody.appendChild(tr);
  }
  if (tbody.children.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="11"><em>Aucun résultat pour ces filtres.</em></td>`;
    tbody.appendChild(tr);
  }
}

function bindTableControls() {
  const search = document.getElementById("search-all");
  const dep = document.getElementById("dep-all");
  if (!search || !dep) return;
  search.addEventListener("input", () => {
    state.search = search.value;
    renderTable();
  });
  dep.addEventListener("change", () => {
    state.depFilter = dep.value;
    renderTable();
  });
  document.querySelectorAll("#table-all thead th").forEach((th) => {
    th.addEventListener("click", () => {
      if (!th.dataset.key) return; // non-sortable columns (e.g. Liens)
      const k = th.dataset.key;
      const s = state.sort;
      s.dir = s.key === k ? -s.dir : 1;
      s.key = k;
      renderTable();
    });
    // Keyboard accessibility: Enter / Space trigger sorting like a click
    th.addEventListener("keydown", (e) => {
      if (!th.dataset.key) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        th.click();
      }
    });
  });
}

/* ------------------------------ Sources ------------------------------ */

function renderSources() {
  const zone = document.getElementById("sources-list");
  // Clear first: renderData() runs again after an agent-run refresh
  zone.innerHTML = "";
  const seen = new Set();
  for (const region of REGIONS) {
    for (const entry of state.data[region] || []) {
      for (const url of entry.sources || []) {
        if (seen.has(url)) continue;
        seen.add(url);
        const li = document.createElement("li");
        let host = url;
        try { host = new URL(url).hostname; } catch { /* relative URL unlikely */ }
        // Same guard as the lien cells: only linkable schemes become <a> (m3)
        li.innerHTML = isLinkable(url)
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(host)}</a> — ${escapeHtml(url)}`
          : escapeHtml(url);
        zone.appendChild(li);
      }
    }
  }
}

/* ------------------------------ Historique des mises à jour ------------------------------ */

/** kind → French label (unknown kinds are displayed raw). */
function historyKindLabel(kind) {
  switch (kind) {
    case "commit": return "Mise à jour des données";
    case "run": return "Exécution de l'agent";
    case "credentials": return "Gestion des connexions";
    case "browser": return "Navigateur de l'agent";
    default: return kind || "—";
  }
}

/** Only non-zero chips are rendered (additions, modifications, moves, purges,
 *  manual keeps, warnings). */
function historyChipsHtml(h) {
  const chips = [];
  if ((h.added || []).length > 0) chips.push(`<span class="hist-chip c-add">+${h.added.length} ajoutées</span>`);
  if ((h.updated || []).length > 0) chips.push(`<span class="hist-chip c-upd">~${h.updated.length} modifiées</span>`);
  if ((h.moved || []).length > 0) chips.push(`<span class="hist-chip c-mov">⇄ ${h.moved.length} déplacées</span>`);
  if ((h.removedEvents || []).length > 0) chips.push(`<span class="hist-chip c-del">🗑 ${h.removedEvents.length} parties purgées</span>`);
  if ((h.manualKept || []).length > 0) chips.push(`<span class="hist-chip">⏸ ${h.manualKept.length} valeurs conservées</span>`);
  if ((h.warnings || []).length > 0) chips.push(`<span class="hist-chip">⚠ ${h.warnings.length} avertissements</span>`);
  return chips.join(" ");
}

/** Expandable details: added ids / updated id+field / moved regions / removed
 *  event dates / manual-kept fields. */
function historyDetailHtml(h) {
  const parts = [];
  if ((h.added || []).length > 0) {
    parts.push(`<li>Ajoutées&nbsp;: ${h.added.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</li>`);
  }
  if ((h.updated || []).length > 0) {
    const items = h.updated.map((u) => `<code>${escapeHtml(u.id)}</code> . ${escapeHtml(u.field)}`).join(", ");
    parts.push(`<li>Champs modifiés&nbsp;: ${items}</li>`);
  }
  if ((h.moved || []).length > 0) {
    const items = h.moved.map((m) => `<code>${escapeHtml(m.id)}</code> ${escapeHtml(m.from)} → ${escapeHtml(m.to)}`).join(", ");
    parts.push(`<li>Déplacées&nbsp;: ${items}</li>`);
  }
  if ((h.removedEvents || []).length > 0) {
    const items = h.removedEvents
      .map((r) => `<code>${escapeHtml(r.id)}</code> (${escapeHtml(r.region)})&nbsp;: ${escapeHtml(r.date)}`)
      .join(", ");
    parts.push(`<li>Parties purgées&nbsp;: ${items}</li>`);
  }
  if ((h.manualKept || []).length > 0) {
    const items = h.manualKept.map((m) => `<code>${escapeHtml(m.id)}</code> . ${escapeHtml(m.field)}`).join(", ");
    parts.push(`<li>Valeurs conservées (champs manuels)&nbsp;: ${items}</li>`);
  }
  if ((h.ignoredFields || []).length > 0) {
    // Contract leaves the item shape open ({id, field} pairs or plain strings) — render both
    const items = h.ignoredFields.map((f) =>
      f && typeof f === "object"
        ? `<code>${escapeHtml(f.id)}</code> . ${escapeHtml(f.field)}`
        : escapeHtml(String(f))
    ).join(", ");
    parts.push(`<li>Champs ignorés (hors schéma)&nbsp;: ${items}</li>`);
  }
  return parts.join("");
}

function historyErrorPart(h) {
  if (h.ok === false && h.error) {
    return `<li class="hist-detail-error">Erreur&nbsp;: ${escapeHtml(h.error)}</li>`;
  }
  return "";
}

/** True once real history entries are on screen; drives the section visibility
 *  together with agentConfigured (see updateHistorySection). */
let historyShown = false;

/** True once the connexions editor is revealed on the agent page (see
 *  initCredentials): keeps #historique visible even with an empty history and
 *  an unconfigured agent — the credentials GET answers regardless of the
 *  agent state, so the section must keep hosting the block in that case too. */
let credentialsShown = false;

/* -------- API-unreachable degradation (agent page, static deploys) -------- */

/** Exact notice shown when the API (status/history) is unreachable at load —
 *  UI string, never data: set as a text node, no HTML path involved. */
const API_UNAVAILABLE_MSG =
  "Partie mise à jour automatique indisponible — les données affichées sont celles du fichier statique.";

let apiUnavailable = false;

/** Marks the auto-update part as unreachable and surfaces the notice once in
 *  the dedicated #api-degraded slot (idempotent: one message per section area).
 *  The pill stays hidden and failing sections keep their hide-on-failure rule;
 *  only the slot's hosting section is unhidden to make the notice readable. */
function markApiUnavailable() {
  if (apiUnavailable) return;
  apiUnavailable = true;
  const slot = document.getElementById("api-degraded");
  if (!slot) return; // slot exists on the agent page only
  slot.textContent = API_UNAVAILABLE_MSG;
  slot.hidden = false;
}

/** A valid HTTP history answer proves the API is reachable again (e.g. a
 *  transient status blip marked the notice) → stop showing it. */
function clearApiUnavailable() {
  apiUnavailable = false;
  const slot = document.getElementById("api-degraded");
  if (slot) slot.hidden = true;
}

/** Section visibility: shown with the history list, or with a placeholder when
 *  the list is empty but the agent is configured (the section hosts the run
 *  button), or with the degradation notice when the API is unreachable.
 *  Hidden when there is nothing at all to show (fetch failed, agent
 *  unconfigured, no notice). */
function updateHistorySection() {
  const section = document.getElementById("historique");
  const list = document.getElementById("history-list");
  if (!section || !list) return;
  if (!historyShown && !agentConfigured && !apiUnavailable && !credentialsShown) {
    section.hidden = true;
    return;
  }
  // The notice replaces the placeholder when the API is unreachable; a
  // previously rendered placeholder must not linger next to it
  if (!historyShown && !apiUnavailable) {
    list.innerHTML = `<p class="hist-empty">Aucun historique pour le moment — les mises à jour automatiques apparaîtront ici.</p>`;
  } else if (!historyShown) {
    list.innerHTML = "";
  }
  section.hidden = false;
}

/** Renders the history list (newest first). Empty/malformed input resets to the
 *  visibility rules instead of rendering anything. */
function renderHistory(entries) {
  const section = document.getElementById("historique");
  const list = document.getElementById("history-list");
  if (!section || !list) return;
  if (!Array.isArray(entries) || entries.length === 0) {
    historyShown = false;
    updateHistorySection();
    return;
  }
  list.innerHTML = "";
  for (const h of entries) {
    const item = document.createElement("div");
    item.className = "hist-entry";
    const chips = historyChipsHtml(h);
    const detail = historyDetailHtml(h) + historyErrorPart(h);
    // Markdown form when the CDN stack is present; escapeHtml fallback otherwise
    const summary = h.summary ? `<span class="hist-summary">${renderMarkdown(h.summary)}</span>` : "";
    item.innerHTML = `
      <div class="hist-line">
        <span class="hist-date">${escapeHtml(formatTimestamp(h.ts))}</span>
        <span class="hist-kind${h.kind === "run" ? " run" : ""}">${escapeHtml(historyKindLabel(h.kind))}</span>
        ${summary}
        ${chips ? `<span class="hist-chips">${chips}</span>` : ""}
      </div>
      ${detail ? `<details><summary>Détails</summary><ul>${detail}</ul></details>` : ""}`;
    list.appendChild(item);
  }
  historyShown = true;
  section.hidden = false;
}

/** Loads the history and renders it; on failure marks the degraded state (the
 *  visibility rules take it into account — section shown to host the notice). */
async function loadHistory() {
  try {
    const res = await fetch(apiUrl(`/api/history?limit=${HISTORY_LIMIT}`));
    if (!res.ok) {
      markApiUnavailable();
      historyShown = false;
      updateHistorySection();
      return;
    }
    // Valid HTTP answer = the API answers: any earlier degradation notice was a blip
    clearApiUnavailable();
    const json = await res.json();
    renderHistory(json.entries || []);
  } catch {
    markApiUnavailable();
    historyShown = false;
    updateHistorySection();
  }
}

/** Re-evaluates the history section after the status answer (the section may
 *  have rendered empty before /api/status revealed the agent is configured). */
function syncHistoryVisibility() {
  updateHistorySection();
}

/* ------------------------------ Activité de l'agent (workflow live) ------------------------------ */

const KIND_LABEL = { maintenance: "Mise à jour automatique", interactive: "Exécution interactive" };

/** Mutable live-workflow state; single owner of the EventSource, the fallback
 *  poller and the post-finish collapse timer (never duplicated — see
 *  startStream / startPollFallback / scheduleCollapse). */
const wf = {
  es: null,            // live SSE EventSource (null when closed)
  errCount: 0,         // consecutive SSE errors
  pollToken: null,     // fallback-polling generation token (null = stopped)
  pollTimer: null,
  pollStarted: 0,      // fallback start time (50 min bound)
  collapseTimer: null,
  live: false,         // live/finished view currently on screen
  run: null,           // last known run meta {runId, kind, startedAt, running}
  events: [],          // events of the current/last run
  lastTurn: null,      // turn of the last rendered toolCall (divider grouping)
};

function kindLabel(kind) {
  return KIND_LABEL[kind] ?? (kind == null ? "—" : String(kind));
}

/** "(0.8 s)" style duration, ms → human units; null when unknown. */
function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60000);
  return `${mins} min ${Math.round((ms % 60000) / 1000)} s`;
}

/** "14:05:32" (local, seconds precision) for run headers; null when the
 *  timestamp is absent/invalid. */
function formatTimeSeconds(iso) {
  const ms = timestampMs(iso);
  if (ms === null) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One workflow event → one DOM node (or null for unknown types). Shared by
 *  live appends and full re-renders so both stay visually identical.
 *  turnCtx: {lastTurn} — caller-owned turn tracker (the wf state for appends,
 *  a local object for full renders); mutated when a toolCall is rendered. */
function buildEventNode(ev, turnCtx) {
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case "runStart": {
      const node = document.createElement("div");
      node.className = "wf-line wf-start";
      const time = formatTimeSeconds(ev.startedAt);
      node.innerHTML =
        `▶ Exécution <code>#${escapeHtml(String(ev.runId ?? ""))}</code>` +
        (time ? ` — démarrée à ${escapeHtml(time)}` : "");
      return node;
    }
    case "toolCall": {
      const frag = document.createDocumentFragment();
      const turn = typeof ev.turn === "number" ? ev.turn : null;
      // Group by turn: divider when the turn changes from the previous toolCall
      if (turn !== null && turnCtx.lastTurn !== null && turn !== turnCtx.lastTurn) {
        const divider = document.createElement("div");
        divider.className = "wf-line wf-divider";
        divider.textContent = `— tour ${turn} —`;
        frag.appendChild(divider);
      }
      const line = document.createElement("div");
      line.className = "wf-line wf-call";
      // tool name + args preview: monospace chip (both are API data — escaped)
      line.innerHTML =
        `<span class="wf-tool">${escapeHtml(String(ev.tool ?? ""))}(${escapeHtml(String(ev.argsPreview ?? ""))})</span>` +
        (turn !== null ? ` <span class="wf-turn">tour ${turn}</span>` : "");
      frag.appendChild(line);
      if (turn !== null) turnCtx.lastTurn = turn;
      return frag;
    }
    case "toolResult": {
      const ok = ev.ok === true;
      const mark = `<span class="${ok ? "wf-mark-ok" : "wf-mark-err"}">${ok ? "✓" : "✗"}</span>`;
      const name = `<span class="wf-toolname">${escapeHtml(String(ev.tool ?? ""))}</span>`;
      const dur = fmtDuration(ev.durationMs);
      const durHtml = dur ? ` <span class="wf-dur">(${escapeHtml(dur)})</span>` : "";
      const preview = typeof ev.preview === "string" ? ev.preview : "";
      if (preview.length > WORKFLOW_PREVIEW_MAX) {
        // Long outputs collapse: summary = first line (bounded), full content below
        const firstLine = preview.split("\n")[0];
        const summary = firstLine.length > 120 ? `${firstLine.slice(0, 120)} …` : firstLine;
        const node = document.createElement("details");
        node.className = "wf-line wf-result";
        node.innerHTML =
          `<summary>${mark} ${name}${durHtml} <span class="wf-preview">${escapeHtml(summary)}</span></summary>` +
          `<div class="wf-preview wf-preview-full">${escapeHtml(preview)}</div>`;
        return node;
      }
      const node = document.createElement("div");
      node.className = "wf-line wf-result";
      node.innerHTML = `${mark} ${name}${durHtml}${preview ? ` <span class="wf-preview">${escapeHtml(preview)}</span>` : ""}`;
      return node;
    }
    case "finalReply": {
      // Distinct block. Markdown form when the CDN stack is present (innerHTML
      // with sanitized+hardened HTML only); textContent keeps the no-raw-HTML
      // guarantee when it is not.
      const node = document.createElement("div");
      node.className = markdownEnabled() ? "wf-reply wf-reply-md" : "wf-reply";
      if (markdownEnabled()) {
        node.innerHTML = renderMarkdown(ev.text);
      } else {
        node.textContent = String(ev.text ?? "");
      }
      return node;
    }
    case "runFinished": {
      const node = document.createElement("div");
      node.className = "wf-line wf-finished";
      const dur = fmtDuration(ev.durationMs);
      if (ev.ok === true) {
        node.innerHTML = `<span class="wf-mark-ok">✔</span> Terminé${dur ? ` en ${escapeHtml(dur)}` : ""}`;
      } else if (ev.error === "timeout") {
        node.innerHTML = `<span class="wf-mark-warn">⏱</span> Interrompu (timeout)`;
      } else {
        node.innerHTML = `<span class="wf-mark-err">✖</span> Échec${ev.error != null ? ` : ${escapeHtml(String(ev.error))}` : ""}`;
      }
      return node;
    }
    case "eventsLagged": {
      const node = document.createElement("div");
      node.className = "wf-line wf-lagged";
      const dropped = Number(ev.dropped);
      node.textContent = `⚠ ${Number.isFinite(dropped) ? dropped : 0} événements manqués (flux ralenti)`;
      return node;
    }
    default:
      return null; // unknown event type: ignore defensively
  }
}

/** Live (or just-finished) view header: ▶/✔ + kind label + started time.
 *  A running header also carries the « Arrêter » stop button — POST
 *  /api/agent/stop for the run in flight (same-origin deploys only:
 *  REMOTE_MODE never renders it, the static site never POSTs). The button is
 *  re-rendered with every wholesale live view; the click is handled by event
 *  delegation on the activity zone (bound once, see setupStatic). */
function wfHeaderHtml(finished) {
  const run = wf.run || {};
  const kind = escapeHtml(kindLabel(run.kind));
  const started = formatTimeSeconds(run.startedAt);
  const stopBtn = !finished && !REMOTE_MODE
    ? ` <button type="button" id="agent-run-stop" class="agent-run-btn wf-stop-btn" title="Demande l'arrêt de l'exécution de l'agent en cours">Arrêter</button>`
    : "";
  return (
    `<div class="wf-header ${finished ? "finished" : "running"}">` +
    `<span class="wf-mark">${finished ? "✔" : "▶"}</span> ` +
    `<span class="wf-title">${escapeHtml(finished ? "Exécution terminée" : "Exécution en cours")}</span>` +
    ` <span class="wf-kind">— ${kind}</span>` +
    (started ? `<span class="wf-starttime">· démarrée à ${escapeHtml(started)}</span>` : "") +
    stopBtn +
    `</div>`
  );
}

/** Renders the live view (header + all known events); wholesale replace path
 *  used by snapshots and the fallback poller (dedupe-safe). */
function renderLiveView(finished = false) {
  const zone = document.getElementById("agent-activity");
  if (!zone) return;
  wf.live = true;
  zone.innerHTML = `${wfHeaderHtml(finished)}<div class="wf-events"></div>`;
  const list = zone.querySelector(".wf-events");
  const ctx = { lastTurn: null };
  for (const ev of wf.events) {
    const node = buildEventNode(ev, ctx);
    if (node) list.appendChild(node);
  }
  wf.lastTurn = ctx.lastTurn;
}

/** Swaps only the live header to its finished variant — the event list keeps
 *  its DOM (open <details> previews survive). */
function markLiveHeaderFinished() {
  const header = document.querySelector("#agent-activity .wf-header");
  if (header) header.outerHTML = wfHeaderHtml(true);
}

/** Appends one event to the live view; passes wf itself as the turn context so
 *  appends share the same divider state as full renders. */
function appendEvent(ev) {
  const list = document.querySelector("#agent-activity .wf-events");
  if (!list) return;
  const node = buildEventNode(ev, wf);
  if (node) list.appendChild(node);
}

/** Idle view: collapsed details of the last run (or the no-run-ever note).
 *  The summary derives from the most recent runStart in the buffer. */
function renderIdleView(events) {
  const zone = document.getElementById("agent-activity");
  if (!zone) return;
  wf.live = false;
  clearCollapse();
  const list = Array.isArray(events) ? events.filter((ev) => ev && typeof ev === "object") : [];
  if (list.length === 0) {
    zone.innerHTML = `<p class="wf-empty">Aucune exécution enregistrée depuis le démarrage du serveur.</p>`;
    return;
  }
  let runStart = null;
  for (const ev of list) {
    if (ev.type === "runStart") runStart = ev;
  }
  const runId = runStart?.runId ?? (wf.run?.runId ?? null);
  const startedAt = runStart?.startedAt ?? (wf.run?.startedAt ?? null);
  const parts = [];
  if (runId != null && String(runId) !== "") parts.push(`#${String(runId)}`);
  if (timestampMs(startedAt) !== null) parts.push(formatTimestamp(startedAt));
  const title = parts.length
    ? `Dernière exécution (${escapeHtml(parts.join(" · "))})`
    : "Dernière exécution";
  const details = document.createElement("details");
  details.className = "wf-idle";
  details.innerHTML = `<summary>${title}</summary><div class="wf-events"></div>`;
  const eventsEl = details.querySelector(".wf-events");
  const ctx = { lastTurn: null };
  for (const ev of list) {
    const node = buildEventNode(ev, ctx);
    if (node) eventsEl.appendChild(node);
  }
  wf.lastTurn = ctx.lastTurn;
  zone.innerHTML = "";
  zone.appendChild(details);
}

function clearCollapse() {
  if (wf.collapseTimer) {
    clearTimeout(wf.collapseTimer);
    wf.collapseTimer = null;
  }
}

/** runFinished → keep the finished live view for a grace period, then collapse
 *  into the idle details (a new run starting meanwhile cancels the collapse). */
function scheduleCollapse() {
  clearCollapse();
  wf.collapseTimer = setTimeout(() => {
    wf.collapseTimer = null;
    // A new run may have taken over during the grace window — never collapse then
    if (!wf.live || wf.run?.running) return;
    renderIdleView(wf.events);
  }, WORKFLOW_COLLAPSE_MS);
}

/** Enters the live view for a run (fresh buffer) and ensures the stream. */
function startLiveRun(runMeta, events) {
  clearCollapse();
  wf.live = true;
  wf.run = runMeta && typeof runMeta === "object" ? { ...runMeta } : null;
  wf.events = Array.isArray(events) ? events.slice() : [];
  renderLiveView(false);
  stopPollFallback();
  startStream();
}

/** Opens the SSE stream exactly once (guard covers repeated runs and snapshot
 *  reconnects — the delivering EventSource is never restarted here). */
function startStream() {
  if (wf.es) return;
  if (typeof EventSource === "undefined") {
    startPollFallback(); // very old browser: poll instead
    return;
  }
  wf.errCount = 0;
  const es = new EventSource(apiUrl(WORKFLOW_STREAM_PATH)); // no credentials: GETs are open by design
  wf.es = es;
  es.onopen = () => {
    wf.errCount = 0; // successful (re)connection resets the failure streak
  };
  es.addEventListener("snapshot", (e) => {
    try {
      onSnapshot(JSON.parse(e.data));
    } catch {
      /* ignored frame */
    }
  });
  es.onmessage = (e) => {
    try {
      handleLiveEvent(JSON.parse(e.data));
    } catch {
      /* ignored frame */
    }
  };
  es.onerror = () => {
    wf.errCount += 1;
    // Persistent failure: close the stream and fall back to polling while the
    // run is going (bounded, see startPollFallback).
    if (wf.errCount >= WORKFLOW_ERR_LIMIT) {
      stopStream();
      startPollFallback();
    }
  };
}

function stopStream() {
  if (wf.es) {
    wf.es.close();
    wf.es = null;
  }
}

/** Applies a workflow snapshot (from the SSE 'snapshot' frame or from a
 *  refreshWorkflow fetch): live view when a run is running, idle view otherwise. */
function onSnapshot(snap) {
  if (!snap || typeof snap !== "object") return;
  if (snap.run && snap.run.running) {
    wf.errCount = 0;
    startLiveRun(snap.run, snap.events); // wholesale replace — dedupe-safe
    return;
  }
  // No active run: idle view from the buffered events; stop all consumption
  stopStream();
  stopPollFallback();
  renderIdleView(Array.isArray(snap.events) ? snap.events : []);
}

/** Live frames: runStart switches to the live view; the rest append; runFinished
 *  ends the consumption (stream closed, collapse scheduled). */
function handleLiveEvent(ev) {
  if (!ev || typeof ev.type !== "string") return;
  switch (ev.type) {
    case "runStart":
      startLiveRun({ ...ev, running: true }, []);
      return;
    case "toolCall":
    case "toolResult":
    case "finalReply":
    case "eventsLagged":
      wf.events.push(ev);
      appendEvent(ev);
      return;
    case "runFinished":
      wf.events.push(ev);
      appendEvent(ev);
      wf.run = wf.run ? { ...wf.run, running: false } : null;
      markLiveHeaderFinished();
      stopStream(); // the run is over — stop consuming the stream
      stopPollFallback();
      scheduleCollapse();
      return;
    default:
      return; // unknown event type: ignore
  }
}

/** SSE fallback: poll the workflow snapshot every 2 s while a run is running
 *  (bounded at 50 min). Each tick replaces the view wholesale (dedupe-safe). */
function startPollFallback() {
  stopPollFallback(); // single fallback at a time
  wf.pollStarted = Date.now();
  const token = wf.pollStarted;
  wf.pollToken = token;
  const tick = async () => {
    if (wf.pollToken !== token) return;
    try {
      const res = await fetch(apiUrl(WORKFLOW_PATH));
      if (res.ok) {
        const snap = await res.json();
        if (snap && snap.run && snap.run.running) {
          wf.run = snap.run;
          wf.events = Array.isArray(snap.events) ? snap.events : [];
          renderLiveView(false);
        } else {
          // Run gone / finished while the stream was out
          wf.run = null;
          wf.events = Array.isArray(snap?.events) ? snap.events : [];
          stopPollFallback();
          renderIdleView(wf.events);
          return;
        }
      }
    } catch {
      /* transient: keep polling until the bound */
    }
    if (Date.now() - wf.pollStarted > WORKFLOW_POLL_MAX_MS) {
      stopPollFallback(); // bound reached: leave the last known view on screen
      return;
    }
    wf.pollTimer = setTimeout(tick, WORKFLOW_POLL_MS);
  };
  tick();
}

function stopPollFallback() {
  wf.pollToken = null; // in-flight tick results are discarded via the token
  if (wf.pollTimer) {
    clearTimeout(wf.pollTimer);
    wf.pollTimer = null;
  }
}

/** Fetches the workflow snapshot and renders it. Used at bootstrap, right
 *  after a trigger (202), and when the status poller sees a run end. Gate:
 *  never fetches/shows for an unconfigured agent. */
async function refreshWorkflow() {
  if (!agentConfigured) return false;
  try {
    const res = await fetch(apiUrl(WORKFLOW_PATH));
    if (!res.ok) return false;
    const snap = await res.json();
    const zone = document.getElementById("agent-activity");
    if (zone) zone.hidden = false;
    onSnapshot(snap);
    return true;
  } catch {
    return false;
  }
}

/** Bootstrap: fetch the snapshot once; failure (503 / network) keeps the block
 *  hidden — same silent rule as the agent pill. */
async function initAgentActivity() {
  const zone = document.getElementById("agent-activity");
  if (!zone) return;
  const ok = await refreshWorkflow();
  if (!ok) zone.hidden = true;
}

/* ------------------------------ Écran de l'agent (browser screenshot) ------------------------------ */

/** Mutable screen-panel state; single owner of the EventSource and the
 *  fallback poller (same single-owner pattern as wf). Named `screenPanel`
 *  rather than `screen` to avoid shadowing the platform's window.screen. */
const screenPanel = {
  es: null,          // live SSE EventSource (null when closed)
  errCount: 0,       // consecutive SSE errors → poll fallback
  pollToken: null,   // generation token of the fallback poller (null = stopped)
  pollTimer: null,
  pollStarted: 0,    // fallback start instant (bounded by WORKFLOW_POLL_MAX_MS)
  readopted: false,  // poll→stream hand-back: tried at most once per fallback round
  lastRenderedTs: null, // raw ts of the last successfully rendered frame (fresh-capture gate)
};

/** French "03/11/2026 15:05:32" for the frame caption (seconds matter —
 *  captures land seconds apart, while formatTimestamp carries minutes only);
 *  null when absent/invalid. */
const SCREEN_TS_FMT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" });
function formatScreenTimestamp(iso) {
  const ms = timestampMs(iso);
  return ms === null ? null : SCREEN_TS_FMT.format(new Date(ms));
}

/** Read-only strip of the agent's open tabs, fed from the screen
 *  snapshot/stream `tabs` key: one chip per tab — « #N host » plus the
 *  truncated title — with the ACTIVE one highlighted. The capture and the
 *  screencast always come from the active tab, so the highlight moves as
 *  the agent switches: auto-follow is inherent, no click handlers by
 *  decision (switching stays the agent's privilege). Absent/empty key →
 *  the strip hides (older payload tolerance, no tabs open); per-chip
 *  malformed entries degrade silently (skipped, others still render). */
function renderScreenTabs(tabs) {
  const strip = document.getElementById("agent-screen-tabs");
  if (!strip) return;
  if (!Array.isArray(tabs) || tabs.length === 0) {
    strip.hidden = true;
    strip.innerHTML = "";
    return;
  }
  strip.hidden = false;
  strip.innerHTML = tabs.map((tab) => {
    if (!tab || typeof tab !== "object") return "";
    const id = typeof tab.id === "number" ? tab.id : null;
    const url = typeof tab.url === "string" ? tab.url : "";
    const title = typeof tab.title === "string" ? tab.title : "";
    // Chip label: #N + the URL host when parseable, else the plain url.
    let host = url;
    try {
      const parsed = new URL(url);
      if (parsed.hostname) host = parsed.hostname;
    } catch {
      /* opaque/empty url: keep the raw text */
    }
    const label = `#${id === null ? "?" : id} ${chatPreviewLine(host, 24)}`;
    const titleHtml = title
      ? ` <em>${escapeHtml(chatPreviewLine(title, 26))}</em>`
      : "";
    const tip = [title, url].filter(Boolean).join(" — ");
    const tipAttr = tip ? ` title="${escapeHtml(tip)}"` : "";
    const active = tab.active === true;
    return `<span role="listitem" class="screen-tab${active ? " active" : ""}"${tipAttr}>${escapeHtml(label)}${titleHtml}</span>`;
  }).filter(Boolean).join("");
}

/** Shows the status/placeholder line and hides image + caption — the degraded
 *  state (no capture yet, REMOTE_MODE or a persistent 503). */
function showScreenNote(text) {
  const note = document.getElementById("agent-screen-status");
  const img = document.getElementById("agent-screen-img");
  const caption = document.getElementById("agent-screen-caption");
  if (note) {
    note.textContent = text;
    note.hidden = false;
  }
  if (img) img.hidden = true;
  if (caption) caption.hidden = true;
}

/** One well-formed frame → view: image source + escaped caption (timestamp,
 *  title, url — empty parts omitted; url stays plain diagnostic text, no link)
 *  and the note line swaps to the capture. Unknown/invalid shapes are skipped
 *  defensively: the server retains the latest frame, so the last good view
 *  simply stays on screen. `opts.live` tells LIVE arrivals (unnamed SSE frame
 *  or poll-fallback tick) apart from the (re)connect snapshot — only live
 *  arrivals may auto-open the chat page's collapsed panel. */
function renderScreenFrame(frame, opts) {
  const img = document.getElementById("agent-screen-img");
  if (!img) return;
  if (!frame || typeof frame !== "object"
      || typeof frame.image !== "string" || !frame.image.startsWith("data:image/")) {
    return;
  }
  img.src = frame.image;
  img.hidden = false;
  // Click-to-zoom affordance: the lightbox opens from this thumbnail (mouse
  // click or Enter/Space once the img is a focusable pseudo-button).
  img.tabIndex = 0;
  img.setAttribute("role", "button");
  const title = typeof frame.title === "string" ? frame.title : "";
  const url = typeof frame.url === "string" ? frame.url : "";
  const ts = formatScreenTimestamp(frame.ts);
  // Caption: label line first, page title after it, url on its own line, the
  // zoom hint last — all dynamic values escaped (title/url are external page
  // data)
  let html = "";
  if (ts) html += `Capture : ${escapeHtml(ts)}`;
  if (title) html += `${html ? " — " : ""}${escapeHtml(title)}`;
  if (url) html += `<span class="agent-screen-url">${escapeHtml(url)}</span>`;
  html += `<span class="agent-screen-hint">Cliquer pour agrandir</span>`;
  const caption = document.getElementById("agent-screen-caption");
  if (caption) {
    caption.innerHTML = html;
    caption.hidden = !html;
  }
  const note = document.getElementById("agent-screen-status");
  if (note) note.hidden = true; // a displayed capture replaces the placeholder

  // Auto-open on genuinely NEW live captures (chat page's collapsible panel):
  // only a LIVE arrival (opts.live) whose ts differs from the last rendered
  // frame's re-opens a collapsed panel — the connect snapshot never auto-opens
  // (an old capture from a previous run is not "new") and an identical ts
  // (repeated poll ticks without a fresh capture) cannot re-open a manually
  // collapsed one. Only successful renders move the tracker: skipped and
  // invalid shapes returned above. The wrapper is absent on the /agent page —
  // null-guarded no-op there.
  const fresh = frame.ts !== screenPanel.lastRenderedTs;
  screenPanel.lastRenderedTs = frame.ts;
  if (opts && opts.live && fresh) {
    const wrap = document.getElementById("agent-screen-wrap");
    if (wrap && !wrap.open) wrap.open = true;
  }
  // Takeover: pin the pending drag-start marker back onto the same frame
  // coordinates after a fresh capture replaced the displayed image.
  repositionTakeoverMarker();
}

/** One unnamed stream frame: a combined {frame, tabs} payload per capture
 *  (or tabs-only refresh). The lagged marker and any unknown shape are
 *  skipped defensively (like the workflow renderer) — the next capture
 *  re-syncs the view. The frame may be `null` on tabs-only refreshes: the
 *  strip updates, the retained view stays. */
function onScreenFrameMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "eventsLagged") return;
  renderScreenFrame(msg.frame, { live: true }); // unnamed SSE frame = live capture
  renderScreenTabs(msg.tabs);
}

/** Opens the SSE stream exactly once (single-owner guard, mirrored from
 *  startStream): named snapshot event → frame-or-null render; unnamed events →
 *  one frame per capture; persistent errors → poll fallback. */
function startScreenStream() {
  if (screenPanel.es) return;
  if (typeof EventSource === "undefined") {
    startScreenPollFallback(); // very old browser: poll instead
    return;
  }
  screenPanel.errCount = 0;
  const es = new EventSource(apiUrl(SCREEN_STREAM_PATH)); // GET-only, no credentials involved
  screenPanel.es = es;
  es.onopen = () => {
    screenPanel.errCount = 0; // successful (re)connection resets the failure streak
  };
  es.addEventListener("snapshot", (e) => {
    try {
      const snap = JSON.parse(e.data);
      // (Re)connect snapshot, never a live arrival → never auto-opens
      if (snap && typeof snap === "object") {
        renderScreenFrame(snap.frame, { live: false });
        renderScreenTabs(snap.tabs);
      }
    } catch {
      /* ignored frame */
    }
  });
  es.onmessage = (e) => {
    try {
      onScreenFrameMessage(JSON.parse(e.data));
    } catch {
      /* ignored frame */
    }
  };
  es.onerror = () => {
    screenPanel.errCount += 1;
    // Persistent failure: close the stream and fall back to polling (bounded,
    // see startScreenPollFallback) — mirrors the workflow fallback lifecycle.
    if (screenPanel.errCount >= WORKFLOW_ERR_LIMIT) {
      stopScreenStream();
      startScreenPollFallback();
    }
  };
}

function stopScreenStream() {
  if (screenPanel.es) {
    screenPanel.es.close();
    screenPanel.es = null;
  }
}

function stopScreenPollFallback() {
  screenPanel.pollToken = null; // in-flight tick results are discarded via the token
  if (screenPanel.pollTimer) {
    clearTimeout(screenPanel.pollTimer);
    screenPanel.pollTimer = null;
  }
}

/** SSE fallback: poll the snapshot endpoint at the workflow fallback cadence
 *  (same 2 s tick, same 50 min bound). Screenshot frames can arrive at any
 *  later time (unlike a workflow run), so one hand-back to the stream is
 *  attempted on the first healthy reply — a still-broken stream re-enters the
 *  fallback after WORKFLOW_ERR_LIMIT errors and then keeps polling (no
 *  reconnect spam). Without any EventSource support the hand-back never
 *  happens: the poll simply runs its full bound. A 503 means the agent got
 *  unconfigured mid-session: a stable server state → degraded note, polling
 *  stops. */
function startScreenPollFallback() {
  stopScreenPollFallback(); // single fallback at a time
  screenPanel.pollStarted = Date.now();
  screenPanel.readopted = false;
  const token = screenPanel.pollStarted;
  screenPanel.pollToken = token;
  const tick = async () => {
    if (screenPanel.pollToken !== token) return;
    try {
      const res = await fetch(apiUrl(SCREEN_PATH));
      if (res.ok) {
        const snap = await res.json();
        // Poll tick = live arrival (may auto-open); identical-ts repeats of
        // the same capture stay silent via the tracker inside renderScreenFrame
        if (snap && typeof snap === "object") {
          renderScreenFrame(snap.frame, { live: true });
          renderScreenTabs(snap.tabs);
        }
        if (!screenPanel.readopted && typeof EventSource !== "undefined") {
          // First healthy reply: hand consumption back to the stream. Only
          // when EventSource exists at all — without it the stream can never
          // start and the hand-back would re-enter this fallback instantly
          // (runaway fetch loop); the poll keeps its cadence and bound.
          screenPanel.readopted = true;
          stopScreenPollFallback();
          startScreenStream();
          return;
        }
      } else if (res.status === 503) {
        stopScreenPollFallback();
        showScreenNote("Écran de l'agent indisponible — agent non configuré.");
        return;
      }
    } catch {
      /* transient: keep polling until the bound */
    }
    if (Date.now() - screenPanel.pollStarted > WORKFLOW_POLL_MAX_MS) {
      stopScreenPollFallback(); // bound reached: leave the last known view on screen
      return;
    }
    screenPanel.pollTimer = setTimeout(tick, WORKFLOW_POLL_MS);
  };
  tick();
}

/** Bootstrap (same gate as #agent-activity — see init): unhide the panel, show
 *  the placeholder, then open the stream (its snapshot frame carries the last
 *  capture). REMOTE_MODE short-circuits FIRST: the screenshot endpoints are
 *  same-origin only by design (no CORS header, no auth token client-side), so
 *  a static deploy degrades to a note and never connects. */
function initAgentScreen() {
  const block = document.getElementById("agent-screen");
  if (!block) return;
  // Static deploy of a live, configured API: explain why no stream is possible
  // here. Every other unconfigured case keeps the panel hidden (same rule as
  // the workflow block).
  if (REMOTE_MODE) {
    if (agentConfigured) {
      block.hidden = false;
      showScreenNote("Écran de l'agent : disponible uniquement sur le serveur dynamique (VPS).");
    }
    return;
  }
  if (!agentConfigured) return;
  block.hidden = false;
  showScreenNote("Aucune capture pour le moment — l'agent n'a pas encore navigué.");
  bindScreenLightbox();
  startScreenStream();
  initAgentTakeover(); // « Prendre la main » over the viewer (same-origin only)
}

/* -------- Screen lightbox (click-to-zoom of the agent screen viewer) -------- */

/** Shared by the /agent panel and the /chat <details> panel (the same
 *  #agent-screen-img): clicking a DISPLAYED frame opens a full-screen overlay
 *  with the current frame at native size (object-fit: contain), the panel
 *  caption reused in the footer and a × close. Closes on Escape, a backdrop
 *  click and the × button. Purely presentational: the overlay DOM is created
 *  lazily once (no chat/agent.html change needed), its payload is reset on
 *  close. */

/** Lazily created overlay root (null until the first open). */
let screenLightbox = null;

/** Thumbnail to restore focus to on close (kept across the open session). */
let screenLightboxReturnFocus = null;

/** Builds the overlay once and keeps it hidden; returns the root. */
function ensureScreenLightbox() {
  if (screenLightbox) return screenLightbox;
  const overlay = document.createElement("div");
  overlay.className = "screen-lightbox";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Capture d'écran agrandie");
  overlay.innerHTML =
    '<div class="screen-lightbox-backdrop"></div>' +
    '<figure class="screen-lightbox-figure">' +
    '<img class="screen-lightbox-img" alt="Capture d\'écran du navigateur de l\'agent en taille réelle">' +
    '<figcaption class="screen-lightbox-caption"></figcaption>' +
    '</figure>' +
    '<button type="button" class="screen-lightbox-close" aria-label="Fermer">✕</button>';
  document.body.appendChild(overlay);
  overlay.querySelector(".screen-lightbox-backdrop").addEventListener("click", closeScreenLightbox);
  overlay.querySelector(".screen-lightbox-close").addEventListener("click", closeScreenLightbox);
  screenLightbox = overlay;
  return overlay;
}

/** Escape closes the overlay; the listener lives only while it is open. */
function onScreenLightboxKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeScreenLightbox();
  }
}

/** Opens the overlay with the CURRENT panel frame — a no-op when the panel
 *  shows no frame (thumbnail hidden / no payload) or when the takeover is
 *  ACTIVE (frame clicks drive the agent's browser instead of zooming; the
 *  Enter/Space pseudo-button path is covered by the same guard). The panel
 *  caption is reused in the footer (minus the zoom hint). Focus moves to the
 *  close button and returns to the opening thumbnail on close. */
function openScreenLightbox() {
  const img = document.getElementById("agent-screen-img");
  if (takeover.active) return;
  if (!img || img.hidden || !img.src || !img.src.startsWith("data:image/")) return;
  const overlay = ensureScreenLightbox();
  const view = overlay.querySelector(".screen-lightbox-img");
  view.src = img.src;
  // Caption copy: strip the « Cliquer pour agrandir » hint (nonsensical in
  // the zoom view); the html was built escaped by this same code path.
  const caption = document.getElementById("agent-screen-caption");
  let captionHtml = "";
  if (caption && !caption.hidden) {
    const clone = caption.cloneNode(true);
    clone.querySelectorAll(".agent-screen-hint").forEach((el) => el.remove());
    captionHtml = clone.innerHTML;
  }
  overlay.querySelector(".screen-lightbox-caption").innerHTML = captionHtml;
  screenLightboxReturnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : img;
  overlay.hidden = false;
  // Scroll lock while the overlay is up (same pattern as html.nav-open)
  document.documentElement.classList.add("screen-lightbox-open");
  document.addEventListener("keydown", onScreenLightboxKeydown);
  overlay.querySelector(".screen-lightbox-close").focus();
}

/** Closes the overlay and clears its payload (a stale frame must not flash
 *  on a later open), then restores the focus. */
function closeScreenLightbox() {
  if (!screenLightbox || screenLightbox.hidden) return;
  screenLightbox.hidden = true;
  document.documentElement.classList.remove("screen-lightbox-open");
  const view = screenLightbox.querySelector(".screen-lightbox-img");
  if (view) view.removeAttribute("src");
  const caption = screenLightbox.querySelector(".screen-lightbox-caption");
  if (caption) caption.innerHTML = "";
  document.removeEventListener("keydown", onScreenLightboxKeydown);
  const back = screenLightboxReturnFocus;
  if (back && document.contains(back)) back.focus();
  screenLightboxReturnFocus = null;
}

/** One-time bindings on the shared thumbnail: click opens, Enter/Space on the
 *  focused pseudo-button too (mirroring a native button). */
function bindScreenLightbox() {
  const img = document.getElementById("agent-screen-img");
  if (!img || img.dataset.lightboxBound) return;
  img.dataset.lightboxBound = "1";
  img.addEventListener("click", openScreenLightbox);
  img.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openScreenLightbox();
    }
  });
}

/* -------- Prise en main (operator takeover over the shared viewer) -------- */

/** One input at a time to the agent's browser through
 *  POST /api/agent/browser/input (goto / click / drag / type / key). The
 *  viewer frame is the mapping surface: its NATURAL size is the page
 *  content area, so a displayed pixel IS a viewport CSS pixel — the server
 *  guarantees that 1:1 (see AGENTS.md, browser screen capture). Active only
 *  same-origin (initAgentTakeover runs from initAgentScreen, which never
 *  connects on a static deploy); a run-active server refuses every input
 *  with 409, surfaced as a status line. */
const takeover = {
  active: false,    // « Prendre la main » engaged (frame clicks are inputs)
  dragStart: null,  // pending drag start, in frame-space pixels {x, y}
};

function takeoverToggle() {
  return document.getElementById("agent-takeover-toggle");
}

function setTakeoverStatus(text) {
  const el = document.getElementById("agent-takeover-status");
  if (el) el.textContent = text;
}

/** One-time bindings + toggle reveal; runs ONLY on same-origin, configured
 *  deploys (initAgentScreen short-circuits in REMOTE_MODE / unconfigured
 *  before calling this). Both pages share the exact ids. */
function initAgentTakeover() {
  const block = document.getElementById("agent-screen");
  const toggle = takeoverToggle();
  if (!block || !toggle || block.dataset.takeoverBound) return;
  block.dataset.takeoverBound = "1";
  const wrap = document.getElementById("agent-takeover");
  if (wrap) wrap.hidden = false;
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    if (takeover.active) exitAgentTakeover();
    else enterAgentTakeover();
  });
  const img = document.getElementById("agent-screen-img");
  if (img) img.addEventListener("click", onTakeoverFrameClick);
  const go = document.getElementById("agent-takeover-go");
  if (go) go.addEventListener("click", sendTakeoverGoto);
  const typeBtn = document.getElementById("agent-takeover-type");
  if (typeBtn) typeBtn.addEventListener("click", sendTakeoverType);
  document
    .querySelectorAll("#agent-screen [data-takeover-key]")
    .forEach((btn) => {
      btn.addEventListener("click", () =>
        sendTakeoverInput({ kind: "key", key: btn.dataset.takeoverKey }),
      );
    });
}

function enterAgentTakeover() {
  const controls = document.getElementById("agent-takeover-controls");
  const img = document.getElementById("agent-screen-img");
  const toggle = takeoverToggle();
  takeover.active = true;
  if (toggle) {
    toggle.textContent = "Rendre la main";
    toggle.setAttribute("aria-pressed", "true");
  }
  if (controls) controls.hidden = false;
  if (img) img.classList.add("agent-screen-takeover");
  setTakeoverStatus(
    "Clic : cliquer à cet endroit. Maj+clic : premier point d'un glisser, puis clic à l'arrivée.",
  );
  const first = document.getElementById("agent-takeover-url");
  if (first) first.focus();
}

/** Disengage everything: controls, pending drag marker, cursor, wording. */
function exitAgentTakeover() {
  const controls = document.getElementById("agent-takeover-controls");
  const img = document.getElementById("agent-screen-img");
  const toggle = takeoverToggle();
  takeover.active = false;
  takeover.dragStart = null;
  hideTakeoverMarker();
  if (toggle) {
    toggle.textContent = "Prendre la main";
    toggle.setAttribute("aria-pressed", "false");
  }
  if (controls) controls.hidden = true;
  if (img) img.classList.remove("agent-screen-takeover");
  setTakeoverStatus("");
}

/** displayed click → frame-space pixel: read the frame's NATURAL size (not
 *  the CSS size) so the mapping stays exact at any displayed scale; tiny
 *  misses clamp to the frame bounds instead of a confusing dead zone. */
function framePixel(img, event) {
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) return null;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = Math.round(((event.clientX - rect.left) * naturalW) / rect.width);
  const y = Math.round(((event.clientY - rect.top) * naturalH) / rect.height);
  return {
    x: Math.min(naturalW - 1, Math.max(0, x)),
    y: Math.min(naturalH - 1, Math.max(0, y)),
  };
}

/** Frame click routing (one listener, gated on the active flag — inactive
 *  clicks keep opening the lightbox). Plain click = immediate click; a
 *  pending drag start turns the next plain click into the drag end;
 *  Shift+click (re)moves the start point. */
function onTakeoverFrameClick(event) {
  if (!takeover.active) return; // inactive: the lightbox handler takes it
  event.preventDefault();
  const img = event.currentTarget;
  const at = framePixel(img, event);
  if (!at) return;
  if (event.shiftKey) {
    takeover.dragStart = at;
    showTakeoverMarker(at);
    setTakeoverStatus(
      `Départ du glisser : (${at.x}, ${at.y}) — cliquez à l'arrivée.`,
    );
  } else if (takeover.dragStart) {
    const start = takeover.dragStart;
    takeover.dragStart = null;
    hideTakeoverMarker();
    sendTakeoverInput({
      kind: "drag",
      x1: start.x,
      y1: start.y,
      x2: at.x,
      y2: at.y,
    });
  } else {
    sendTakeoverInput({ kind: "click", x: at.x, y: at.y });
  }
}

/* Pending drag-start marker: an absolutely positioned dot inside
   #agent-screen (position:relative via CSS), placed relative to the img's
   box so it follows the displayed size, not the frame size. */

function ensureTakeoverMarker() {
  let marker = document.getElementById("agent-takeover-marker");
  if (!marker) {
    marker = document.createElement("div");
    marker.id = "agent-takeover-marker";
    marker.hidden = true;
    const block = document.getElementById("agent-screen");
    if (block) block.appendChild(marker);
  }
  return marker;
}

function showTakeoverMarker(at) {
  const marker = ensureTakeoverMarker();
  const img = document.getElementById("agent-screen-img");
  if (!img || !img.naturalWidth || !img.naturalHeight) return marker;
  const scaleX = img.offsetWidth / img.naturalWidth;
  const scaleY = img.offsetHeight / img.naturalHeight;
  // offsetLeft/offsetTop are relative to the .agent-screen block (its
  // position:relative makes it the offsetParent).
  marker.style.left = `${img.offsetLeft + at.x * scaleX}px`;
  marker.style.top = `${img.offsetTop + at.y * scaleY}px`;
  marker.hidden = false;
  return marker;
}

function hideTakeoverMarker() {
  const marker = document.getElementById("agent-takeover-marker");
  if (marker) marker.hidden = true;
}

/** Fresh captures replace the displayed image: keep the pending drag start
 *  pinned to the SAME frame coordinates (called from renderScreenFrame). */
function repositionTakeoverMarker() {
  if (!takeover.active || !takeover.dragStart) return;
  showTakeoverMarker(takeover.dragStart);
}

/* Takeover controls + POST plumbing. */

function sendTakeoverGoto() {
  const field = document.getElementById("agent-takeover-url");
  if (!field) return;
  const url = field.value.trim();
  if (!url) {
    setTakeoverStatus("Entrez une URL d'abord.");
    field.focus();
    return;
  }
  sendTakeoverInput({ kind: "goto", url });
}

function sendTakeoverType() {
  const field = document.getElementById("agent-takeover-text");
  if (!field) return;
  // Raw value on purpose: leading/trailing spaces are meaningful input.
  const text = field.value;
  if (!text) {
    setTakeoverStatus("Entrez un texte d'abord.");
    field.focus();
    return;
  }
  sendTakeoverInput({ kind: "type", text });
}

/** One POST /api/agent/browser/input + its French status lines (409 /
 *  400 / 401 / 503 / network), then nothing more: a succeeding frame
 *  refresh and capture arrive through the screen SSE stream naturally. */
async function sendTakeoverInput(payload) {
  setTakeoverStatus("Envoi…");
  let res;
  try {
    res = await fetch(apiUrl(SCREEN_INPUT_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    setTakeoverStatus("Serveur injoignable (prise en main refusée).");
    return;
  }
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    switch (payload.kind) {
      case "goto": {
        const url = data && typeof data.url === "string" ? data.url : "";
        setTakeoverStatus(url ? `Page ouverte : ${url}` : "Navigation envoyée.");
        break;
      }
      case "click":
        setTakeoverStatus(`Clic envoyé (${payload.x}, ${payload.y}).`);
        break;
      case "drag":
        setTakeoverStatus(
          `Glisser envoyé : (${payload.x1}, ${payload.y1}) → (${payload.x2}, ${payload.y2}).`,
        );
        break;
      case "type":
        setTakeoverStatus("Texte saisi.");
        break;
      case "key":
        setTakeoverStatus("Touche envoyée.");
        break;
      default:
        setTakeoverStatus("Saisie envoyée.");
    }
    return;
  }
  if (res.status === 409) {
    setTakeoverStatus("Run actif — reprends après la fin du run.");
  } else if (res.status === 503) {
    setTakeoverStatus("Navigateur indisponible — agent non configuré.");
  } else if (res.status === 401) {
    setTakeoverStatus("Autorisation refusée (jeton requis).");
  } else {
    const data = await res.json().catch(() => ({}));
    const detail =
      data && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    setTakeoverStatus(`Échec de la saisie (${res.status}) : ${detail}`);
  }
}

/* ------------------------------ Agent status pill ------------------------------ */

/** Small header pill: last/next automatic update, orange on error, grey when
 *  unconfigured, pulsing while running. Never renders on status failure. */
function renderAgentPill(status) {
  const pill = document.getElementById("agent-pill");
  if (!pill) return false;
  if (!status || !status.agent) {
    pill.hidden = true;
    return false;
  }
  agentConfigured = Boolean(status.agent.configured);
  const agent = status.agent;
  pill.hidden = false;
  pill.className = "agent-pill";
  pill.removeAttribute("title");

  if (!agent.configured) {
    pill.classList.add("idle");
    pill.innerHTML = `<span class="pill-dot"></span>Agent : non configuré`;
  } else {
    const lastMs = agent.lastRunAt ? timestampMs(agent.lastRunAt) : null;
    const nextMs = agent.nextRunAt ? timestampMs(agent.nextRunAt) : null;
    // lastRunAt is in the past (sign −1), nextRunAt in the future (sign +1)
    const parts = [];
    if (lastMs !== null) parts.push(`dernière ${relativeTimestamp(Date.now() - lastMs, -1)}`);
    if (nextMs !== null) parts.push(`prochaine ${relativeTimestamp(nextMs - Date.now(), +1)}`);

    if (agent.running) {
      pill.classList.add("run");
      pill.innerHTML = `<span class="pill-dot"></span>Exécution en cours…`;
    } else {
      const errored =
        agent.lastRunOutcome === "error" ||
        agent.lastRunOutcome === "timeout" ||
        agent.lastRunOutcome === "stopped";
      if (errored) pill.classList.add("err");
      if (errored && agent.lastRunSummary) {
        pill.setAttribute("title", agent.lastRunSummary);
        pill.setAttribute("aria-label", "Statut de la mise à jour automatique : " + agent.lastRunSummary);
      }
      pill.innerHTML = `<span class="pill-dot"></span>${escapeHtml(`Mise à jour auto : ${parts.length > 0 ? parts.join(" · ") : "en attente"}`)}`;
      if (!errored) pill.classList.add("ok");
    }
    if (agent.chromiumFound === false) {
      pill.appendChild(Object.assign(document.createElement("span"), {
        className: "pill-warn",
        textContent: "⚠",
        title: "Navigateur Chromium introuvable — outils de navigation désactivés",
      }));
    }
  }
  return true;
}

/** Fetch /api/status once; on failure the pill simply stays hidden (no error
 *  box). The run button is re-evaluated from the last known status so a failed
 *  fetch never leaves it stuck disabled mid-run outside the poller. */
async function loadAgentStatus() {
  try {
    const res = await fetch(apiUrl("/api/status"));
    if (!res.ok) {
      markApiUnavailable();
      renderAgentPill(null);
      updateRunButtonVisibility(lastAgentStatus);
      renderScheduleEditor(lastAgentStatus);
      renderBrowserClearBlock(lastAgentStatus);
      syncHistoryVisibility();
      return null;
    }
    const status = await res.json();
    lastAgentStatus = status;
    renderAgentPill(status);
    updateRunButtonVisibility(status);
    renderScheduleEditor(status);
    renderBrowserClearBlock(status);
    syncHistoryVisibility();
    return status;
  } catch {
    markApiUnavailable(); // network error: treat the API as unreachable
    renderAgentPill(null);
    updateRunButtonVisibility(lastAgentStatus);
    renderScheduleEditor(lastAgentStatus);
    renderBrowserClearBlock(lastAgentStatus);
    syncHistoryVisibility();
    return null;
  }
}

/** "Lancer la mise à jour": visible only when the agent is configured. On a
 *  static deploy (REMOTE_MODE) the trigger is never shown at all — the site
 *  carries no auth token, updates are launched VPS-side (scheduler / curl). */
function updateRunButtonVisibility(status) {
  const btn = document.getElementById("agent-update-btn");
  if (!btn) return;
  if (REMOTE_MODE) {
    btn.hidden = true;
    return;
  }
  if (status && status.agent && status.agent.configured) {
    btn.hidden = false;
    btn.disabled = Boolean(status.agent.running);
    btn.textContent = status.agent.running ? "Exécution en cours…" : "Lancer la mise à jour";
  } else {
    btn.hidden = true;
  }
}

function showAgentMessage(msg) {
  const el = document.getElementById("agent-msg");
  if (el) el.textContent = msg;
}

/** POST /api/agent/update → 202 {runId} (then poll), 409/503 → inline French message. */
async function triggerAgentUpdate() {
  const btn = document.getElementById("agent-update-btn");
  if (btn) btn.disabled = true;
  showAgentMessage("");
  try {
    const res = await fetch(apiUrl("/api/agent/update"), { method: "POST" });
    if (res.status === 202) {
      if (btn) btn.textContent = "Exécution en cours…";
      renderPollingPill();
      showAgentMessage("Mise à jour lancée.");
      pollAgentStatus();
      void refreshWorkflow(); // open the live activity view for the new run
      return;
    }
    if (res.status === 409) {
      showAgentMessage("Une mise à jour est déjà en cours.");
    } else if (res.status === 503) {
      showAgentMessage("Agent indisponible pour le moment.");
    } else {
      showAgentMessage(`Échec du lancement (code HTTP ${res.status}).`);
    }
  } catch {
    showAgentMessage("Serveur injoignable — mise à jour non lancée.");
  }
  if (btn) btn.disabled = false; // only reached on failure: 202 keeps it disabled while polling
}

/** « Arrêter » (workflow panel of the /agent page): POST /api/agent/stop for
 *  the run shown in the live header — same POST and status lines as the
 *  chat-page stop, surfaced in the section header's inline message. Only
 *  reachable on same-origin deploys (the button is not rendered under
 *  REMOTE_MODE; the delegation binding is agent-page-only too). */
async function stopAgentRun() {
  showAgentMessage("");
  try {
    const res = await fetch(apiUrl(AGENT_STOP_PATH), { method: "POST" });
    if (res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* malformed body: fall through to the "déjà terminée" reading */
      }
      showAgentMessage(
        body && body.stopped
          ? "Arrêt demandé — l'exécution va s'interrompre."
          : "L'exécution s'est déjà terminée.",
      );
      return;
    }
    if (res.status === 401) {
      showAgentMessage("Accès refusé — l'arrêt exige le jeton d'authentification du serveur.");
    } else {
      showAgentMessage(`Échec de l'arrêt (code HTTP ${res.status}).`);
    }
  } catch {
    showAgentMessage("Serveur injoignable — arrêt non envoyé.");
  }
}

/** Optimistic pill state between the 202 and the first poll. */
function renderPollingPill() {
  const pill = document.getElementById("agent-pill");
  if (!pill) return;
  pill.hidden = false;
  pill.className = "agent-pill run";
  pill.removeAttribute("title");
  pill.innerHTML = `<span class="pill-dot"></span>Exécution en cours…`;
}

/** Poll /api/status while the agent runs (≤ AGENT_POLL_MAX_MS); afterwards
 *  reload /api/data + /api/history and refresh the pill.
 *
 *  Control flow rules:
 *  - Only an explicit `running === false` from a well-formed status ends the
 *    loop (run finished). A non-OK reply, a network error or a malformed
 *    payload keeps the loop going: the run may still be going server-side.
 *  - On such failures the pill and button keep their last known state (run
 *    state) instead of flickering to hidden. */
function pollAgentStatus() {
  const started = Date.now();
  pollAgentStatus.active = started; // token: a newer poll supersedes this one
  const tick = async () => {
    if (pollAgentStatus.active !== started) return;
    try {
      const res = await fetch(apiUrl("/api/status"));
      if (res.ok) {
        const status = await res.json();
        // A well-formed payload only: anything else is transient — the pill,
        // button and running state keep their last known values.
        if (status && status.agent) {
          lastAgentStatus = status;
          renderAgentPill(status);
          updateRunButtonVisibility(status);
          renderScheduleEditor(status);
          renderBrowserClearBlock(status);
          if (status.agent.running === false) {
            // Run confirmed finished by the server: refresh what it can change
            await refreshData();
            await loadHistory();
            await refreshWorkflow(); // sync the activity block once with the end state
            return;
          }
        }
      }
    } catch {
      // network error or non-JSON body: keep polling until the deadline
    }
    if (Date.now() - started > AGENT_POLL_MAX_MS) {
      // Sane state at the deadline: one last status fetch (freshest pill and
      // history), then re-enable the button so the user can retry — a retry
      // POST is safe because the server answers 409 while a run is still live.
      await loadAgentStatus();
      if (lastAgentStatus?.agent && lastAgentStatus.agent.running === false) {
        // Confirmed finished after all: plain confirmation, data refresh below
        showAgentMessage("Mise à jour terminée.");
        await refreshData();
        await loadHistory();
        await refreshWorkflow(); // sync the activity block once with the end state
      } else {
        showAgentMessage("L'exécution prend plus de temps que prévu — rechargez la page pour voir le résultat.");
      }
      const btn = document.getElementById("agent-update-btn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Lancer la mise à jour";
      }
      return;
    }
    setTimeout(tick, AGENT_POLL_MS);
  };
  setTimeout(tick, AGENT_POLL_MS);
}

/* ------------------------------ Planification (weekday schedule editor) ------------------------------ */

/** Last server-side schedule rendered into the editor (normalized shape —
 *  see normalizeSchedule): the baseline of the unsaved-edit pin. A status
 *  poll re-rendering the SAME values must not wipe edits mid-selection (the
 *  poller re-evaluates this every 5 s while a run is going); a genuinely
 *  CHANGED server schedule (a save landing, an operator CLI flag, another
 *  tab) releases the pin. null = nothing rendered yet / baseline reset. */
let scheduleRendered = null;

/** Normalizes a raw agent.schedule to the editor's selection shape
 *  ({disabled: bool, days: [chip codes], time: "HH:MM"}) — days intersected
 *  with the real chips (an unknown tag could never be represented in the DOM
 *  and would stick the pin forever) — or null when the payload is not
 *  renderable (absent object, bad time format): the block then stays hidden,
 *  no schedule value is ever invented client-side. */
function normalizeSchedule(block, schedule) {
  if (!schedule || typeof schedule !== "object" || !Array.isArray(schedule.days)) return null;
  if (typeof schedule.time !== "string" || !/^\d{2}:\d{2}$/.test(schedule.time)) return null;
  const wanted = new Set(schedule.days.filter((d) => typeof d === "string"));
  const days = [...block.querySelectorAll(".schedule-chip[data-day]")]
    .filter((chip) => wanted.has(chip.dataset.day))
    .map((chip) => chip.dataset.day);
  return { disabled: schedule.disabled === true, days, time: schedule.time };
}

/** Value equality of two normalized schedules (days compared as a set — the
 *  DOM order is fixed, but the comparison must not depend on it). */
function schedulesEqual(a, b) {
  if (!a || !b) return false;
  if (a.disabled !== b.disabled || a.time !== b.time) return false;
  if (a.days.length !== b.days.length) return false;
  const set = new Set(b.days);
  return a.days.every((d) => set.has(d));
}

/** Renders the schedule editor from a /api/status payload — same call sites
 *  and REMOTE_MODE rule as updateRunButtonVisibility. Visible only same-origin,
 *  for a configured agent AND with well-formed agent.schedule data (an older
 *  server keeps the block hidden; the current values always come from
 *  /api/status, never invented client-side). Overwrite rules: server truth is
 *  written whenever it differs from the last-rendered baseline, or when the
 *  editor already matches it; an identical re-render (poll noise) is skipped
 *  while the editor holds UNSAVED EDITS. A completed save releases everything
 *  by value: success → the fresh /api/status differs from the baseline (or the
 *  selection already equals it) → the saved state re-renders; failure → no pin
 *  state is created, the refused selection stays until the user or the server
 *  changes it. */
function renderScheduleEditor(status) {
  const block = document.getElementById("schedule-block");
  if (!block) return;
  if (REMOTE_MODE) {
    // Static deploy: the site never POSTs (no auth token) — never shows
    block.hidden = true;
    scheduleRendered = null;
    return;
  }
  const server = status?.agent?.configured ? normalizeSchedule(block, status.agent.schedule) : null;
  // Malformed/absent schedule = feature not available server-side → stay hidden
  if (!server) {
    block.hidden = true;
    scheduleRendered = null;
    return;
  }
  // A save in flight pins the editor: a status poll tick must not clobber the
  // selection the POST is about to carry (the save re-enables on every path)
  const save = document.getElementById("schedule-save");
  if (save && save.disabled) return;
  // Unsaved-edit pin: identical server values must not wipe in-progress edits;
  // a server-side change releases it (stale-pin guard)
  const unchanged = schedulesEqual(scheduleRendered, server);
  if (unchanged && !schedulesEqual(scheduleSelection(), server)) return;
  block.hidden = false;
  if (save) save.hidden = false; // revealed with the block (ships hidden)
  const wanted = new Set(server.days);
  for (const chip of block.querySelectorAll(".schedule-chip[data-day]")) {
    chip.setAttribute("aria-pressed", wanted.has(chip.dataset.day) ? "true" : "false");
  }
  const time = document.getElementById("schedule-time");
  if (time) time.value = server.time;
  const disable = document.getElementById("schedule-disable");
  if (disable) {
    disable.checked = server.disabled;
    applyScheduleDisabledState();
  }
  scheduleRendered = server;
}

/** Presentation-only rule of the « Désactiver la planification » checkbox: the
 *  days chips + time input lose interactivity and dim. The underlying selection
 *  is kept — the save POSTs it unambiguously alongside disabled:true. */
function applyScheduleDisabledState() {
  const block = document.getElementById("schedule-block");
  const disable = document.getElementById("schedule-disable");
  if (!block || !disable) return;
  for (const chip of block.querySelectorAll(".schedule-chip[data-day]")) {
    chip.disabled = disable.checked;
  }
  const time = document.getElementById("schedule-time");
  if (time) time.disabled = disable.checked;
}

/** Current editor selection as the POST payload: {disabled, days, time} — the
 *  FULL set, not a partial one, so the saved intent is unambiguous. */
function scheduleSelection() {
  const block = document.getElementById("schedule-block");
  const disable = document.getElementById("schedule-disable");
  const time = document.getElementById("schedule-time");
  return {
    disabled: Boolean(disable?.checked),
    days: block
      ? [...block.querySelectorAll('.schedule-chip[data-day][aria-pressed="true"]')].map((c) => c.dataset.day)
      : [],
    time: typeof time?.value === "string" ? time.value : "",
  };
}

function showScheduleMsg(msg) {
  const el = document.getElementById("schedule-msg");
  if (el) el.textContent = msg;
}

/** « Enregistrer »: client-side mirror of the server's 400 rules first (one
 *  day minimum while enabled, always a well-formed HH:MM time — no POST for a
 *  selection the server would refuse), then the full selection through the
 *  same fetch pattern as the « Lancer la mise à jour » trigger (apiUrl + plain
 *  POST, no Authorization header; same-origin deploys only). On success the
 *  agent status re-refreshes so the pill nextRunAt + editor re-render from the
 *  saved state; on failure an inline French message keeps the selection. */
async function saveSchedule() {
  const sel = scheduleSelection();
  if (!sel.disabled && sel.days.length === 0) {
    showScheduleMsg("Choisissez au moins un jour — ou désactivez la planification.");
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(sel.time)) {
    showScheduleMsg("Choisissez une heure d'exécution.");
    return;
  }
  const btn = document.getElementById("schedule-save");
  if (btn) btn.disabled = true;
  showScheduleMsg("");
  let saved = false;
  try {
    const res = await fetch(apiUrl(SCHEDULE_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: sel.disabled, days: sel.days, time: sel.time }),
    });
    if (res.ok) {
      saved = true;
      showScheduleMsg("Planification enregistrée.");
    } else if (res.status === 400) {
      showScheduleMsg("Planification refusée par le serveur — vérifiez les jours sélectionnés et l'heure.");
    } else if (res.status === 401) {
      showScheduleMsg("Accès refusé — l'enregistrement exige le jeton d'authentification du serveur.");
    } else if (res.status === 503) {
      showScheduleMsg("Agent indisponible pour le moment.");
    } else {
      showScheduleMsg(`Échec de l'enregistrement (code HTTP ${res.status}).`);
    }
  } catch {
    showScheduleMsg("Serveur injoignable — planification non enregistrée.");
  }
  // Every path (also after a save): releases the editor's busy pin
  if (btn) btn.disabled = false;
  if (saved) await loadAgentStatus();
}

/** One-time editor bindings (agent page, same-origin deploys only): chip
 *  toggling flips aria-pressed (the CSS renders the selection), the disable
 *  checkbox applies the dim rule, any interaction clears the inline message,
 *  and the save button triggers saveSchedule. */
function bindScheduleEditor() {
  const block = document.getElementById("schedule-block");
  if (!block) return;
  for (const chip of block.querySelectorAll(".schedule-chip[data-day]")) {
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      showScheduleMsg("");
    });
  }
  const disable = document.getElementById("schedule-disable");
  if (disable) disable.addEventListener("change", applyScheduleDisabledState);
  const time = document.getElementById("schedule-time");
  if (time) time.addEventListener("input", () => showScheduleMsg(""));
  const save = document.getElementById("schedule-save");
  if (save) save.addEventListener("click", saveSchedule);
}

/* ------------------------------ Connexions (agent credentials, agent page) ------------------------------ */

/** Inline message of the connexions editor (same conventions as showScheduleMsg). */
function showCredentialsMsg(msg) {
  const el = document.getElementById("credentials-msg");
  if (el) el.textContent = msg;
}

/** One French badge per SET field of a credentials row — names + field
 *  presence only, the credentials endpoint never carries values. */
function credentialBadgesHtml(cred) {
  const badges = [];
  if (cred.hasLogin) badges.push(`<span class="hist-chip">login</span>`);
  if (cred.hasPassword) badges.push(`<span class="hist-chip">mot de passe</span>`);
  if (cred.hasTotp) badges.push(`<span class="hist-chip">TOTP</span>`);
  return badges.join(" ");
}

/** Renders the stored credentials (rows: name + badges + per-row « Retirer »).
 *  Names are data values: escaped like every interpolation. */
function renderCredentials(credentials) {
  const zone = document.getElementById("credentials-list");
  if (!zone) return;
  zone.innerHTML = "";
  const rows = Array.isArray(credentials)
    ? credentials.filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name !== "")
    : [];
  if (rows.length === 0) {
    zone.innerHTML = `<p class="credentials-empty">Aucune connexion enregistrée pour le moment.</p>`;
    return;
  }
  for (const cred of rows) {
    const row = document.createElement("div");
    row.className = "cred-row";
    row.innerHTML =
      `<code class="cred-name">${escapeHtml(cred.name)}</code>` +
      `<span class="cred-badges">${credentialBadgesHtml(cred)}</span>` +
      `<button type="button" class="chat-clear-btn cred-delete">Retirer</button>`;
    // Rows are rebuilt wholesale (like the table rows): bind per row
    const del = row.querySelector(".cred-delete");
    if (del) del.addEventListener("click", () => deleteCredential(cred.name));
    zone.appendChild(row);
  }
}

/** GET /api/agent/credentials → render the rows. A failure renders an inline
 *  note — the GET is open even for an unconfigured agent, so every failure is
 *  a genuine server problem worth naming. */
async function loadCredentials() {
  const zone = document.getElementById("credentials-list");
  if (!zone) return;
  try {
    const res = await fetch(apiUrl(CREDENTIALS_PATH));
    if (!res.ok) throw new Error(`GET /api/agent/credentials → HTTP ${res.status}`);
    const body = await res.json();
    renderCredentials(body && Array.isArray(body.credentials) ? body.credentials : []);
  } catch {
    zone.innerHTML = `<p class="credentials-empty">Connexions indisponibles — le serveur ne répond pas.</p>`;
  }
}

/** « Enregistrer la connexion»: client-side mirror of the upsert semantics.
 *  A BLANK field is deliberately omitted from the body (absent key = the
 *  server keeps the stored value): the UI never sends "" — clearing a single
 *  field is not offered, a saved connexion is replaced with new values or
 *  removed wholesale via « Retirer ». Sent values are the typed ones (name
 *  trimmed; TOTP secret only outer-trimmed — interior spaces stay meaningful,
 *  "JBSWY3DP EHPK3PXP"); passwords are sent untouched (a space is a legal
 *  password character). */
async function saveCredential() {
  const nameInput = document.getElementById("cred-name");
  const loginInput = document.getElementById("cred-login");
  const passwordInput = document.getElementById("cred-password");
  const totpInput = document.getElementById("cred-totp-secret");
  const name = (nameInput?.value ?? "").trim();
  if (!name) {
    showCredentialsMsg("Donnez un nom à la connexion (par exemple facebook-main).");
    return;
  }
  const login = (loginInput?.value ?? "").trim();
  const password = passwordInput?.value ?? "";
  const totpSecret = (totpInput?.value ?? "").trim();
  if (login === "" && password === "" && totpSecret === "") {
    showCredentialsMsg("Rien à enregistrer — remplissez au moins un champ (login, mot de passe ou secret TOTP).");
    return;
  }
  // Blank = keep the stored value: build the body from the fields actually typed
  const payload = { name };
  if (login !== "") payload.login = login;
  if (password !== "") payload.password = password;
  if (totpSecret !== "") payload.totpSecret = totpSecret;
  const btn = document.getElementById("credentials-save");
  if (btn) btn.disabled = true;
  showCredentialsMsg("");
  let saved = false;
  try {
    const res = await fetch(apiUrl(CREDENTIALS_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      saved = true;
      showCredentialsMsg(`Connexion « ${name} » enregistrée.`);
      // The typed values never stay in the form; the name does (a follow-up
      // edit of the same connexion starts from its name)
      for (const input of [loginInput, passwordInput, totpInput]) {
        if (input) input.value = "";
      }
    } else if (res.status === 400) {
      // The server's validation error is operator-facing: surface it as-is
      let msg = "Connexion refusée par le serveur — vérifiez les valeurs saisies.";
      try {
        const body = await res.json();
        if (body && typeof body.error === "string" && body.error !== "") msg = body.error;
      } catch {
        /* malformed error body: keep the generic message */
      }
      showCredentialsMsg(msg);
    } else if (res.status === 401) {
      showCredentialsMsg("Accès refusé — l'enregistrement exige le jeton d'authentification du serveur.");
    } else {
      showCredentialsMsg(`Échec de l'enregistrement (code HTTP ${res.status}).`);
    }
  } catch {
    showCredentialsMsg("Serveur injoignable — connexion non enregistrée.");
  }
  // Every path (also after a save): releases the button's busy state
  if (btn) btn.disabled = false;
  if (saved) {
    await loadCredentials();
    await loadAgentStatus(); // refresh the status fetch (agent.credentialsFound)
  }
}

/** « Retirer»: French confirm, then POST /delete and refresh the list + the
 *  status fetch. Idempotent server-side (an unknown name still answers ok). */
async function deleteCredential(name) {
  if (!window.confirm(`Retirer la connexion « ${name} » ? Les valeurs seront supprimées du serveur.`)) {
    return;
  }
  showCredentialsMsg("");
  try {
    const res = await fetch(apiUrl(CREDENTIALS_DELETE_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      showCredentialsMsg(`Connexion « ${name} » retirée.`);
      await loadCredentials();
      await loadAgentStatus();
    } else if (res.status === 401) {
      showCredentialsMsg("Accès refusé — le retrait exige le jeton d'authentification du serveur.");
    } else {
      showCredentialsMsg(`Échec du retrait (code HTTP ${res.status}).`);
    }
  } catch {
    showCredentialsMsg("Serveur injoignable — connexion non retirée.");
  }
}

/** One-time bindings of the connexions editor (agent page, same-origin deploys
 *  only): typed input clears the inline message, save triggers saveCredential. */
function bindCredentialsEditor() {
  const block = document.getElementById("credentials-block");
  if (!block) return;
  for (const id of ["cred-name", "cred-login", "cred-password", "cred-totp-secret"]) {
    const input = document.getElementById(id);
    if (input) input.addEventListener("input", () => showCredentialsMsg(""));
  }
  const save = document.getElementById("credentials-save");
  if (save) save.addEventListener("click", saveCredential);
}

/** Reveals the connexions editor and loads the stored list once. Visibility
 *  mirrors the schedule editor's own rule (same-origin agent page only — on a
 *  static deploy the POSTs are unusable, so the block never shows) WITHOUT the
 *  agent-configured gate: the credentials GET answers regardless, which is why
 *  #historique must stay hostable for it (credentialsShown). */
async function initCredentials() {
  const block = document.getElementById("credentials-block");
  if (!block) return;
  credentialsShown = true;
  block.hidden = false;
  const save = document.getElementById("credentials-save");
  if (save) save.hidden = false; // revealed with the block (ships hidden)
  await loadCredentials();
}

/* ------------------------------ Navigateur de l'agent (browser profile reset, agent page) ------------------------------ */

/** Inline message of the browser reset block (same conventions as showCredentialsMsg). */
function showBrowserClearMsg(msg) {
  const el = document.getElementById("browser-clear-status");
  if (el) el.textContent = msg;
}

/** Renders the browser reset block from a /api/status payload — same call
 *  sites and REMOTE_MODE rule as renderScheduleEditor. Visible same-origin
 *  once ANY status payload is known (the profile path is a serve-level
 *  setting, surfaced with or without a configured agent — like the
 *  connexions block, without the agent-configured gate). null profile =
 *  transient mode: the « profil transitoire » line + a disabled button
 *  (nothing is persisted, nothing to reset). A failed status fetch hides
 *  the block again (hide-on-failure rule of the dynamic blocks). */
function renderBrowserClearBlock(status) {
  const block = document.getElementById("browser-clear-block");
  if (!block) return;
  if (REMOTE_MODE) {
    // Static deploy: the site never POSTs (no auth token) — never shows
    block.hidden = true;
    return;
  }
  const profile = status?.agent ? status.agent.browserProfile : undefined;
  if (profile === undefined) {
    // No usable status payload yet (or a failed fetch): stay hidden
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const line = document.getElementById("browser-profile-line");
  if (line) line.textContent = profile === null
    ? "profil transitoire — rien à réinitialiser"
    : `Profil : ${profile}`;
  const btn = document.getElementById("browser-clear-btn");
  if (btn) {
    btn.hidden = false; // revealed with the block (ships hidden)
    btn.disabled = profile === null;
  }
}

/** « Réinitialiser »: French confirm (what is lost, what is kept), then
 *  POST /api/agent/browser/clear → render the outcome in the status line.
 *  200: ok/cleared; 409: a run is active — retry after it ends; other
 *  errors: the server's error text when readable. The button stays
 *  disabled while the request is in flight. */
async function clearBrowserProfile() {
  const profile = lastAgentStatus?.agent?.browserProfile;
  if (!profile) return; // transient mode: the disabled button guards this too
  if (!window.confirm("Réinitialise le navigateur de l'agent : ferme le navigateur et efface son profil — toutes les sessions enregistrées (connexions aux sites) sont déconnectées. Les identifiants stockés (connexions & TOTP) sont conservés.")) {
    return;
  }
  const btn = document.getElementById("browser-clear-btn");
  if (btn) btn.disabled = true;
  showBrowserClearMsg("");
  try {
    const res = await fetch(apiUrl(BROWSER_CLEAR_PATH), { method: "POST" });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && body.cleared === true) {
        // The profile is recreated on the agent's next browser use
        showBrowserClearMsg("Profil réinitialisé ; les sites se reconnecteront à la prochaine navigation.");
      } else {
        showBrowserClearMsg("Profil transitoire — rien à réinitialiser.");
      }
    } else if (res.status === 409) {
      showBrowserClearMsg("Une mise à jour est en cours — réessaie après la fin de l'exécution.");
    } else if (res.status === 401) {
      showBrowserClearMsg("Accès refusé — la réinitialisation exige le jeton d'authentification du serveur.");
    } else {
      // Other errors (400/500): surface the server error text when readable
      let msg = `Échec de la réinitialisation (code HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body && typeof body.error === "string" && body.error !== "") msg = body.error;
      } catch {
        /* malformed error body: keep the generic message */
      }
      showBrowserClearMsg(msg);
    }
  } catch {
    showBrowserClearMsg("Serveur injoignable — profil non réinitialisé.");
  }
  // Restore the button: enabled only when a persistent profile exists
  if (btn) btn.disabled = lastAgentStatus?.agent?.browserProfile == null;
}

/* ------------------------------ Discussion avec l'agent (chat page) ------------------------------ */

/** Mutable chat-waiting state; single owner of the EventSource, the fallback
 *  poller and the pending assistant bubble (same single-owner pattern as wf). */
const chat = {
  running: false,       // waiting for the agent's reply (a run is active)
  expectedRunId: null,  // runId from our own accepted POST (null = boot-waiting)
  adoptedRunId: null,   // runId of the run currently watched on the stream
  es: null,             // live SSE EventSource (null when closed)
  errCount: 0,          // consecutive SSE errors → poll fallback
  pollToken: null,      // generation token of the fallback poller (null = stopped)
  pollTimer: null,
  pollStarted: 0,       // fallback start instant (bounded by WORKFLOW_POLL_MAX_MS)
  rewatchCount: 0,      // consecutive finish→rewatch cycles (hot-loop safety)
  finishing: false,     // finishChat guard (runFinished frame and a no-run snapshot can race)
  pendingBubble: null,  // pending assistant bubble currently on screen
};

/** True when stream events may be attributed to the watched run: either we
 *  started it ourselves (expectedRunId matches) or we boot-wait without any
 *  expectation and adopt whatever run is live (single-run guard — no second
 *  run can take the slot while we wait). */
function chatRunAdopted() {
  return chat.expectedRunId == null || chat.adoptedRunId == null || chat.adoptedRunId === chat.expectedRunId;
}

function scrollChatToBottom() {
  const zone = document.getElementById("chat-transcript");
  if (zone) zone.scrollTop = zone.scrollHeight;
}

function showChatMsg(msg) {
  const el = document.getElementById("chat-msg");
  if (el) el.textContent = msg;
}

function clearChatMsg() {
  showChatMsg("");
}

/** Send + clear stay disabled while a run is active. The stop button follows
 *  the waiting state: hidden+disabled when idle, visible+enabled while
 *  watching a run (enterWaiting flips it on through this same call). A
 *  stopped/timed-out run re-enables it only via the waiting end —
 *  setChatControls(false) hides it again for the idle state. */
function setChatControls(running) {
  const send = document.getElementById("chat-send");
  const clear = document.getElementById("chat-clear");
  const stop = document.getElementById("chat-stop");
  if (send) send.disabled = running;
  if (clear) clear.disabled = running;
  if (stop) {
    stop.hidden = !running;
    stop.disabled = !running;
  }
}

/** Local time "14:05:32" under a bubble; empty when the record carries no
 *  usable timestamp. */
function chatTimestampHtml(ts) {
  const time = formatTimeSeconds(ts);
  return time ? `<span class="chat-ts">${escapeHtml(time)}</span>` : "";
}

/** French token count: full grouping below 10 000 ("1 432"), then the "k"/
 *  "M" short forms ("24,5 k"). null when the value is not a usable number. */
function fmtTokenCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  if (n < 10000) return n.toLocaleString("fr-FR");
  if (n < 1000000) return `${(n / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k`;
  return `${(n / 1000000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`;
}

/** "≈ 0,0122 $" style USD figure (fr-FR decimal comma, 4 significant digits);
 *  the « ≈ » marks every displayed cost as possibly an estimate (catalog
 *  list price or operator rates, per the server's costSource). null when
 *  the value is not a usable number. */
function fmtCostUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return `≈ ${value.toLocaleString("fr-FR", { maximumSignificantDigits: 4 })} $`;
}

/** Tooltip naming where a usage cost figure comes from (matches the
 *  server's costSource values; anything unknown degrades to the
 *  tokens-only wording). */
function usageCostTitle(source) {
  if (typeof source === "string" && source) {
    return USAGE_SOURCE_TITLES[source] ?? USAGE_SOURCE_TITLE_NONE;
  }
  return USAGE_SOURCE_TITLE_NONE;
}

/** Grey micro-line under a successful assistant bubble, naming the run's
 *  token usage (+ the resolved cost line when the cost source could be
 *  established): "1 432 tok. in · 210 tok. out · ≈ 0,0122 $". Empty when the
 *  record carries no usage (user/error records, older servers, provider
 *  reporting nothing) — rows render exactly as before. */
function chatUsageLineHtml(usage) {
  if (!usage || typeof usage !== "object") return "";
  const parts = [];
  const input = fmtTokenCount(usage.inputTokens);
  const output = fmtTokenCount(usage.outputTokens);
  if (input) parts.push(`${input} tok. in`);
  if (output) parts.push(`${output} tok. out`);
  const cost = fmtCostUsd(usage.costUsd);
  if (cost) parts.push(cost);
  if (!parts.length) return "";
  const text = parts.join(" · ");
  return `<span class="chat-usage-line" title="${escapeHtml(usageCostTitle(usage.costSource))}">${escapeHtml(text)}</span>`;
}

/** Session usage chip (#chat-usage, sits right above the transcript), fed
 *  from the GET usage totals on every wholesale render:
 *  "Session : 12 échanges · ≈ 0,094 $" — tokens-only variant "Session :
 *  12 échanges · 24,5 k tokens". Hidden while the session counts no usage
 *  (fresh page, or right after a chat clear) and on data-less renders
 *  (busy-clear re-sync, failures). Same tooltip treatment as the bubble
 *  micro-line. */
function renderChatUsage(usage) {
  const el = document.getElementById("chat-usage");
  if (!el) return;
  if (!usage || typeof usage !== "object" || !(usage.turns > 0)) {
    el.hidden = true;
    el.removeAttribute("title");
    el.textContent = "";
    return;
  }
  const turns = Number(usage.turns).toLocaleString("fr-FR");
  const parts = [
    `Session : ${turns} ${usage.turns === 1 ? "échange" : "échanges"}`,
  ];
  // The chip shows the cost when known (the plan's session shape), else the
  // session token total (totalTokens, or input+output when the provider
  // never reported their sum).
  const cost = fmtCostUsd(usage.costUsd);
  const totalTokens = typeof usage.totalTokens === "number"
    ? usage.totalTokens
    : (typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens
      : null);
  if (cost) {
    parts.push(cost);
  } else {
    const tokens = fmtTokenCount(totalTokens);
    if (tokens) parts.push(`${tokens} tokens`);
  }
  el.textContent = parts.join(" · ");
  el.title = usageCostTitle(usage.costSource);
  el.hidden = false;
}

/** One transcript row per message — shared by wholesale renders and live
 *  appends. User content stays plain text (textContent: user input must never
 *  become HTML); assistant content goes through renderMarkdown (sanitized,
 *  escapeHtml fallback without the CDN stack). An assistant record may also
 *  carry a non-empty `activity` array (persisted tool calls): it renders as a
 *  collapsed <details> block inside the bubble, above the reply text
 *  (makeChatActivityDetails); records without it render exactly as before. */
function makeUserRow(text, ts) {
  const row = document.createElement("div");
  row.className = "chat-row chat-row-user";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-user";
  bubble.textContent = String(text ?? "");
  row.appendChild(bubble);
  row.insertAdjacentHTML("beforeend", chatTimestampHtml(ts));
  return row;
}

function makeAssistantRow(text, ts, activity, usage) {
  const row = document.createElement("div");
  row.className = "chat-row chat-row-assistant";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-assistant";
  const details = makeChatActivityDetails(activity);
  if (details) bubble.appendChild(details);
  // The markdown output must keep its nodes as direct bubble children (the
  // :first-child/:last-child spacing rules rely on it): append after the
  // activity block instead of assigning bubble.innerHTML wholesale.
  bubble.insertAdjacentHTML("beforeend", renderMarkdown(String(text ?? "")));
  row.appendChild(bubble);
  // Usage micro-line under the timestamp (absent when the record carries
  // none — renders exactly as before).
  row.insertAdjacentHTML("beforeend", chatTimestampHtml(ts) + chatUsageLineHtml(usage));
  return row;
}

/** Assistant error record: optional reply text above the error line itself;
 *  a persisted tool-activity block (see makeChatActivityDetails) sits above
 *  both when the record carries one. */
function makeErrorRow(rec) {
  const row = document.createElement("div");
  row.className = "chat-row chat-row-assistant";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-assistant chat-bubble-error";
  const details = makeChatActivityDetails(rec.activity);
  if (details) bubble.appendChild(details);
  const text = String(rec.text ?? "");
  bubble.insertAdjacentHTML("beforeend",
    (text ? renderMarkdown(text) : "") +
    `<div class="chat-err-line">⚠ ${escapeHtml(String(rec.error ?? "Erreur inconnue."))}</div>`);
  row.appendChild(bubble);
  row.insertAdjacentHTML("beforeend", chatTimestampHtml(rec.ts));
  return row;
}

/** Wholesale transcript render from the authoritative server state — the
 *  dedupe path for boot, runFinished and poll fallback. Never merge with a
 *  locally-built view: the GET answer is the single truth. */
function renderChatTranscript(messages) {
  const zone = document.getElementById("chat-transcript");
  if (!zone) return;
  zone.innerHTML = "";
  chat.pendingBubble = null;
  for (const rec of Array.isArray(messages) ? messages : []) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.role === "user") {
      zone.appendChild(makeUserRow(rec.text, rec.ts));
    } else if (rec.role === "assistant") {
      // rec.activity (absent on older servers / user records) flows to the
      // collapsed block builder, rec.usage (successful turns only) to the
      // grey micro-line — rows without them render exactly as before.
      zone.appendChild(rec.error ? makeErrorRow(rec) : makeAssistantRow(rec.text, rec.ts, rec.activity, rec.usage));
    }
  }
  scrollChatToBottom();
}

/** Live append right after an accepted POST: the server persists the user
 *  message too, so the next authoritative render shows the same bubble. */
function appendUserBubble(text) {
  const zone = document.getElementById("chat-transcript");
  if (!zone) return;
  zone.appendChild(makeUserRow(text, null));
  scrollChatToBottom();
}

/** Pending assistant bubble ("L'agent travaille…" + tool-activity lines).
 *  Never duplicated: a still-connected bubble is reused. */
function addPendingBubble() {
  const zone = document.getElementById("chat-transcript");
  if (!zone) return;
  if (chat.pendingBubble && chat.pendingBubble.isConnected) return;
  const row = document.createElement("div");
  row.className = "chat-row chat-row-assistant";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-assistant chat-bubble-pending";
  bubble.innerHTML =
    `<div class="chat-activity" hidden></div>` +
    `<span class="chat-pending-status">L'agent travaille…</span>`;
  row.appendChild(bubble);
  zone.appendChild(row);
  chat.pendingBubble = bubble;
  scrollChatToBottom();
}

/** Activity container of the pending bubble; un-hidden by the first line. */
function chatActivityZone() {
  const zone = chat.pendingBubble ? chat.pendingBubble.querySelector(".chat-activity") : null;
  if (zone) zone.hidden = false;
  return zone;
}

function clearChatActivity() {
  const zone = chat.pendingBubble ? chat.pendingBubble.querySelector(".chat-activity") : null;
  if (zone) {
    zone.innerHTML = "";
    zone.hidden = true;
  }
}

/** Bounded single-line preview for the activity lines. */
function chatPreviewLine(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** One tool-activity line per event, as a standalone node (no scrolling):
 *  the single line builder behind both the live pending-bubble appends (which
 *  scroll per line) and the wholesale renders (collapsed details block,
 *  poll-tick rebuild — the caller owns the single scroll at the end).
 *  The caller has already checked ev.type; unknown fields degrade via ?? "". */
function chatActivityCallLine(ev) {
  const line = document.createElement("div");
  line.className = "chat-act-line";
  line.innerHTML =
    `<span class="chat-act-mark">▸</span> ` +
    `<code class="chat-act-tool">${escapeHtml(String(ev.tool ?? ""))}(${escapeHtml(chatPreviewLine(ev.argsPreview, CHAT_ACTIVITY_MAX))})</code>`;
  return line;
}

/** Result-line twin of chatActivityCallLine — same node-only builder (no
 *  scrolling, wholesale renders scroll once at the end), same rules: the
 *  caller has already checked ev.type; unknown fields degrade via ?? "". */
function chatActivityResultLine(ev) {
  const ok = ev.ok === true;
  const dur = fmtDuration(ev.durationMs);
  const line = document.createElement("div");
  line.className = "chat-act-line";
  line.innerHTML =
    `<span class="${ok ? "chat-act-ok" : "chat-act-err"}">${ok ? "✔" : "✖"}</span> ` +
    `<span class="chat-act-toolname">${escapeHtml(String(ev.tool ?? ""))}</span>` +
    (dur ? ` <span class="chat-act-dur">(${escapeHtml(dur)})</span>` : "");
  return line;
}

/** Collapsed tool-activity block inside an assistant transcript bubble — the
 *  persisted equivalent of the pending bubble's live lines (same line markup,
 *  folded into a native <details> the reader expands by clicking). Returns
 *  null when the record carries nothing renderable (absent/empty array —
 *  older servers omit the field entirely — or only unknown event types), so
 *  the row renders exactly as before. */
function makeChatActivityDetails(activity) {
  if (!Array.isArray(activity) || activity.length === 0) return null;
  const calls = activity.filter((ev) => ev && ev.type === "toolCall").length;
  const details = document.createElement("details");
  details.className = "chat-act-details";
  // Collapsed by default (no open attribute); the label counts the calls.
  const summary = document.createElement("summary");
  summary.textContent = calls === 1 ? "⚙ 1 appel d'outil" : `⚙ ${calls} appels d'outils`;
  details.appendChild(summary);
  const inner = document.createElement("div");
  inner.className = "chat-act-inner";
  for (const ev of activity) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "toolCall") inner.appendChild(chatActivityCallLine(ev));
    else if (ev.type === "toolResult") inner.appendChild(chatActivityResultLine(ev));
    // unknown event types: skip defensively (same spirit as the workflow renderer)
  }
  if (!inner.children.length) return null;
  details.appendChild(inner);
  return details;
}

/** Live pending-bubble appends: same line nodes, one scroll per line so the
 *  activity streams visibly from the bottom (wholesale renders never scroll
 *  here — they scroll once at the end). */
function appendChatActivityCall(ev, zone = chatActivityZone()) {
  if (!zone) return;
  zone.appendChild(chatActivityCallLine(ev));
  scrollChatToBottom();
}

function appendChatActivityResult(ev, zone = chatActivityZone()) {
  if (!zone) return;
  zone.appendChild(chatActivityResultLine(ev));
  scrollChatToBottom();
}

function appendChatActivityLagged(ev) {
  const zone = chatActivityZone();
  if (!zone) return;
  const dropped = Number(ev.dropped);
  const line = document.createElement("div");
  line.className = "chat-act-line chat-act-lag";
  line.textContent = `⚠ ${Number.isFinite(dropped) ? dropped : 0} événements manqués (flux ralenti)`;
  zone.appendChild(line);
  scrollChatToBottom();
}

/** Wholesale rebuild of the activity lines (workflow snapshot or a fallback
 *  poll tick — dedupe-safe). */
function renderChatActivity(events) {
  const zone = chat.pendingBubble ? chat.pendingBubble.querySelector(".chat-activity") : null;
  if (!zone) return;
  zone.innerHTML = "";
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "toolCall") appendChatActivityCall(ev, zone);
    else if (ev.type === "toolResult") appendChatActivityResult(ev, zone);
  }
  zone.hidden = zone.children.length === 0;
  scrollChatToBottom();
}

/** finalReply frame → show the markdown reply immediately in the pending
 *  bubble; the bubble stays "pending" until the authoritative re-render. */
function showChatFinalReply(ev) {
  const bubble = chat.pendingBubble;
  if (!bubble || !bubble.isConnected) return;
  const status = bubble.querySelector(".chat-pending-status");
  if (status) status.hidden = true;
  const old = bubble.querySelector(".chat-reply");
  if (old) old.remove();
  const reply = document.createElement("div");
  reply.className = "chat-reply";
  reply.innerHTML = renderMarkdown(String(ev.text ?? ""));
  bubble.appendChild(reply);
  scrollChatToBottom();
}

/** Enters the waiting state: pending bubble + watch on the live workflow
 *  stream. runId comes from the accepted POST (null while boot-waiting: the
 *  single-run guard makes the next run on the stream the watched one). The
 *  waiting state also exposes the « Arrêter » stop button (setChatControls). */
function enterWaiting(runId) {
  chat.running = true;
  chat.expectedRunId = runId ?? null;
  chat.adoptedRunId = null;
  stopChatStream();
  stopChatPoll();
  clearChatMsg();
  addPendingBubble();
  setChatControls(true);
  startChatStream();
}

/** Opens the chat watch stream exactly once per waiting session. */
function startChatStream() {
  if (chat.es || !chat.running) return;
  if (typeof EventSource === "undefined") {
    startChatPoll(); // very old browser: poll instead
    return;
  }
  chat.errCount = 0;
  const es = new EventSource(apiUrl(WORKFLOW_STREAM_PATH)); // GET: open by design
  chat.es = es;
  es.onopen = () => {
    chat.errCount = 0; // successful (re)connection resets the failure streak
  };
  es.addEventListener("snapshot", (e) => {
    try {
      onChatSnapshot(JSON.parse(e.data));
    } catch {
      /* ignored frame */
    }
  });
  es.onmessage = (e) => {
    try {
      handleChatEvent(JSON.parse(e.data));
    } catch {
      /* ignored frame */
    }
  };
  es.onerror = () => {
    if (!chat.es) return; // waiting session already ended
    chat.errCount += 1;
    // Persistent failure: close the stream and fall back to polling while
    // the run is going (bounded, see startChatPoll).
    if (chat.errCount >= WORKFLOW_ERR_LIMIT) {
      stopChatStream();
      startChatPoll();
    }
  };
}

function stopChatStream() {
  if (chat.es) {
    chat.es.close();
    chat.es = null;
  }
}

/** SSE snapshot frame: adopt the live run (activity lines rebuilt wholesale)
 *  or, when no run is active at connect time, hand the question back to the
 *  authoritative endpoint (run ended before the stream opened, or the waiting
 *  flag was stale). */
function onChatSnapshot(snap) {
  if (!chat.es) return; // waiting session already ended
  if (snap && snap.run && snap.run.running) {
    if (chat.expectedRunId && snap.run.runId !== chat.expectedRunId) return; // foreign run
    chat.adoptedRunId = snap.run.runId ?? null;
    chat.rewatchCount = 0;
    renderChatActivity(Array.isArray(snap.events) ? snap.events : []);
    return;
  }
  void finishChat();
}

/** Live workflow frames: runStart adopts the fresh run (activity resets),
 *  tool lines append, finalReply shows the reply early, runFinished ends the
 *  watch with an authoritative re-render. */
function handleChatEvent(ev) {
  if (!chat.es) return; // waiting session already ended
  if (!ev || typeof ev.type !== "string") return;
  switch (ev.type) {
    case "runStart": {
      if (chat.expectedRunId && ev.runId !== chat.expectedRunId) return;
      chat.adoptedRunId = ev.runId ?? null;
      chat.rewatchCount = 0;
      clearChatActivity(); // fresh run → fresh activity lines
      return;
    }
    case "toolCall":
      if (!chatRunAdopted()) return;
      appendChatActivityCall(ev);
      return;
    case "toolResult":
      if (!chatRunAdopted()) return;
      appendChatActivityResult(ev);
      return;
    case "eventsLagged":
      if (!chatRunAdopted()) return;
      appendChatActivityLagged(ev);
      return;
    case "finalReply":
      if (!chatRunAdopted()) return;
      showChatFinalReply(ev);
      return;
    case "runFinished":
      // runFinished frames carry no runId: attribution comes from the adopted
      // run (frames for an un-adopted run's lifetime cannot appear under the
      // single-run guard — a finish we see belongs to the run we watch).
      if (!chatRunAdopted()) return;
      void finishChat();
      return;
    default:
      return; // unknown event type: ignore defensively
  }
}

function stopChatPoll() {
  chat.pollToken = null; // in-flight tick results are discarded via the token
  if (chat.pollTimer) {
    clearTimeout(chat.pollTimer);
    chat.pollTimer = null;
  }
}

/** SSE fallback: poll the authoritative transcript every ~2 s while the run
 *  is going (same cadence and bound as the workflow fallback). Wholesale
 *  renders dedupe; tool-activity lines rebuild from /api/agent/workflow. */
function startChatPoll() {
  stopChatPoll(); // single fallback at a time
  chat.pollStarted = Date.now();
  const token = chat.pollStarted;
  chat.pollToken = token;
  const tick = async () => {
    if (chat.pollToken !== token) return;
    const r = await refreshChatState();
    if (chat.pollToken !== token) return; // ended elsewhere meanwhile
    if (r.json) {
      if (r.json.running) {
        addPendingBubble(); // recreated fresh after the wholesale render
      } else {
        stopChatPoll();
        chat.running = false;
        chat.pendingBubble = null;
        setChatControls(false);
        return;
      }
      // Still running: rebuild the activity lines from the live workflow
      // session (best effort — the display is decorative).
      try {
        const wfres = await fetch(apiUrl(WORKFLOW_PATH));
        if (wfres.ok) {
          const snap = await wfres.json();
          if (snap && snap.run && snap.run.running) {
            renderChatActivity(snap.events || []);
          }
        }
      } catch {
        /* activity display is best-effort */
      }
    } else if (r.unavailable) {
      // Agent unconfigured mid-wait: stop waiting and say why (transient
      // failures keep polling until the bound instead).
      stopChatPoll();
      chat.running = false;
      chat.pendingBubble?.remove();
      chat.pendingBubble = null;
      setChatControls(false);
      showChatMsg("Agent indisponible pour le moment — rechargez la page pour réessayer.");
      return;
    }
    if (Date.now() - chat.pollStarted > WORKFLOW_POLL_MAX_MS) {
      stopChatPoll();
      chat.running = false;
      chat.pendingBubble?.remove();
      chat.pendingBubble = null;
      setChatControls(false);
      showChatMsg("L'attente a été trop longue — rechargez la page pour voir le résultat.");
      return;
    }
    chat.pollTimer = setTimeout(tick, WORKFLOW_POLL_MS);
  };
  tick();
}

/** Re-fetches the authoritative transcript and re-renders it wholesale.
 *  Returns { json } on a well-formed answer, { json: null, unavailable: true }
 *  on 503 (agent unconfigured), { json: null } on any other failure. */
async function refreshChatState() {
  try {
    const res = await fetch(apiUrl(CHAT_PATH));
    if (res.status === 503) return { json: null, unavailable: true };
    if (!res.ok) return { json: null };
    const body = await res.json();
    if (!body || !Array.isArray(body.messages)) return { json: null };
    renderChatTranscript(body.messages);
    // The wholesale render is also the session-chip refresh point (the
    // totals ride the same GET answer; absent on older servers → hidden).
    renderChatUsage(body.usage);
    return { json: body };
  } catch {
    return { json: null };
  }
}

/** Ends the waiting state: the watched run finished (or the stream lost it)
 *  → re-fetch the authoritative transcript, then either re-enter the wait
 *  (a new run took the slot right away) or restore the controls. */
async function finishChat() {
  if (chat.finishing) return;
  chat.finishing = true;
  try {
    stopChatStream();
    stopChatPoll();
    chat.adoptedRunId = null;
    const r = await refreshChatState();
    if (r.json && r.json.running) {
      if (chat.rewatchCount < CHAT_REWATCH_LIMIT) {
        chat.rewatchCount += 1;
        enterWaiting(null); // watch the run that took the slot
        return;
      }
      showChatMsg("Une autre exécution occupe l'agent — réessayez une fois terminée.");
    } else if (!r.json) {
      showChatMsg("Résultat indisponible — rechargez la page pour voir la réponse de l'agent.");
    }
    chat.running = false;
    chat.pendingBubble?.remove();
    chat.pendingBubble = null;
    setChatControls(false);
  } finally {
    chat.finishing = false;
  }
}

/** Send: POST /api/agent/chat → 202 {runId} (watch the stream), 400 / 409 /
 *  503 / others → inline French error near the input, controls re-enabled. */
async function sendChatMessage() {
  if (chat.running) return;
  const input = document.getElementById("chat-input");
  const text = (input?.value ?? "").trim();
  if (!text) {
    showChatMsg("Écrivez un message avant d'envoyer.");
    return;
  }
  const sendBtn = document.getElementById("chat-send");
  if (sendBtn) sendBtn.disabled = true;
  clearChatMsg();
  try {
    const res = await fetch(apiUrl(CHAT_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (res.status === 202) {
      // The runId may be absent from a malformed body: boot-like watch then
      // (the single-run guard makes the next run the watched one)
      let runId = null;
      try {
        runId = (await res.json()).runId ?? null;
      } catch {
        /* body ignored */
      }
      if (input) input.value = "";
      appendUserBubble(text);
      enterWaiting(runId);
      return; // controls stay disabled until the run ends
    }
    if (res.status === 409) {
      showChatMsg("Une exécution de l'agent est déjà en cours — réessayez dans un instant.");
    } else if (res.status === 503) {
      showChatMsg("Agent indisponible pour le moment.");
    } else if (res.status === 400) {
      showChatMsg("Message vide — rien à envoyer.");
    } else if (res.status === 401) {
      showChatMsg("Accès refusé — l'envoi exige le jeton d'authentification du serveur.");
    } else {
      showChatMsg(`Échec de l'envoi (code HTTP ${res.status}).`);
    }
  } catch {
    showChatMsg("Serveur injoignable — message non envoyé.");
  }
  if (sendBtn) sendBtn.disabled = false; // failure path only: 202 keeps it disabled while watching
}

/** « Arrêter »: POST /api/agent/stop — best-effort cooperative stop of the
 *  run being watched (same-origin page: plain fetch, no CORS concern). The
 *  button stays disabled for the rest of the waiting state — it is re-shown
 *  re-enabled only when the watch ends (finishChat → setChatControls(false);
 *  a new waiting session re-arms it). The stopped run's finalization (audit,
 *  transcript error bubble) flows through the ordinary runFinished frames —
 *  the error record shows the raw server string "stopped by operator", the
 *  same convention as "timeout". */
async function stopChatRun() {
  if (!chat.running) return;
  const stopBtn = document.getElementById("chat-stop");
  if (stopBtn) stopBtn.disabled = true;
  clearChatMsg();
  try {
    const res = await fetch(apiUrl(AGENT_STOP_PATH), { method: "POST" });
    if (res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* malformed body: fall through to the "déjà terminée" reading */
      }
      if (body && body.stopped) {
        showChatMsg("Arrêt demandé — l'exécution va s'interrompre.");
      } else {
        showChatMsg("L'exécution s'est déjà terminée.");
      }
      return; // stop accepted (or already finished): the watch closes the session
    }
    if (res.status === 401) {
      showChatMsg("Accès refusé — l'arrêt exige le jeton d'authentification du serveur.");
    } else {
      showChatMsg(`Échec de l'arrêt (code HTTP ${res.status}).`);
    }
  } catch {
    showChatMsg("Serveur injoignable — arrêt non envoyé.");
  }
}

/** « Effacer la conversation »: idempotent server-side clear, then the local
 *  transcript is wiped too (no confirmation asked). Blocked while running.
 *  A 200 answer can still report ok:false/busy:true (a run — chat or
 *  maintenance — started between the controls being re-enabled and the
 *  click): the server then keeps the conversation, so the local view
 *  re-syncs instead of wiping — no silent divergence with the server. */
async function clearConversation() {
  if (chat.running) return;
  clearChatMsg();
  try {
    const res = await fetch(apiUrl(CHAT_CLEAR_PATH), { method: "POST" });
    if (res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* malformed body: fall back to the plain-clear behavior */
      }
      if (body && body.ok === false) {
        // Busy: nothing was cleared server-side — say so and re-sync the
        // local view with the authoritative transcript
        showChatMsg("Une exécution de l'agent est en cours — conversation non effacée.");
        await refreshChatState();
        return;
      }
      renderChatTranscript([]);
      // Real clear: the server wiped the session usage with the transcript.
      renderChatUsage(null);
      return;
    }
    if (res.status === 401) {
      showChatMsg("Accès refusé — l'effacement exige le jeton d'authentification du serveur.");
    } else if (res.status === 503) {
      showChatMsg("Agent indisponible pour le moment.");
    } else {
      showChatMsg(`Échec de l'effacement (code HTTP ${res.status}).`);
    }
  } catch {
    showChatMsg("Serveur injoignable — conversation non effacée.");
  }
}

/** Chat page boot (silent-hide rules): a static deploy never POSTs → the
 *  section never shows; an unreachable server or an unconfigured agent (503)
 *  keeps it hidden too. Only a well-formed transcript answer unhides it. */
async function initChat() {
  const section = document.getElementById("chat");
  if (!section) return;
  if (REMOTE_MODE) return;
  let body = null;
  try {
    const res = await fetch(apiUrl(CHAT_PATH));
    if (!res.ok) return;
    body = await res.json();
  } catch {
    return;
  }
  if (!body || !Array.isArray(body.messages)) return;
  section.hidden = false;
  renderChatTranscript(body.messages);
  renderChatUsage(body.usage);
  if (body.running) {
    enterWaiting(null);
  } else {
    setChatControls(false);
  }
}

/* ------------------------------ Navigation (hamburger / off-canvas panel) ------------------------------ */

/** Reduced-motion preference (drives scroll behavior of the nav). */
function prefersReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** Binds the hamburger → off-canvas navigation (one-time listeners; no leak on
 *  repeated open/close). The panel lives closed in the DOM (CSS visibility)
 *  so the page keeps working without JS and nothing is tabbable while closed. */
function setupNavigation() {
  const toggle = document.getElementById("nav-toggle");
  const panel = document.getElementById("nav-panel");
  const backdrop = document.getElementById("nav-backdrop");
  const closeBtn = document.getElementById("nav-close");
  const topBtn = document.getElementById("nav-top");
  if (!toggle || !panel || !backdrop) return;

  let navOpen = false;

  // Modal truthfulness: the page sections behind the panel become inert while
  // it is open (native `inert`; feature-checked — harmless no-op elsewhere).
  // The Tab-trap below stays as the fallback for browsers without inert.
  const behind = ["main", "header", "footer"]
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);

  const openNav = () => {
    navOpen = true;
    document.documentElement.classList.add("nav-open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Fermer la navigation");
    for (const el of behind) if ("inert" in el) el.inert = true;
    // Focus moves into the (modal) panel
    const first = panel.querySelector("a");
    if (first) first.focus();
  };

  const closeNav = () => {
    navOpen = false;
    document.documentElement.classList.remove("nav-open"); // scroll lock off
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Ouvrir la navigation");
    // inert off BEFORE focusing the toggle (it lives inside <header>)
    for (const el of behind) if ("inert" in el) el.inert = false;
    toggle.focus(); // focus always returns to the hamburger button
  };

  toggle.addEventListener("click", () => (navOpen ? closeNav() : openNav()));
  if (closeBtn) closeBtn.addEventListener("click", closeNav);
  backdrop.addEventListener("click", closeNav);
  // Clicking a link navigates AND closes: closeNav removes the scroll lock
  // synchronously, so the browser's anchor jump after the listener still lands.
  panel.addEventListener("click", (e) => {
    if (e.target.closest("a")) closeNav();
  });
  if (topBtn) {
    topBtn.addEventListener("click", () => {
      closeNav();
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && navOpen) closeNav();
  });
  // Minimal focus trap while the modal panel is open (Tab wraps inside it)
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusables = [...panel.querySelectorAll("a, button")].filter((el) => !el.disabled);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

/** Active-page highlight: the nav link whose href matches the current page
 *  pathname gets .active + aria-current="page" (accent + dash marker).
 *  Page-based replacement for the old in-page scrollspy — the nav links are
 *  real page links now. */
function setupNavActivePage() {
  const links = [...document.querySelectorAll(".nav-links a")];
  for (const link of links) {
    try {
      if (new URL(link.getAttribute("href"), location.href).pathname === location.pathname) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
    } catch {
      /* unparseable href: skip */
    }
  }
}

/** Header « Site public » link (stable UI-chrome URL): shown ONLY on the
 *  dynamic server — the anchor ships hidden in the HTML, and the published
 *  static site receives these very files, so it stays hidden there (its data
 *  URL is the published file, not the server API). */
function setupPublicSiteLink() {
  const link = document.getElementById("public-site-link");
  if (link) link.hidden = STATIC_DATA;
}

/* ------------------------------ Errors ------------------------------ */

function showFetchError(err) {
  const zone = document.getElementById("error-zone");
  if (STATIC_DATA) {
    // Static deployment: there is no server to "start" — the failure is the
    // published data file itself (its config.js URL is the useful pointer).
    zone.innerHTML = `
      <div class="error-box">
        <h2 style="border:none; margin-top:0">Impossible de charger les données</h2>
        <p>${escapeHtml(err && err.message ? err.message : String(err))}</p>
        <p>Fichier de données injoignable ou invalide (<code>${escapeHtml(DATA_URL)}</code>)&nbsp;:
        vérifiez le déploiement statique et le fichier publié.</p>
      </div>`;
    return;
  }
  zone.innerHTML = `
    <div class="error-box">
      <h2 style="border:none; margin-top:0">Impossible de charger les données</h2>
      <p>${escapeHtml(err && err.message ? err.message : String(err))}</p>
      <p>Serveur injoignable ou donnée invalide. Le site sert ses données via l'API du
      serveur dynamique (<code>/api/data</code>)&nbsp;: assurez-vous qu'il tourne.</p>
      <p>Depuis ce répertoire, lancez&nbsp;:</p>
      <p><code>airsoft-ops serve</code></p>
      <p>puis rechargez cette page.</p>
    </div>`;
}

/* ------------------------------ Init ------------------------------ */

/** Freshness span: last-verified date from the data file's meta (fallback:
 *  static text already in the HTML) — shared, rendered on every page. */
function renderVerifiedDate() {
  const verified = state.data?.meta?.lastVerified;
  const span = document.getElementById("verified-date");
  const verifiedDate = verified && /^\d{4}-\d{2}-\d{2}$/.test(verified) ? parseIso(verified) : null;
  if (
    span &&
    verifiedDate &&
    !Number.isNaN(verifiedDate.getTime()) &&
    // parseIso doesn't validate bounds (constructor rollover, e.g. 2026-13-40 → 09/02/2027):
    // component comparison, timezone-safe.
    verifiedDate.getFullYear() === +verified.slice(0, 4) &&
    verifiedDate.getMonth() === +verified.slice(5, 7) - 1 &&
    verifiedDate.getDate() === +verified.slice(8, 10)
  ) {
    span.textContent = `Données vérifiées le ${formatDate(verified)}`;
  }
}

/** Renders everything that depends on the data file — shared pieces on every
 *  page (freshness span + footer sources), page sections behind the dispatcher. */
function renderData() {
  renderVerifiedDate();
  renderSources();

  if (PAGE === "home") {
    // MAIN page: Carte → Calendrier → Tableaux (all in this DOM order)
    renderMap();
    renderNoGeo();
    renderHero();
    renderTable();
    populateDepSelect();
    handleEntryHash();
  }
  console.info(
    `Loaded: ${REGIONS.map((r) => `${(state.data[r] || []).length} ${REGION_LABELS[r]} entries`).join(", ")}`
  );
}

/** The zone/distance filters drive both the calendar and the unified table. */
function renderFilteredViews() {
  renderHero();
  renderTable();
}

/** Bind the zone chips + max-distance input (init-time only). */
function bindTimelineFilters() {
  document.querySelectorAll(".filter-controls .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const key = chip.dataset.zone;
      const on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      if (on) state.zones.delete(key);
      else state.zones.add(key);
      renderFilteredViews();
    });
  });
  const maxKmInput = document.getElementById("max-km");
  const applyMaxKm = () => {
    const v = Number(maxKmInput.value);
    if (!Number.isFinite(v)) return;
    if (v < 10 || v > 500 || v === state.maxKm) return;
    state.maxKm = v;
    renderFilteredViews();
  };
  // While typing, react only to valid in-range values (avoids jarring re-renders mid-typing)
  maxKmInput.addEventListener("input", applyMaxKm);
  // On change (blur/Enter), clamp whatever is displayed into [10, 500] so the
  // input never contradicts the filter state; an empty or non-numeric field
  // falls back to the last valid state.maxKm
  maxKmInput.addEventListener("change", () => {
    // Number("") is 0 (finite), so check for an empty field before parsing
    const raw = maxKmInput.value.trim();
    let v = raw === "" || !Number.isFinite(Number(raw)) ? state.maxKm : Number(raw);
    v = Math.min(500, Math.max(10, v));
    maxKmInput.value = String(v);
    if (v !== state.maxKm) {
      state.maxKm = v;
      renderFilteredViews();
    }
  });
}

/** Loads the data file again and re-renders (after an agent run, agent page
 *  only): the freshness span and the footer sources reflect the new state. */
async function refreshData() {
  try {
    await loadData();
    renderData();
  } catch {
    // Keep the current data on failure; the page remains usable
  }
}

/** Fetches the data file and validates the payload shape; throws on failure
 *  (invalid shape counts as "donnée invalide"). */
async function loadData() {
  // no-cache: static hosts (and the server) must not hide a fresh publish
  // behind a cached copy — every load and refresh revalidates.
  const res = await fetch(DATA_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${DATA_URL} a renvoyé le code HTTP ${res.status}`);
  const json = await res.json();
  if (!json || typeof json !== "object" || !Array.isArray(json.rennes) || !Array.isArray(json.nanterre)) {
    throw new Error("Réponse du serveur invalide (rennes / nanterre attendus).");
  }
  state.data = json;
  // Defensive: only render what actually exists in the payload. rennes and
  // nanterre were checked above; caen may be ABSENT (stale data.json without
  // the new bucket) — every REGIONS key is normalized to an array so the
  // region loops below stay simple.
  for (const r of REGIONS) {
    if (!Array.isArray(state.data[r])) state.data[r] = [];
  }
  return json;
}

/** One-time setup per page (shared pieces everywhere, page pieces behind the
 *  dispatcher): map + tables + timeline filter (home), navigation + active-
 *  page highlight (all), run button + schedule editor + connexions editor +
 *  browser reset (agent, same-origin deploys only), chat input bindings
 *  (chat). */
function setupStatic(page) {
  if (page === "home") {
    const mapOk = initMap();
    if (!mapOk) document.querySelector(".map-legend")?.style.setProperty("opacity", ".4");
    bindTableControls();
    bindTimelineFilters();
  }
  setupNavigation();
  setupNavActivePage();
  setupPublicSiteLink();
  if (page === "agent") {
    if (REMOTE_MODE) {
      // Static deployment: no token client-side — the update trigger is hidden
      // once here (updateRunButtonVisibility keeps it hidden on status updates)
      const btn = document.getElementById("agent-update-btn");
      if (btn) btn.hidden = true;
      // Same rule for the schedule editor (renderScheduleEditor keeps it hidden)
      const scheduleBlock = document.getElementById("schedule-block");
      if (scheduleBlock) scheduleBlock.hidden = true;
      // Same rule for the connexions editor (initCredentials never runs)
      const credBlock = document.getElementById("credentials-block");
      if (credBlock) credBlock.hidden = true;
      // Same rule for the browser reset block (renderBrowserClearBlock
      // keeps it hidden on status updates too)
      const browserBlock = document.getElementById("browser-clear-block");
      if (browserBlock) browserBlock.hidden = true;
    } else {
      const updateBtn = document.getElementById("agent-update-btn");
      if (updateBtn) updateBtn.addEventListener("click", triggerAgentUpdate);
      bindScheduleEditor();
      bindCredentialsEditor();
      void initCredentials(); // reveal + list load (GET-only until a save)
      const browserClearBtn = document.getElementById("browser-clear-btn");
      if (browserClearBtn) {
        browserClearBtn.addEventListener("click", clearBrowserProfile);
      }
      // Workflow-header stop button: bound ONCE by event delegation on the
      // activity zone (the header — and its button — is re-rendered
      // wholesale by the live-view snapshots/appends).
      const activityZone = document.getElementById("agent-activity");
      if (activityZone) {
        activityZone.addEventListener("click", (e) => {
          const btn = e.target.closest("#agent-run-stop");
          if (!btn || btn.disabled) return;
          btn.disabled = true; // one stop per render; the finished-state swap re-renders
          void stopAgentRun();
        });
      }
    }
  }
  if (page === "chat") {
    const sendBtn = document.getElementById("chat-send");
    const clearBtn = document.getElementById("chat-clear");
    const stopBtn = document.getElementById("chat-stop");
    const input = document.getElementById("chat-input");
    if (sendBtn) sendBtn.addEventListener("click", sendChatMessage);
    if (clearBtn) clearBtn.addEventListener("click", clearConversation);
    if (stopBtn) stopBtn.addEventListener("click", stopChatRun);
    if (input) {
      // Enter sends, Shift+Enter inserts a newline (standard chat-input
      // behavior; isComposing keeps IME composition from sending)
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }
  }
}

function init() {
  setupStatic(PAGE);
  loadData()
    .then(renderData)
    .catch((err) => showFetchError(err));

  // Pill on every page; the workflow block and history list are agent-page-only
  // (their DOM is absent on the home page — both are null-guarded anyway)
  loadAgentStatus().then(() => {
    if (PAGE === "agent" && agentConfigured) {
      void initAgentActivity();
      initAgentScreen(); // « Écran de l'agent » viewer, next to the workflow block
    }
    // Chat page: the same viewer folded into a collapsible panel inside #chat.
    // The REMOTE_MODE guard inside initAgentScreen stays authoritative — on a
    // static deploy #chat never unhides anyway, so nothing shows regardless.
    if (PAGE === "chat" && agentConfigured) initAgentScreen();
  });
  if (PAGE === "agent") loadHistory();
  if (PAGE === "chat") void initChat(); // silent-hide on remote deploys / unconfigured agent
}

init();