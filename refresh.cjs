// Daily refresh of the Ffs and SBM bear trap maps (kingdom #1130).
// 1. Asks MightPulse for a fresh scan (one "Update Map" request) and waits for its queue.
// 2. Reads city positions from MightPulse and the hive plan from ksmapper.
// 3. Renders each map independently: PNG + CSVs in the repo root, interactive page in ./site.
//
// Usage: node refresh.cjs [--no-update] [--site <dir>]
//   --no-update  skip the Update Map request and use the positions MightPulse already has
//   --site <dir> where to write the interactive pages (default: ./site)
//
// Writes a JSON summary to stdout and, inside GitHub Actions, to the job summary.
// Exit code: 0 = everything fine, 1 = something failed (files that did succeed are still written).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const KID = 1130;
const MP = "https://mightpulse.com";
const KSMAPPER = "https://ksmapper.jim-harvey-yu.workers.dev/map/981tkvsj";
const UA = "FfsLiveMap/1.0 (+https://github.com/aenariel/FfsLiveMap)";

const POLL_SEC = 15;            // status polling interval while queued/running
const QUEUE_TIMEOUT_MIN = 45;   // give up waiting for the scan after this
const STALE_HOURS = 20;         // positions older than this count as a failure
const PLAN_TYPES = ["city", "beartrap", "hq", "obs1", "obs2", "obs3"];

const MAPS = [
  {
    name: "Ffs",
    renderer: "render.cjs",
    template: "templates/ffs-page.html",
    files: { plan: "plan.csv", live: "live.csv", png: "ffs-bear-traps.png", page: "ffs.html" },
    live: c => (c.x >= 730 && c.x <= 810 && c.y >= 697 && c.y <= 777) || c.alliance_abbr === "Ffs",
    plan: (x, y) => Math.abs(x - 769) <= 40 && Math.abs(y - 737) <= 40
  },
  {
    name: "SBM",
    renderer: "render-sbm.cjs",
    template: "templates/sbm-page.html",
    files: { plan: "sbm-plan.csv", live: "sbm-live.csv", png: "sbm-bear-traps.png", page: "sbm.html" },
    live: c => (c.x >= 690 && c.x <= 760 && c.y >= 725 && c.y <= 795) || c.alliance_abbr === "SBM",
    plan: (x, y) => x >= 696 && x <= 750 && y >= 728 && y <= 786
  }
];

const args = process.argv.slice(2);
const NO_UPDATE = args.includes("--no-update");
const SITE = path.resolve(args.includes("--site") ? args[args.indexOf("--site") + 1] : "site");
const ROOT = __dirname;

// MightPulse and ksmapper use no-break and other Unicode spaces in some names; the renderers
// match names with plain spaces, so normalise them (this is also what the old browser path did).
const plainSpaces = t => String(t ?? "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = s => new Promise(r => setTimeout(r, s * 1000));
const utc = sec => sec ? new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, "Z") : null;

async function http(url, { method = "GET", tries = 3 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { method, headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store" });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) {}
      if (r.status >= 500 || (body === null && r.ok)) throw new Error(`HTTP ${r.status} from ${url}: ${text.slice(0, 200)}`);
      return { status: r.status, body: body || {} };
    } catch (e) {
      last = e;
      log(`request failed (${i}/${tries}): ${e.message}`);
      if (i < tries) await sleep(10 * i);
    }
  }
  throw last;
}

// ---------- 1. Update Map ----------
async function requestScan(report) {
  let token = "t_" + crypto.randomBytes(8).toString("hex");
  const q = () => `kid=${KID}&token=${encodeURIComponent(token)}`;
  const status = async () => {
    const { body } = await http(`${MP}/api/map/update/status?${q()}`);
    if (body.request_token) token = body.request_token;
    return body;
  };

  const before = await status();
  const startFinished = Number(before.last_finished_at) || 0;
  report.previousScan = utc(startFinished);

  if (before.updates_paused) { report.update = "updates paused by MightPulse"; return; }

  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { status: code, body } = await http(`${MP}/api/map/update?${q()}`, { method: "POST", tries: 1 });
    res = body;
    if (res.request_token) token = res.request_token;
    log(`Update Map -> HTTP ${code} ${JSON.stringify(res).slice(0, 300)}`);
    if (res.error === "ip_cooldown" && attempt === 1) {
      const wait = Math.min(Number(res.ip_cooldown_remaining_sec) || 60, 31 * 60) + 5;
      log(`IP cooldown, waiting ${wait} s and trying once more`);
      await sleep(wait);
      continue;
    }
    break;
  }

  if (res.updates_paused) { report.update = "updates paused by MightPulse"; return; }
  if (res.error === "cooldown") { report.update = `kingdom updated recently (cooldown ${res.cooldown_remaining_sec ?? "?"} s), using that scan`; return; }
  if (res.error === "ip_cooldown") { report.update = "IP cooldown persisted after retry, using the last scan"; report.warnings.push(report.update); return; }
  if (res.error) { report.update = `Update Map refused: ${res.error}${res.message ? " - " + res.message : ""}`; report.warnings.push(report.update); return; }

  // Accepted: wait for the job to leave the queue and finish.
  const deadline = Date.now() + QUEUE_TIMEOUT_MIN * 60e3;
  let seenActive = ["queued", "running"].includes(res.status) || !!res.job_id;
  let lastLine = "", idlePolls = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_SEC);
    let st;
    try { st = await status(); } catch (e) { continue; }
    const job = st.job;
    const line = job ? `${job.status}${job.queue_position ? " #" + job.queue_position : ""}${st.progress_pct != null ? " " + Math.round(st.progress_pct) + "%" : ""}` : "no job";
    if (line !== lastLine) { log(`scan status: ${line}`); lastLine = line; }
    if (job && ["queued", "running"].includes(job.status)) { seenActive = true; continue; }
    if (job && job.status === "done") { report.update = "scan finished"; return; }
    if (job && job.status) { report.update = `scan ended with status "${job.status}"`; report.warnings.push(report.update); return; }
    // No job: finished (status endpoint dropped it) or never queued.
    if (Number(st.last_finished_at) > startFinished) { report.update = "scan finished"; return; }
    if (seenActive) { report.update = "scan job disappeared without a newer scan"; report.warnings.push(report.update); return; }
    if (++idlePolls >= 4) { report.update = "Update Map accepted but no scan job appeared, using the last scan"; report.warnings.push(report.update); return; }
  }
  report.update = `scan still not finished after ${QUEUE_TIMEOUT_MIN} min, using the last scan`;
  report.warnings.push(report.update);
}

// ---------- 2. Data ----------
async function getData(report) {
  const { body: mp } = await http(`${MP}/api/map?kid=${KID}&layers=cities&limit=50000`);
  if (!Array.isArray(mp.cities) || !mp.stats) throw new Error("MightPulse map response has no cities/stats");
  const at = Math.round(Number(mp.stats.location_updated_at) || 0);
  report.positionsAt = utc(at);
  report.citiesInKingdom = mp.cities.length;

  const { body: ks } = await http(KSMAPPER);
  if (typeof ks.csv !== "string") throw new Error("ksmapper response has no csv");
  report.planUpdatedAt = ks.updatedAt || null;
  return { cities: mp.cities, at, planLines: ks.csv.split(/\r?\n/).map(plainSpaces) };
}

// ---------- 3. Render ----------
function renderMap(map, data, report) {
  const r = { ok: false };
  report.maps[map.name] = r;
  try {
    const live = data.cities.filter(map.live)
      .map(c => [c.x, c.y, c.alliance_abbr || "", plainSpaces(c.nick_name).replace(/,/g, "|")].join(","));
    const plan = data.planLines.filter(l => {
      const a = l.split(",");
      return PLAN_TYPES.includes(a[0]) && map.plan(+a[1], +a[2]);
    });
    if (!plan.length) throw new Error("no plan lines inside the hive area");
    if (!live.length) throw new Error("no cities inside the hive area");
    r.planLines = plan.length; r.liveCities = live.length;

    // Render into a scratch folder first, so a failure never leaves half-updated files behind.
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), map.name + "-"));
    const t = k => path.join(tmp, map.files[k]);
    fs.writeFileSync(t("plan"), plan.join("\n") + "\n");
    fs.writeFileSync(t("live"), `at,${data.at}\n` + live.join("\n") + "\n");
    const out = execFileSync(process.execPath, [
      path.join(ROOT, map.renderer), path.join(ROOT, map.template), t("plan"), t("live"), t("png"), t("page")
    ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    for (const k of ["plan", "live", "png"]) {
      fs.copyFileSync(t(k), path.join(ROOT, map.files[k]));
      fs.appendFileSync(path.join(ROOT, ".refresh-files"), map.files[k] + "\n");
    }
    fs.mkdirSync(SITE, { recursive: true });
    fs.copyFileSync(t("page"), path.join(SITE, map.files.page));
    fs.rmSync(tmp, { recursive: true, force: true });
    const summary = JSON.parse(out);
    delete summary.page;
    r.render = summary;
    r.ok = true;
  } catch (e) {
    r.error = e.message.split("\n").slice(0, 3).join(" | ");
    report.failures.push(`${map.name}: ${r.error}`);
  }
}

function writeJobSummary(report) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    "## Bear trap maps refresh", "",
    `- Update Map: ${report.update}`,
    `- Positions from: ${report.positionsAt || "?"} (previous scan ${report.previousScan || "?"})`,
    ...Object.entries(report.maps).map(([n, r]) => `- ${n}: ${r.ok ? "rendered" : "FAILED - " + r.error}`),
    ...report.warnings.map(w => `- Warning: ${w}`),
    ...report.failures.map(w => `- Failure: ${w}`),
    "", "```json", JSON.stringify(report, null, 1), "```"
  ];
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

(async () => {
  fs.rmSync(path.join(ROOT, ".refresh-files"), { force: true }); // list of files written by successful maps
  const report = { startedAt: new Date().toISOString(), update: NO_UPDATE ? "skipped (--no-update)" : "not attempted", maps: {}, warnings: [], failures: [] };
  try {
    if (!NO_UPDATE) {
      try { await requestScan(report); }
      catch (e) { report.update = `Update Map request failed: ${e.message}`; report.warnings.push(report.update); }
    }
    let data = await getData(report);
    // The cities endpoint can lag a little behind the status endpoint: re-read a few times if needed.
    if (report.update === "scan finished") {
      for (let i = 0; i < 3 && Date.parse(report.positionsAt) <= Date.parse(report.previousScan || 0); i++) {
        await sleep(20);
        data = await getData(report);
      }
    }
    const ageH = (Date.now() / 1000 - data.at) / 3600;
    report.positionsAgeHours = Math.round(ageH * 10) / 10;
    if (ageH > STALE_HOURS) report.failures.push(`positions are ${Math.round(ageH)} h old (no fresh scan)`);
    for (const map of MAPS) renderMap(map, data, report);
  } catch (e) {
    report.failures.push(`fatal: ${e.message}`);
  }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 1));
  writeJobSummary(report);
  process.exit(report.failures.length ? 1 : 0);
})();
