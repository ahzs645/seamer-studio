"""Read resolved upstream Interface data; never change drafting, placement or sewing."""
import hashlib
import inspect
import json
import math
from pathlib import Path
import struct

REVISION = "garmentcode-resolved-gather-evidence-v1"


def canonical_tagged(value):
    """Cross-language typed JSON; finite numbers use exact IEEE754 f64 words."""
    if value is None:
        return ["z"]
    if isinstance(value, bool):
        return ["b", value]
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("Nonfinite generation provenance")
        return ["n", struct.pack(">d", float(value)).hex()]
    if isinstance(value, str):
        return ["s", value]
    if isinstance(value, list):
        return ["a", [canonical_tagged(item) for item in value]]
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        return ["o", [[key, canonical_tagged(value[key])] for key in keys]]
    raise ValueError(f"Unsupported provenance value {type(value).__name__}")


def canonical_sha256(value):
    data = json.dumps(canonical_tagged(value), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def gather_evidence(garment, spec, root: Path, resolved_design, source_body, preset, upstream_revision):
    from pygarment.garmentcode.interface import Interface
    from pygarment.garmentcode.connector import StitchingRule
    from pygarment.garmentcode.component import Component
    seen = set()
    components = []
    def walk(component, path):
        if id(component) in seen:
            return
        seen.add(id(component))
        here = path + [f"{type(component).__module__}.{type(component).__qualname__}:{component.name}"]
        components.append((component, here))
        if isinstance(component, Component):
            for child in sorted(component._get_subcomponents(), key=lambda item: (type(item).__module__, type(item).__qualname__, item.name)):
                walk(child, here)
    walk(garment, [])
    program_paths = set()
    for cls in [type(component) for component, _ in components] + [Interface, StitchingRule]:
        file = Path(inspect.getfile(cls)).resolve()
        file.relative_to(root)
        program_paths.add(file)
    programs = [{"path": path.relative_to(root).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                for path in sorted(program_paths)]
    stitches = spec["pattern"]["stitches"]
    stitch_lookup = {}
    for index, stitch in enumerate(stitches):
        refs = tuple((side["panel"], side["edge"]) for side in stitch[:2])
        if refs in stitch_lookup:
            raise ValueError("Ambiguous duplicate generated stitch")
        stitch_lookup[refs] = index
    records = []
    for component, style_path in components:
        for rule in component.stitching_rules.rules:
            for ordinal, (first, second) in enumerate(zip(rule.int1.edges, rule.int2.edges)):
                interfaces = [rule.int1, rule.int2]
                refs = tuple((interface.panel[ordinal].name, interface.edges[ordinal].geometric_id) for interface in interfaces)
                if refs not in stitch_lookup:
                    raise ValueError("Resolved Interface does not match actual serialized stitch")
                coefficients = []
                for interface in interfaces:
                    groups = [r for r in interface.ruffle if r["sec"][0] <= ordinal < r["sec"][1]]
                    if len(groups) != 1:
                        raise ValueError("Ambiguous resolved ruffle section")
                    coefficients.append(float(groups[0]["coeff"]))
                if any(not math.isfinite(v) or v <= 0 for v in coefficients):
                    raise ValueError("Invalid resolved Interface ruffle")
                if abs(coefficients[0] - coefficients[1]) <= 1e-3:
                    continue
                long_side = 0 if coefficients[0] > coefficients[1] else 1
                lengths = [float(first.length()), float(second.length())]
                if lengths[long_side] <= lengths[1 - long_side]:
                    # A nonuniform/projection mismatch is declared but not a proven long boundary.
                    continue
                records.append({"stitchIndex": stitch_lookup[refs], "longSide": long_side,
                    "sides": [{"panel": panel, "edge": edge, "ruffleCoefficient": coefficients[side],
                               "sourceArcLength": lengths[side], "sourceMaterialInterval": [0, 1]}
                              for side, (panel, edge) in enumerate(refs)],
                    "stylePath": style_path,
                    "programPath": Path(inspect.getfile(type(component))).resolve().relative_to(root).as_posix(),
                    "evidence": "actual-resolved-upstream-Interface.ruffle"})
    records.sort(key=lambda row: row["stitchIndex"])
    evidence = {"revision": REVISION, "encoding": "typed-json-ieee754-f64be-v1", "upstreamRevision": upstream_revision,
        "programs": programs, "resolvedDesign": resolved_design, "sourceBody": source_body, "preset": preset,
        "sourcePatternSha256": canonical_sha256(spec["pattern"]), "stitches": records}
    evidence["evidenceSha256"] = canonical_sha256(evidence)
    return evidence
