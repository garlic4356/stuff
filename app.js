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

/* Interactive chat with the agent (chat page): the conversation transcript is
 * GET /api/agent/chat, POST starts a chat run through the shared single-run
 * guard (409 while a run is active) and POST /clear wipes it idempotently.
 * POSTs never work on a static deploy (no auth token, no CORS) → the whole
 * section stays hidden there (REMOTE_MODE). The waiting watch reuses the
 * workflow SSE + poll-fallback constants above. */
const CHAT_PATH = "/api/agent/chat";
const CHAT_CLEAR_PATH = "/api/agent/chat/clear";
const CHAT_ACTIVITY_MAX = 120;                 // argsPreview chars kept in an activity line
const CHAT_REWATCH_LIMIT = 3;                  // finish→rewatch cycles before stopping (hot-loop guard)

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
  if (!historyShown && !agentConfigured && !apiUnavailable) {
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

/** Live (or just-finished) view header: ▶/✔ + kind label + started time. */
function wfHeaderHtml(finished) {
  const run = wf.run || {};
  const kind = escapeHtml(kindLabel(run.kind));
  const started = formatTimeSeconds(run.startedAt);
  return (
    `<div class="wf-header ${finished ? "finished" : "running"}">` +
    `<span class="wf-mark">${finished ? "✔" : "▶"}</span> ` +
    `<span class="wf-title">${escapeHtml(finished ? "Exécution terminée" : "Exécution en cours")}</span>` +
    ` <span class="wf-kind">— ${kind}</span>` +
    (started ? `<span class="wf-starttime">· démarrée à ${escapeHtml(started)}</span>` : "") +
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
      const errored = agent.lastRunOutcome === "error" || agent.lastRunOutcome === "timeout";
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
      syncHistoryVisibility();
      return null;
    }
    const status = await res.json();
    lastAgentStatus = status;
    renderAgentPill(status);
    updateRunButtonVisibility(status);
    syncHistoryVisibility();
    return status;
  } catch {
    markApiUnavailable(); // network error: treat the API as unreachable
    renderAgentPill(null);
    updateRunButtonVisibility(lastAgentStatus);
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

/** Send + clear stay disabled while a run is active. */
function setChatControls(running) {
  const send = document.getElementById("chat-send");
  const clear = document.getElementById("chat-clear");
  if (send) send.disabled = running;
  if (clear) clear.disabled = running;
}

/** Local time "14:05:32" under a bubble; empty when the record carries no
 *  usable timestamp. */
function chatTimestampHtml(ts) {
  const time = formatTimeSeconds(ts);
  return time ? `<span class="chat-ts">${escapeHtml(time)}</span>` : "";
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

function makeAssistantRow(text, ts, activity) {
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
  row.insertAdjacentHTML("beforeend", chatTimestampHtml(ts));
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
      // collapsed block builder — rows without it render exactly as before.
      zone.appendChild(rec.error ? makeErrorRow(rec) : makeAssistantRow(rec.text, rec.ts, rec.activity));
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
 *  single-run guard makes the next run on the stream the watched one). */
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
 *  page highlight (all), run button (agent, same-origin deploys only), chat
 *  input bindings (chat). */
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
    } else {
      const updateBtn = document.getElementById("agent-update-btn");
      if (updateBtn) updateBtn.addEventListener("click", triggerAgentUpdate);
    }
  }
  if (page === "chat") {
    const sendBtn = document.getElementById("chat-send");
    const clearBtn = document.getElementById("chat-clear");
    const input = document.getElementById("chat-input");
    if (sendBtn) sendBtn.addEventListener("click", sendChatMessage);
    if (clearBtn) clearBtn.addEventListener("click", clearConversation);
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
    if (PAGE === "agent" && agentConfigured) void initAgentActivity();
  });
  if (PAGE === "agent") loadHistory();
  if (PAGE === "chat") void initChat(); // silent-hide on remote deploys / unconfigured agent
}

init();