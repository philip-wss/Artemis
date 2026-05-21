"""
Global Search Benchmark Script

Benchmarks the Artemis global search API (GET /api/search) backed by Weaviate.

For each configured query the script:
  1. Runs `iterations` warm-up-free calls to the search endpoint.
  2. Records wall-clock latency per call.
  3. Reports min / max / mean / median / p95 / p99 per (query × type) combination.

Before running the latency benchmark the script queries Weaviate directly to
report how many entities of each type are currently ingested — this context is
included at the top of the generated Markdown report.

Usage
-----
    python3 benchmark_global_search.py [--config path/to/config.ini] [--output path/to/report.md]

Output
------
    benchmark_report_<YYYY-MM-DD_HH-MM-SS>.md   (written to output_dir from config)
"""

import argparse
import configparser
import json
import os
import statistics
import time
from datetime import datetime, timezone
from typing import Any

import requests

from logging_config import logging

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.ini")

config = configparser.ConfigParser()


def load_config(path: str) -> None:
    read = config.read(path)
    if not read:
        raise FileNotFoundError(f"Config file not found: {path}")


# ---------------------------------------------------------------------------
# Artemis authentication
# ---------------------------------------------------------------------------

def authenticate(session: requests.Session, server_url: str, username: str, password: str) -> None:
    url = f"{server_url}/core/public/authenticate"
    payload = {"username": username, "password": password, "rememberMe": True}
    resp = session.post(url, json=payload, headers={"Content-Type": "application/json"})
    if resp.status_code != 200:
        raise RuntimeError(
            f"Authentication failed for '{username}' — HTTP {resp.status_code}: {resp.text}"
        )
    logging.info("Authenticated as '%s'", username)


# ---------------------------------------------------------------------------
# Weaviate entity-count helpers
# ---------------------------------------------------------------------------

def _weaviate_base_url(http_host: str, http_port: int) -> str:
    return f"http://{http_host}:{http_port}"


def _weaviate_headers(api_key: str) -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _graphql_count(
    weaviate_url: str,
    headers: dict[str, str],
    collection_name: str,
    entity_type: str | None,
) -> int:
    """Return the number of Weaviate objects matching the given type (or all if None)."""
    if entity_type:
        where_clause = (
            f'(where: {{ path: ["type"], operator: Equal, valueText: "{entity_type}" }})'
        )
    else:
        where_clause = ""

    query = (
        "{ Aggregate { "
        + collection_name
        + where_clause
        + " { meta { count } } } }"
    )

    try:
        resp = requests.post(
            f"{weaviate_url}/v1/graphql",
            json={"query": query},
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["data"]["Aggregate"][collection_name][0]["meta"]["count"]
    except Exception as exc:
        logging.warning("Could not fetch count for type=%s: %s", entity_type, exc)
        return -1


def collect_entity_counts(
    http_host: str,
    http_port: int,
    collection_prefix: str,
    api_key: str,
    entity_types: list[str],
) -> dict[str, int]:
    """
    Query Weaviate for the total entity count and per-type counts.

    Returns a dict with 'total' plus one entry per type.
    """
    weaviate_url = _weaviate_base_url(http_host, http_port)
    headers = _weaviate_headers(api_key)
    collection_name = f"{collection_prefix}SearchableEntities"

    logging.info("Querying Weaviate at %s for entity counts (collection: %s)", weaviate_url, collection_name)

    counts: dict[str, int] = {}
    for t in entity_types:
        counts[t] = _graphql_count(weaviate_url, headers, collection_name, t)
    known = [c for c in counts.values() if c >= 0]
    counts["total"] = sum(known) if known else -1

    return counts


# ---------------------------------------------------------------------------
# Search benchmark
# ---------------------------------------------------------------------------

# A curated set of queries designed to exercise different entity types.
# Ordered from generic (hits many types) to type-specific.
BENCHMARK_QUERIES: list[dict[str, Any]] = [
    # Generic / cross-type
    {"label": "empty (browse mode)", "query": ""},
    {"label": "generic: programming", "query": "programming"},
    {"label": "generic: quiz", "query": "quiz"},
    {"label": "generic: lecture notes", "query": "lecture notes"},
    {"label": "generic: exam preparation", "query": "exam preparation"},
    # Exercise-oriented
    {"label": "exercise: sorting algorithm", "query": "sorting algorithm"},
    {"label": "exercise: binary search tree", "query": "binary search tree"},
    {"label": "exercise: object-oriented design", "query": "object-oriented design"},
    # Lecture / lecture-unit-oriented
    {"label": "lecture: introduction to databases", "query": "introduction to databases"},
    {"label": "lecture: machine learning basics", "query": "machine learning basics"},
    # Exam-oriented
    {"label": "exam: midterm", "query": "midterm"},
    {"label": "exam: final", "query": "final exam"},
    # FAQ-oriented
    {"label": "faq: submission deadline", "query": "submission deadline"},
    {"label": "faq: grading criteria", "query": "grading criteria"},
    # Channel-oriented
    {"label": "channel: general announcements", "query": "general announcements"},
    {"label": "channel: organization", "query": "organization"},
    # Course-oriented (requires add-courses-and-messages feature)
    {"label": "course: software engineering", "query": "software engineering"},
    {"label": "course: computer science", "query": "computer science"},
    # Post / answer-post-oriented (requires add-courses-and-messages feature)
    {"label": "message: help with exercise", "query": "help with exercise"},
    {"label": "message: clarification needed", "query": "clarification needed"},
]


def _run_query(
    session: requests.Session,
    server_url: str,
    query: str,
    types_param: str,
    limit: int,
) -> float:
    """Issue one search request and return the wall-clock latency in milliseconds."""
    url = f"{server_url}/search"
    params: dict[str, Any] = {"q": query, "types": types_param, "limit": limit}
    t0 = time.perf_counter()
    resp = session.get(url, params=params)
    elapsed_ms = (time.perf_counter() - t0) * 1000
    if resp.status_code != 200:
        logging.warning("Search returned HTTP %d for query '%s' (types=%s)", resp.status_code, query, types_param)
    return elapsed_ms


def _latency_stats(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {}
    sorted_s = sorted(samples)
    n = len(sorted_s)
    return {
        "min": sorted_s[0],
        "max": sorted_s[-1],
        "mean": statistics.mean(sorted_s),
        "median": statistics.median(sorted_s),
        "p95": sorted_s[min(int(n * 0.95), n - 1)],
        "p99": sorted_s[min(int(n * 0.99), n - 1)],
    }


def run_benchmark(
    session: requests.Session,
    server_url: str,
    entity_types: list[str],
    iterations: int,
    limit: int,
) -> list[dict[str, Any]]:
    """
    Run the benchmark suite.

    For each query in BENCHMARK_QUERIES, two flavours are tested:
      - types=all  (no type restriction)
      - one run per entity type (types=<type>)

    Returns a list of result records, each with keys:
      query_label, query_text, types, latency_stats
    """
    # Build the list of (types_label, types_param) combinations to test.
    type_variants: list[tuple[str, str]] = [("all", "all")]
    for t in entity_types:
        type_variants.append((t, t))

    results: list[dict[str, Any]] = []

    total_calls = len(BENCHMARK_QUERIES) * len(type_variants) * iterations
    logging.info(
        "Starting benchmark: %d queries × %d type variants × %d iterations = %d total HTTP calls",
        len(BENCHMARK_QUERIES), len(type_variants), iterations, total_calls,
    )

    for q_info in BENCHMARK_QUERIES:
        label: str = q_info["label"]
        query_text: str = q_info["query"]

        for types_label, types_param in type_variants:
            samples: list[float] = []
            for _ in range(iterations):
                ms = _run_query(session, server_url, query_text, types_param, limit)
                samples.append(ms)

            stats = _latency_stats(samples)
            results.append(
                {
                    "query_label": label,
                    "query_text": query_text,
                    "types": types_label,
                    "latency_stats": stats,
                }
            )
            logging.info(
                "  [%-40s | types=%-12s] mean=%.1f ms  p95=%.1f ms  p99=%.1f ms",
                label, types_label, stats["mean"], stats["p95"], stats["p99"],
            )

    return results


# ---------------------------------------------------------------------------
# Markdown report generation
# ---------------------------------------------------------------------------

def _fmt(value: float) -> str:
    return f"{value:.1f}"


def generate_markdown_report(
    server_url: str,
    weaviate_url: str,
    collection_name: str,
    entity_counts: dict[str, int],
    entity_types: list[str],
    iterations: int,
    limit: int,
    results: list[dict[str, Any]],
    run_at: datetime,
) -> str:
    lines: list[str] = []

    lines.append("# Global Search Benchmark Report")
    lines.append("")
    lines.append(f"**Generated:** {run_at.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append("")

    # --- Methodology / how to read ---
    lines.append("## How to Read This Report")
    lines.append("")
    lines.append(
        "Each query is issued `iterations` times without warm-up. "
        "The following latency statistics are reported per query:"
    )
    lines.append("")
    lines.append("| Metric | Meaning |")
    lines.append("|--------|---------|")
    lines.append("| **Min** | Fastest observed response time. |")
    lines.append("| **Max** | Slowest observed response time. |")
    lines.append("| **Mean** | Arithmetic average across all iterations. |")
    lines.append("| **Median** | Middle value (50th percentile) — robust to outliers. |")
    lines.append("| **p95** | 95th-percentile latency: 95 % of requests completed within this time. Captures typical tail latency. |")
    lines.append("| **p99** | 99th-percentile latency: 99 % of requests completed within this time. Captures worst-case tail latency. |")
    lines.append("")
    lines.append(
        "> **Note:** With a small iteration count (e.g. 20) the p95 and p99 values "
        "collapse to the observed maximum because there are too few samples to "
        "distinguish the top 5 % from the top 1 %. Increase `iterations` in "
        "`config.ini` for more meaningful percentile resolution."
    )
    lines.append("")
    lines.append(
        "> **Measurement scope:** All latency values are **end-to-end wall-clock times** "
        "measured from the benchmark client. Each request travels: benchmark client → "
        "Artemis Spring endpoint (`GET /api/search`) → Weaviate → Spring response → client. "
        "The numbers therefore include HTTP overhead, Spring controller processing, and "
        "Weaviate query time. Weaviate is queried *directly* only for the entity-count "
        "snapshot reported in the [Ingested Entities](#ingested-entities-in-weaviate) "
        "section; those calls are not part of the latency benchmark."
    )
    lines.append("")

    # --- Environment ---
    lines.append("## Environment")
    lines.append("")
    lines.append(f"| Parameter | Value |")
    lines.append(f"|-----------|-------|")
    lines.append(f"| Artemis server | `{server_url}` |")
    lines.append(f"| Weaviate | `{weaviate_url}` |")
    lines.append(f"| Weaviate collection | `{collection_name}` |")
    lines.append(f"| Iterations per query | {iterations} |")
    lines.append(f"| Result limit per call | {limit} |")
    lines.append("")

    # --- Ingested entity counts ---
    lines.append("## Ingested Entities in Weaviate")
    lines.append("")
    lines.append("Counts were captured immediately before the benchmark run.")
    lines.append("")
    lines.append("| Entity Type | Count |")
    lines.append("|-------------|------:|")
    for t in entity_types:
        count = entity_counts.get(t, -1)
        count_str = str(count) if count >= 0 else "_unavailable_"
        lines.append(f"| `{t}` | {count_str} |")
    total = entity_counts.get("total", -1)
    total_str = str(total) if total >= 0 else "_unavailable_"
    lines.append(f"| **Total** | **{total_str}** |")
    lines.append("")

    # --- Latency results: combined (all-types) ---
    lines.append("## Benchmark Results — All Types Combined (`types=all`)")
    lines.append("")
    lines.append("All latency values are in milliseconds (ms).")
    lines.append("")
    lines.append("| Query | Min | Max | Mean | Median | p95 | p99 |")
    lines.append("|-------|----:|----:|-----:|-------:|----:|----:|")
    for r in results:
        if r["types"] != "all":
            continue
        s = r["latency_stats"]
        lines.append(
            f"| {r['query_label']} "
            f"| {_fmt(s['min'])} | {_fmt(s['max'])} | {_fmt(s['mean'])} "
            f"| {_fmt(s['median'])} | {_fmt(s['p95'])} | {_fmt(s['p99'])} |"
        )
    lines.append("")

    # --- Latency results: per entity type ---
    lines.append("## Benchmark Results — Per Entity Type")
    lines.append("")
    lines.append("All latency values are in milliseconds (ms).")
    lines.append("")
    for t in entity_types:
        lines.append(f"### `{t}`")
        lines.append("")
        lines.append("| Query | Min | Max | Mean | Median | p95 | p99 |")
        lines.append("|-------|----:|----:|-----:|-------:|----:|----:|")
        for r in results:
            if r["types"] != t:
                continue
            s = r["latency_stats"]
            lines.append(
                f"| {r['query_label']} "
                f"| {_fmt(s['min'])} | {_fmt(s['max'])} | {_fmt(s['mean'])} "
                f"| {_fmt(s['median'])} | {_fmt(s['p95'])} | {_fmt(s['p99'])} |"
            )
        lines.append("")

    # --- Summary statistics ---
    lines.append("## Summary Statistics (All-Types Combined)")
    lines.append("")
    lines.append("Aggregated across all benchmark queries for the `types=all` variant.")
    lines.append("")
    all_means = [r["latency_stats"]["mean"] for r in results if r["types"] == "all"]
    all_p95 = [r["latency_stats"]["p95"] for r in results if r["types"] == "all"]
    all_p99 = [r["latency_stats"]["p99"] for r in results if r["types"] == "all"]
    if all_means:
        lines.append(f"| Metric | Value (ms) |")
        lines.append(f"|--------|----------:|")
        lines.append(f"| Min mean latency | {_fmt(min(all_means))} |")
        lines.append(f"| Max mean latency | {_fmt(max(all_means))} |")
        lines.append(f"| Overall mean latency | {_fmt(statistics.mean(all_means))} |")
        lines.append(f"| Overall p95 (worst query p95) | {_fmt(max(all_p95))} |")
        lines.append(f"| Overall p99 (worst query p99) | {_fmt(max(all_p99))} |")
    lines.append("")

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark the Artemis global search API")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to config.ini")
    parser.add_argument("--output", default=None, help="Override output file path for the markdown report")
    args = parser.parse_args()

    load_config(args.config)

    server_url: str = config.get("Settings", "server_url").rstrip("/")
    admin_user: str = config.get("Settings", "admin_user")
    admin_password: str = config.get("Settings", "admin_password")

    weaviate_host: str = config.get("Weaviate", "http_host")
    weaviate_port: int = config.getint("Weaviate", "http_port")
    collection_prefix: str = config.get("Weaviate", "collection_prefix")
    weaviate_api_key: str = config.get("Weaviate", "api_key", fallback="")

    iterations: int = config.getint("Benchmark", "iterations")
    limit: int = config.getint("Benchmark", "limit")
    output_dir: str = config.get("Benchmark", "output_dir")
    entity_types: list[str] = [
        t.strip() for t in config.get("Benchmark", "entity_types").split(",") if t.strip()
    ]

    weaviate_url = f"http://{weaviate_host}:{weaviate_port}"
    collection_name = f"{collection_prefix}SearchableEntities"

    # ------------------------------------------------------------------
    # Step 1: Authenticate with Artemis
    # ------------------------------------------------------------------
    logging.info("=" * 70)
    logging.info("GLOBAL SEARCH BENCHMARK")
    logging.info("=" * 70)
    logging.info("Server: %s", server_url)
    logging.info("Weaviate: %s (collection: %s)", weaviate_url, collection_name)
    logging.info("Iterations per query: %d | Result limit: %d", iterations, limit)
    logging.info("=" * 70)

    session = requests.Session()
    authenticate(session, server_url, admin_user, admin_password)

    # ------------------------------------------------------------------
    # Step 2: Collect entity counts from Weaviate
    # ------------------------------------------------------------------
    logging.info("Collecting entity counts from Weaviate...")
    entity_counts = collect_entity_counts(
        weaviate_host, weaviate_port, collection_prefix, weaviate_api_key, entity_types
    )
    logging.info("Entity counts: %s", json.dumps(entity_counts, indent=2))

    # ------------------------------------------------------------------
    # Step 3: Run the benchmark
    # ------------------------------------------------------------------
    run_at = datetime.now(timezone.utc)
    results = run_benchmark(session, server_url, entity_types, iterations, limit)

    # ------------------------------------------------------------------
    # Step 4: Generate and write the markdown report
    # ------------------------------------------------------------------
    report_md = generate_markdown_report(
        server_url=server_url,
        weaviate_url=weaviate_url,
        collection_name=collection_name,
        entity_counts=entity_counts,
        entity_types=entity_types,
        iterations=iterations,
        limit=limit,
        results=results,
        run_at=run_at,
    )

    if args.output:
        report_path = args.output
    else:
        timestamp = run_at.strftime("%Y-%m-%d_%H-%M-%S")
        script_dir = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(script_dir, output_dir)
        os.makedirs(out_dir, exist_ok=True)
        report_path = os.path.join(out_dir, f"benchmark_report_{timestamp}.md")

    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_md)

    logging.info("=" * 70)
    logging.info("Benchmark complete. Report written to: %s", report_path)
    logging.info("=" * 70)


if __name__ == "__main__":
    main()
