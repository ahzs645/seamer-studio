#!/usr/bin/env python3
"""Generate real GarmentCode geometry, with JSON stdin/stdout as the boundary."""

import contextlib
import copy
import json
import math
import os
from pathlib import Path
import sys

UPSTREAM_REVISION = "d449629979028123a5c4dc9e732a2ec19b7fce31"
PRESETS = {
    "t-shirt": {},
    "hoodie": {"collar": {"component": {"style": "Hood2Panels"}}, "sleeve": {"length": 1.0}},
    "skirt": {"meta": {"upper": None, "bottom": "Skirt2", "wb": "StraightWB"}, "skirt": {"length": 0.5}},
    "pants": {"meta": {"upper": None, "bottom": "Pants", "wb": "StraightWB"}, "pants": {"length": 0.9}},
    # This torso is sewn to a waist-level band; its default must reach that
    # level rather than use the previous cropped .8 block. Users can still
    # request a cropped block explicitly through design.shirt.length.
    "dress": {"meta": {"upper": "Shirt", "bottom": "Skirt2", "wb": "StraightWB"}, "shirt": {"length": 1.0}, "skirt": {"length": 0.5}},
}


class InputError(ValueError):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InputError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise InputError(f"Non-finite JSON number: {value}")


def read_request():
    raw = sys.stdin.buffer.read(1_048_577)
    if len(raw) > 1_048_576:
        raise InputError("Request exceeds 1 MiB")
    try:
        request = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InputError(f"Invalid JSON: {error}") from error
    if not isinstance(request, dict):
        raise InputError("Request must be an object")
    unknown = set(request) - {"preset", "body", "design"}
    if unknown:
        raise InputError(f"Unknown request fields: {', '.join(sorted(unknown))}")
    preset = request.get("preset", "t-shirt")
    if not isinstance(preset, str) or preset not in PRESETS:
        raise InputError(f"Unknown preset; choose {', '.join(PRESETS)}")
    return request


def merge_design(target, overrides, path="design"):
    if not isinstance(overrides, dict):
        raise InputError(f"{path} must be an object")
    for key, override in overrides.items():
        if key not in target:
            raise InputError(f"Unknown design field: {path}.{key}")
        field = target[key]
        here = f"{path}.{key}"
        if "v" not in field:
            merge_design(field, override, here)
            continue
        if isinstance(override, dict):
            if set(override) != {"v"}:
                raise InputError(f"{here} accepts a scalar or an object containing only v")
            value = override["v"]
        else:
            value = override
        kind = field["type"]
        bounds = field["range"]
        if kind in {"float", "int"}:
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                raise InputError(f"{here} must be a finite number")
            if kind == "int" and value != int(value):
                raise InputError(f"{here} must be an integer")
            if not bounds[0] <= value <= bounds[1]:
                raise InputError(f"{here} must be between {bounds[0]} and {bounds[1]}")
            value = int(value) if kind == "int" else float(value)
        elif kind == "bool":
            if not isinstance(value, bool):
                raise InputError(f"{here} must be a boolean")
        elif kind in {"select", "select_null"}:
            # Python equates True with 1; do not let booleans through numeric enums.
            if not any(type(value) is type(option) and value == option for option in bounds):
                raise InputError(f"{here} must be one of {bounds}")
        else:
            raise InputError(f"Unsupported upstream field type: {kind}")
        field["v"] = value


def validate_body(defaults, overrides):
    if not isinstance(overrides, dict):
        raise InputError("body must be an object of upstream measurement names in centimetres (angles in degrees)")
    result = copy.deepcopy(defaults)
    for key, value in overrides.items():
        if key not in defaults or key.startswith("_"):
            raise InputError(f"Unknown body measurement: {key}")
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
            raise InputError(f"body.{key} must be a finite number")
        is_angle = "angle" in key or "incl" in key
        low, high = (0, 90) if is_angle else (0.1, 400)
        if not low <= value <= high:
            raise InputError(f"body.{key} must be between {low} and {high}")
        result[key] = float(value)
    if result["height"] <= result["head_l"] + result["waist_line"] + result["hips_line"]:
        raise InputError("height must exceed head_l + waist_line + hips_line")
    if result["neck_w"] >= result["shoulder_w"]:
        raise InputError("neck_w must be smaller than shoulder_w")
    return result


def validate_pattern(spec):
    panels = spec["pattern"]["panels"]
    if not panels:
        raise InputError("Design generated an empty garment")
    for name, panel in panels.items():
        if len(panel["vertices"]) < 3 or len(panel["edges"]) < 3:
            raise RuntimeError(f"Generated degenerate panel: {name}")
        for edge in panel["edges"]:
            if any(not isinstance(v, int) or v < 0 or v >= len(panel["vertices"]) for v in edge["endpoints"]):
                raise RuntimeError(f"Invalid generated boundary reference: {name}")
    for stitch in spec["pattern"]["stitches"]:
        for side in stitch[:2]:
            if side["panel"] not in panels or not 0 <= side["edge"] < len(panels[side["panel"]]["edges"]):
                raise RuntimeError("Invalid generated stitch reference")


def run(request, describe=False):
    root_value = os.environ.get("GARMENTCODE_ROOT")
    if not root_value:
        raise RuntimeError("GARMENTCODE_ROOT is not configured; see scripts/garmentcode/README.md")
    root = Path(root_value).resolve()
    if not (root / "assets/design_params/t-shirt.yaml").is_file() or not (root / "pygarment/__init__.py").is_file():
        raise RuntimeError("GARMENTCODE_ROOT must point to a trusted GarmentCode checkout")
    # Only a deployment-owned root is allowed; the request cannot choose code or file paths.
    sys.path.insert(0, str(root))
    # A fixed upstream design enum uses an SVG asset relative to the checkout root.
    os.chdir(root)
    os.environ.setdefault("MPLBACKEND", "Agg")
    import yaml

    with (root / "assets/design_params/t-shirt.yaml").open() as file:
        design = yaml.safe_load(file)["design"]
    with (root / "assets/bodies/mean_all.yaml").open() as file:
        defaults = yaml.safe_load(file)["body"]
    if describe:
        return {"testedUpstreamRevision": UPSTREAM_REVISION, "presets": list(PRESETS), "body": defaults, "design": design}
    preset = request.get("preset", "t-shirt")
    merge_design(design, PRESETS[preset])
    merge_design(design, request.get("design", {}))
    body_values = validate_body(defaults, request.get("body", {}))

    from assets.bodies.body_params import BodyParameters
    from assets.garment_programs.meta_garment import MetaGarment

    body = BodyParameters(str(root / "assets/bodies/mean_all.yaml"))
    body.load_from_dict(body_values)
    garment = MetaGarment(preset, body, design)
    garment.assert_non_empty()
    garment.assert_total_length()
    if garment.is_self_intersecting():
        raise InputError("Design generated intersecting panels; reduce the requested style or measurement extremes")
    spec = garment.assembly().spec
    # Retain resolved drafting inputs, including omitted neutral defaults. Consumers can
    # match their own avatar geometry explicitly instead of guessing from garment panels.
    spec["properties"]["garmentcode_body"] = body_values
    # The reference simulator uses the apart-leg source body for trousers.
    # Preserve this explicit design-derived selection instead of guessing from panel names.
    spec["properties"]["garmentcode_body_pose"] = (
        "apart" if design["meta"]["bottom"]["v"] == "Pants" else "straight"
    )
    validate_pattern(spec)
    from gather_provenance import gather_evidence
    spec["properties"]["garmentcode_gather_evidence"] = gather_evidence(
        garment, spec, root, design, body_values, preset, UPSTREAM_REVISION)
    # JSON serialization also rejects any non-finite numeric geometry.
    return spec


def main():
    if sys.argv[1:] not in ([], ["--describe"]):
        print("Usage: generate.py [--describe]; JSON request on stdin", file=sys.stderr)
        return 2
    try:
        describe = sys.argv[1:] == ["--describe"]
        request = {} if describe else read_request()
        # Upstream prints geometric diagnostics; keep stdout a single valid JSON document.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request, describe)
        serialized = json.dumps(result, allow_nan=False, separators=(",", ":"))
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as error:
        # Upstream geometry errors inherit BaseException rather than Exception.
        print(f"GarmentCode generation failed ({type(error).__name__}): {error}", file=sys.stderr)
        return 2 if isinstance(error, (InputError, json.JSONDecodeError)) else 1
    print(serialized)
    return 0


if __name__ == "__main__":
    sys.exit(main())
