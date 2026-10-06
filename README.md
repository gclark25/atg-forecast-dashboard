# ATG Forecast Dashboard

Displays askthegrid.com's Metis 1 Preview nodal price forecasts for HEN's
nodes. Follows the same pattern as `hen-morning-report`: Python orchestrator +
integrations library, static Chart.js frontend, GitHub Actions on a schedule,
Cloudflare Pages to host it.

## Status

Scaffold only -- not yet run against the real API. Three things need
confirming against askthegrid's actual docs before this works (see the
`CONFIRM` comments in `integrations/askthegrid.py`):

1. Base URL / endpoint path for "latest forecast by node"
2. Auth header scheme (assumed `Authorization: Bearer <key>` -- confirm)
3. Response field names (assumed to match the CSV schema we already graded:
   `origin_time`, `target_time`, `horizon_hours`, `q05`...`q95`)

## Setup

1. Generate an API key at https://askthegrid.com/developers/console/api-keys
2. Add it as a GitHub Actions secret on this repo: **Settings → Secrets and
   variables → Actions → New repository secret**, name `ASKTHEGRID_API_KEY`.
   Never paste the key into code, a commit, or this README.
3. For local testing in Codespaces: `export ASKTHEGRID_API_KEY=...` (Codespaces
   needs a full stop/restart to pick up a new secret, not just a terminal
   reload -- same as the ESR Utilization project).
4. `pip install -r requirements.txt`
5. `python orchestrator.py` to do a manual pull and confirm it writes to
   `data/` and `dashboard/data/`.
6. Open `dashboard/index.html` locally (or deploy -- see below) to check the
   chart renders.

## Nodes

Edit `config/nodes.yaml` to add nodes as askthegrid turns on more of the
fleet. Nothing else in the pipeline needs to change. `weak_tail_nodes` in that
same file controls which nodes show the tail-risk caveat banner -- update it
once/if the vendor fixes the calibration issue at Junction and Olney.

## Deploying

Cloudflare Pages, same as the other dashboards. Git-integration builds are
fine for the static `dashboard/` folder, but if you hit the same silent
reversion issue noted on ESR Utilization (Cron Triggers / KV bindings / env
vars reverting to `wrangler.toml` on Git deploys), push code normally and run
`npx wrangler pages deploy dashboard --project-name=atg-forecast-dashboard`
with a real API token instead -- see the commented step at the bottom of
`.github/workflows/update-forecasts.yml`.

## What's not built yet

- **Live accuracy scorecard**: `scripts/score_accuracy.py` has the same
  pinball-loss/calibration math as the Sep 2026 backtest workbook, but it
  isn't wired into the schedule. It needs ERCOT settlement prices joined in
  against `data/<node>/forecast_log.jsonl` by `target_time` -- natural fit
  for the existing ERCOT RTM settlement price collector. This is the thing
  that eventually tells you the pilot has graduated (q90 coverage 87-93%
  for 3 straight months including a high-price month).
- **Push to the RT dispatch tool.** Out of scope for this repo -- this is a
  display dashboard. Internal push (new forecast in `data/` → notify the
  dispatch tool) can sit on top of this once that tool exists; external
  push (askthegrid webhook vs. polling) depends on whether Matt confirms
  webhook support.
- **Full fleet.** Only the 5 nodes with API access today are in
  `config/nodes.yaml`. Add rows as more get turned on.
