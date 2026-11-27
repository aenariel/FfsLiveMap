// Hive editor API (Cloudflare Worker + D1).
//
// Public:
//   GET  /api/maps                     maps with their version
//   GET  /api/maps/:map                current assignments (read by the map refresh and the editor page)
// Editors (header "Authorization: Bearer <code>"):
//   GET  /api/me                       who am I, which maps, submissions left today
//   GET  /api/maps/:map/history        last saved submissions of a map
//   POST /api/maps/:map                save changes {base, changes:[{spot, player}]} (player "" clears the spot)
// Admin only:
//   GET    /api/editors                list editors
//   POST   /api/editors                add an editor {name, maps:[...], admin} -> returns the new code once
//   PATCH  /api/editors/:id            change {name, maps, admin, active}
//   POST   /api/editors/:id/code       new code (the old one stops working) -> returns it once
//   DELETE /api/editors/:id            remove the editor (their history stays)
//
// The admin code from the ADMIN_CODE secret always works, so access can't be lost.
// Every request is logged (one line), visible in the Cloudflare dashboard (Workers -> hive-editor -> Logs).

const SPOT_RE = /^BT\d-\d{3,4}$/;
const MAX_NAME = 40;
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const CORS = { "access-control-allow-origin": "*" };
const err = (status, message, extra) => json({ error: message, ...extra }, status);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const today = () => new Date().toISOString().slice(0, 10);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// 12 characters without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX-XXXX.
function newCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = [...r].map(b => abc[b % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
const normCode = c => String(c || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

function cleanName(s) {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return t.slice(0, MAX_NAME);
}
const mapList = env => String(env.MAPS || "").split(",").map(s => s.trim()).filter(Boolean);
const editorMaps = e => String(e.maps || "").split(",").map(s => s.trim()).filter(Boolean);

async function whoIs(request, env) {
  const h = request.headers.get("authorization") || "";
  const code = normCode(h.replace(/^Bearer\s+/i, ""));
  if (!code) return null;
  if (env.ADMIN_CODE && code === normCode(env.ADMIN_CODE)) {
    return { id: null, name: env.ADMIN_NAME || "Admin", maps: mapList(env), admin: true };
  }
  const row = await env.DB.prepare("SELECT * FROM editors WHERE code_hash = ? AND active = 1").bind(await sha256(code)).first();
  if (!row) return null;
  return { id: row.id, name: row.name, maps: row.admin ? mapList(env) : editorMaps(row), admin: !!row.admin };
}

async function usedToday(env, who) {
  if (who.id === null) return 0;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM history WHERE editor_id = ? AND substr(at, 1, 10) = ?").bind(who.id, today()).first();
  return r ? r.n : 0;
}

async function readMap(env, map) {
  const m = await env.DB.prepare("SELECT * FROM maps WHERE id = ?").bind(map).first();
  const { results } = await env.DB.prepare("SELECT spot, player, updated_by AS by, updated_at AS at FROM assignments WHERE map = ? ORDER BY spot").bind(map).all();
  return { map, version: m ? m.version : 0, updatedAt: m ? m.updated_at : null, updatedBy: m ? m.updated_by : null, assignments: results };
}

// Ask GitHub to re-render the maps right away (step 4). Only when the GH_DISPATCH_TOKEN secret is set.
// GitHub keeps at most one run waiting (concurrency group), so several submits in a row cost one extra run.
async function dispatchRender(env, reason) {
  if (!env.GH_DISPATCH_TOKEN) { console.log("dispatch: no GH_DISPATCH_TOKEN, skipped"); return; }
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "hive-editor", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { update: false } })
  });
  console.log(`dispatch: ${reason} -> HTTP ${r.status} in ${Date.now() - t0} ms${r.ok ? "" : " " + (await r.text()).slice(0, 200)}`);
}

async function submit(request, env, ctx, map, who) {
  if (!who.maps.includes(map)) return err(403, `You can't edit the ${map} map.`);
  const limit = Number(env.DAILY_LIMIT) || 50;
  const used = await usedToday(env, who);
  if (used >= limit) return err(429, `Daily limit reached (${limit} saves per day). It resets at 00:00 UTC.`, { used, limit });

  let body;
  try { body = await request.json(); } catch (_) { return err(400, "Body must be JSON."); }
  const base = Number(body.base);
  const raw = Array.isArray(body.changes) ? body.changes : null;
  if (!raw || !raw.length) return err(400, "No changes sent.");
  if (raw.length > 500) return err(400, "Too many changes in one save (500 max).");
  const replace = !!body.replace;
  if (replace && !who.admin) return err(403, "Only the admin can replace a whole map.");

  const changes = new Map();
  for (const c of raw) {
    const spot = String(c && c.spot || "").trim().toUpperCase();
    if (!SPOT_RE.test(spot)) return err(400, `Bad spot number "${spot}" (expected e.g. BT1-012).`);
    changes.set(spot, cleanName(c.player));
  }

  const cur = await readMap(env, map);
  if (base !== cur.version) {
    console.log(`submit ${map}: ${who.name} sent base ${base}, current ${cur.version} -> conflict`);
    return err(409, "Someone changed this map since you loaded it. Reload to see their changes, then redo yours.", { current: cur });
  }

  // Resulting assignments, to check for a player on two spots.
  const after = new Map(replace ? [] : cur.assignments.map(a => [a.spot, a.player]));
  for (const [spot, player] of changes) player ? after.set(spot, player) : after.delete(spot);
  const seen = new Map(), dupes = [];
  for (const [spot, player] of after) {
    const k = player.toLowerCase();
    if (seen.has(k)) dupes.push(`${player} (${seen.get(k)} and ${spot})`); else seen.set(k, spot);
  }
  if (dupes.length) return err(422, `A player can only hold one spot: ${dupes.join(", ")}.`, { dupes });

  const before = new Map(cur.assignments.map(a => [a.spot, a.player]));
  const diff = [];
  for (const spot of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(spot) || "", a = after.get(spot) || "";
    if (b !== a) diff.push({ spot, before: b, after: a });
  }
  if (!diff.length) return json({ ok: true, unchanged: true, ...cur });

  const at = now(), version = cur.version + 1;
  const token = crypto.randomUUID();
  // All statements run in one D1 batch (a transaction). The first moves the version only if nobody else did;
  // every other statement only acts if the map's token is still this save's, so a save that loses a race
  // writes nothing.
  const mine = "(SELECT token FROM maps WHERE id = ?) = ?";
  const stmts = [
    cur.version === 0
      ? env.DB.prepare("INSERT INTO maps (id, version, updated_at, updated_by, token) VALUES (?, 1, ?, ?, ?)").bind(map, at, who.name, token)
      : env.DB.prepare("UPDATE maps SET version = ?, updated_at = ?, updated_by = ?, token = ? WHERE id = ? AND version = ?").bind(version, at, who.name, token, map, cur.version)
  ];
  for (const d of diff) {
    stmts.push(d.after
      ? env.DB.prepare(`INSERT INTO assignments (map, spot, player, updated_by, updated_at) SELECT ?, ?, ?, ?, ? WHERE ${mine} ON CONFLICT (map, spot) DO UPDATE SET player = excluded.player, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(map, d.spot, d.after, who.name, at, map, token)
      : env.DB.prepare(`DELETE FROM assignments WHERE map = ? AND spot = ? AND ${mine}`).bind(map, d.spot, map, token));
  }
  stmts.push(env.DB.prepare(`INSERT INTO history (map, version, editor, editor_id, at, changes) SELECT ?, ?, ?, ?, ?, ? WHERE ${mine}`).bind(map, version, who.name, who.id, at, JSON.stringify(diff), map, token));
  let won = false;
  try {
    const res = await env.DB.batch(stmts);
    won = res[0].meta.changes === 1;
  } catch (e) {
    console.log(`submit ${map}: batch failed (${e.message})`);
  }
  if (!won) {
    console.log(`submit ${map}: ${who.name} lost a race for v${version}, nothing written`);
    return err(409, "Someone saved this map at the same moment. Reload and redo your changes.", { current: await readMap(env, map) });
  }
  console.log(`submit ${map}: ${who.name} saved v${version}, ${diff.length} change(s): ${diff.map(d => `${d.spot} "${d.before}"->"${d.after}"`).join("; ").slice(0, 500)}`);
  ctx.waitUntil(dispatchRender(env, `${map} v${version} by ${who.name}`).catch(e => console.log("dispatch failed: " + e.message)));
  return json({ ok: true, saved: diff.length, used: used + 1, limit, rerender: !!env.GH_DISPATCH_TOKEN, ...(await readMap(env, map)) });
}

async function editorsApi(request, env, who, parts) {
  if (!who.admin) return err(403, "Admin only.");
  const known = mapList(env);
  const pickMaps = v => (Array.isArray(v) ? v : String(v || "").split(",")).map(s => String(s).trim()).filter(m => known.includes(m));
  const id = parts[2] ? Number(parts[2]) : null;
  const m = request.method;

  if (!id && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id, name, maps, admin, active, created_at FROM editors ORDER BY name COLLATE NOCASE").all();
    const counts = await env.DB.prepare("SELECT editor_id, COUNT(*) AS n, MAX(at) AS last FROM history GROUP BY editor_id").all();
    const c = new Map(counts.results.map(r => [r.editor_id, r]));
    return json({ maps: known, editors: results.map(e => ({ ...e, maps: editorMaps(e), admin: !!e.admin, active: !!e.active, saves: c.get(e.id)?.n || 0, lastSave: c.get(e.id)?.last || null })) });
  }
  if (!id && m === "POST") {
    const b = await request.json().catch(() => ({}));
    const name = cleanName(b.name);
    if (!name) return err(400, "Name is required.");
    const code = newCode();
    const r = await env.DB.prepare("INSERT INTO editors (name, code_hash, maps, admin, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .bind(name, await sha256(normCode(code)), pickMaps(b.maps).join(","), b.admin ? 1 : 0, now()).run();
    console.log(`editors: ${who.name} added "${name}" (maps ${pickMaps(b.maps).join(",") || "none"}${b.admin ? ", admin" : ""})`);
    return json({ ok: true, id: r.meta.last_row_id, name, code });
  }
  if (!id) return err(405, "Method not allowed.");
  const row = await env.DB.prepare("SELECT * FROM editors WHERE id = ?").bind(id).first();
  if (!row) return err(404, "No such editor.");

  if (parts[3] === "code" && m === "POST") {
    const code = newCode();
    await env.DB.prepare("UPDATE editors SET code_hash = ? WHERE id = ?").bind(await sha256(normCode(code)), id).run();
    console.log(`editors: ${who.name} gave "${row.name}" a new code`);
    return json({ ok: true, id, name: row.name, code });
  }
  if (!parts[3] && m === "PATCH") {
    const b = await request.json().catch(() => ({}));
    const name = b.name !== undefined ? cleanName(b.name) || row.name : row.name;
    const maps = b.maps !== undefined ? pickMaps(b.maps).join(",") : row.maps;
    const admin = b.admin !== undefined ? (b.admin ? 1 : 0) : row.admin;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : row.active;
    await env.DB.prepare("UPDATE editors SET name = ?, maps = ?, admin = ?, active = ? WHERE id = ?").bind(name, maps, admin, active, id).run();
    console.log(`editors: ${who.name} changed "${row.name}" -> name "${name}", maps ${maps || "none"}, admin ${admin}, active ${active}`);
    return json({ ok: true });
  }
  if (!parts[3] && m === "DELETE") {
    await env.DB.prepare("DELETE FROM editors WHERE id = ?").bind(id).run();
    console.log(`editors: ${who.name} removed "${row.name}"`);
    return json({ ok: true });
  }
  return err(405, "Method not allowed.");
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1); // ["api", ...]
  const m = request.method;
  if (m === "OPTIONS") return new Response(null, { headers: { ...CORS, "access-control-allow-methods": "GET", "access-control-max-age": "86400" } });

  if (parts[1] === "maps") {
    const map = parts[2];
    if (!map && m === "GET") {
      const { results } = await env.DB.prepare("SELECT id, version, updated_at, updated_by FROM maps").all();
      const v = new Map(results.map(r => [r.id, r]));
      return json({ maps: mapList(env).map(id => ({ id, version: v.get(id)?.version || 0, updatedAt: v.get(id)?.updated_at || null })) }, 200, CORS);
    }
    if (!mapList(env).includes(map)) return err(404, `Unknown map "${map}".`);
    if (!parts[3] && m === "GET") return json(await readMap(env, map), 200, CORS);
    const who = await whoIs(request, env);
    if (!who) return err(401, "Unknown or disabled code.");
    if (parts[3] === "history" && m === "GET") {
      if (!who.maps.includes(map)) return err(403, `You can't see the ${map} map's history.`);
      const n = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 200);
      const { results } = await env.DB.prepare("SELECT version, editor, at, changes FROM history WHERE map = ? ORDER BY id DESC LIMIT ?").bind(map, n).all();
      return json({ map, history: results.map(h => ({ ...h, changes: JSON.parse(h.changes) })) });
    }
    if (!parts[3] && m === "POST") return submit(request, env, ctx, map, who);
    return err(405, "Method not allowed.");
  }

  if (parts[1] === "me" && m === "GET") {
    const who = await whoIs(request, env);
    if (!who) return err(401, "Unknown or disabled code.");
    return json({ name: who.name, maps: who.maps, admin: who.admin, used: await usedToday(env, who), limit: who.id === null ? null : Number(env.DAILY_LIMIT) || 50 });
  }

  if (parts[1] === "editors") {
    const who = await whoIs(request, env);
    if (!who) return err(401, "Unknown or disabled code.");
    return editorsApi(request, env, who, parts);
  }
  return err(404, "Not found.");
}

export default {
  async fetch(request, env, ctx) {
    const t0 = Date.now();
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    let res;
    try { res = await handle(request, env, ctx); }
    catch (e) { console.log(`error: ${e.stack || e.message}`); res = err(500, "Server error: " + e.message); }
    console.log(`${request.method} ${url.pathname} -> ${res.status} (${Date.now() - t0} ms)`);
    return res;
  }
};
