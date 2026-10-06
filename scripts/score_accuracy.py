"""
Live accuracy scorecard -- same pinball-loss / calibration methodology as the
Sep 2026 backtest workbook, run against whatever's accumulated in
data/<node>/forecast_log.jsonl so far.

Scores straight off the log's `truth` column (populated from askthegrid's own
`actual` field on each forecast point -- no separate ERCOT settlement join
needed). `truth` will be null for rows whose target_time hasn't settled yet;
score() drops those automatically, so just re-run this later as more of the
log fills in -- you don't need to re-pull anything.

Not wired into the GitHub Actions schedule yet on purpose: only useful once
enough history has accumulated to be meaningful. Run manually for now:

    python scripts/score_accuracy.py data/FTDUNCAN_RN/forecast_log.jsonl

Pass --actuals only if you want to score against some other actuals source
instead of (or to backfill gaps in) the log's own truth column.

This is the thing that will eventually tell you the pilot has graduated:
q90 coverage within ~87-93% for 3 consecutive months including at least one
high-price month (see askthegrid-forecast-eval notes for the full exit
criteria).
"""

import argparse
import json

import pandas as pd
import numpy as np

QCOLS = ["q05", "q10", "q25", "q50", "q75", "q90", "q95"]
QLEV = {"q05": 0.05, "q10": 0.10, "q25": 0.25, "q50": 0.50, "q75": 0.75, "q90": 0.90, "q95": 0.95}


def load_forecast_log(path: str) -> pd.DataFrame:
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return pd.DataFrame(rows)


def pinball_loss(truth: np.ndarray, pred: np.ndarray, q: float) -> np.ndarray:
    diff = truth - pred
    return np.where(diff >= 0, q * diff, (q - 1) * diff)


def score(df: pd.DataFrame) -> dict:
    """df must have a 'truth' column joined in alongside the quantile columns."""
    df = df.dropna(subset=["truth"])
    out = {"n": len(df)}
    if len(df) == 0:
        return out
    for q in QCOLS:
        pb = pinball_loss(df["truth"].values, df[q].values, QLEV[q])
        out[f"pinball_{q}"] = float(pb.mean())
        out[f"coverage_{q}"] = float((df["truth"] <= df[q]).mean())
    resid = df["truth"].values - df["q50"].values
    out["mae_median"] = float(np.abs(resid).mean())
    out["rmse_median"] = float(np.sqrt((resid ** 2).mean()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("forecast_log")
    ap.add_argument("--actuals", help="optional CSV with node_id, target_time, truth to override/backfill the log's own truth column", required=False)
    args = ap.parse_args()

    df = load_forecast_log(args.forecast_log)

    if args.actuals:
        actuals = pd.read_csv(args.actuals)
        df = df.drop(columns=["truth"], errors="ignore").merge(
            actuals[["node_id", "target_time", "truth"]], on=["node_id", "target_time"], how="left"
        )
    elif "truth" not in df.columns:
        print("Forecast log has no truth column and no --actuals given -- nothing to score yet.")
        return

    result = score(df)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
