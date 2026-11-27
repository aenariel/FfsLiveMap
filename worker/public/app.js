// Hive editor page: assign players to the numbered bear trap spots and save them to the hive-editor service.
// Layout (spots, traps, HQ) and MightPulse positions come from the FfsLiveMap repo (refreshed every 6 h);
// assignments come from /api/maps/<map>. Every step logs to the browser console.
"use strict";

const RAW = "https://raw.githubusercontent.com/aenariel/FfsLiveMap/main/";
const MAPS = {
  ffs: { label: "Ffs", tag: "Ffs", kd: "#1130", plan: "plan.csv", live: "live.csv", keys: ["BT1", "BT2"] },
  var: { label: "VAR", tag: "VAR", kd: "#2116", plan: "var-plan.csv", live: "var-live.csv", keys: ["BT1", "BT2"] }
};
const RADIUS = 18;
const SPOT_RE = /^BT\d-\d{3,4}$/;
const CODE_KEY = "hive-editor-code", MAP_KEY = "hive-editor-map", ZOOM_KEY = "hive-editor-zoom";
const COL = {
  ground: "#142722", grid: "rgba(170,210,190,0.07)", ring1: "#4a9e6e", ring2: "#2e7151", ring3: "#1d4434",
  soft1: "rgba(74,158,110,0.20)", soft2: "rgba(46,113,81,0.24)", soft3: "rgba(29,68,52,0.34)",
  ink: "#f3f6f1", sub: "#d3efdf", empty: "rgba(205,228,216,0.72)", edge: "rgba(170,210,190,0.38)",
  gold: "#e3b84a", green: "#7fd6a2", orange: "#ff9a3c", red: "#ff7474", grey: "#a9b6b0",
  trap: "#a8322a", trapEdge: "#ec7a62", hq: "#5a478f", hqEdge: "#b6a4e6", other: "rgba(120,140,132,0.35)", otherEdge: "rgba(170,190,180,0.5)"
};
const STATUS = {
  in: { col: COL.green, text: "In place" },
  away: { col: COL.red, text: "Assigned, city elsewhere" },
  blocked: { col: COL.orange, text: "Assigned, someone else is on it" },
  missing: { col: COL.grey, text: "Assigned, name not found on the map" },
  taken: { col: COL.orange, text: "Free, but someone is on it" },
  free: { col: COL.empty, text: "Free" }
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const fmt = iso => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "?";
const log = (...a) => console.log("[hive-editor]", ...a);

const S = {
  mapId: null, layout: null, live: null, server: null,
  pending: new Map(),      // spot -> player ("" clears)
  pendingBase: new Map(),  // spot -> saved value when the change was made (to spot conflicts)
  conflicts: new Set(), selected: null, swapFrom: null,
  code: localStorage.getItem(CODE_KEY) || "", me: null,
  zoom: Number(localStorage.getItem(ZOOM_KEY)) || 0, geo: null
};

/* ---------------- data ---------------- */
async function api(method, path, body) {
  const t0 = performance.now();
  const r = await fetch(path, { method, headers: { ...(S.code ? { authorization: "Bearer " + S.code } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  log(`${method} ${path} -> ${r.status} (${Math.round(performance.now() - t0)} ms)`);
  return { status: r.status, data: data || {} };
}

function parsePlan(text, cfg) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(",");
    if (p.length < 3) continue;
    const x = parseInt(p[1], 10), y = parseInt(p[2], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = p.length > 6 ? p[p.length - 1].trim().toUpperCase() : "";
    rows.push({ type: p[0].trim().toLowerCase(), x, y, label: (p[3] || "").trim().replace(/\|/g, ","), num: SPOT_RE.test(last) ? last : "" });
  }
  const norm = s => s.replace(/\s+/g, "").toUpperCase();
  const traps = cfg.keys.map(k => rows.find(r => r.type === "beartrap" && norm(r.label).includes(k))).filter(Boolean);
  if (traps.length < 2) throw new Error(`no bear traps labelled ${cfg.keys.join("/")} in ${cfg.plan}`);
  const tc = t => [t.x + 1.5, t.y + 1.5];
  const gap = (c, t) => Math.max(Math.max(0, c.x - (t.x + 3), t.x - (c.x + 2)), Math.max(0, c.y - (t.y + 3), t.y - (c.y + 2)));
  const spots = rows.filter(r => r.type === "city" && r.num).map(r => {
    const d = Math.min(...traps.map(t => Math.hypot(r.x + 1 - tc(t)[0], r.y + 1 - tc(t)[1])));
    const g = Math.min(...traps.map(t => gap(r, t)));
    return { num: r.num, x: r.x, y: r.y, label: r.label, d, ring: g === 0 ? 1 : g <= 2 ? 2 : 3 };
  }).filter(s => s.d <= RADIUS).sort((a, b) => a.num.localeCompare(b.num));
  const hq = rows.find(r => r.type === "hq" && norm(r.label) === norm(cfg.tag)) || null;
  const others = rows.filter(r => ["hq", "beartrap", "obs1", "obs2", "obs3"].includes(r.type) && !traps.includes(r) && r !== hq);
  return { rows, traps, hq, others, spots, byNum: new Map(spots.map(s => [s.num, s])) };
}
function parseLive(text) {
  let at = null; const cities = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.split(",");
    if (p[0] === "at") { at = Number(p[1]) * 1000; continue; }
    if (p.length < 4) continue;
    const x = parseInt(p[0], 10), y = parseInt(p[1], 10);
    if (!Number.isFinite(x)) continue;
    cities.push({ x, y, abbr: p[2].trim(), name: p.slice(3).join(",").replace(/\|/g, ",").trim() });
  }
  return { at, cities };
}

async function loadMap(id) {
  const cfg = MAPS[id];
  const t0 = performance.now();
  setStatus(`Loading ${cfg.label}…`);
  const bust = "?t=" + Math.floor(Date.now() / 120000);
  try {
    const [plan, live, srv] = await Promise.all([
      fetch(RAW + cfg.plan + bust).then(r => { if (!r.ok) throw new Error(`${cfg.plan}: HTTP ${r.status}`); return r.text(); }),
      fetch(RAW + cfg.live + bust).then(r => { if (!r.ok) throw new Error(`${cfg.live}: HTTP ${r.status}`); return r.text(); }),
      api("GET", `/api/maps/${id}`)
    ]);
    if (srv.status !== 200) throw new Error(srv.data.error || `assignments: HTTP ${srv.status}`);
    S.mapId = id; S.layout = parsePlan(plan, cfg); S.live = parseLive(live); S.server = toServer(srv.data);
    S.pending.clear(); S.pendingBase.clear(); S.conflicts.clear(); S.selected = null; S.swapFrom = null;
    localStorage.setItem(MAP_KEY, id);
    log(`${cfg.label}: ${S.layout.spots.length} spots, ${S.live.cities.length} towns, ${S.server.map.size} assignments (v${S.server.version}) in ${Math.round(performance.now() - t0)} ms`);
    renderAll(true);
    loadHistory();
  } catch (e) {
    log("load failed", e);
    setStatus(`Couldn't load ${cfg.label}: ${e.message}`, "bad");
  }
}
function toServer(d) {
  return { version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy, map: new Map(d.assignments.map(a => [a.spot, a])) };
}

/* ---------------- model ---------------- */
const saved = num => S.server.map.get(num)?.player || "";
const effective = num => S.pending.has(num) ? S.pending.get(num) : saved(num);
const canEdit = () => !!(S.me && S.me.maps.includes(S.mapId));
const overlaps = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;

function statusOf(spot) {
  const name = effective(spot.num);
  const occ = S.live.cities.filter(c => overlaps(c, spot));
  if (!name) return { key: occ.length ? "taken" : "free", occ };
  const f = fold(name), tag = MAPS[S.mapId].tag;
  const cands = S.live.cities.filter(c => fold(c.name) === f).sort((a, b) => (b.abbr === tag) - (a.abbr === tag));
  const me = cands.find(c => c.x === spot.x && c.y === spot.y) || cands[0] || null;
  const others = occ.filter(c => c !== me);
  if (me && me.x === spot.x && me.y === spot.y) return { key: "in", me, occ };
  if (others.length) return { key: "blocked", me, occ: others };
  if (me) return { key: "away", me, occ };
  return { key: "missing", occ };
}
function spotOfPlayer(name, except) {
  const f = fold(name);
  if (!f) return null;
  for (const s of S.layout.spots) if (s.num !== except && fold(effective(s.num)) === f) return s.num;
  for (const [num] of S.server.map) if (num !== except && !S.layout.byNum.has(num) && fold(effective(num)) === f) return num;
  return null;
}

function setPending(num, player) {
  player = String(player || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!S.pendingBase.has(num)) S.pendingBase.set(num, saved(num));
  if (player === saved(num)) { S.pending.delete(num); S.pendingBase.delete(num); S.conflicts.delete(num); }
  else S.pending.set(num, player);
}
// Put a player on a spot; if they already hold another spot, that one is freed (a move).
function assign(num, player) {
  const from = player ? spotOfPlayer(player, num) : null;
  if (from) setPending(from, "");
  setPending(num, player);
  log(`assign ${num} = "${player}"${from ? ` (moved from ${from})` : ""}`);
  renderAll();
  return from;
}
function swap(a, b) {
  const pa = effective(a), pb = effective(b);
  setPending(a, pb); setPending(b, pa);
  log(`swap ${a} "${pa}" <-> ${b} "${pb}"`);
  renderAll();
}

/* ---------------- map drawing ---------------- */
function geometry() {
  const L = S.layout;
  const wrap = $("stage").clientWidth || 800;
  const pts = [];
  const add = (r, s) => { for (const [dx, dy] of [[0, 0], [s, 0], [s, s], [0, s]]) pts.push([r.x + dx, r.y + dy]); };
  L.spots.forEach(s => add(s, 2)); L.traps.forEach(t => add(t, 3)); if (L.hq) add(L.hq, 3);
  const u = pts.map(([x, y]) => x - y), v = pts.map(([x, y]) => -(x + y));
  const uMin = Math.min(...u) - 2, uMax = Math.max(...u) + 2, vMin = Math.min(...v) - 2, vMax = Math.max(...v) + 2;
  const fitH = (wrap - 4) / (uMax - uMin);           // pixels per half-diagonal unit that fit the width
  const H = S.zoom > 0 ? S.zoom : Math.max(fitH, 20); // never so small that the names disappear
  const W = Math.round((uMax - uMin) * H), Ht = Math.round((vMax - vMin) * H);
  const P = (gx, gy) => [((gx - gy) - uMin) * H, (-(gx + gy) - vMin) * H];
  const toGrid = (px, py) => { const a = px / H + uMin, b = -(py / H + vMin); return [(a + b) / 2, (b - a) / 2]; };
  return { H, W, Ht, P, toGrid, fitH, bounds: { uMin, uMax, vMin, vMax } };
}
function fitText(ctx, t, maxW, weight, size, min, fam) {
  for (let s = size; s >= min; s -= 0.5) { ctx.font = `${weight} ${s}px ${fam}`; if (ctx.measureText(t).width <= maxW) return t; }
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
function drawMap() {
  const g = S.geo = geometry();
  const cv = $("map"), dpr = window.devicePixelRatio || 1;
  cv.width = g.W * dpr; cv.height = g.Ht * dpr; cv.style.width = g.W + "px"; cv.style.height = g.Ht + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.ground; ctx.fillRect(0, 0, g.W, g.Ht);
  const poly = pts => { ctx.beginPath(); ctx.moveTo(...pts[0]); for (const p of pts.slice(1)) ctx.lineTo(...p); ctx.closePath(); };
  const sq = (r, s) => [g.P(r.x, r.y), g.P(r.x + s, r.y), g.P(r.x + s, r.y + s), g.P(r.x, r.y + s)];
  const MONO = '"IBM Plex Mono", Consolas, monospace', BODY = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';

  // other structures (other alliances' HQs and traps, statues, nodes) in grey, for orientation
  const SZ = { hq: 3, beartrap: 3, obs3: 3, obs2: 2, obs1: 1 };
  for (const o of S.layout.others) {
    poly(sq(o, SZ[o.type] || 2)); ctx.fillStyle = COL.other; ctx.fill(); ctx.strokeStyle = COL.otherEdge; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const maxW = g.H * 2.7;
  for (const s of S.layout.spots) {
    const st = statusOf(s), name = effective(s.num), changed = S.pending.has(s.num);
    const [cx, cy] = g.P(s.x + 1, s.y + 1);
    poly(sq(s, 2));
    if (name) { ctx.fillStyle = s.ring === 1 ? COL.ring1 : s.ring === 2 ? COL.ring2 : COL.ring3; ctx.fill(); }
    else { ctx.fillStyle = s.ring === 1 ? COL.soft1 : s.ring === 2 ? COL.soft2 : COL.soft3; ctx.fill(); }
    ctx.lineWidth = st.key === "in" ? 1 : 2.5;
    ctx.strokeStyle = st.key === "in" ? COL.edge : STATUS[st.key].col;
    if (!name) ctx.setLineDash([5, 4]);
    ctx.stroke(); ctx.setLineDash([]);
    if (changed || s.num === S.selected || s.num === S.swapFrom) {
      const inset = sq(s, 2).map(([px, py]) => [cx + (px - cx) * 0.86, cy + (py - cy) * 0.86]);
      poly(inset); ctx.lineWidth = s.num === S.selected ? 3.5 : 2; ctx.strokeStyle = COL.gold;
      if (s.num === S.swapFrom) ctx.setLineDash([6, 4]);
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (g.H < 13) continue; // too small for text
    const k = g.H / 30;
    const lines = [
      { t: s.num, w: 700, s: 12 * k, f: MONO, c: COL.gold },
      { t: name || (st.key === "taken" ? "blocked" : "free"), w: 600, s: 14 * k, f: BODY, c: name ? COL.ink : (st.key === "taken" ? COL.orange : COL.empty) },
      { t: `${s.x}:${s.y}`, w: 500, s: 11 * k, f: MONO, c: name ? COL.sub : COL.empty }
    ];
    const total = lines.reduce((a, l) => a + l.s, 0) + 2 * k * 2;
    let y = cy - total / 2;
    for (const l of lines) {
      ctx.fillStyle = l.c; ctx.fillText(fitText(ctx, l.t, maxW, l.w, l.s, Math.max(7, l.s * 0.7), l.f), cx, y + l.s / 2);
      y += l.s + 2 * k;
    }
  }
  const big = (r, fill, edge, title) => {
    poly(sq(r, 3)); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.stroke();
    const [cx, cy] = g.P(r.x + 1.5, r.y + 1.5);
    ctx.fillStyle = COL.ink; ctx.font = `700 ${Math.max(10, g.H * 0.8)}px ${BODY}`; ctx.fillText(title, cx, cy);
  };
  if (S.layout.hq) big(S.layout.hq, COL.hq, COL.hqEdge, "HQ");
  S.layout.traps.forEach((t, i) => big(t, COL.trap, COL.trapEdge, MAPS[S.mapId].keys[i]));
}
function spotAt(px, py) {
  const [gx, gy] = S.geo.toGrid(px, py);
  return S.layout.spots.find(s => gx >= s.x && gx < s.x + 2 && gy >= s.y && gy < s.y + 2) || null;
}

/* ---------------- panels ---------------- */
function setStatus(text, cls) { const el = $("status"); el.textContent = text; el.className = "status " + (cls || ""); }

function renderTabs() {
  $("mapTabs").innerHTML = Object.entries(MAPS).map(([id, m]) => `<button data-map="${id}" class="${id === S.mapId ? "on" : ""}">${esc(m.label)} <span class="muted small">${esc(m.kd)}</span></button>`).join("");
}
function renderWho() {
  $("who").textContent = S.me ? `${S.me.name}${S.me.admin ? " (admin)" : ""}` : "Not signed in";
  const info = $("signinInfo");
  if (S.me) {
    info.innerHTML = `Signed in as <b>${esc(S.me.name)}</b>. Can edit: ${S.me.maps.map(m => MAPS[m]?.label || m).join(", ") || "nothing"}.` +
      (S.me.limit ? ` Saves today: ${S.me.used} of ${S.me.limit}.` : "");
    $("signOut").hidden = false; $("signinForm").hidden = true;
  } else {
    info.textContent = "Ask leadership for your code. It's kept on this device after you sign in.";
    $("signOut").hidden = true; $("signinForm").hidden = false;
  }
  $("cardAdmin").hidden = !(S.me && S.me.admin);
  $("cardImport").hidden = !(S.me && S.me.admin);
}
function renderLegend() {
  $("legend").innerHTML = Object.values(STATUS).map(s => `<span><i style="background:${s.col}"></i>${esc(s.text)}</span>`).join("") +
    `<span><i style="background:${COL.gold}"></i>Changed / selected</span>`;
}
function renderSpot() {
  const body = $("spotBody");
  const num = S.selected;
  document.body.classList.toggle("hasSel", !!num);
  if (num) $("cardSpot").open = true;
  if (!num) { body.innerHTML = `<p class="muted">Tap a spot on the map or in the list.</p>`; return; }
  const s = S.layout.byNum.get(num);
  const st = statusOf(s), name = effective(num), was = saved(num), srv = S.server.map.get(num);
  const members = S.live.cities.filter(c => c.abbr === MAPS[S.mapId].tag).map(c => c.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const where = st.me && !(st.me.x === s.x && st.me.y === s.y) ? ` (city now at ${st.me.x}:${st.me.y})` : "";
  const onIt = st.occ.filter(c => !st.me || c !== st.me).map(c => `${c.abbr ? "[" + c.abbr + "] " : ""}${c.name} ${c.x}:${c.y}`);
  body.innerHTML = `
    <div class="spotHead"><b>${esc(num)}</b><span class="mono">${s.x} : ${s.y}</span><span class="muted">row ${s.ring === 3 ? "3+" : s.ring}</span><button class="link closeSel" id="closeSel">close</button></div>
    <div class="kv">
      <span>Player</span><span>${name ? esc(name) : '<span class="muted">none</span>'}${S.pending.has(num) ? ` <span class="gold small">(was ${was ? esc(was) : "empty"})</span>` : ""}</span>
      <span>Status</span><span style="color:${STATUS[st.key].col}">${esc(STATUS[st.key].text)}${esc(where)}</span>
      ${onIt.length ? `<span>On the spot</span><span>${onIt.map(esc).join("<br>")}</span>` : ""}
      ${srv ? `<span>Last saved</span><span class="small">${esc(srv.by)}, ${esc(fmt(srv.at))}</span>` : ""}
    </div>
    ${canEdit() ? `
    <form id="assignForm" class="row">
      <input id="assignName" list="memberList" placeholder="Player name" autocomplete="off" value="${esc(name)}">
      <datalist id="memberList">${members.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
      <button type="submit">Set</button>
    </form>
    <div class="row">
      <button id="clearBtn" ${name ? "" : "disabled"}>Clear</button>
      <button id="swapBtn" class="${S.swapFrom === num ? "on" : ""}">${S.swapFrom === num ? "Tap the other spot…" : "Swap with…"}</button>
      ${S.pending.has(num) ? `<button id="undoBtn">Undo</button>` : ""}
    </div>
    <div id="assignMsg" class="small"></div>` : `<p class="muted small">${S.me ? "Your code can't edit this map." : "Sign in to edit."}</p>`}`;
  $("closeSel").onclick = () => select(null);
  if (!canEdit()) return;
  $("assignForm").onsubmit = e => {
    e.preventDefault();
    const v = $("assignName").value.trim();
    const from = assign(num, v);
    if (from) $("assignMsg").innerHTML = `<span class="gold">${esc(v)} moved here from ${esc(from)}, which is now free.</span>`;
  };
  $("clearBtn").onclick = () => assign(num, "");
  $("swapBtn").onclick = () => { S.swapFrom = S.swapFrom === num ? null : num; renderAll(); };
  if ($("undoBtn")) $("undoBtn").onclick = () => { S.pending.delete(num); S.pendingBase.delete(num); S.conflicts.delete(num); renderAll(); };
}
function renderPending() {
  const items = [...S.pending.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  $("pendingCount").textContent = items.length;
  $("pendingList").innerHTML = items.length ? items.map(([num, p]) => `<li data-num="${esc(num)}">${S.conflicts.has(num) ? '<span class="warn" title="Someone else changed this spot since">⚠</span> ' : ""}<b class="mono gold">${esc(num)}</b> ${esc(saved(num) || "empty")} → <b>${esc(p || "empty")}</b> <button class="link" data-undo="${esc(num)}">undo</button></li>`).join("") : `<li class="muted">No changes.</li>`;
  $("submitBtn").disabled = !items.length || !canEdit();
  $("discardBtn").disabled = !items.length;
}
function renderSpots() {
  const q = fold($("spotFilter").value);
  const rows = S.layout.spots.filter(s => !q || fold(s.num).includes(q) || fold(effective(s.num)).includes(q) || fold(`${s.x}:${s.y}`).includes(q) || fold(`${s.x} ${s.y}`).includes(q));
  $("spotsCount").textContent = `${S.layout.spots.filter(s => effective(s.num)).length} / ${S.layout.spots.length}`;
  $("spotTable").innerHTML = rows.map(s => {
    const st = statusOf(s), n = effective(s.num);
    return `<tr data-num="${s.num}" class="${s.num === S.selected ? "sel" : ""} ${S.pending.has(s.num) ? "changed" : ""}"><td><span class="dot" style="background:${STATUS[st.key].col}"></span></td><td class="mono gold">${s.num}</td><td class="mono">${s.x}:${s.y}</td><td class="name">${n ? esc(n) : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
}
function renderMembers() {
  const tag = MAPS[S.mapId].tag;
  const held = new Set();
  for (const s of S.layout.spots) { const n = effective(s.num); if (n) held.add(fold(n)); }
  const list = S.live.cities.filter(c => c.abbr === tag && !held.has(fold(c.name))).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  $("membersCount").textContent = list.length;
  $("membersList").innerHTML = list.map(c => `<li data-name="${esc(c.name)}" title="${c.x}:${c.y}">${esc(c.name)}</li>`).join("") || `<li class="muted">Everyone has a spot.</li>`;
}
function renderOrphans() {
  const list = [...new Set([...S.server.map.keys(), ...S.pending.keys()])].filter(num => !S.layout.byNum.has(num) && effective(num));
  $("cardOrphans").hidden = !list.length;
  $("orphansCount").textContent = list.length;
  $("orphansList").innerHTML = list.map(num => `<li><b class="mono gold">${esc(num)}</b> ${esc(effective(num))} ${canEdit() ? `<button class="link" data-clear="${esc(num)}">clear</button>` : ""}</li>`).join("");
}
function renderStatusLine() {
  const cfg = MAPS[S.mapId], sv = S.server;
  setStatus(`${cfg.label} ${cfg.kd} · ${S.layout.spots.length} spots · positions from MightPulse ${S.live.at ? fmt(new Date(S.live.at).toISOString()) : "?"} · assignments v${sv.version}${sv.updatedAt ? ` (${fmt(sv.updatedAt)} by ${sv.updatedBy})` : ""}`);
}
function renderAll(fit) {
  renderTabs(); renderWho(); renderLegend();
  if (!S.layout) return;
  if (fit) { S.zoom = Number(localStorage.getItem(ZOOM_KEY + "-" + S.mapId)) || 0; }
  drawMap(); renderSpot(); renderPending(); renderSpots(); renderMembers(); renderOrphans(); renderStatusLine(); renderImport();
}

/* ---------------- history, admin ---------------- */
async function loadHistory() {
  if (!S.me || !S.me.maps.includes(S.mapId)) { $("historyList").innerHTML = `<li class="muted">${S.me ? "Not available for this map." : "Sign in to see the history."}</li>`; return; }
  const r = await api("GET", `/api/maps/${S.mapId}/history?limit=40`);
  if (r.status !== 200) { $("historyList").innerHTML = `<li class="bad">${esc(r.data.error || "Couldn't load the history.")}</li>`; return; }
  $("historyList").innerHTML = r.data.history.map(h => `<li><b>v${h.version}</b> · ${esc(h.editor)} · ${esc(fmt(h.at))}<br>${h.changes.map(c => `<span class="mono gold">${esc(c.spot)}</span> ${esc(c.before || "empty")} → ${esc(c.after || "empty")}`).join("<br>")}</li>`).join("") || `<li class="muted">No saves yet.</li>`;
}
async function loadEditors() {
  if (!S.me || !S.me.admin) return;
  const r = await api("GET", "/api/editors");
  if (r.status !== 200) { $("editorsList").innerHTML = `<p class="bad">${esc(r.data.error)}</p>`; return; }
  const maps = r.data.maps;
  $("newMaps").innerHTML = maps.map(m => `<label class="small"><input type="checkbox" value="${esc(m)}"> ${esc(MAPS[m]?.label || m)}</label>`).join("");
  $("editorsList").innerHTML = r.data.editors.map(e => `
    <div class="editor" data-id="${e.id}">
      <div><b>${esc(e.name)}</b> <span class="muted small">${e.saves} saves${e.lastSave ? ", last " + esc(fmt(e.lastSave)) : ""}</span></div>
      <div class="row small">
        ${maps.map(m => `<label><input type="checkbox" data-field="maps" value="${esc(m)}" ${e.maps.includes(m) ? "checked" : ""}> ${esc(MAPS[m]?.label || m)}</label>`).join("")}
        <label><input type="checkbox" data-field="admin" ${e.admin ? "checked" : ""}> admin</label>
        <label><input type="checkbox" data-field="active" ${e.active ? "checked" : ""}> active</label>
      </div>
      <div class="row"><button data-act="code">New code</button><button data-act="del" class="danger">Remove</button></div>
    </div>`).join("") || `<p class="muted">No editors yet.</p>`;
}
function showCode(name, code) {
  const box = $("codeBox");
  box.hidden = false;
  box.innerHTML = `Code for <b>${esc(name)}</b> (shown only now, copy it):<br><code>${esc(code)}</code> <button id="copyCode">Copy</button>`;
  $("copyCode").onclick = () => navigator.clipboard.writeText(code).then(() => { $("copyCode").textContent = "Copied"; });
}
function importCandidates() {
  if (!S.layout) return [];
  const tag = fold(MAPS[S.mapId].tag);
  return S.layout.spots.filter(s => s.label && !SPOT_RE.test(s.label.toUpperCase()) && fold(s.label) !== "city" && fold(s.label) !== tag).map(s => ({ spot: s.num, player: s.label }));
}
function renderImport() {
  if ($("cardImport").hidden) return;
  const c = importCandidates();
  $("importInfo").textContent = `${c.length} names found in the ksmapper plan of ${MAPS[S.mapId].label}; ${S.server.map.size} assignments saved now.`;
  $("importBtn").disabled = !c.length || S.pending.size > 0;
}

/* ---------------- actions ---------------- */
async function signIn(code) {
  S.code = code.trim();
  const r = await api("GET", "/api/me");
  if (r.status !== 200) {
    S.code = ""; S.me = null; localStorage.removeItem(CODE_KEY);
    $("signinInfo").innerHTML = `<span class="bad">${esc(r.data.error || "Sign-in failed.")}</span>`;
    return;
  }
  S.me = r.data; localStorage.setItem(CODE_KEY, S.code);
  log(`signed in as ${S.me.name}, maps ${S.me.maps.join(",")}${S.me.admin ? ", admin" : ""}`);
  renderAll(); loadHistory(); loadEditors();
}
async function submit() {
  const changes = [...S.pending.entries()].map(([spot, player]) => ({ spot, player }));
  $("submitBtn").disabled = true;
  $("submitMsg").textContent = `Saving ${changes.length} change(s)…`;
  const r = await api("POST", `/api/maps/${S.mapId}`, { base: S.server.version, changes });
  const msg = $("submitMsg");
  if (r.status === 200) {
    S.server = toServer(r.data); S.pending.clear(); S.pendingBase.clear(); S.conflicts.clear();
    if (S.me && r.data.used !== undefined) S.me.used = r.data.used;
    msg.innerHTML = r.data.unchanged ? `<span class="muted">Nothing to save.</span>`
      : `<span class="ok">Saved ${r.data.saved} change(s) as v${r.data.version}.</span> ${r.data.rerender ? "The map image updates in a few minutes." : "The map image updates on the next 6-hourly refresh."}`;
    renderAll(); loadHistory();
    return;
  }
  if (r.status === 409 && r.data.current) {
    S.server = toServer(r.data.current);
    for (const [num, base] of S.pendingBase) if (saved(num) !== base) { S.conflicts.add(num); S.pendingBase.set(num, saved(num)); }
    for (const [num, p] of [...S.pending]) if (p === saved(num)) { S.pending.delete(num); S.pendingBase.delete(num); S.conflicts.delete(num); }
    msg.innerHTML = `<span class="warn">Someone else saved this map meanwhile. The map now shows their changes plus yours.${S.conflicts.size ? " Check the spots marked ⚠ (they changed those too), then press Submit again." : " Press Submit again to save yours."}</span>`;
    renderAll(); loadHistory();
    return;
  }
  if (r.status === 401) { S.me = null; S.code = ""; localStorage.removeItem(CODE_KEY); renderAll(); }
  msg.innerHTML = `<span class="bad">${esc(r.data.error || "Save failed (HTTP " + r.status + ").")}</span>`;
  renderPending();
}

function select(num) {
  if (S.swapFrom && num && S.swapFrom !== num) { const a = S.swapFrom; S.swapFrom = null; swap(a, num); S.selected = num; renderAll(); return; }
  S.selected = num; renderAll();
  if (num) { // scroll the list only, never the page
    const tr = $("spotTable").querySelector(`tr[data-num="${num}"]`), wrap = tr && tr.closest(".tablewrap");
    if (wrap) wrap.scrollTop = Math.max(0, tr.offsetTop - wrap.clientHeight / 2);
  }
}

function wire() {
  $("mapTabs").onclick = e => {
    const b = e.target.closest("button[data-map]");
    if (!b || b.dataset.map === S.mapId) return;
    if (S.pending.size && !confirm("Discard the changes you haven't saved?")) return;
    loadMap(b.dataset.map);
  };
  $("map").onclick = e => {
    const r = $("map").getBoundingClientRect();
    const s = spotAt(e.clientX - r.left, e.clientY - r.top);
    select(s ? s.num : null);
  };
  $("spotTable").onclick = e => { const tr = e.target.closest("tr[data-num]"); if (tr) select(tr.dataset.num); };
  $("spotFilter").oninput = renderSpots;
  $("membersList").onclick = e => {
    const li = e.target.closest("li[data-name]");
    if (!li || !canEdit()) return;
    if (!S.selected) { setStatus("Select a spot first, then tap a name.", "warn"); return; }
    assign(S.selected, li.dataset.name);
  };
  $("orphansList").onclick = e => { const b = e.target.closest("[data-clear]"); if (b) assign(b.dataset.clear, ""); };
  $("pendingList").onclick = e => {
    const b = e.target.closest("[data-undo]");
    if (b) { const n = b.dataset.undo; S.pending.delete(n); S.pendingBase.delete(n); S.conflicts.delete(n); renderAll(); return; }
    const li = e.target.closest("li[data-num]"); if (li && S.layout.byNum.has(li.dataset.num)) select(li.dataset.num);
  };
  $("submitBtn").onclick = submit;
  $("discardBtn").onclick = () => { if (confirm("Discard all changes you haven't saved?")) { S.pending.clear(); S.pendingBase.clear(); S.conflicts.clear(); renderAll(); } };
  $("signinForm").onsubmit = e => { e.preventDefault(); signIn($("codeInput").value); };
  $("signOut").onclick = () => { S.me = null; S.code = ""; localStorage.removeItem(CODE_KEY); $("codeInput").value = ""; renderAll(); loadHistory(); };
  const zoomTo = h => { S.zoom = h; localStorage.setItem(ZOOM_KEY + "-" + S.mapId, String(h || "")); drawMap(); };
  $("zoomIn").onclick = () => zoomTo((S.geo ? S.geo.H : 20) * 1.25);
  $("zoomOut").onclick = () => zoomTo(Math.max(8, (S.geo ? S.geo.H : 20) / 1.25));
  $("zoomFit").onclick = () => zoomTo(0);
  let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (S.layout && !S.zoom) drawMap(); }, 200); });
  window.addEventListener("beforeunload", e => { if (S.pending.size) { e.preventDefault(); e.returnValue = ""; } });

  $("addEditor").onsubmit = async e => {
    e.preventDefault();
    const name = $("newName").value.trim();
    if (!name) return;
    const maps = [...$("newMaps").querySelectorAll("input:checked")].map(i => i.value);
    const r = await api("POST", "/api/editors", { name, maps, admin: $("newAdmin").checked });
    if (r.status !== 200) { $("codeBox").hidden = false; $("codeBox").innerHTML = `<span class="bad">${esc(r.data.error)}</span>`; return; }
    $("newName").value = ""; $("newAdmin").checked = false;
    showCode(r.data.name, r.data.code); loadEditors();
  };
  $("editorsList").onchange = async e => {
    const box = e.target.closest(".editor"); if (!box) return;
    const id = box.dataset.id, f = e.target.dataset.field;
    const body = f === "maps" ? { maps: [...box.querySelectorAll('input[data-field="maps"]:checked')].map(i => i.value) } : { [f]: e.target.checked };
    const r = await api("PATCH", `/api/editors/${id}`, body);
    if (r.status !== 200) alert(r.data.error || "Change failed.");
    loadEditors();
  };
  $("editorsList").onclick = async e => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const box = b.closest(".editor"), id = box.dataset.id, name = box.querySelector("b").textContent;
    if (b.dataset.act === "code") {
      if (!confirm(`Give ${name} a new code? The current one stops working.`)) return;
      const r = await api("POST", `/api/editors/${id}/code`);
      if (r.status === 200) showCode(name, r.data.code); else alert(r.data.error);
    } else if (b.dataset.act === "del") {
      if (!confirm(`Remove ${name}? Their saves stay in the history.`)) return;
      const r = await api("DELETE", `/api/editors/${id}`);
      if (r.status !== 200) alert(r.data.error);
    }
    loadEditors();
  };
  $("importBtn").onclick = async () => {
    const c = importCandidates();
    if (!confirm(`Replace all ${S.server.map.size} assignments of ${MAPS[S.mapId].label} with the ${c.length} names from the ksmapper plan?`)) return;
    const r = await api("POST", `/api/maps/${S.mapId}`, { base: S.server.version, replace: true, changes: c });
    if (r.status === 200) { S.server = toServer(r.data); renderAll(); loadHistory(); $("importInfo").innerHTML = `<span class="ok">Imported: v${r.data.version}, ${r.data.assignments.length} assignments.</span>`; }
    else $("importInfo").innerHTML = `<span class="bad">${esc(r.data.error || "Import failed.")}</span>`;
  };
}

(async function start() {
  wire();
  const want = (location.hash || "").slice(1);
  const id = MAPS[want] ? want : (MAPS[localStorage.getItem(MAP_KEY)] ? localStorage.getItem(MAP_KEY) : "ffs");
  renderTabs(); renderWho();
  if (S.code) await signIn(S.code);
  await loadMap(id);
})();
