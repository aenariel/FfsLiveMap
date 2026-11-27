// Fixed spot numbers for the bear trap maps.
//
// Every city spot of a hive gets a number per bear trap ("BT1-001", "BT2-014"), kept in
// spots/<map>.csv so it never changes while the spot stays where it is:
//   - a spot already in the file keeps its number (matched by X : Y);
//   - a new spot whose ksmapper label is already a free number (e.g. "BT2-002", as the hive
//     generator writes them) keeps that number;
//   - any other new spot gets the next number of its nearest trap, in the generator's order:
//     distance from the trap centre, then X, then Y;
//   - numbers of spots removed from the plan stay in the file and are never handed out again;
//   - spots farther than `radius` from every trap (not drawn on the map, e.g. room for a future
//     BT3) get no number yet, so they can take the right trap's number once it is in the plan.
//
// Usage from refresh.cjs: numberSpots(planLines, { file, keys: ["BT1", "BT2"], radius: 18, log })
// returns the plan lines with the number appended as the last field of each city line.

const fs = require("fs");
const path = require("path");

const pad3 = n => String(n).padStart(3, "0");
const norm = s => String(s || "").replace(/\s+/g, "").toUpperCase();
const NUM_RE = /^([A-Z0-9]+)-(\d{1,4})$/i;

function readFile(file) {
  const spots = new Map(); // "x,y" -> { trap, n }
  if (!fs.existsSync(file)) return spots;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [trap, n, x, y] = line.split(",").map(s => s.trim());
    if (!trap || !Number.isFinite(+n)) continue;
    spots.set(`${+x},${+y}`, { trap: trap.toUpperCase(), n: +n });
  }
  return spots;
}

function writeFile(file, spots) {
  const rows = [...spots.entries()].map(([k, v]) => ({ ...v, x: +k.split(",")[0], y: +k.split(",")[1] }))
    .sort((a, b) => a.trap.localeCompare(b.trap) || a.n - b.n);
  const head = "# Fixed spot numbers: trap,number,x,y (bottom-left corner, as in ksmapper). Edit by hand if needed;\n" +
    "# numbers of spots no longer in the plan are kept so they are never reused.\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, head + rows.map(r => `${r.trap},${r.n},${r.x},${r.y}`).join("\n") + "\n");
}

function numberSpots(planLines, { file, keys, radius = 18, log = () => {} }) {
  const t0 = Date.now();
  const rows = planLines.map(l => l.split(","));
  const traps = [];
  for (const key of keys) {
    const r = rows.find(a => a[0] === "beartrap" && norm(a[3]).includes(norm(key)) && !traps.some(t => t.row === a));
    if (r) traps.push({ key: key.toUpperCase(), x: +r[1], y: +r[2], row: r });
    else log(`spots: no bear trap labelled ${key} in the plan, its spots can't be numbered`);
  }
  if (!traps.length) throw new Error(`no bear traps labelled ${keys.join("/")} in the plan`);
  const spots = readFile(file);
  const before = spots.size;
  const maxOf = key => Math.max(0, ...[...spots.values()].filter(v => v.trap === key).map(v => v.n));
  const used = new Set([...spots.values()].map(v => `${v.trap}-${v.n}`));

  // centre-to-centre distance, as the hive generator numbers its spots
  const near = (x, y) => traps.map(t => ({ t, d: Math.hypot(x + 1 - (t.x + 1.5), y + 1 - (t.y + 1.5)) })).sort((a, b) => a.d - b.d)[0];
  const cities = rows.filter(a => a[0] === "city").map(a => ({ a, x: +a[1], y: +a[2], k: `${+a[1]},${+a[2]}` }));
  let kept = 0, fromLabel = 0, far = 0;
  const fresh = [];
  for (const c of cities) {
    if (spots.has(c.k)) { kept++; continue; }
    const m = NUM_RE.exec(String(c.a[3] || "").trim());
    if (m) {
      const trap = m[1].toUpperCase(), n = +m[2];
      if (traps.some(t => t.key === trap) && !used.has(`${trap}-${n}`)) {
        spots.set(c.k, { trap, n }); used.add(`${trap}-${n}`); fromLabel++;
        continue;
      }
    }
    const { t, d } = near(c.x, c.y);
    if (d > radius) { far++; continue; }
    fresh.push({ ...c, trap: t.key, d });
  }
  fresh.sort((a, b) => a.trap.localeCompare(b.trap) || a.d - b.d || a.x - b.x || a.y - b.y);
  const next = {};
  for (const c of fresh) {
    next[c.trap] = (next[c.trap] ?? maxOf(c.trap)) + 1;
    spots.set(c.k, { trap: c.trap, n: next[c.trap] });
  }
  const inPlan = new Set(cities.map(c => c.k));
  const retired = [...spots.keys()].filter(k => !inPlan.has(k)).length;
  log(`spots: ${path.basename(file)} - ${cities.length} spots in plan: ${kept} already numbered, ${fromLabel} numbered from their label, ` +
    `${fresh.length} new (${Object.entries(next).map(([k, n]) => `${k} up to ${pad3(n)}`).join(", ") || "none"}); ` +
    `${far} too far from any trap left unnumbered; ${retired} kept for spots no longer in the plan (${Date.now() - t0} ms)`);
  const changed = spots.size !== before;
  if (changed) writeFile(file, spots);
  const label = k => { const v = spots.get(k); return v ? `${v.trap}-${pad3(v.n)}` : null; };
  const lines = rows.map(a => { const l = a[0] === "city" && label(`${+a[1]},${+a[2]}`); return (l ? [...a, l] : a).join(","); });
  return { lines, changed, total: cities.length, added: fresh.length + fromLabel };
}

module.exports = { numberSpots, readFile };
