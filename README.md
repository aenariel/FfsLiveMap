# Ffs Live Map

Bear trap positions for alliances Ffs and SBM (kingdom #1130) and VAR (kingdom #2116), Kingshot.

**Image:** [ffs-bear-traps.png](https://raw.githubusercontent.com/aenariel/FfsLiveMap/main/ffs-bear-traps.png) — refreshed every 6 hours (00:00, 06:00, 12:00 and 18:00 UTC).

Assigned spots come from the alliance's ksmapper plan; player positions come from MightPulse.
Find your name, then move your city to the X : Y shown. If your spot is blocked or you have no spot, contact leadership.

Files: `plan.csv` (plan as of the last refresh, with the editor's names), `live.csv` (MightPulse positions used), `assignments/ffs.csv`, `render.cjs` (renderer), `templates/ffs-page.html` (drawing code).

## SBM

Bear trap hive for alliance SBM, same kingdom.

**Image:** [sbm-bear-traps.png](https://raw.githubusercontent.com/aenariel/FfsLiveMap/main/sbm-bear-traps.png) — refreshed with the Ffs image.

There are no assigned spots: the map shows which marked spots hold an SBM city, which are blocked, and lists every town not correctly placed (SBM members off the marked spots and anyone blocking a spot).

Files: `sbm-plan.csv`, `sbm-live.csv`, `render-sbm.cjs`, `templates/sbm-page.html`.

## VAR

Bear trap hive for alliance VAR, kingdom #2116 (ksmapper map `axcubtfj`). Same format as Ffs: same renderer (`render.cjs --tag VAR --kd #2116`) and the same template (`templates/ffs-page.html`), so any format change applies to both.

**Image:** [var-bear-traps.png](https://raw.githubusercontent.com/aenariel/FfsLiveMap/main/var-bear-traps.png) — refreshed with the other maps.

Files: `var-plan.csv`, `var-live.csv`, `assignments/var.csv`.

## Hive editor (Ffs, VAR)

Who goes on which spot is set in the hive editor, https://hive-editor.kstools.workers.dev (code in `worker/`, deployed by `.github/workflows/deploy-editor.yml` to Cloudflare Workers + D1). Editors sign in with a personal code; the admin adds or removes editors and chooses their maps there.

- ksmapper still sets the layout: spots, traps, HQ. The names on the spots come from the editor, by spot number.
- Each refresh saves the editor's assignments to `assignments/ffs.csv` and `assignments/var.csv`; if the editor can't be reached, the last copy is used.
- Until a map is saved in the editor for the first time, the ksmapper labels are used (labels that are only spot numbers count as empty).

## Spot numbers

Every spot has a fixed number per bear trap (`BT1-001`, `BT2-014`…), shown on the maps and in the lists. The numbers live in `spots/ffs.csv`, `spots/sbm.csv` and `spots/var.csv` (`trap,number,x,y`) and are handled by `spots.cjs`:
- a spot keeps its number for as long as it stays at the same X : Y;
- a new spot whose ksmapper label is already a number (as the hive generator writes them) keeps it; otherwise it gets the next number of its nearest trap, counted outwards (distance from the trap, then X, then Y);
- numbers of removed spots are never reused; spots more than 18 tiles from both traps get no number yet.

The files can be edited by hand; the refresh commits them when spots are added.

## How the refresh works

A GitHub Actions workflow (`.github/workflows/refresh.yml`) runs every 6 hours (00:00, 06:00, 12:00 and 18:00 UTC). GitHub sometimes starts scheduled runs a few minutes late.
It runs `refresh.cjs --kingdom 1130` (Ffs, SBM) and `refresh.cjs --kingdom 2116` (VAR) in parallel, on separate machines. Each sends one Update Map request to MightPulse for its kingdom, waits for the scan to leave the queue, reads the city positions and the ksmapper plan, and renders its maps. A last job commits all images and publishes the interactive pages.
The maps are independent: if one fails, the others are still updated.
To run it by hand: Actions → Refresh bear trap maps → Run workflow.
Each refresh replaces the previous refresh commit, so old images are not kept in the history.
