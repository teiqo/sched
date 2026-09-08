#!/usr/bin/env python3
"""Only public/ is uploaded to the static host: no bot, tests, env or database files."""
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parents[1]
if __name__ == "__main__":
    dist=ROOT / "dist"
    if dist.exists(): shutil.rmtree(dist)
    shutil.copytree(
        ROOT / "public",
        dist,
        ignore=shutil.ignore_patterns("local-config.js"),
    )
    print("dist/ ready (public files only)")
