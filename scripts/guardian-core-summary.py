"""Account for every selected core/app-server test, including failed attempts."""
from pathlib import Path
import datetime
import hashlib
import json
import re

root = Path(__file__).resolve().parent.parent
evidence = root / "evidence"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


inventory_path = evidence / "guardian-validation-list.log"
text = inventory_path.read_text()
inventory = json.loads(text[text.index("{"):])
eligible = set()
ignored = []
for binary, suite in inventory["rust-suites"].items():
    for name, case in suite["testcases"].items():
        key = (binary, name)
        if case["ignored"]:
            ignored.append(key)
        elif case["filter-match"]["status"] == "matches":
            eligible.add(key)
assert len(eligible) + len(ignored) == inventory["test-count"]

names = [
    "core", *[f"core-batch-{n}" for n in range(1, 7)],
    "core-shell-diagnostic", "mcp-startup-trace", "mcp-startup-final",
]
paths = sorted(
    (evidence / f"guardian-validation-{name}.log" for name in names),
    key=lambda path: path.stat().st_mtime_ns,
)
latest = {}
attempts = []
logs = []
for path in paths:
    text = re.sub(r"\x1b\[[0-9;]*m", "", path.read_text())
    counts = {}
    for status, binary, name in re.findall(
        r"^[ \t]*(?:TRY \d+ )?(PASS|FAIL|TIMEOUT|TMT) \[.*?\]\s+\([^)]*\) (\S+) (\S+)",
        text, re.MULTILINE,
    ):
        key = (binary, name)
        assert key in eligible, f"Unexpected test: {key}"
        if status == "TMT":
            status = "TIMEOUT"
        counts[status] = counts.get(status, 0) + 1
        latest[key] = {"status": status, "log": path.name}
        if status != "PASS":
            attempts.append({"binary": binary, "test": name, **latest[key]})
    assert counts, f"No results in {path}"
    logs.append({"file": path.name, "sha256": sha(path),
                 "modifiedAtNs": path.stat().st_mtime_ns, "records": counts})

missing = sorted(eligible - latest.keys())
failed = [key for key in sorted(eligible) if latest.get(key, {}).get("status") not in (None, "PASS")]
source = root / "research/codex-0.160.0"
test_file = source / "codex-rs/core/tests/suite/mcp_optional_startup_grace.rs"
source_manifest = json.loads((evidence / "permission-engine-source.json").read_text())
assert sha(root / source_manifest["archive"]) == source_manifest["sha256"]
assert sha(source / "codex-rs/Cargo.lock") == source_manifest["cargoLockSHA256"]
assert sha(test_file) == source_manifest["modified"]["codex-rs/core/tests/suite/mcp_optional_startup_grace.rs"]
report = {
    "version": "0.4.10",
    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "passed": not missing and not failed,
    "scope": "All non-ignored codex-core and codex-app-server tests; split runs with recorded retries, not one uninterrupted run.",
    "totalDiscovered": inventory["test-count"],
    "selected": len(eligible),
    "passedUnique": sum(latest.get(key, {}).get("status") == "PASS" for key in eligible),
    "ignored": ignored,
    "missing": missing,
    "failedLatest": failed,
    "priorFailureRecords": attempts,
    "inventorySHA256": sha(inventory_path),
    "logs": logs,
    "cargoLockSHA256": sha(source / "codex-rs/Cargo.lock"),
    "sourceArchiveSHA256": source_manifest["sha256"],
    "fixtureTimingChange": {
        "file": test_file.relative_to(root).as_posix(),
        "sha256": sha(test_file),
        "reason": "A 250 ms server startup deadline expired during first HTTP client's platform trust-store initialization before the fixture received its handshake.",
        "change": "Server startup deadline 250 ms to 1 s; completion bound 1 s to 2 s. Retains observed handshake, pending turn, gated handshake and omitted-tool assertions.",
        "retested": 6,
    },
    "tests": [{"binary": key[0], "test": key[1], **latest[key]} for key in sorted(latest)],
}
(evidence / "guardian-core-summary.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: report[key] for key in ("passed", "selected", "passedUnique", "missing", "failedLatest")}))
assert report["passed"], "Core regression coverage incomplete"
