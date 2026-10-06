"""
Client for askthegrid.com's `GET /api/v1/grid/forecasts` endpoint, confirmed
against their real OpenAPI spec (received 2026-10-06). Replaces the earlier
placeholder version.

Two things are still genuinely unconfirmed because the OpenAPI schema
describes shapes, not the actual string values a live response contains --
fix these once you've made one real call and can see them:

1. SOURCE_MATCH below -- which `series[].source` entry is Metis 1 Preview.
   The spec confirms `series` can hold multiple forecast sources per node;
   we select by a fuzzy name match. Check the first real response's
   `series[].source.id` / `.shortName` / `.displayName` and tighten this if
   it ever selects the wrong one.
2. The exact string keys inside each point's `levels` dict for q05/q25/q75/
   q95 (p10/p50/p90 are confirmed top-level fields, not in `levels`). The
   schema only says `levels` is `{str: number}`; `_extract_quantile` below
   tries a few plausible encodings ("0.05", "5", "p05") -- check a real
   response and adjust CANDIDATE_KEY_FORMATS if none of them hit.

Everything else here (base URL, auth scheme, endpoint path, param names,
response field names) is taken directly from the spec, not guessed.
"""

import os
import time
import logging
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger("askthegrid")

BASE_URL = "https://askthegrid.com"
FORECAST_PATH = "/api/v1/grid/forecasts"
API_KEY_ENV = "ASKTHEGRID_API_KEY"

# name -> quantile level. p10/p50/p90 come back as dedicated top-level fields;
# everything else must be read out of each point's `levels` dict.
QUANTILE_LEVELS = {"q05": 0.05, "q10": 0.10, "q25": 0.25, "q50": 0.50, "q75": 0.75, "q90": 0.90, "q95": 0.95}
TOP_LEVEL_FIELD = {0.10: "p10", 0.50: "p50", 0.90: "p90"}

SOURCE_MATCH = "metis"  # CONFIRM against a real series[].source once you can see one


class AskTheGridError(RuntimeError):
    pass


def _get_api_key() -> str:
    key = os.environ.get(API_KEY_ENV)
    if not key:
        raise AskTheGridError(
            f"{API_KEY_ENV} is not set. In GitHub Actions this comes from the repo secret; "
            "locally, export it in your Codespace (don't commit it)."
        )
    return key


def _request(path: str, params: dict, max_retries: int = 5) -> dict:
    """GET with exponential backoff on 429/5xx, same pattern as ercot_get()."""
    headers = {
        "Authorization": f"Bearer {_get_api_key()}",  # confirmed: bearerAuth in the spec
        "Accept": "application/json",
    }
    url = f"{BASE_URL}{path}"

    for attempt in range(max_retries):
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (429, 500, 502, 503, 504):
            wait = 2 ** attempt
            log.warning("askthegrid %s on %s, retrying in %ss", resp.status_code, path, wait)
            time.sleep(wait)
            continue
        # 400/401 are listed as the only other documented responses -- not retryable
        raise AskTheGridError(f"askthegrid API error {resp.status_code}: {resp.text[:500]}")

    raise AskTheGridError(f"askthegrid API: exhausted retries on {path}")


def get_latest_forecast(node_id: str, horizon_hours: float = 48) -> dict:
    """
    GET /api/v1/grid/forecasts for one ERCOT resource node, current issuance.

    `detail=levels` skips the 256-entry bucketProbabilities/distributionSupports
    payload we don't need for a quantile chart -- smaller response, same quantiles.
    No `vintageMode` passed -- defaults to the live/current forecast rather than
    the historical-comparison or latest-before stitching modes (those matter for
    scripts/score_accuracy.py, not for the dashboard).
    """
    now = datetime.now(timezone.utc)
    params = {
        "iso": "ERCOT",
        "targetKind": "node",
        "targetId": node_id,
        "from": now.isoformat(),
        "to": (now + timedelta(hours=horizon_hours)).isoformat(),
        "detail": "levels",
    }
    return _request(FORECAST_PATH, params)


def _select_metis_series(raw: dict) -> dict | None:
    for s in raw.get("series", []):
        src = s.get("source", {}) or {}
        name = " ".join(str(src.get(k, "")) for k in ("id", "shortName", "displayName", "modelId")).lower()
        if SOURCE_MATCH in name:
            return s
    if raw.get("series"):
        log.warning("no series matched SOURCE_MATCH=%r; falling back to series[0] (%s)",
                    SOURCE_MATCH, raw["series"][0].get("source", {}).get("displayName"))
        return raw["series"][0]
    return None


def _extract_quantile(point: dict, level: float):
    if level in TOP_LEVEL_FIELD:
        return point.get(TOP_LEVEL_FIELD[level])
    levels = point.get("levels") or {}
    for key in (str(level), f"{level:.2f}", str(int(round(level * 100))), f"p{int(round(level * 100)):02d}"):
        if key in levels:
            return levels[key]
    return None


def parse_forecast_response(raw: dict, node_id: str) -> list[dict]:
    """
    Normalize one /grid/forecasts response into our flat row schema.

    Row schema matches the CSV backtest deliverables (origin_time, target_time,
    horizon_hours, q05...q95) plus a new `truth` field: the API returns the
    settled actual price right on each point once ERCOT has published it
    (`point["actual"]`), so scripts/score_accuracy.py can score directly off
    this log without a separate ERCOT settlement-price join.
    """
    series = _select_metis_series(raw)
    if series is None:
        log.warning("no forecast series returned for %s", node_id)
        return []

    issued_at = series.get("issuedAt")
    issued_dt = datetime.fromisoformat(issued_at.replace("Z", "+00:00")) if issued_at else None

    out = []
    for p in series.get("points", []):
        ts = p.get("ts")
        horizon_hours = None
        if issued_dt and ts:
            ts_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            horizon_hours = (ts_dt - issued_dt).total_seconds() / 3600

        row = {
            "node_id": node_id,
            "origin_time": issued_at,
            "target_time": ts,
            "horizon_hours": horizon_hours,
            "pulled_at": datetime.now(timezone.utc).isoformat(),
            "truth": p.get("actual"),
        }
        for qcol, qlev in QUANTILE_LEVELS.items():
            row[qcol] = _extract_quantile(p, qlev)
        out.append(row)
    return out


def fetch_all(nodes: list[dict]) -> dict[str, list[dict]]:
    """Fetch latest forecast for every configured node. Returns node_id -> rows."""
    results = {}
    for node in nodes:
        node_id = node["node_id"]
        try:
            raw = get_latest_forecast(node_id)
            results[node_id] = parse_forecast_response(raw, node_id)
            log.info("pulled %d rows for %s", len(results[node_id]), node_id)
        except AskTheGridError as e:
            log.error("failed to pull %s: %s", node_id, e)
            results[node_id] = []
    return results
