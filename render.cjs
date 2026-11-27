// Renders a bear trap PNG with assigned spots (Ffs, VAR: same template, so both always share the format)
// without a browser, using the drawing code inside the page itself.
// Usage: node render.cjs <page.html> <plan.csv> <live.csv> <out.png> [page-new.html] [--tag Ffs] [--kd #1130]
//   plan.csv  — ksmapper export lines (type,x,y,label,colour)
//   live.csv  — first line "at,<unix seconds>", then x,y,alliance,name per city (MightPulse snapshot)
const fs = require("fs");
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const argv = process.argv.slice(2), flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) argv[i].startsWith("--") ? (flags[argv[i].slice(2)] = argv[++i]) : pos.push(argv[i]);
const [pagePath, planPath, livePath, outPath, outHtml] = pos;
const TAG = flags.tag || "Ffs", KD = flags.kd || "#1130";
console.error(`render: ${TAG} ${KD} from ${path.basename(pagePath || "?")}`);
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
// Fallback fonts for player names in other scripts (Chinese, Japanese, Korean, Hebrew, Thai, Devanagari, Tibetan, symbols, emoji and more).
// The machine the daily run uses has no system fonts for these, so they must be bundled.
const FALLBACK = [
  ["noto-sans-sc", "Noto Sans SC"], ["noto-sans-tc", "Noto Sans TC"], ["noto-sans-jp", "Noto Sans JP"], ["noto-sans-kr", "Noto Sans KR"],
  ["noto-sans-hebrew", "Noto Sans Hebrew"], ["noto-sans-thai", "Noto Sans Thai"], ["noto-sans-devanagari", "Noto Sans Devanagari"],
  ["noto-serif-tibetan", "Noto Serif Tibetan"], ["noto-sans-symbols", "Noto Sans Symbols"], ["noto-sans-symbols-2", "Noto Sans Symbols 2"],
  ["noto-sans-math", "Noto Sans Math"], ["noto-emoji", "Noto Emoji"],
  // Last resort for stylised names: phonetic small letters (ᵈ ᶦ ᶰ), Balinese, Canadian syllabics, Cherokee, runes.
  ["noto-sans", "Noto Sans"], ["noto-sans-balinese", "Noto Sans Balinese"], ["noto-sans-canadian-aboriginal", "Noto Sans Canadian Aboriginal"],
  ["noto-sans-cherokee", "Noto Sans Cherokee"], ["noto-sans-runic", "Noto Sans Runic"]
];
const fallbackFamilies = [];
for (const [pkg, family] of FALLBACK) {
  const dir = path.join(fontRoot, pkg);
  if (!fs.existsSync(dir)) { console.warn("missing font package", pkg); continue; }
  const weights = fs.readdirSync(dir).filter(d => /^\d00[A-Za-z]+$/.test(d));
  const use = weights.filter(w => /^(400|500|600|700)/.test(w));
  for (const w of (use.length ? use : weights)) {
    for (const f of fs.readdirSync(path.join(dir, w)).filter(n => n.endsWith(".ttf"))) GlobalFonts.registerFromPath(path.join(dir, w, f), family);
  }
  fallbackFamilies.push('"' + family + '"');
}
const FALLBACK_STACK = fallbackFamilies.join(", ");

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
const run = new Function("planCsv", "liveTxt", "liveAt", "fs", "outPath", "FALLBACK_STACK", "TAG", "KD",
  code + `
  F.body = '"IBM Plex Sans", "Noto Sans Arabic", ' + FALLBACK_STACK + ', sans-serif';
  F.mono = '"IBM Plex Mono", "IBM Plex Sans", ' + FALLBACK_STACK + ', monospace';
  F.display = '"Chakra Petch", "IBM Plex Sans", ' + FALLBACK_STACK + ', sans-serif';
  const live = { ...parseLive(liveTxt), at: liveAt };
  const o = { tag: TAG, kd: KD, roster: true, empty: true, live: true, times: false,
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
const summary = run(planCsv, liveTxt, liveAt, fs, outPath, FALLBACK_STACK, TAG, KD);

// Optional 5th argument: write a copy of the page with this plan and snapshot embedded as its saved data.
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
  if (TAG !== "Ffs" || KD !== "#1130") {
    // The template's defaults are Ffs's: point the copy at this alliance and kingdom.
    const kid = KD.replace(/\D/g, "");
    page = page.replace("<title>Ffs Bear Trap Map</title>", `<title>${TAG} Bear Trap Map</title>`)
      .replace('<span id="hTag">Ffs</span>', `<span id="hTag">${TAG}</span>`)
      .replace('id="optTag" value="Ffs"', `id="optTag" value="${TAG}"`)
      .replace('id="optKd" value="#1130"', `id="optKd" value="${KD}"`)
      .replace('$("optTag").value.trim() || "Ffs"', `$("optTag").value.trim() || "${TAG}"`)
      .replace(/kid=1130/g, `kid=${kid}`).replace(/kingdom 1130/g, `kingdom ${kid}`).replace(/\{"kid":1130/g, `{"kid":${kid}`)
      .replace("plus every Ffs member", `plus every ${TAG} member`)
      .replace(/"bt4-/g, `"bt4-${TAG.toLowerCase()}-`); // own saved options in the browser, not Ffs's
  }
  fs.writeFileSync(outHtml, page);
  summary.page = outHtml;
}
console.log(JSON.stringify(summary, null, 1));
