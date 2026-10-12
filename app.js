"use strict";

/* --------------------------------------------------------------------------
 * Two-page frontend served by airsoft-ops (default) or any static host:
 *   /      (index.html, data-page="home")  — MAIN page: Carte → Calendrier →
 *                                            Tableaux (Leaflet loads here)
 *   /agent (agent.html, data-page="agent") — historique + activité de l'agent
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

/** Current page, from the server-served <body data-page> (home|agent) — drives
 *  the init dispatcher: home carries map + calendar + tables, agent carries
 *  history, workflow and the update trigger. */
const PAGE = document.body.dataset.page;

const state = {
  // Zone filter (timeline only): active anchor keys; empty = no filter, all shown
  zones: new Set(),
  maxKm: DEFAULT_MAX_KM,
  data: { meta: {}, rennes: [], nanterre: [] },
  sorts: { rennes: { key: null, dir: 1 }, nanterre: { key: null, dir: 1 } },
  depFilters: { rennes: "", nanterre: "" },
  searches: { rennes: "", nanterre: "" },
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

/** First non-past event of an entry (events are date-ascending; today counts as upcoming), or null. */
function nextUpcomingEvent(entry) {
  const events = entry.events || [];
  for (const ev of events) {
    if (daysFromToday(ev.date) >= 0) return ev;
  }
  return null;
}

/** Renders text greyed out when it equals / starts with "n.c." (FRENCH data convention — the string itself is data, keep as-is). */
function ncSpan(text) {
  const t = String(text ?? "").trim();
  if (t === "" || t === "—" || /^n\.c\./i.test(t)) {
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

/** True when the CDN markdown stack finished loading (agent page only). */
function markdownEnabled() {
  return PAGE === "agent" && typeof marked !== "undefined" && typeof DOMPurify !== "undefined";
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

/** Markdown → sanitized HTML (marked + DOMPurify); the no-CDN/other-page
 *  fallback is the escapeHtml discipline — raw HTML is never produced. */
function renderMarkdown(text) {
  if (!markdownEnabled()) {
    return escapeHtml(text);
  }
  // marked.parse is synchronous by default; sanitize before any DOM touch
  return hardenLinks(DOMPurify.sanitize(marked.parse(String(text ?? ""))));
}

/* ------------------------------ Hero / timeline ------------------------------ */

function allEvents() {
  const out = [];
  for (const region of ["rennes", "nanterre"]) {
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
  let zoneTag;
  if (state.zones.size > 0 && ev.entry.coords) {
    let best = null;
    for (const key of state.zones) {
      const a = ANCHORS[key];
      if (!a) continue;
      const km = distKm(ev.entry.coords.lat, ev.entry.coords.lon, a.lat, a.lon);
      if (!best || km < best.km) best = { km, label: a.label };
    }
    zoneTag = best ? `à ${Math.round(best.km)} km de ${best.label}` : null;
  }
  const card = document.createElement("a");
  card.className = "event-card";
  card.href = `#entry-${ev.region}-${ev.entry.id}`;
  card.innerHTML = `
    <span class="ev-date">${escapeHtml(formatDate(ev.date))}</span>
    <span class="ev-rel${soon ? " soon" : ""}">${escapeHtml(rel)}</span>
    <div class="ev-orga">${escapeHtml(ev.entry.nom)}</div>
    <div class="ev-lieu">${escapeHtml(ev.lieu)} · <span class="${zoneTag ? "ev-zone" : "ev-region"}">${zoneTag ? escapeHtml(zoneTag) : ev.region === "rennes" ? "Rennes" : "Nanterre"}</span></div>
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

/** Click from the hero/past games: make sure the filters don't hide the row,
 *  then scroll+flash it. */
function scrollToEntry(region, id) {
  state.searches[region] = "";
  state.depFilters[region] = "";
  document.getElementById(`search-${region}`).value = "";
  document.getElementById(`dep-${region}`).value = "";
  renderTable(region);
  const row = document.getElementById(`entry-${region}-${id}`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 2000);
}

/** Deep-link on load: /…#entry-<region>-<id> (bookmark or external link)
 *  scrolls to the matching row and flashes it once the tables render. */
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
  const bounds = [];
  for (const region of ["rennes", "nanterre"]) {
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

/** Entries without coordinates, listed below the map. */
function renderNoGeo() {
  const zone = document.getElementById("no-geo");
  zone.innerHTML = "";
  const missing = ["rennes", "nanterre"]
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

function entryRegion(entry) {
  return (state.data.rennes || []).some((e) => e.id === entry.id) ? "rennes" : "nanterre";
}

/* ------------------------------ Tables ------------------------------ */

function populateDepSelect(region) {
  const select = document.getElementById(`dep-${region}`);
  // Re-population on refresh must not duplicate the "Tous départements" option
  const keep = select.querySelector("option[value='']");
  select.innerHTML = "";
  if (keep) select.appendChild(keep);
  const deps = [...new Set((state.data[region] || []).map((e) => e.dep))].sort((a, b) => a.localeCompare(b, "fr"));
  for (const dep of deps) {
    const opt = document.createElement("option");
    opt.value = dep;
    opt.textContent = dep;
    select.appendChild(opt);
  }
  // Keep the visible selection in sync with the active filter: after a refresh
  // the previous filter may no longer exist as an option — then clear both the
  // select and the filter state (and re-render so the table agrees).
  const filter = state.depFilters[region];
  if (filter && deps.includes(filter)) {
    select.value = filter;
  } else if (filter) {
    state.depFilters[region] = "";
    select.value = "";
    renderTable(region);
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

function filteredEntries(region) {
  const search = state.searches[region].trim().toLowerCase();
  const dep = state.depFilters[region];
  const { key, dir } = state.sorts[region];
  // includes(): handles composite deps like "78 / 95" (AMA France matches filter 78 as well as 95)
  let entries = (state.data[region] || []).filter(
    (e) =>
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

function renderTable(region) {
  const tbody = document.querySelector(`#table-${region} tbody`);
  const head = document.querySelector(`#table-${region} thead`);
  if (!tbody || !head) return;
  // Sort markers
  head.querySelectorAll("th .arrow").forEach((a) => a.remove());
  const { key, dir } = state.sorts[region];
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
  for (const entry of filteredEntries(region)) {
    const tr = document.createElement("tr");
    tr.className = "entry-row";
    tr.id = `entry-${region}-${entry.id}`;
    const detail = entry.statutDetail
      ? `<span class="status-detail">${escapeHtml(entry.statutDetail)}</span>` : "";
    tr.innerHTML = `
      <td class="cell-nom">${escapeHtml(entry.nom)}</td>
      <td>${ncSpan(entry.commune)}</td>
      <td>${escapeHtml(entry.dep)}</td>
      <td>${ncSpan(entry.distance)}</td>
      <td>${ncSpan(entry.type)}</td>
      <td><span class="badge ${escapeHtml(entry.statut)}">${escapeHtml(STATUS_LABEL[entry.statut] || entry.statut)}</span>${detail}</td>
      <td>${ncSpan(entry.frequence)}</td>
      <td>${eventsCellHtml(entry)}</td>
      <td>${ncSpan(entry.terrain)}</td>
      <td>${ncSpan(entry.cout)}</td>
      <td>${liensCellHtml(entry)}</td>`;
    tbody.appendChild(tr);
  }
  if (tbody.children.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="11"><em>Aucun résultat pour ces filtres.</em></td>`;
    tbody.appendChild(tr);
  }
}

function bindTableControls(region) {
  const search = document.getElementById(`search-${region}`);
  const dep = document.getElementById(`dep-${region}`);
  if (!search || !dep) return;
  search.addEventListener("input", () => {
    state.searches[region] = search.value;
    renderTable(region);
  });
  dep.addEventListener("change", () => {
    state.depFilters[region] = dep.value;
    renderTable(region);
  });
  document.querySelectorAll(`#table-${region} thead th`).forEach((th) => {
    th.addEventListener("click", () => {
      if (!th.dataset.key) return; // non-sortable columns (e.g. Liens)
      const k = th.dataset.key;
      const s = state.sorts[region];
      s.dir = s.key === k ? -s.dir : 1;
      s.key = k;
      renderTable(region);
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
  for (const region of ["rennes", "nanterre"]) {
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

/** Only non-zero chips are rendered (additions, modifications, purges, manual
 *  keeps, warnings). */
function historyChipsHtml(h) {
  const chips = [];
  if ((h.added || []).length > 0) chips.push(`<span class="hist-chip c-add">+${h.added.length} ajoutées</span>`);
  if ((h.updated || []).length > 0) chips.push(`<span class="hist-chip c-upd">~${h.updated.length} modifiées</span>`);
  if ((h.removedEvents || []).length > 0) chips.push(`<span class="hist-chip c-del">🗑 ${h.removedEvents.length} parties purgées</span>`);
  if ((h.manualKept || []).length > 0) chips.push(`<span class="hist-chip">⏸ ${h.manualKept.length} valeurs conservées</span>`);
  if ((h.warnings || []).length > 0) chips.push(`<span class="hist-chip">⚠ ${h.warnings.length} avertissements</span>`);
  return chips.join(" ");
}

/** Expandable details: added ids / updated id+field / removed event dates / manual-kept fields. */
function historyDetailHtml(h) {
  const parts = [];
  if ((h.added || []).length > 0) {
    parts.push(`<li>Ajoutées&nbsp;: ${h.added.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</li>`);
  }
  if ((h.updated || []).length > 0) {
    const items = h.updated.map((u) => `<code>${escapeHtml(u.id)}</code> . ${escapeHtml(u.field)}`).join(", ");
    parts.push(`<li>Champs modifiés&nbsp;: ${items}</li>`);
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
 *  pathname gets .active (accent + dash marker). Page-based replacement for
 *  the old in-page scrollspy — the nav links are real page links now. */
function setupNavActivePage() {
  const links = [...document.querySelectorAll(".nav-links a")];
  for (const link of links) {
    try {
      if (new URL(link.getAttribute("href"), location.href).pathname === location.pathname) {
        link.classList.add("active");
      }
    } catch {
      /* unparseable href: skip */
    }
  }
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
    renderTable("rennes");
    renderTable("nanterre");
    for (const r of ["rennes", "nanterre"]) populateDepSelect(r);
    handleEntryHash();
  }
  console.info(`Loaded: ${state.data.rennes.length} Rennes entries, ${state.data.nanterre.length} Nanterre entries`);
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
      renderHero();
    });
  });
  const maxKmInput = document.getElementById("max-km");
  const applyMaxKm = () => {
    const v = Number(maxKmInput.value);
    if (!Number.isFinite(v)) return;
    if (v < 10 || v > 500 || v === state.maxKm) return;
    state.maxKm = v;
    renderHero();
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
      renderHero();
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
  // Defensive: only render what actually exists in the payload
  for (const r of ["rennes", "nanterre"]) {
    if (!Array.isArray(state.data[r])) state.data[r] = [];
  }
  return json;
}

/** One-time setup per page (shared pieces everywhere, page pieces behind the
 *  dispatcher): map + tables + timeline filter (home), navigation + active-
 *  page highlight (all), run button (agent, same-origin deploys only). */
function setupStatic(page) {
  if (page === "home") {
    const mapOk = initMap();
    if (!mapOk) document.querySelector(".map-legend")?.style.setProperty("opacity", ".4");
    for (const r of ["rennes", "nanterre"]) {
      bindTableControls(r);
    }
    bindTimelineFilters();
  }
  setupNavigation();
  setupNavActivePage();
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
}

init();