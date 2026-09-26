"""Select the SolarGen production blend from stored forecast history.

The supervised target caps hourly actual generation at 6.1 kWh. That removes
above-curtailment production that depends on coincident household consumption
and is therefore not forecastable from weather inputs alone.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

try:
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
    from sklearn.linear_model import ElasticNetCV, HuberRegressor, LassoCV, RidgeCV
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
except ModuleNotFoundError as exc:  # pragma: no cover - analysis helper dependency check
    print(
        f"Missing analysis dependency: {exc.name}. "
        "Install numpy, pandas, and scikit-learn in a temporary environment to run this script.",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "solargen_history.sqlite3"
FORECASTABLE_HOURLY_CAP_KWH = 6.1
MIN_ROLLING_TRAIN_DAYS = 21
BOOTSTRAP_SAMPLES = 20_000

OM_SOURCE = "Open-Meteo day-ahead"
DWD_SOURCE = "DWD MOSMIX day-ahead"
PREVIOUS_MODEL_NAME = "Equal OM current + DWD stable"
PRODUCTION_MODEL_NAME = "Equal hourly blend, then 6.1 cap"


@dataclass
class Candidate:
    name: str
    group: str
    parameters: int
    fit: Callable[[pd.DataFrame], tuple[Callable[[pd.DataFrame], np.ndarray], dict]]


def main() -> None:
    df, hourly = load_dataset()
    candidates = build_candidates(hourly)
    rows = [evaluate_candidate(candidate, df) for candidate in candidates]
    results = pd.DataFrame(rows).sort_values(["loo_mae", "parameters", "name"])
    selected = select_candidate(results)
    previous = results[results["name"] == PREVIOUS_MODEL_NAME].iloc[0]

    print(f"Dataset: {len(df)} paired OM/DWD day-ahead dates, {df.date.min()} to {df.date.max()}")
    print(f"Actual target: sum(min(hourly_actual_kWh, {FORECASTABLE_HOURLY_CAP_KWH}))")
    print()
    print("Top candidates by leave-one-date-out MAE:")
    print_table(results.head(18))
    print()
    print("Selection rule:")
    print(
        "Choose the fewest fitted parameters among candidates within one standard error "
        "of the best chronological rolling MAE; break equal-complexity ties by rolling MAE, then LOO MAE."
    )
    print()
    print("Recommended production model:")
    print_table(pd.DataFrame([selected]))
    if selected["name"] != PRODUCTION_MODEL_NAME:
        print(f"WARNING: selection differs from production model {PRODUCTION_MODEL_NAME!r}")
    print()
    print(f"Previous production baseline: {PREVIOUS_MODEL_NAME}")
    print_comparison(previous, selected)
    print()
    print("Paired full-sample comparison (positive MAE reduction favours the recommendation):")
    print_paired_comparison(df, candidates, previous["name"], selected["name"])
    print()
    print("Monthly full-sample MAE comparison:")
    print_monthly_comparison(df, candidates, previous["name"], selected["name"])


def load_dataset() -> tuple[pd.DataFrame, dict[str, tuple[np.ndarray, np.ndarray]]]:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row

    raw_actual = {
        row["date"]: float(row["total_kwh"])
        for row in con.execute("SELECT date, total_kwh FROM actual_days")
    }
    capped_actual = {
        date: capped_actual_total(con, date, total)
        for date, total in raw_actual.items()
    }

    runs: dict[str, dict[str, dict]] = {}
    for row in con.execute(
        """
        SELECT *
        FROM forecast_runs
        WHERE source IN (?, ?)
        ORDER BY target_date, source
        """,
        (OM_SOURCE, DWD_SOURCE),
    ):
        if row["target_date"] not in capped_actual:
            continue
        item = dict(row)
        item["weather"] = json.loads(item["weather_json"])
        item["hours"] = np.array(
            [
                float(hour["forecast_kwh"])
                for hour in con.execute(
                    "SELECT forecast_kwh FROM forecast_hours WHERE forecast_run_id=? ORDER BY hour",
                    (row["id"],),
                )
            ],
            dtype=float,
        )
        runs.setdefault(row["target_date"], {})[row["source"]] = item

    records = []
    hourly: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for date, by_source in sorted(runs.items()):
        if OM_SOURCE not in by_source or DWD_SOURCE not in by_source:
            continue
        om = by_source[OM_SOURCE]
        dwd = by_source[DWD_SOURCE]
        om_weather = om["weather"]
        dwd_weather = dwd["weather"]
        dwd_stable_total = float(dwd["simple_forecast_total_kwh"])
        dwd_current_total = float(dwd["forecast_total_kwh"])
        dwd_stable_hours = dwd["hours"] * (dwd_stable_total / dwd_current_total if dwd_current_total > 0 else 0)
        hourly[date] = (om["hours"], dwd_stable_hours)

        records.append(
            {
                "date": date,
                "actual": capped_actual[date],
                "raw_actual": raw_actual[date],
                "om_current": float(om["forecast_total_kwh"]),
                "om_cap": capped_total(om["hours"]),
                "dwd_current": dwd_current_total,
                "dwd_cap": capped_total(dwd["hours"]),
                "dwd_stable": dwd_stable_total,
                "dwd_stable_cap": capped_total(dwd_stable_hours),
                "dwd_raw": float(dwd_weather.get("dwd_simple_raw_kwh", 0)),
                "old_073_blend": 0.73 * float(om["forecast_total_kwh"]) + 0.27 * dwd_stable_total,
                "equal_blend": 0.5 * float(om["forecast_total_kwh"]) + 0.5 * dwd_stable_total,
                "om_cloud": float(om_weather.get("cloud_cover_mean", 0)),
                "om_rain": float(om_weather.get("precipitation_sum", 0)),
                "om_sun_h": float(om_weather.get("sunshine_duration", 0) or 0) / 3600,
                "dwd_cloud": float(dwd_weather.get("cloud_cover_mean", 0)),
                "dwd_rain": float(dwd_weather.get("precipitation_sum", 0)),
                "dwd_sun_h": float(dwd_weather.get("sunshine_duration", 0) or 0) / 3600,
            }
        )

    return pd.DataFrame(records).reset_index(drop=True), hourly


def capped_actual_total(con: sqlite3.Connection, date: str, raw_total: float) -> float:
    rows = con.execute(
        "SELECT generation_kwh FROM actual_hours WHERE date=? ORDER BY hour",
        (date,),
    ).fetchall()
    if not rows:
        return float(raw_total)
    return sum(min(float(row["generation_kwh"]), FORECASTABLE_HOURLY_CAP_KWH) for row in rows)


def capped_total(values: np.ndarray) -> float:
    return float(np.minimum(values, FORECASTABLE_HOURLY_CAP_KWH).sum())


def build_candidates(hourly: dict[str, tuple[np.ndarray, np.ndarray]]) -> list[Candidate]:
    def fixed_column(name: str, column: str) -> Candidate:
        return Candidate(name, "fixed", 0, lambda _train, column=column: (lambda test: np.array(test[column]), {}))

    def fixed_expression(name: str, predict: Callable[[pd.DataFrame], np.ndarray]) -> Candidate:
        return Candidate(name, "fixed", 0, lambda _train, predict=predict: (predict, {}))

    def fixed_hourly_cap(name: str, weight: float) -> Candidate:
        return Candidate(name, "structural", 0, lambda _train, weight=weight: (lambda test: hourly_cap_prediction(test, hourly, weight), {}))

    candidates = [
        fixed_column("Old 0.73 OM + 0.27 DWD stable", "old_073_blend"),
        fixed_column("Equal OM current + DWD stable", "equal_blend"),
        fixed_column("OM current only", "om_current"),
        fixed_column("DWD stable only", "dwd_stable"),
        fixed_expression("Equal capped OM + capped DWD stable", lambda test: 0.5 * np.array(test["om_cap"]) + 0.5 * np.array(test["dwd_stable_cap"])),
        fixed_hourly_cap("Equal hourly blend, then 6.1 cap", 0.5),
        Candidate("Fitted convex OM/DWD stable", "simple", 1, lambda train: fit_convex(train, "om_current", "dwd_stable")),
        Candidate("Fitted convex OM/DWD stable + median bias", "simple", 2, lambda train: fit_convex(train, "om_current", "dwd_stable", bias=True)),
        Candidate("Old blend + mean bias", "simple", 1, lambda train: fit_bias(train, "old_073_blend")),
        Candidate("Old blend affine", "simple", 2, lambda train: fit_affine(train, ["old_073_blend"])),
        Candidate("Linear OM + DWD stable + bias", "linear", 3, lambda train: fit_affine(train, ["om_current", "dwd_stable"])),
        Candidate("Linear OM + DWD current + DWD raw + bias", "linear", 4, lambda train: fit_affine(train, ["om_current", "dwd_current", "dwd_raw"])),
        Candidate("Fitted hourly blend, then 6.1 cap", "structural", 1, lambda train: fit_hourly_cap(train, hourly)),
        Candidate("Fitted hourly blend, then 6.1 cap + median bias", "structural", 2, lambda train: fit_hourly_cap(train, hourly, bias=True)),
    ]

    raw_weather_features = [
        "om_current",
        "dwd_stable",
        "dwd_current",
        "dwd_raw",
        "om_cloud",
        "om_rain",
        "om_sun_h",
        "dwd_cloud",
        "dwd_rain",
        "dwd_sun_h",
    ]
    capped_weather_features = [
        "om_cap",
        "dwd_stable_cap",
        "dwd_cap",
        "dwd_raw",
        "om_cloud",
        "om_rain",
        "om_sun_h",
        "dwd_cloud",
        "dwd_rain",
        "dwd_sun_h",
    ]
    alphas = np.logspace(-3, 4, 40)
    candidates.extend(
        [
            Candidate("RidgeCV raw weather", "ml", 12, sklearn_fit(lambda: make_pipeline(StandardScaler(), RidgeCV(alphas=alphas)), raw_weather_features)),
            Candidate("RidgeCV capped weather", "ml", 12, sklearn_fit(lambda: make_pipeline(StandardScaler(), RidgeCV(alphas=alphas)), capped_weather_features)),
            Candidate("LassoCV capped weather", "ml", 12, sklearn_fit(lambda: make_pipeline(StandardScaler(), LassoCV(alphas=np.logspace(-3, 2, 40), cv=5, max_iter=100000, random_state=1)), capped_weather_features)),
            Candidate("ElasticNetCV capped weather", "ml", 12, sklearn_fit(lambda: make_pipeline(StandardScaler(), ElasticNetCV(alphas=np.logspace(-3, 2, 30), l1_ratio=[0.2, 0.5, 0.8, 1], cv=5, max_iter=100000, random_state=1)), capped_weather_features)),
            Candidate("Huber capped weather", "ml", 12, sklearn_fit(lambda: make_pipeline(StandardScaler(), HuberRegressor(alpha=1, max_iter=1000)), capped_weather_features)),
            Candidate("RandomForest capped weather", "ml", 20, sklearn_fit(lambda: RandomForestRegressor(n_estimators=300, max_depth=2, min_samples_leaf=5, random_state=1), capped_weather_features)),
            Candidate("GradientBoosting capped weather", "ml", 30, sklearn_fit(lambda: GradientBoostingRegressor(n_estimators=50, learning_rate=0.05, max_depth=2, min_samples_leaf=5, random_state=1), capped_weather_features)),
        ]
    )
    return candidates


def fit_bias(train: pd.DataFrame, column: str):
    bias = float((train["actual"] - train[column]).mean())
    return lambda test: np.array(test[column], dtype=float) + bias, {"bias": bias}


def fit_affine(train: pd.DataFrame, columns: list[str]):
    x = np.column_stack([np.array(train[column], dtype=float) for column in columns] + [np.ones(len(train))])
    beta = np.linalg.lstsq(x, np.array(train["actual"], dtype=float), rcond=None)[0]

    def predict(test: pd.DataFrame) -> np.ndarray:
        test_x = np.column_stack([np.array(test[column], dtype=float) for column in columns] + [np.ones(len(test))])
        return test_x @ beta

    params = {f"b_{column}": float(beta[index]) for index, column in enumerate(columns)}
    params["intercept"] = float(beta[-1])
    return predict, params


def fit_convex(train: pd.DataFrame, a_column: str, b_column: str, bias: bool = False):
    y = np.array(train["actual"], dtype=float)
    a = np.array(train[a_column], dtype=float)
    b = np.array(train[b_column], dtype=float)
    best = None
    for weight in np.arange(0, 1.0005, 0.001):
        base = weight * a + (1 - weight) * b
        offset = float(np.median(y - base)) if bias else 0.0
        mae = float(np.mean(np.abs(y - base - offset)))
        if best is None or mae < best[0]:
            best = (mae, float(weight), offset)
    _, weight, offset = best
    return (
        lambda test: weight * np.array(test[a_column], dtype=float) + (1 - weight) * np.array(test[b_column], dtype=float) + offset,
        {f"w_{a_column}": weight, f"w_{b_column}": 1 - weight, "bias": offset},
    )


def fit_hourly_cap(train: pd.DataFrame, hourly: dict[str, tuple[np.ndarray, np.ndarray]], bias: bool = False):
    y = np.array(train["actual"], dtype=float)
    dates = list(train["date"])
    best = None
    for weight in np.arange(0, 1.0005, 0.001):
        base = hourly_cap_prediction_dates(dates, hourly, float(weight))
        offset = float(np.median(y - base)) if bias else 0.0
        mae = float(np.mean(np.abs(y - base - offset)))
        if best is None or mae < best[0]:
            best = (mae, float(weight), offset)
    _, weight, offset = best
    return (
        lambda test: hourly_cap_prediction(test, hourly, weight) + offset,
        {"w_om_hourly": weight, "w_dwd_stable_hourly": 1 - weight, "bias": offset},
    )


def hourly_cap_prediction(test: pd.DataFrame, hourly: dict[str, tuple[np.ndarray, np.ndarray]], weight: float) -> np.ndarray:
    return hourly_cap_prediction_dates(list(test["date"]), hourly, weight)


def hourly_cap_prediction_dates(dates: list[str], hourly: dict[str, tuple[np.ndarray, np.ndarray]], weight: float) -> np.ndarray:
    return np.array(
        [
            np.minimum(weight * hourly[date][0] + (1 - weight) * hourly[date][1], FORECASTABLE_HOURLY_CAP_KWH).sum()
            for date in dates
        ],
        dtype=float,
    )


def sklearn_fit(factory: Callable[[], object], features: list[str]):
    def fit(train: pd.DataFrame):
        estimator = factory()
        estimator.fit(train[features].fillna(0).to_numpy(dtype=float), train["actual"].to_numpy(dtype=float))
        return (
            lambda test: estimator.predict(test[features].fillna(0).to_numpy(dtype=float)),
            {"features": ",".join(features)},
        )

    return fit


def evaluate_candidate(candidate: Candidate, df: pd.DataFrame) -> dict:
    in_sample, params = score_fit(candidate, df, df)
    loo = leave_one_out(candidate, df)
    rolling = rolling_validation(candidate, df)
    recent = recent_validation(candidate, df)
    return {
        "name": candidate.name,
        "group": candidate.group,
        "parameters": candidate.parameters,
        **{f"in_{key}": value for key, value in in_sample.items()},
        **{f"loo_{key}": value for key, value in loo.items()},
        **{f"rolling_{key}": value for key, value in rolling.items()},
        **{f"recent14_{key}": value for key, value in recent.items()},
        "fit": params,
    }


def select_candidate(results: pd.DataFrame) -> pd.Series:
    best = results.sort_values(["rolling_mae", "loo_mae"]).iloc[0]
    threshold = float(best["rolling_mae"] + best["rolling_mae_se"])
    eligible = results[results["rolling_mae"] <= threshold]
    return eligible.sort_values(["parameters", "rolling_mae", "loo_mae", "name"]).iloc[0]


def score_fit(candidate: Candidate, train: pd.DataFrame, test: pd.DataFrame) -> tuple[dict, dict]:
    predict, params = candidate.fit(train)
    return metrics(test["actual"], np.maximum(0, predict(test))), params


def leave_one_out(candidate: Candidate, df: pd.DataFrame) -> dict:
    actuals = []
    predictions = []
    for index in range(len(df)):
        train = df.drop(df.index[index]).reset_index(drop=True)
        test = df.iloc[[index]]
        predict, _ = candidate.fit(train)
        actuals.extend(test["actual"])
        predictions.extend(np.maximum(0, predict(test)))
    return metrics(actuals, predictions)


def rolling_validation(candidate: Candidate, df: pd.DataFrame) -> dict:
    actuals = []
    predictions = []
    for index in range(MIN_ROLLING_TRAIN_DAYS, len(df)):
        train = df.iloc[:index].reset_index(drop=True)
        test = df.iloc[[index]]
        predict, _ = candidate.fit(train)
        actuals.extend(test["actual"])
        predictions.extend(np.maximum(0, predict(test)))
    return metrics(actuals, predictions)


def recent_validation(candidate: Candidate, df: pd.DataFrame, days: int = 14) -> dict:
    train = df.iloc[:-days].reset_index(drop=True)
    test = df.iloc[-days:].reset_index(drop=True)
    predict, _ = candidate.fit(train)
    return metrics(test["actual"], np.maximum(0, predict(test)))


def metrics(actuals, predictions) -> dict[str, float]:
    actual = np.array(actuals, dtype=float)
    predicted = np.array(predictions, dtype=float)
    error = actual - predicted
    absolute_error = np.abs(error)
    nonzero = actual > 1e-9
    return {
        "n": int(len(actual)),
        "mae": float(np.mean(absolute_error)),
        "mae_se": float(np.std(absolute_error, ddof=1) / np.sqrt(len(actual))) if len(actual) > 1 else 0.0,
        "rmse": float(np.sqrt(np.mean(error * error))),
        "bias": float(np.mean(error)),
        "median_ae": float(np.median(absolute_error)),
        "p90_ae": float(np.quantile(absolute_error, 0.9)),
        "mape": float(np.mean(absolute_error[nonzero] / actual[nonzero]) * 100) if np.any(nonzero) else 0.0,
        "wape": float(np.sum(absolute_error) / np.sum(actual) * 100) if np.sum(actual) > 0 else 0.0,
    }


def print_table(rows: pd.DataFrame) -> None:
    columns = ["name", "group", "parameters", "in_mae", "loo_mae", "rolling_mae", "recent14_mae", "loo_bias"]
    print(
        rows[columns].to_string(
            index=False,
            formatters={
                "in_mae": "{:.3f}".format,
                "loo_mae": "{:.3f}".format,
                "rolling_mae": "{:.3f}".format,
                "recent14_mae": "{:.3f}".format,
                "loo_bias": "{:.3f}".format,
            },
        )
    )


def print_comparison(current: pd.Series, selected: pd.Series) -> None:
    rows = []
    for validation in ("loo", "rolling", "recent14"):
        rows.append({
            "validation": validation,
            "current_mae": current[f"{validation}_mae"],
            "recommended_mae": selected[f"{validation}_mae"],
            "mae_change": selected[f"{validation}_mae"] - current[f"{validation}_mae"],
            "current_rmse": current[f"{validation}_rmse"],
            "recommended_rmse": selected[f"{validation}_rmse"],
            "current_bias": current[f"{validation}_bias"],
            "recommended_bias": selected[f"{validation}_bias"],
            "current_wape": current[f"{validation}_wape"],
            "recommended_wape": selected[f"{validation}_wape"],
        })
    columns = [
        "validation", "current_mae", "recommended_mae", "mae_change",
        "current_rmse", "recommended_rmse", "current_bias", "recommended_bias",
        "current_wape", "recommended_wape",
    ]
    print(
        pd.DataFrame(rows)[columns].to_string(
            index=False,
            formatters={column: "{:.3f}".format for column in columns if column != "validation"},
        )
    )


def candidate_predictions(df: pd.DataFrame, candidates: list[Candidate], name: str) -> np.ndarray:
    candidate = next(item for item in candidates if item.name == name)
    predict, _ = candidate.fit(df)
    return np.maximum(0, predict(df))


def print_paired_comparison(
    df: pd.DataFrame,
    candidates: list[Candidate],
    current_name: str,
    selected_name: str,
) -> None:
    actual = df["actual"].to_numpy(dtype=float)
    current = candidate_predictions(df, candidates, current_name)
    selected = candidate_predictions(df, candidates, selected_name)
    improvement = np.abs(actual - current) - np.abs(actual - selected)
    rng = np.random.default_rng(20260926)
    indexes = rng.integers(0, len(improvement), size=(BOOTSTRAP_SAMPLES, len(improvement)))
    bootstrap_means = improvement[indexes].mean(axis=1)
    low, high = np.quantile(bootstrap_means, [0.025, 0.975])
    selected_wins = int(np.sum(improvement > 1e-9))
    ties = int(np.sum(np.abs(improvement) <= 1e-9))
    current_wins = int(np.sum(improvement < -1e-9))
    print(
        f"mean_mae_reduction={improvement.mean():.3f} kWh/day; "
        f"paired_bootstrap_95pct_ci=[{low:.3f}, {high:.3f}]; "
        f"recommended_wins={selected_wins}; ties={ties}; current_wins={current_wins}"
    )


def print_monthly_comparison(
    df: pd.DataFrame,
    candidates: list[Candidate],
    current_name: str,
    selected_name: str,
) -> None:
    comparison = df[["date", "actual"]].copy()
    comparison["month"] = comparison["date"].str[:7]
    comparison["current"] = candidate_predictions(df, candidates, current_name)
    comparison["recommended"] = candidate_predictions(df, candidates, selected_name)
    comparison["current_ae"] = np.abs(comparison["actual"] - comparison["current"])
    comparison["recommended_ae"] = np.abs(comparison["actual"] - comparison["recommended"])
    monthly = comparison.groupby("month", as_index=False).agg(
        days=("date", "count"),
        mean_actual=("actual", "mean"),
        current_mae=("current_ae", "mean"),
        recommended_mae=("recommended_ae", "mean"),
    )
    monthly["mae_change"] = monthly["recommended_mae"] - monthly["current_mae"]
    print(
        monthly.to_string(
            index=False,
            formatters={
                "mean_actual": "{:.3f}".format,
                "current_mae": "{:.3f}".format,
                "recommended_mae": "{:.3f}".format,
                "mae_change": "{:.3f}".format,
            },
        )
    )


if __name__ == "__main__":
    main()
