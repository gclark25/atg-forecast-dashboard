"""
Live accuracy scorecard -- same pinball-loss / calibration methodology as the
Sep 2026 backtest workbook, run against whatever's accumulated in
data/<node>/forecast_log.jsonl so far.

Not wired into the GitHub Actions schedule yet on purpose: this only becomes
useful once (a) actual settled prices are available to compare against (the
log only stores the forecast side right now -- you'll need to join in ERCOT
settlement prices, e.g. via the existing ERCOT np6-905-cd RTM settlement
point price feed, keyed on node_id + target_time) and (b) enough history has
accumulated to be meaningful. Run manually for now:

    python scripts/score_accuracy.py data/FTDUNCAN_RN/forecast_log.jsonl --actuals path/to/ercot_actuals.csv

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
    ap.add_argument("--actuals", help="CSV with node_id, target_time, truth columns to join in", required=False)
    args = ap.parse_args()

    df = load_forecast_log(args.forecast_log)

    if args.actuals:
        actuals = pd.read_csv(args.actuals)
        df = df.merge(actuals[["node_id", "target_time", "truth"]], on=["node_id", "target_time"], how="left")
    elif "truth" not in df.columns:
        print("No actuals joined and forecast log has no truth column -- nothing to score yet.")
        return

    result = score(df)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
