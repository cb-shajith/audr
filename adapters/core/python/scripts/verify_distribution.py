"""Verify the built `audr` wheel installs and runs in isolation.

Assumes `make build` has already produced `dist/`. This creates a throwaway venv with
`uv venv`, installs the wheel into it with `uv pip install`, and imports the public
surface to prove the core installs and runs with no adapter (e.g. `httpx`) present.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST_DIR = ROOT / "dist"

_CHECK = (
    "import audr, audr.sinks, audr.testing; "
    "import importlib.util as u; "
    "assert u.find_spec('httpx') is None; "
    "print(audr.__version__)"
)


def _find_wheel(dist_dir: Path) -> Path:
    wheels = sorted(dist_dir.glob("*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"expected exactly one wheel in {dist_dir}, found {wheels}")
    return wheels[0]


def verify_distribution(dist_dir: Path) -> None:
    """Install `dist_dir`'s one wheel into a fresh venv and run the isolation check."""
    wheel = _find_wheel(dist_dir)
    with tempfile.TemporaryDirectory() as tmp:
        venv_dir = Path(tmp) / ".venv"
        subprocess.run(["uv", "venv", str(venv_dir)], check=True, capture_output=True)
        python = venv_dir / "bin" / "python"
        subprocess.run(
            ["uv", "pip", "install", "--python", str(python), str(wheel)],
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            [str(python), "-c", _CHECK], check=True, capture_output=True, text=True
        )
        print(result.stdout.strip())


def main() -> None:
    verify_distribution(DIST_DIR)


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
