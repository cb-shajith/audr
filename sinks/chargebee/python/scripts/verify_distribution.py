"""Verify the built `audr-sink-chargebee` wheel installs and runs in isolation.

Assumes `make build` has already produced `dist/`. This creates a throwaway venv with
`uv venv` and installs the wheel into it, so the check runs against the artifact that
would be published rather than against the editable development tree.

`audr` is not resolvable from PyPI for an unreleased version, and resolving it from
there would defeat the point: the wheel must be proven against the core it ships
beside. So the core wheel is built into the same temporary directory and offered to
the resolver with `--find-links`.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "dist"
CORE_DIR = ROOT.parents[2] / "adapters" / "core" / "python"

_CHECK = (
    "import audr, audr_sink_chargebee; "
    "from audr_sink_chargebee import ChargebeeSink; "
    "sink = ChargebeeSink(ingest_url='https://acme.ingest.chargebee.com', api_key='k'); "
    "assert isinstance(sink, audr.Sink); "
    "print(audr_sink_chargebee.__version__)"
)


def _find_wheel(dist_dir: Path) -> Path:
    wheels = sorted(dist_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected exactly one wheel in {dist_dir}, found {wheels}")
    return wheels[0]


def _venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def verify_distribution(dist_dir: Path, core_dir: Path) -> None:
    """Install the built wheel, plus a freshly built core wheel, into a clean venv."""
    wheel = _find_wheel(dist_dir)
    with tempfile.TemporaryDirectory() as tmp:
        links = Path(tmp) / "links"
        subprocess.run(
            ["uv", "build", "--wheel", "--out-dir", str(links), str(core_dir)],
            check=True,
            capture_output=True,
        )
        venv_dir = Path(tmp) / ".venv"
        subprocess.run(["uv", "venv", str(venv_dir)], check=True, capture_output=True)
        python = _venv_python(venv_dir)
        subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                "--find-links",
                str(links),
                str(wheel),
            ],
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            [str(python), "-c", _CHECK], check=True, capture_output=True, text=True
        )
        print(result.stdout.strip())


def main() -> None:
    verify_distribution(DIST_DIR, CORE_DIR)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"verify_distribution failed: {exc}", file=sys.stderr)
        if isinstance(exc, subprocess.CalledProcessError):
            if exc.stdout:
                print(exc.stdout, file=sys.stderr)
            if exc.stderr:
                print(exc.stderr, file=sys.stderr)
        sys.exit(1)
