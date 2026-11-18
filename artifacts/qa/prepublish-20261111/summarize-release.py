"""Aggregate final release evidence; never starts a test, browser or workload.

Run with --allow-incomplete while producers are still running. Without that
flag, missing/invalid records or failed checks exit 1. Explicit environment
blocks can complete the record set, but never make allChecksPassed/closed true.
"""
from pathlib import Path
import argparse
import collections
import datetime
import hashlib
import json
import math
import re
import statistics
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASELINE = "a9bb92642780cee06bb1d990a9a807536a6904de"
REQUIRED = [
    "release-full-check.log", "release-full-check-round2.log", "release-dependencies.json",
    "sites-baseline-workload.json", "release-workload.json", "browser-results.json",
    "mixed-ui-load.json", "stream-render-results.json", "assistant-merge-review.json",
    "evidence-review.json", "stream-ui-review.json",
]
missing, missing_fields, invalid, failed, blocked, inputs = [], [], [], [], [], {}


def demand(condition, message):
    if not condition:
        raise ValueError(message)


def read(name, as_json=True):
    path = HERE / name
    if not path.is_file():
        missing.append(name)
        return None
    raw = path.read_bytes()
    inputs[name] = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    return json.loads(raw) if as_json else raw.decode("utf-8")


def section(name, parser, as_json=True):
    try:
        value = read(name, as_json)
        if value is None:
            return {"status": "missing", "source": name}
        result = parser(value)
        result.setdefault("status", "passed")
        result["source"] = name
        if result["status"] == "blocked_environment":
            blocked.append({"source": name, "reason": result["reason"], "executed": False})
        elif result["status"] != "passed":
            failed.append({"source": name, "reason": result.get("reason", result["status"])})
        return result
    except KeyError as error:
        field = str(error.args[0])
        missing.append(f"{name}#{field}")
        missing_fields.append({"source": name, "field": field})
        return {"status": "missing", "source": name, "missingField": field}
    except (ValueError, TypeError, IndexError, OSError) as error:
        invalid.append({"source": name, "reason": str(error)})
        return {"status": "invalid", "source": name, "reason": str(error)}


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def latency(values):
    demand(values and all(numeric(v) and v >= 0 for v in values), "Missing or invalid latency samples")
    ordered = sorted(values)
    return {"n": len(values), **{f"p{p}Ms": ordered[math.ceil(len(ordered) * p / 100) - 1] for p in (50, 95, 99)}}


def spread(values):
    demand(values and all(numeric(v) for v in values), "Missing or invalid numeric samples")
    return {"n": len(values), "median": statistics.median(values), "min": min(values), "max": max(values), "samples": values}


def parse_full_check(text):
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    stages = re.findall(r"^> pep-vocab-studio@([^ ]+) ([^\n]+)", text, re.M)
    expected = ["data:audit", "typecheck", "lint", "test:unit", "build", "test:runtime", "test:security"]
    found = [name for _, name in stages if name in expected]
    demand(found == expected, f"Incomplete npm test stage chain: {found}")
    demand({v for v, name in stages if name in expected} == {VERSION}, "Tested package version differs from candidate")
    unit = {}
    for key in ("tests", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"):
        matches = re.findall(rf"^(?:ℹ |# ){key} ([0-9.]+)$", text, re.M)
        demand(len(matches) == 1, f"Expected one complete unit summary for {key}")
        unit[key] = float(matches[0]) if key == "duration_ms" else int(matches[0])
    demand(unit["tests"] >= 758 and unit["tests"] == unit["pass"], "Unit count is incomplete or failed")
    demand(all(unit[k] == 0 for k in ("fail", "cancelled", "skipped", "todo")), "Nonpassing unit cases")
    runtime_start = re.search(r'\{\s*"runtime"\s*:', text)
    demand(runtime_start, "Missing Worker/D1 result object")
    runtime = json.JSONDecoder().raw_decode(text[runtime_start.start():])[0]
    demand(isinstance(runtime["results"], list) and len(runtime["results"]) == 55, "Expected 55 runtime smoke cases")
    for case in runtime["results"]:
        demand(isinstance(case.get("path"), str), "Runtime case lacks a path")
        demand(case.get("status") == "passed" or (isinstance(case.get("status"), int) and 100 <= case["status"] <= 599) or case.get("statuses") == [200, 409], "Malformed runtime case")
    matrix = re.findall(r"^(\d+) runtime checks passed across (\d+) private API routes\s*$", text, re.M)
    demand(matrix == [("202", "28")], "Missing complete 202-check security matrix")
    demand(text.rstrip().endswith("202 runtime checks passed across 28 private API routes"), "Log has not reached the final successful stage")
    return {"version": VERSION, "stages": found, "unit": unit,
            "runtimeSmoke": {"count": len(runtime["results"]), "scope": runtime["runtime"]},
            "securityMatrix": {"count": 202, "privateRoutes": 28},
            "completionEvidence": "All npm test && stages reached the final success marker; no external process exit-code sidecar was supplied."}


def parse_audit(data):
    counts = data["metadata"]["vulnerabilities"]
    demand(all(isinstance(counts.get(k), int) for k in ("info", "low", "moderate", "high", "critical", "total")), "Incomplete audit severity counts")
    clean = counts["total"] == 0 and not data["vulnerabilities"]
    return {"status": "passed" if clean else "failed", "vulnerabilities": counts,
            "dependencies": data["metadata"]["dependencies"], "scope": "All installed dependency classes, including build dependencies"}


def parse_workload(data):
    demand(data["seed"] == {"accounts": 8, "days": 30, "regularEventsPerDay": 80, "denseEventsPerDay": 1000, "totalEvents": 46800}, "Unexpected fixture size")
    demand(len(data["scenarios"]) == len(data["samples"]) == 9, "Expected three rounds at three concurrency levels")
    raw = {(r["round"], r["concurrency"]): r for r in data["samples"]}
    demand(len(raw) == 9, "Duplicate raw workload scenario")
    expected_routes = {"GET /api/learning-journal": 10, "GET /api/learning-memory": 4,
                       "GET /data/v1/index.json": 2, "GET /": 2, "POST /api/learning-journal": 2}
    by_concurrency = []
    for concurrency in (1, 4, 12):
        runs = sorted((r for r in data["scenarios"] if r["concurrency"] == concurrency), key=lambda r: r["round"])
        demand([r["round"] for r in runs] == [1, 2, 3], f"Incomplete c{concurrency} rounds")
        pooled, per_route, errors, rounds = [], collections.defaultdict(list), [], []
        for run in runs:
            sample = raw[(run["round"], concurrency)]
            values, routes = sample["latencies"], sample["byRoute"]
            demand(run["n"] == len(values) == 20 * concurrency, "Raw sample count differs from scenario")
            demand(set(routes) == set(expected_routes), "Unexpected workload route mix")
            demand(all(len(routes[k]) == n * concurrency for k, n in expected_routes.items()), "Route counts differ from fixture mix")
            demand(sorted(values) == sorted(v for a in routes.values() for v in a), "Route samples do not reconstruct the raw latency sample set")
            measured = latency(values)
            demand(numeric(run["elapsedMs"]) and run["elapsedMs"] > 0, "Invalid run elapsed time")
            demand(isinstance(run["errors"], list), "Missing run error array")
            for p in (50, 95, 99):
                demand(math.isclose(measured[f"p{p}Ms"], run[f"p{p}"], rel_tol=1e-10, abs_tol=1e-8), "Stored percentile disagrees with raw samples")
            pooled.extend(values)
            errors.extend(run["errors"])
            for key, route_values in routes.items():
                per_route[key].extend(route_values)
            rounds.append({"round": run["round"], **measured, "elapsedMs": run["elapsedMs"], "errors": len(run["errors"])})
        elapsed = sum(r["elapsedMs"] for r in runs)
        by_concurrency.append({"concurrency": concurrency, **latency(pooled), "elapsedMs": elapsed,
            "requestsPerSecond": len(pooled) * 1000 / elapsed, "bytes": sum(r["bytes"] for r in runs),
            "errorCount": len(errors), "errors": errors, "rounds": rounds,
            "routes": [{"route": key, **latency(values), "mixedRunContributionRps": len(values) * 1000 / elapsed}
                       for key, values in sorted(per_route.items())]})
    return {"status": "passed" if all(r["errorCount"] == 0 for r in by_concurrency) else "failed",
            "timestamp": data["timestamp"], "build": data["build"], "seed": data["seed"], "method": data["method"],
            "reportedEnvironment": {k: data[k] for k in ("node", "cpu", "logicalCpus", "memoryBytes")},
            "byConcurrency": by_concurrency, "measuredRequests": sum(r["n"] for r in by_concurrency)}


def parse_soak(data):
    demand(data["soakSeconds"] == 120, "Expected final 120-second soak")
    rows = data["soak"]
    demand(rows, "Missing soak samples")
    for row in rows:
        demand(numeric(row["at"]) and 0 <= row["at"] < 120000, "Soak start outside configured time range")
        demand(row["path"] in ("/api/learning-journal", "/api/learning-memory", "/data/v1/index.json", "/"), "Unexpected soak route")
        demand(isinstance(row["status"], int), "Missing soak response status")
    observed_ms = max(r["at"] + r["ms"] for r in rows)
    errors = [r for r in rows if r["status"] != 200]
    segments = []
    for start in range(0, 120, 30):
        group = [r for r in rows if start * 1000 <= r["at"] < (start + 30) * 1000]
        segments.append({"startSeconds": start, "endSeconds": start + 30, **latency([r["ms"] for r in group]),
                         "errorCount": sum(r["status"] != 200 for r in group)})
    return {"status": "passed" if not errors else "failed", "configuredSeconds": 120, "concurrentReaders": 12,
            **latency([r["ms"] for r in rows]), "observedCompletionSpanMs": observed_ms,
            "observedRequestsPerSecond": len(rows) * 1000 / observed_ms, "errorCount": len(errors),
            "statusCounts": dict(collections.Counter(str(r["status"]) for r in rows)), "segments": segments,
            "routes": [{"route": key, **latency([r["ms"] for r in rows if r["path"] == key])} for key in sorted({r["path"] for r in rows})],
            "segmentAttribution": "Requests grouped by start timestamp; each latency includes its complete response, even across a 30-second boundary.",
            "scope": "Closed-loop local read workload only; no writes/provider calls; 120 seconds is not a production endurance test."}


def compare(before, after):
    if before["status"] != "passed" or after["status"] != "passed":
        return {"status": "missing" if "missing" in (before["status"], after["status"]) else "invalid", "byConcurrency": []}
    demand(before["seed"] == after["seed"] and before["method"] == after["method"], "Baseline/candidate workload methods differ")
    rows = []
    for a, b in zip(before["byConcurrency"], after["byConcurrency"]):
        demand(a["concurrency"] == b["concurrency"] and a["n"] == b["n"], "Baseline/candidate scenario counts differ")
        demand(a["p95Ms"] > 0 and a["requestsPerSecond"] > 0, "Invalid comparison denominator")
        routes = []
        for x, y in zip(a["routes"], b["routes"]):
            demand(x["route"] == y["route"] and x["n"] == y["n"], "Baseline/candidate route counts differ")
            routes.append({"route": x["route"], "before": x, "after": y,
                           "p95ReductionPercent": 100 * (1 - y["p95Ms"] / x["p95Ms"]) if x["p95Ms"] else None})
        rows.append({"concurrency": a["concurrency"], "before": {k: a[k] for k in ("n", "p50Ms", "p95Ms", "p99Ms", "requestsPerSecond", "errorCount")},
                     "after": {k: b[k] for k in ("n", "p50Ms", "p95Ms", "p99Ms", "requestsPerSecond", "errorCount")},
                     "p95ReductionPercent": 100 * (1 - b["p95Ms"] / a["p95Ms"]),
                     "throughputRatio": b["requestsPerSecond"] / a["requestsPerSecond"], "routes": routes})
    return {"status": "passed", "byConcurrency": rows,
            "sameReportedEnvironment": before["reportedEnvironment"] == after["reportedEnvironment"],
            "statistics": "Nearest-rank percentiles of pooled raw request samples; throughput=sum(n)*1000/sum(elapsedMs). Route contribution RPS uses the whole mixed-run time denominator."}


def parse_browser(data):
    if data["status"] == "blocked_environment":
        demand(data["results"] == [] and data["reason"], "Blocked browser record must state why no checks ran")
        return {"status": "blocked_environment", "executed": False, "checkCount": 0,
                "reason": data["reason"], "scope": data["scope"], "attempt": data["attempt"],
                "policyReference": data["policyReference"], "checks": []}
    demand(data["status"] == "passed", "Browser producer did not report passed")
    results = data["results"]
    demand(len(results) == 19 and all(r["status"] == "passed" for r in results), "Expected 19 passing browser checks")
    demand(not data.get("pageErrors", []), "Browser page errors")
    return {"checkCount": len(results), "byViewport": dict(collections.Counter(str(r["width"]) for r in results)),
            "base": data["base"], "generatedAt": data["generatedAt"], "scope": data["scope"], "checks": results}


def parse_mixed_ui(data):
    if data["status"] == "blocked_environment":
        demand(data["runs"] == [] and data["reason"], "Blocked UI load must state why no runs executed")
        return {"status": "blocked_environment", "executed": False, "runs": 0, "devices": [],
                "reason": data["reason"], "plannedFixture": data["fixture"], "script": data["script"],
                "verification": data["verification"], "scope": "Planned whole-app load was not run; no latency or pass claim."}
    demand(data["status"] == "passed", f"Mixed UI producer did not pass: {data.get('failure')}")
    runs = data["runs"]
    demand(len(runs) == 6, "Expected six completed mixed UI runs")
    fixture = data["fixture"]
    demand(fixture["conversations"] == 50 and fixture["messages"] == 2000 and fixture["activeMessages"] == 120, "Unexpected mixed UI data scale")
    timing_names = {"startupMs", "chatMs", "listMs", "searchMs", "historyOpenMs", "typingMs", "streamTypingMs", "streamListMs", "streamSearchMs", "completionMs", "firstProseMs", "revealSpanMs", "persistMs"}
    devices = []
    for device, throttle in (("desktop", 1), ("phone-cpu4", 4)):
        group = sorted([r for r in runs if r["device"] == device], key=lambda r: r["round"])
        demand([r["round"] for r in group] == [1, 2, 3], f"Incomplete {device} rounds")
        for run in group:
            demand(run["status"] == "passed" and run["pageErrors"] == [] and run["overflow"] == 0, "Mixed UI errors/overflow")
            demand(run["cpuThrottle"] == throttle, "Unexpected CPU throttle")
            demand(timing_names <= run["timings"].keys(), "Missing mixed UI timing fields")
            demand(run["sse"]["requests"] >= 1 and run["reveal"]["samples"] >= 1, "Missing streaming/reveal exercise")
        tasks = [task for run in group for task in run["longTasks"]]
        demand(all(numeric(t["duration"]) and t["duration"] >= 0 for t in tasks), "Invalid long task duration")
        devices.append({"device": device, "rounds": 3, "cpuThrottle": throttle, "viewport": group[0]["viewport"],
                        "timings": {key: spread([r["timings"][key] for r in group]) for key in sorted(timing_names)},
                        "longTaskCount": len(tasks), "maxLongTaskMs": max([t["duration"] for t in tasks] or [0]),
                        "longTasksByStage": dict(collections.Counter(t["stage"] for t in tasks)),
                        "heapBytes": spread([r["heapBytes"] for r in group]), "pageErrorCount": 0, "overflow": 0,
                        "streaming": [{"round": r["round"], "sse": r["sse"], "reveal": r["reveal"], "storage": r["storage"]} for r in group]})
    return {"preview": data["preview"], "fixture": fixture, "method": data["method"], "runs": len(runs), "devices": devices,
            "scope": "Real browser/app with synthetic history and controlled SSE; timing includes automation and is not INP or real-provider latency."}


def parse_stream(data):
    demand(data["baselineRevision"] == BASELINE, "Unexpected component baseline")
    demand(len(data["runs"]) == 6, "Expected three component rounds per variant")
    variants = []
    for variant, expected in (("baseline", 1180), ("current", 0)):
        group = sorted([r for r in data["runs"] if r["variant"] == variant], key=lambda r: r["round"])
        demand([r["round"] for r in group] == [1, 2, 3], "Incomplete component variants")
        for run in group:
            demand(run["assistantRows"] == run["initialSourceCount"] == 60 and run["updates"] == 20, "Incomplete component fixture")
            demand(run["progressive"] == {"history": expected, "current": 20}, "Historical or current render-count regression")
            demand(run["vocabularyRefresh"]["history"] == 59 and run["vocabularyRefresh"]["sourceCount"] == 0, "Vocabulary/provenance invalidation regression")
            demand(len(run["updateMs"]) == 20 and all(numeric(v) and v >= 0 for v in run["updateMs"]), "Invalid synchronous commit samples")
        variants.append({"variant": variant, "rounds": 3, "historicalRichTextCalls": [r["progressive"]["history"] for r in group],
                         "activeRichTextCalls": [r["progressive"]["current"] for r in group],
                         "synchronousCommitTotalMs": spread([sum(r["updateMs"]) for r in group])})
    return {"baselineRevision": BASELINE, "scope": data["scope"], "variants": variants,
            "medianCommitReductionPercent": 100 * (1 - variants[1]["synchronousCommitTotalMs"]["median"] / variants[0]["synchronousCommitTotalMs"]["median"])}


def source_scope():
    paths = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    prefixes = ("app/", "build/", "components/", "config/", "data/", "db/", "drizzle/", "hooks/", "lib/", "public/", "scripts/", "tests/", "worker/", ".github/workflows/", ".openai/")
    root_names = {"package.json", "package-lock.json", ".npmrc", ".gitignore", ".env.example", "tsconfig.json", "next.config.ts", "vite.config.ts", "postcss.config.mjs", "eslint.config.mjs", "drizzle.config.ts", "worker-env.d.ts", "wrangler.json", "wrangler.jsonc", "wrangler.toml"}
    names = sorted({p for p in paths if p and not p.startswith("artifacts/") and p != "data/audit-summary.json" and (p.startswith(prefixes) or p in root_names) and (ROOT / p).is_file()})
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in names}
    digest = hashlib.sha256("".join(f"{name}\0{digest}\n" for name, digest in hashes.items()).encode()).hexdigest()
    return {"sha256": digest, "fileCount": len(hashes), "files": hashes,
            "scope": "Current production source/assets, test fixtures, build/QA scripts, configuration, CI and immutable migrations. Excludes artifacts/, docs and generated data/audit-summary.json to avoid evidence self-reference and audit timestamp churn."}


def parse_review(name, data):
    if name == "evidence-review.json":
        demand(data["status"] == "passed_in_assigned_scope" and data["blockers"] == [], "Evidence review has blockers")
        demand(data["sitesMigrationByteMatch"] is True, "Migration differs from Sites")
        hashes = data["reviewedFileSha256"]
        result = data["status"]
    elif name == "assistant-merge-review.json":
        demand("no new blocking findings" in data["result"].lower(), "Assistant merge review has no clean conclusion")
        demand(data["tests"]["sse_cases_passed"] == 15 and data["tests"]["related_test_files_passed"] == 7 and data["tests"]["typecheck"] == "passed", "Assistant targeted verification incomplete")
        hashes = data["reviewed_source_sha256"]
        result = data["result"]
    else:
        demand(data["status"] == "passed_after_fix" and data["unresolvedBlockers"] == [], "UI review has blockers")
        demand(all(f["status"] == "fixed" for f in data["findings"]), "UI finding unresolved")
        hashes = {}
        result = data["status"]
    drift = [path for path, digest in hashes.items() if path in SOURCE["files"] and digest != SOURCE["files"][path]]
    demand(not drift, f"Reviewed source changed: {drift}")
    return {"result": result, "reviewType": "Independent manual scoped review; not a formal Codex Security scan",
            "checkedSourceHashCount": sum(path in SOURCE["files"] for path in hashes), "sourceHashDrift": drift}


def container_limits():
    cpu = Path("/sys/fs/cgroup/cpu.max").read_text().strip()
    memory = Path("/sys/fs/cgroup/memory.max").read_text().strip()
    quota, period = cpu.split()
    return {"cpuCores": None if quota == "max" else int(quota) / int(period), "memoryBytes": None if memory == "max" else int(memory),
            "memoryGiB": None if memory == "max" else int(memory) / (1024 ** 3), "cpuMax": cpu, "memoryMax": memory,
            "note": "Effective cgroup quota: 4 CPU cores and 16 GiB. os.cpus()/totalmem() fields describe the visible host, not this quota."}


def guidance_sizes():
    revision = "f10737e675cf5e55352f0a9d2808600eb19e664d"
    rows = []
    for name in ("AGENTS.md", "docs/DEVELOPMENT.md", "PROJECT_STATE.md", "docs/prompt-guidance.md"):
        old = subprocess.check_output(["git", "--no-replace-objects", "show", f"{revision}:{name}"], cwd=ROOT)
        new = (ROOT / name).read_bytes()
        rows.append({"file": name, "beforeBytes": len(old), "afterBytes": len(new),
                     "reductionPercent": 100 * (1 - len(new) / len(old))})
    return {"baselineRevision": revision, "documents": rows,
            "note": "Documentation baseline differs intentionally from the deployed Sites performance baseline."}


VERSION = json.loads((ROOT / "package.json").read_text())["version"]
SOURCE = source_scope()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    rounds = [section(name, parse_full_check, False) for name in REQUIRED[:2]]
    if all(r["status"] == "passed" for r in rounds) and {r["unit"]["tests"] for r in rounds} != {758}:
        invalid.append({"source": "full-check rounds", "reason": "Final rounds differ from the frozen 758-case suite"})
    dependencies = section("release-dependencies.json", parse_audit)
    before = section("sites-baseline-workload.json", parse_workload)
    after = section("release-workload.json", parse_workload)
    soak = section("release-workload.json", parse_soak)
    try:
        comparison = compare(before, after)
    except (ValueError, KeyError, TypeError) as error:
        invalid.append({"source": "HTTP comparison", "reason": str(error)})
        comparison = {"status": "invalid", "byConcurrency": [], "reason": str(error)}
    browser = section("browser-results.json", parse_browser)
    mixed = section("mixed-ui-load.json", parse_mixed_ui)
    stream = section("stream-render-results.json", parse_stream)
    reviews = [section(name, lambda data, name=name: parse_review(name, data)) for name in REQUIRED[-3:]]
    missing[:] = sorted(set(missing))
    materials_complete = not missing and not invalid
    checks_passed = materials_complete and not failed and not blocked
    status = "failed" if failed or invalid else "missing" if missing else "blocked_environment" if blocked else "passed"
    summary = {
        "schemaVersion": 1, "generatedAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": status, "version": VERSION,
        "completeness": {"complete": materials_complete, "allAvailableEvidencePresent": materials_complete,
                         "allChecksPassed": checks_passed, "closed": checks_passed,
                         "meaning": "complete means every expected final evidence record is present and parseable, including explicit blocked records. closed/allChecksPassed require every requested check to have executed and passed.",
                         "requiredInputs": REQUIRED, "missing": missing, "missingFields": missing_fields,
                         "invalid": invalid, "failed": failed, "blocked": blocked},
        "checks": {"fullRounds": rounds, "acceptedRounds": sum(r["status"] == "passed" for r in rounds)},
        "dependencies": dependencies, "guidance": guidance_sizes(),
        "performance": {"baselineRevision": BASELINE, "container": container_limits(),
                        "http": {"baseline": before, "candidate": after, "comparison": comparison}, "soak": soak},
        "browser": browser, "mixedUi": mixed, "streamRender": stream, "reviews": reviews, "blockers": blocked,
        "provenance": {"gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                       "baselineRevision": BASELINE, "sourceSnapshot": SOURCE, "inputs": inputs,
                       "aggregationScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                       "note": "Source snapshot hashes current worktree bytes; a Git HEAD alone does not identify uncommitted candidate changes. Final report uses only the named final evidence, not prior f107/pre-merge benchmark results."},
        "limits": ["Closed-loop synthetic local HTTP/D1 workload has coordinated omission; no open-loop production capacity claim.",
                   "Three HTTP rounds and 120-second read soak do not establish statistical significance or long-term production stability.",
                   "Browser SSE/model responses are controlled fixtures; no real paid provider, WAN, production identity gateway, physical iPad/Safari or INP measurement.",
                   "Component render counts and synchronous commit timings are separate from whole-app interaction timings.",
                   "Manual scoped reviews do not replace a formal Security Cloud scan; deployment and live migration validation are separate later evidence."]
    }
    target = HERE / "release-summary.json"
    temp = HERE / ".release-summary.json.tmp"
    temp.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    temp.replace(target)
    print(json.dumps({"output": str(target.relative_to(ROOT)), "status": status, "complete": materials_complete, "closed": checks_passed, "missing": missing, "invalid": invalid, "failed": failed, "blocked": blocked}, ensure_ascii=False))
    return 0 if (materials_complete and not failed) or args.allow_incomplete else 1


if __name__ == "__main__":
    raise SystemExit(main())
