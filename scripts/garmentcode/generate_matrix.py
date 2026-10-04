#!/usr/bin/env python3
"""Reproduce the checked generated preset matrix; no dataset records or drapes."""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
TESTED_REVISION = "d449629979028123a5c4dc9e732a2ec19b7fce31"
EXAMPLES = (
    "shirt_mean_specification.json",
    "hoody_mean_specification.json",
    "dress_pencil_specification.json",
    "js_mean_all_specification.json",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def observed_revision(root):
    """An unpacked checkout may lack git metadata; do not invent its revision."""
    try:
        top = subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        ).strip()
        if Path(top).resolve() != root:
            return None
        return subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            text=True, stderr=subprocess.DEVNULL, timeout=5,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def generate(case, output):
    name, request = case["id"], case["request"]
    (output / f"{name}.request.json").write_text(json.dumps(request, indent=2) + "\n")
    started = time.monotonic()
    item = {
        "id": name, "kind": "generated-preset", "request": request,
        "requestFile": f"{name}.request.json", "fixtureFile": None,
        "limitations": case.get("limitations", []),
    }
    try:
        result = subprocess.run(
            [sys.executable, str(HERE / "generate.py")], input=json.dumps(request),
            text=True, capture_output=True, timeout=90,
            env={**os.environ, "PYTHONHASHSEED": "0"},
        )
        (output / f"{name}.stderr.log").write_text(result.stderr)
        item["exitCode"] = result.returncode
        if result.returncode:
            item["error"] = result.stderr[-1200:]
            return item
        data = result.stdout.encode("utf-8")
        if len(data) > 9 * 1024 * 1024:
            raise ValueError("Generated fixture exceeds 9 MiB")
        spec = json.loads(result.stdout)
        # Upstream assembles components in object-set order. Canonicalize only
        # container ordering: panel geometry, stitch sides and orientations stay intact.
        (output / f"{name}.upstream.json").write_bytes(data)
        spec["pattern"]["stitches"].sort(key=lambda stitch: json.dumps(stitch, sort_keys=True))
        canonical = (json.dumps(spec, sort_keys=True, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        panels = spec["pattern"]["panels"]
        measurements = spec["properties"]["garmentcode_body"]
        (output / f"{name}.json").write_bytes(canonical)
        item.update({
            "fixtureFile": f"{name}.json", "sha256": digest(canonical),
            "upstreamFixtureFile": f"{name}.upstream.json", "upstreamOutputSha256": digest(data),
            "panels": len(panels), "stitches": len(spec["pattern"]["stitches"]),
            "panelNames": list(panels), "resolvedMeasurements": len(measurements),
            "heightCm": measurements["height"],
            "unitsInMeter": spec["properties"]["units_in_meter"],
        })
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        item.update({"exitCode": 1, "error": str(error)})
    finally:
        item["seconds"] = round(time.monotonic() - started, 3)
    return item


def bundled_examples(root, output):
    records = []
    for filename in EXAMPLES:
        source = root / "assets" / "Patterns" / filename
        data = source.read_bytes()
        spec = json.loads(data)
        target = "upstream-" + filename
        (output / target).write_bytes(data)
        records.append({
            "id": target.removesuffix(".json"), "kind": "bundled-upstream-example",
            "fixtureFile": target, "sha256": digest(data),
            "sourcePath": "assets/Patterns/" + filename,
            "panels": len(spec["pattern"]["panels"]),
            "stitches": len(spec["pattern"]["stitches"]),
            "hasResolvedBodyMetadata": False, "datasetRecordId": None,
            "limitations": [
                "Original bundled sewing patterns, without verified released dataset record IDs.",
                "No paired body metadata or certified drapes; do not infer a calibrated source body.",
            ],
        })
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("--include-bundled-examples", action="store_true",
                        help="Also copy the four original upstream Patterns; no body metadata is inferred.")
    args = parser.parse_args()
    root_value = os.environ.get("GARMENTCODE_ROOT")
    if not root_value:
        parser.error("GARMENTCODE_ROOT must identify the trusted upstream checkout; see README.md")
    root = Path(root_value).resolve()
    if not (root / "assets" / "design_params" / "t-shirt.yaml").is_file():
        parser.error("GARMENTCODE_ROOT does not contain the upstream design schema")
    config_bytes = (HERE / "matrix.json").read_bytes()
    config = json.loads(config_bytes)
    cases = config["fixtures"]
    names = [case["id"] for case in cases]
    if config.get("version") != 1 or not cases or len(set(names)) != len(names) or any(
        not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) for name in names
    ):
        parser.error("matrix.json has an unsupported version or invalid fixture IDs")
    args.output_directory.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda case: generate(case, args.output_directory), cases))
    manifest = {
        "provenance": {
            "kind": "generated-preset", "repository": "https://github.com/maria-korosteleva/GarmentCode",
            "testedUpstreamRevision": TESTED_REVISION, "observedUpstreamRevision": observed_revision(root),
            "license": "MIT", "bodyDefaults": "assets/bodies/mean_all.yaml",
            "bridge": "scripts/garmentcode/generate.py", "bridgeSha256": digest((HERE / "generate.py").read_bytes()),
            "matrixConfig": "scripts/garmentcode/matrix.json", "matrixConfigSha256": digest(config_bytes),
            "pythonVersion": sys.version.split()[0], "pythonHashSeed": 0,
            "canonicalization": "Sorted JSON object keys and whole stitch records; directed stitch sides, panel arrays, source geometry and measurements stay intact. Raw upstream JSON is retained separately.",
            "datasetCoverage": "Generated presets, not verified released GarmentCodeData records. No simulated dataset meshes, splits or material batches are reproduced.",
        },
        "fixtures": results,
        "bundledExamples": [],
    }
    try:
        if args.include_bundled_examples:
            manifest["bundledExamples"] = bundled_examples(root, args.output_directory)
    except (OSError, ValueError, KeyError) as error:
        manifest["bundledExampleError"] = str(error)
    (args.output_directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"outputDirectory": str(args.output_directory), "fixtures": [
        {key: item[key] for key in ("id", "exitCode", "panels", "stitches", "heightCm") if key in item}
        for item in results
    ], "bundledExamples": len(manifest["bundledExamples"]), "bundledExampleError": manifest.get("bundledExampleError")}))
    return int(any(item["exitCode"] for item in results) or "bundledExampleError" in manifest)


if __name__ == "__main__":
    sys.exit(main())
