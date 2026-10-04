"""Build deployment-owned program checksums; input is trusted checkout configuration, not a garment."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def registry(root: Path):
    root = root.resolve()
    revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], check=True,
                              capture_output=True, text=True).stdout.strip()
    programs = {}
    for directory in ["assets/garment_programs", "pygarment/garmentcode"]:
        for file in sorted((root / directory).rglob("*.py")):
            file.resolve().relative_to(root)
            programs[file.relative_to(root).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    return {"upstreamRevision": revision, "programSha256": programs}


if __name__ == "__main__":
    print(json.dumps(registry(Path(sys.argv[1])), indent=2))
