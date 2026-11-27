// API test against a running `wrangler dev` (local D1). Usage:
//   npx wrangler d1 migrations apply hive-editor --local   (once, on an empty local database)
//   npx wrangler dev --port 8787 &   (with .dev.vars holding ADMIN_CODE=TEST-ADMN-CODE)
//   node test/api.test.mjs [http://127.0.0.1:8787]
// Every check logs one line; the run stops at the first failure.

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const ADMIN = "TEST-ADMN-CODE";
let n = 0;
const t0 = Date.now();
function ok(cond, what, extra) {
  n++;
  if (!cond) { console.error(`FAIL ${n}: ${what}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); process.exit(1); }
  console.log(`ok ${n}: ${what}`);
}
async function call(method, path, { code, body } = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...(code ? { authorization: `Bearer ${code}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, cors: r.headers.get("access-control-allow-origin") };
}

let r = await call("GET", "/api/maps");
ok(r.status === 200 && r.data.maps.length === 2 && r.cors === "*", "public map list with CORS", r.data);
const v0 = r.data.maps.find(m => m.id === "ffs").version;

r = await call("GET", "/api/me");
ok(r.status === 401, "no code -> 401");
r = await call("GET", "/api/me", { code: "WRONG-CODE-XXXX" });
ok(r.status === 401, "wrong code -> 401");
r = await call("GET", "/api/me", { code: ADMIN.toLowerCase().replace(/-/g, " ") });
ok(r.status === 200 && r.data.admin && r.data.maps.includes("var"), "admin code works (case and separators ignored)", r.data);

// editors
r = await call("POST", "/api/editors", { code: ADMIN, body: { name: "Lurker", maps: ["ffs", "nope"] } });
ok(r.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.data.code), "admin adds Lurker, gets a code", r.data);
const lurker = r.data;
r = await call("POST", "/api/editors", { code: ADMIN, body: { name: "Luna", maps: "var" } });
const luna = r.data;
ok(r.status === 200, "admin adds Luna (var)");
r = await call("POST", "/api/editors", { code: lurker.code, body: { name: "Hacker", maps: ["ffs"] } });
ok(r.status === 403, "non-admin can't add editors");
r = await call("GET", "/api/editors", { code: ADMIN });
ok(r.status === 200 && r.data.editors.find(e => e.name === "Lurker").maps.join() === "ffs", "editor list, unknown map dropped", r.data);
r = await call("GET", "/api/me", { code: lurker.code });
ok(r.status === 200 && r.data.maps.join() === "ffs" && r.data.limit === 50 && r.data.used === 0, "Lurker /me", r.data);

// saves
r = await call("POST", "/api/maps/var", { code: lurker.code, body: { base: 0, changes: [{ spot: "BT1-001", player: "X" }] } });
ok(r.status === 403, "Lurker can't edit var");
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0, changes: [{ spot: "BT9-1", player: "X" }] } });
ok(r.status === 400, "bad spot number refused");
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0, changes: [{ spot: "bt1-001", player: "  Kipper  " }, { spot: "BT1-002", player: "Heidi" }] } });
ok(r.status === 200 && r.data.version === v0 + 1 && r.data.assignments.length === 2 && r.data.assignments[0].player === "Kipper", "Lurker saves 2 spots (spot upper-cased, name trimmed)", r.data);
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0, changes: [{ spot: "BT1-003", player: "Late" }] } });
ok(r.status === 409 && r.data.current.version === v0 + 1, "stale base -> 409 with the current map", r.data);
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0 + 1, changes: [{ spot: "BT1-003", player: "kipper" }] } });
ok(r.status === 422 && /one spot/.test(r.data.error), "same player on two spots (case-insensitive) refused", r.data);
// swap BT1-001 <-> BT1-002 in one save
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0 + 1, changes: [{ spot: "BT1-001", player: "Heidi" }, { spot: "BT1-002", player: "Kipper" }] } });
ok(r.status === 200 && r.data.assignments.find(a => a.spot === "BT1-001").player === "Heidi", "swap in one save", r.data);
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0 + 2, changes: [{ spot: "BT1-001", player: "" }] } });
ok(r.status === 200 && r.data.assignments.length === 1, "clear a spot");
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0 + 3, changes: [{ spot: "BT1-002", player: "Kipper" }] } });
ok(r.status === 200 && r.data.unchanged && r.data.version === v0 + 3, "no-op save doesn't bump the version", r.data);
r = await call("POST", "/api/maps/ffs", { code: lurker.code, body: { base: v0 + 3, replace: true, changes: [{ spot: "BT1-001", player: "A" }] } });
ok(r.status === 403, "replace is admin only");

// two saves at the same moment on the same base: exactly one wins
const base = v0 + 3;
const [a, b] = await Promise.all([
  call("POST", "/api/maps/ffs", { code: lurker.code, body: { base, changes: [{ spot: "BT2-001", player: "Racer A" }] } }),
  call("POST", "/api/maps/ffs", { code: ADMIN, body: { base, changes: [{ spot: "BT2-002", player: "Racer B" }] } })
]);
ok([a.status, b.status].sort().join() === "200,409", "simultaneous saves: one 200, one 409", [a.status, b.status]);
r = await call("GET", "/api/maps/ffs");
ok(r.data.version === base + 1 && r.data.assignments.filter(x => x.player.startsWith("Racer")).length === 1, "loser wrote nothing", r.data);

// history
r = await call("GET", "/api/maps/ffs/history?limit=3", { code: lurker.code });
ok(r.status === 200 && r.data.history.length === 3 && Array.isArray(r.data.history[0].changes), "history readable by the map's editor", r.data);
r = await call("GET", "/api/maps/ffs/history", { code: luna.code });
ok(r.status === 403, "Luna can't read ffs history");

// admin replace (initial import)
r = await call("GET", "/api/maps/var");
r = await call("POST", "/api/maps/var", { code: ADMIN, body: { base: r.data.version, replace: true, changes: [{ spot: "BT1-001", player: "Luna" }, { spot: "BT2-001", player: "Boppa Kris" }] } });
ok(r.status === 200 && r.data.assignments.length === 2, "admin import with replace", r.data);

// code rotation, disable, delete
r = await call("POST", `/api/editors/${lurker.id}/code`, { code: ADMIN });
const newCode = r.data.code;
ok(r.status === 200 && newCode !== lurker.code, "new code for Lurker");
r = await call("GET", "/api/me", { code: lurker.code });
ok(r.status === 401, "old code stops working");
r = await call("GET", "/api/me", { code: newCode });
ok(r.status === 200 && r.data.used >= 3, "new code works, today's saves counted", r.data);
r = await call("PATCH", `/api/editors/${lurker.id}`, { code: ADMIN, body: { maps: ["ffs", "var"] } });
r = await call("GET", "/api/me", { code: newCode });
ok(r.data.maps.join() === "ffs,var", "maps changed by admin", r.data);
r = await call("PATCH", `/api/editors/${lurker.id}`, { code: ADMIN, body: { active: false } });
r = await call("GET", "/api/me", { code: newCode });
ok(r.status === 401, "disabled editor locked out");
r = await call("DELETE", `/api/editors/${luna.id}`, { code: ADMIN });
r = await call("GET", "/api/me", { code: luna.code });
ok(r.status === 401, "deleted editor locked out");

// daily limit (temporary editor, 50 saves)
r = await call("POST", "/api/editors", { code: ADMIN, body: { name: "Limit test", maps: ["var"] } });
const lim = r.data;
let ver = (await call("GET", "/api/maps/var")).data.version;
const tl = Date.now();
for (let i = 0; i < 50; i++) {
  const s = await call("POST", "/api/maps/var", { code: lim.code, body: { base: ver, changes: [{ spot: "BT1-050", player: "P" + i }] } });
  if (s.status !== 200) ok(false, `limit-test save ${i + 1}`, s.data);
  ver = s.data.version;
}
console.log(`   50 saves in ${Date.now() - tl} ms`);
r = await call("POST", "/api/maps/var", { code: lim.code, body: { base: ver, changes: [{ spot: "BT1-050", player: "One too many" }] } });
ok(r.status === 429 && r.data.used === 50, "51st save of the day refused", r.data);
await call("DELETE", `/api/editors/${lim.id}`, { code: ADMIN });

r = await call("GET", "/index.html");
ok(r.status === 200 || r.status === 304 || r.data === null, "static page served");
console.log(`all ${n} checks passed in ${Date.now() - t0} ms`);
