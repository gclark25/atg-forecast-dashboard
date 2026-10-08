# ATG Forecast Dashboard

Displays askthegrid.com's Metis 1 Preview nodal price forecasts for HEN's
nodes. Follows the same pattern as `hen-morning-report`: Python orchestrator +
integrations library, static Chart.js frontend, GitHub Actions on a schedule,
Cloudflare Pages to host it.

## Status

Built against askthegrid's real OpenAPI spec (`GET /api/v1/grid/forecasts`,
bearer auth, base URL `https://askthegrid.com`) and **verified against a real
pull on 2026-10-06** (all 5 nodes, 93 rows each): quantiles came back
monotonic (q05 < q10 < ... < q95) on every row, and no `SOURCE_MATCH` fallback
warning was logged, so both previously-open items are confirmed working:

1. `SOURCE_MATCH = "metis"` correctly picked the right `series[].source` on
   the first try, across all 5 nodes. Revisit only if a future pull logs a
   fallback warning (e.g. the vendor adds a second forecast source per node).
2. The `levels` dict key-guessing in `_extract_quantile` hit on the first
   format tried for every point observed so far.

Each forecast point also carries the settled `actual` price once ERCOT has
published it, right alongside the quantiles -- confirmed live (currently
`null` for all points, since every pulled point is still in the future
relative to the pull). That means `scripts/score_accuracy.py` scores straight
off `data/<node>/forecast_log.jsonl`'s `truth` column, no separate ERCOT
settlement-price join needed.

One thing worth asking James: the live pull returned **~23 hours of horizon**
(93 rows at 15-min resolution), not the 48h the backtest data implied.
`source_meta.horizon_hours` in each dashboard snapshot file will show the
vendor's own stated horizon on the next pull -- worth checking whether 23h is
the current live ceiling (vs. the backtest's 48h) or just what happened to be
available at pull time.

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
  pinball-loss/calibration math as the Sep 2026 backtest workbook, and now
  scores directly off `data/<node>/forecast_log.jsonl`'s `truth` column
  (populated from the API's own `actual` field -- no ERCOT join needed). It
  just isn't wired into the schedule yet. Note that `truth` is often still
  null for recent rows -- the forecast log is append-only, so simply re-reading
  the same file days later picks up actuals as ERCOT settles them; you don't
  need to re-pull. This is the thing that eventually tells you the pilot has
  graduated (q90 coverage 87-93% for 3 straight months including a high-price
  month).
- **Push to the RT dispatch tool.** Out of scope for this repo -- this is a
  display dashboard. Internal push (new forecast in `data/` → notify the
  dispatch tool) can sit on top of this once that tool exists; external
  push (askthegrid webhook vs. polling) depends on whether Matt confirms
  webhook support.

