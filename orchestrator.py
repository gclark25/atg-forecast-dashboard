"""
Entry point run by GitHub Actions on a schedule.

For each configured node:
  1. Pull the latest Metis 1 forecast.
  2. Append new (origin_time, target_time) rows to data/<node>/forecast_log.jsonl
     -- this is the vintage-keyed store. We never overwrite past vintages, so
     this doubles as the raw input for the live accuracy scorecard later
     (scripts/score_accuracy.py reads the same file).
  3. Write dashboard/data/<node>_latest.json -- a small, frontend-friendly
     snapshot of just the most recent origin_time's forecast, for the chart.

Schedule this hourly to start (matches Metis 1's current issuance cadence).
If askthegrid ships the 5-15min cadence upgrade, tighten the cron and nothing
else here needs to change.
"""

import json
import logging
import os
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path

import yaml

from integrations.askthegrid import fetch_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("orchestrator")

ROOT = Path(__file__).parent
CONFIG_PATH = ROOT / "config" / "nodes.yaml"
RAW_DATA_DIR = ROOT / "data"
DASHBOARD_DATA_DIR = ROOT / "dashboard" / "data"


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f)


def existing_keys(log_path: Path) -> set:
    """(origin_time, target_time) pairs already on disk, so we don't duplicate rows."""
    keys = set()
    if log_path.exists():
        with open(log_path) as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                keys.add((r["origin_time"], r["target_time"]))
    return keys


def append_new_rows(node_id: str, rows: list[dict]) -> int:
    node_dir = RAW_DATA_DIR / node_id
    node_dir.mkdir(parents=True, exist_ok=True)
    log_path = node_dir / "forecast_log.jsonl"

    seen = existing_keys(log_path)
    new_rows = [r for r in rows if (r["origin_time"], r["target_time"]) not in seen]

    if new_rows:
        with open(log_path, "a") as f:
            for r in new_rows:
                f.write(json.dumps(r) + "\n")

    return len(new_rows)


def write_latest_snapshot(node_id: str, display_name: str, rows: list[dict], is_weak_tail: bool, meta: dict | None):
    DASHBOARD_DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not rows:
        return
    latest_origin = max(r["origin_time"] for r in rows)
    snapshot_rows = [r for r in rows if r["origin_time"] == latest_origin]
    snapshot_rows.sort(key=lambda r: r["target_time"])

    out = {
        "node_id": node_id,
        "display_name": display_name,
        "origin_time": latest_origin,
        "weak_tail_node": is_weak_tail,
        "source_meta": meta,  # e.g. how far this forecast actually reaches, issue cadence
        "rows": snapshot_rows,
    }
    with open(DASHBOARD_DATA_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f)

    # Separate from manifest.json (kept as a bare array so the frontend's
    # existing manifest.map()/.find() calls don't need to change) -- this is
    # when the run *started*, so the dashboard can show how stale the data is
    # and flag it if a scheduled run gets missed.
    with open(DASHBOARD_DATA_DIR / "run_status.json", "w") as f:
        json.dump({"generated_at": datetime.now(timezone.utc).isoformat()}, f)


def main():
    cfg = load_config()
    nodes = cfg["nodes"]
    weak_tail = set(cfg.get("weak_tail_nodes", []))

    results = fetch_all(nodes)

    manifest = []
    for node in nodes:
        node_id = node["node_id"]
        entry = results.get(node_id, {"rows": [], "meta": None})
        rows = entry["rows"]
        meta = entry["meta"]
        added = append_new_rows(node_id, rows)
        write_latest_snapshot(node_id, node["display_name"], rows, node_id in weak_tail, meta)
        log.info("%s: %d rows pulled, %d new", node_id, len(rows), added)
        manifest.append({
            "node_id": node_id,
            "display_name": node["display_name"],
            "weak_tail_node": node_id in weak_tail,
            "rows_pulled": len(rows),
            "new_rows": added,
        })

    with open(DASHBOARD_DATA_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f)


if __name__ == "__main__":
    main()
