# Ffs Live Map

Bear trap positions for alliance Ffs, kingdom #1130 (Kingshot).

**Image:** [ffs-bear-traps.png](https://raw.githubusercontent.com/aenariel/FfsLiveMap/main/ffs-bear-traps.png) — refreshed daily at server reset (00:00 UTC).

Assigned spots come from the alliance's ksmapper plan; player positions come from MightPulse.
Find your name, then move your city to the X : Y shown. If your spot is blocked or you have no spot, contact leadership.

Files: `plan.csv` (plan as of the last refresh), `live.csv` (MightPulse positions used), `render.cjs` (renderer), `templates/ffs-page.html` (drawing code).

## SBM

Bear trap hive for alliance SBM, same kingdom.

**Image:** [sbm-bear-traps.png](https://raw.githubusercontent.com/aenariel/FfsLiveMap/main/sbm-bear-traps.png) — refreshed daily with the Ffs image.

There are no assigned spots: the map shows which marked spots hold an SBM city, which are blocked, and lists every town not correctly placed (SBM members off the marked spots and anyone blocking a spot).

Files: `sbm-plan.csv`, `sbm-live.csv`, `render-sbm.cjs`, `templates/sbm-page.html`.

## How the refresh works

A GitHub Actions workflow (`.github/workflows/refresh.yml`) runs `refresh.cjs` every day at 00:00 UTC. GitHub sometimes starts scheduled runs a few minutes late.
It sends one Update Map request to MightPulse, waits for the scan to leave the queue, reads the city positions and the ksmapper plan, and renders both maps.
The two maps are independent: if one fails, the other is still updated.
To run it by hand: Actions → Refresh bear trap maps → Run workflow.
