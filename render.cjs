// Renders the Ffs bear trap PNG without a browser, using the drawing code inside the page itself.
// Usage: node render.cjs <page.html> <plan.csv> <live.csv> <out.png>
//   plan.csv  — ksmapper export lines (type,x,y,label,colour)
//   live.csv  — first line "at,<unix seconds>", then x,y,alliance,name per city (MightPulse snapshot)
const fs = require("fs");
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const [pagePath, planPath, livePath, outPath] = process.argv.slice(2);
if (!outPath) { console.error("usage: node render.cjs page.html plan.csv live.csv out.png"); process.exit(2); }

// fonts: same families the page loads from Google Fonts
const fontRoot = path.join(__dirname, "node_modules", "@expo-google-fonts");
const fonts = [
  ["chakra-petch/600SemiBold/ChakraPetch_600SemiBold.ttf", "Chakra Petch"],
  ["chakra-petch/700Bold/ChakraPetch_700Bold.ttf", "Chakra Petch"],
  ["ibm-plex-sans/400Regular/IBMPlexSans_400Regular.ttf", "IBM Plex Sans"],
  ["ibm-plex-sans/500Medium/IBMPlexSans_500Medium.ttf", "IBM Plex Sans"],
  ["ibm-plex-sans/600SemiBold/IBMPlexSans_600SemiBold.ttf", "IBM Plex Sans"],
  ["ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf", "IBM Plex Mono"],
  ["ibm-plex-mono/600SemiBold/IBMPlexMono_600SemiBold.ttf", "IBM Plex Mono"],
  ["noto-sans-arabic/500Medium/NotoSansArabic_500Medium.ttf", "Noto Sans Arabic"],
  ["noto-sans-arabic/600SemiBold/NotoSansArabic_600SemiBold.ttf", "Noto Sans Arabic"]
];
for (const [rel, family] of fonts) {
  const f = path.join(fontRoot, rel);
  if (fs.existsSync(f)) GlobalFonts.registerFromPath(f, family); else console.warn("missing font", rel);
}

const html = fs.readFileSync(pagePath, "utf8");
const script = html.split("<script>")[1].split("</script>")[0];
const marker = "/* ---------- page state ---------- */";
if (!script.includes(marker)) { console.error("page drawing code not found"); process.exit(1); }
const code = script.split(marker)[0];

const planCsv = fs.readFileSync(planPath, "utf8");
const liveTxt = fs.readFileSync(livePath, "utf8");
const atMatch = /^at,(\d+)/m.exec(liveTxt);
const liveAt = atMatch ? Number(atMatch[1]) * 1000 : null;

global.document = { createElement: () => createCanvas(10, 10) };
const run = new Function("planCsv", "liveTxt", "liveAt", "fs", "outPath",
  code + `
  const live = { ...parseLive(liveTxt), at: liveAt };
  const o = { tag: "Ffs", kd: "#1130", roster: true, empty: true, live: true, times: false,
    key1: "BT1", key2: "BT2", key3: "BT3", radius: 18,
    planDate: fmtDay(Date.now()), liveDate: liveAt ? fmtUtc(liveAt) : "an unknown date" };
  const m = buildModel(planCsv, live, o);
  if (m.error) throw new Error(m.error);
  const cv = draw(m, o);
  fs.writeFileSync(outPath, cv.toBuffer("image/png"));
  const count = {}; m.cities.forEach(c => count[c.status] = (count[c.status] || 0) + 1);
  return { size: [cv.width, cv.height], count, renamed: m.renamed.map(c => c.label + " -> " + c.found.name),
    missing: m.cities.filter(c => c.status === "missing").map(c => c.label), unassigned: m.unassigned.map(u => u.name + " " + u.x + ":" + u.y) };
`);
const summary = run(planCsv, liveTxt, liveAt, fs, outPath);

// Optional 5th argument: write a copy of the page with this plan and snapshot embedded as its saved data.
const outHtml = process.argv[6];
if (outHtml) {
  const swap = (src, name, body) => {
    const i = src.indexOf(`const ${name} = {`);
    const j = src.indexOf("`\n};", i);
    if (i < 0 || j < 0) throw new Error(`${name} block not found in page`);
    return src.slice(0, i) + body + src.slice(j + 4);
  };
  const clean = t => t.replace(/`/g, "'").replace(/\$\{/g, "$ {").trim();
  const liveLines = liveTxt.split(/\r?\n/).filter(l => l.trim() && !/^at,/.test(l)).join("\n");
  let page = swap(html, "PLAN", `const PLAN = {\n  updated: "${new Date().toISOString().replace(/\.\d+Z$/, "Z")}",\n  csv: \`${clean(planCsv)}\`\n};`);
  page = swap(page, "LIVE", `const LIVE = {\n  at: ${liveAt ? Math.round(liveAt / 1000) : 0},\n  csv: \`${clean(liveLines)}\`\n};`);
  fs.writeFileSync(outHtml, page);
  summary.page = outHtml;
}
console.log(JSON.stringify(summary, null, 1));
