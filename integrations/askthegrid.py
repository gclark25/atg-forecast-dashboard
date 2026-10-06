"""
Thin client for askthegrid.com's Metis 1 Preview forecast API.

IMPORTANT -- confirm before first real run:
This vendor does not publish public API docs (the console at
https://askthegrid.com/developers/console/api-keys is login-gated), so the
exact endpoint path, auth header name, and response schema below are a
best-guess placeholder based on the CSV deliverables we've already graded
(same column names: node_id, origin_time, target_time, horizon_step,
horizon_hours, q05...q95). Open the API reference from inside the developer
console once you have the key and fix the three spots marked CONFIRM below.
Everything downstream (parsing, storage) is written against that known
column schema, so it shouldn't need to change even if the endpoint does.
"""

import os
import time
import json
import logging
from datetime import datetime, timezone

import requests

log = logging.getLogger("askthegrid")

BASE_URL = os.environ.get("ASKTHEGRID_BASE_URL", "https://api.askthegrid.com")  # CONFIRM
API_KEY_ENV = "ASKTHEGRID_API_KEY"

QUANTILE_COLS = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"]


class AskTheGridError(RuntimeError):
    pass


def _get_api_key() -> str:
    key = os.environ.get(API_KEY_ENV)
    if not key:
        raise AskTheGridError(
            f"{API_KEY_ENV} is not set. In GitHub Actions this comes from a repo secret; "
            "locally, export it in your Codespace (don't commit it)."
        )
    return key


def _request(path: str, params: dict, max_retries: int = 5) -> dict:
    """GET with exponential backoff on 429/5xx, same pattern as ercot_get()."""
    headers = {
        "Authorization": f"Bearer {_get_api_key()}",  # CONFIRM header name/scheme
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
        raise AskTheGridError(f"askthegrid API error {resp.status_code}: {resp.text[:500]}")

    raise AskTheGridError(f"askthegrid API: exhausted retries on {path}")


def get_latest_forecast(node_id: str) -> dict:
    """
    Pull the most recently issued forecast for one node.

    Expected to return, per target_time out to the forecast horizon:
    origin_time, target_time, horizon_step, horizon_hours, and q05..q95.
    Adjust the path/params below (CONFIRM) once you've read the real docs --
    keep the return shape (a dict with a "rows" list of that schema) the same
    so parse_forecast_response() below doesn't need to change.
    """
    data = _request("/v1/forecasts/latest", {"node_id": node_id})  # CONFIRM path/params
    return data


def parse_forecast_response(raw: dict, node_id: str) -> list[dict]:
    """Normalize whatever the API returns into our flat row schema."""
    rows = raw.get("rows", raw.get("data", []))
    out = []
    for r in rows:
        row = {
            "node_id": node_id,
            "origin_time": r.get("origin_time"),
            "target_time": r.get("target_time"),
            "horizon_hours": r.get("horizon_hours"),
            "pulled_at": datetime.now(timezone.utc).isoformat(),
        }
        for q in QUANTILE_COLS:
            row[q] = r.get(q)
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
