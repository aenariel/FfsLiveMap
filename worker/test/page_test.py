# Page test: Playwright + Chrome against `wrangler dev` on a fresh local D1 (see api.test.mjs); raw GitHub files are
# served from this repo. Usage: python3 worker/test/page_test.py [screenshot dir]
import sys, time, pathlib
from playwright.sync_api import sync_playwright
REPO = pathlib.Path(__file__).resolve().parents[2]  # repo root (plan/live CSVs)
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp")  # screenshots
t0 = time.time()
def log(*a): print(f"{time.time()-t0:6.1f}s", *a, flush=True)

def raw(route):
    name = route.request.url.split("/main/")[1].split("?")[0]
    route.fulfill(status=200, body=(REPO / name).read_text(encoding="utf-8"), headers={"access-control-allow-origin": "*", "content-type": "text/plain; charset=utf-8"})

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1500, "height": 950})
    pg.on("console", lambda m: log("console:", m.text[:200]))
    pg.on("pageerror", lambda e: log("PAGE ERROR:", e))
    pg.on("dialog", lambda d: (log("dialog:", d.message[:120]), d.accept()))
    pg.route("https://raw.githubusercontent.com/**", raw)
    pg.goto("http://127.0.0.1:8787/#ffs"); pg.wait_for_function("document.querySelector('#spotTable tr')", timeout=15000)
    log("ffs loaded:", pg.inner_text("#status"))
    pg.fill("#codeInput", "test-admn-code"); pg.click("#signinForm button")
    pg.wait_for_selector("#cardAdmin:not([hidden])"); log("signed in:", pg.inner_text("#who"))
    # import Ffs names from the ksmapper labels
    pg.click("#cardImport summary"); log("import info:", pg.inner_text("#importInfo"))
    pg.click("#importBtn"); pg.wait_for_function("document.querySelector('#importInfo').textContent.includes('Imported') || document.querySelector('#importInfo .bad')")
    log("import:", pg.inner_text("#importInfo"))
    log("spots:", pg.inner_text("#spotsCount"), "| members w/o spot:", pg.inner_text("#membersCount"))
    # add editors
    pg.click("#cardAdmin summary")
    for name, maps in [("Lurker", ["ffs"]), ("Luna", ["var"])]:
        pg.fill("#newName", name)
        for m in maps: pg.check(f'#newMaps input[value="{m}"]')
        pg.click("#addEditor button"); pg.wait_for_function(f"document.querySelector('#codeBox').textContent.includes('{name}')")
        code = pg.inner_text("#codeBox code"); log(f"editor {name}: code {code}")
        if name == "Luna": luna = code
    pg.screenshot(path=str(OUT / "ffs_admin.png"), full_page=False)
    # switch to VAR as Luna
    pg.click("#signOut"); pg.fill("#codeInput", luna); pg.click("#signinForm button"); pg.wait_for_function("document.querySelector('#who').textContent.startsWith('Luna')")
    pg.click('#mapTabs button[data-map="var"]'); pg.wait_for_function("document.querySelector('#status').textContent.startsWith('VAR')")
    log("var:", pg.inner_text("#status"))
    # pick BT1-001 from the list, assign a member from the chips, then move, swap
    pg.click('#spotTable tr[data-num="BT1-001"]'); pg.click("#cardMembers summary")
    first = pg.inner_text("#membersList li >> nth=0"); pg.click("#membersList li >> nth=0"); log("assigned", first, "to BT1-001")
    pg.click('#spotTable tr[data-num="BT1-002"]'); pg.fill("#assignName", "Builder Pingu"); pg.click("#assignForm button")
    pg.click('#spotTable tr[data-num="BT1-003"]'); pg.fill("#assignName", "Builder Pingu"); pg.click("#assignForm button")
    log("move msg:", pg.inner_text("#assignMsg"))
    pg.click('#spotTable tr[data-num="BT1-001"]'); pg.click("#swapBtn"); pg.click('#spotTable tr[data-num="BT1-003"]')
    log("pending:", pg.inner_text("#pendingList").replace("\n", " | "))
    # click on the map: centre of spot BT2-002
    xy = pg.evaluate("(() => { const s = S.layout.byNum.get('BT2-002'); const [x,y] = S.geo.P(s.x+1, s.y+1); return [x,y]; })()")
    box = pg.locator("#map").bounding_box(); pg.mouse.click(box["x"] + xy[0], box["y"] + xy[1])
    log("map click selected:", pg.evaluate("S.selected"))
    pg.fill("#assignName", "Luna"); pg.click("#assignForm button")
    pg.click("#submitBtn"); pg.wait_for_function("document.querySelector('#submitMsg').textContent.startsWith('Saved') || document.querySelector('#submitMsg .bad')")
    log("submit:", pg.inner_text("#submitMsg"))
    pg.click("#cardHistory summary"); log("history:", pg.inner_text("#historyList").replace("\n", " | ")[:300])
    pg.screenshot(path=str(OUT / "var_desktop.png"))
    # conflict: another tab saves meanwhile
    pg2 = b.new_page(); pg2.route("https://raw.githubusercontent.com/**", raw)
    r = pg2.request.post("http://127.0.0.1:8787/api/maps/var", headers={"authorization": "Bearer TEST-ADMN-CODE"}, data={"base": pg.evaluate("S.server.version"), "changes": [{"spot": "BT2-010", "player": "Other Edit"}]})
    log("other save:", r.status)
    pg.click('#spotTable tr[data-num="BT2-011"]'); pg.fill("#assignName", "Late Change"); pg.click("#assignForm button")
    pg.click("#submitBtn"); pg.wait_for_function("document.querySelector('#submitMsg .warn')"); log("409:", pg.inner_text("#submitMsg"))
    pg.click("#submitBtn"); pg.wait_for_function("document.querySelector('#submitMsg').textContent.startsWith('Saved')"); log("resubmit:", pg.inner_text("#submitMsg"))
    # mobile
    m = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    m.route("https://raw.githubusercontent.com/**", raw); m.on("pageerror", lambda e: log("MOBILE PAGE ERROR:", e))
    m.goto("http://127.0.0.1:8787/#var"); m.wait_for_function("document.querySelector('#spotTable tr')")
    m.screenshot(path=str(OUT / "var_mobile.png"), full_page=False)
    log("mobile page width:", m.evaluate("document.documentElement.scrollWidth"), "viewport 390")
    xy = m.evaluate("(() => { const s = S.layout.byNum.get('BT2-002'); return S.geo.P(s.x+1, s.y+1); })()")
    bx = m.locator("#map").bounding_box(); m.mouse.click(bx["x"] + xy[0], bx["y"] + xy[1])
    m.screenshot(path=str(OUT / "var_mobile_sel.png"), full_page=False)
    log("mobile selected:", m.evaluate("S.selected"))
    log("done")
    b.close()
