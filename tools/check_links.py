"""Fail if a relative link or heading anchor in a tracked Markdown file does not resolve.

Runs offline. Links into this repository written as absolute
``https://github.com/openaudr/audr/blob/main/...`` URLs — the form the PyPI READMEs must
use — are resolved to local paths and checked too. Other external URLs are checked
separately in CI by lychee. Files under
``spec/prose/`` are skipped: they are spliced into ``spec/SPEC.md`` one level up, their
links are authored relative to the rendered document, and ``SPEC.md`` itself is checked.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
# The PyPI READMEs link into this repository by absolute URL; those resolve to local paths.
REPO_BLOB = "https://github.com/openaudr/audr/blob/main/"
REPO_TREE = "https://github.com/openaudr/audr/tree/main/"
LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$", re.MULTILINE)
FENCE = re.compile(r"^```.*?^```", re.MULTILINE | re.DOTALL)


def tracked_markdown() -> list[pathlib.Path]:
    out = subprocess.run(
        ["git", "ls-files", "--", "*.md", "**/*.md"],
        cwd=ROOT, check=True, capture_output=True, text=True,
    ).stdout
    return [ROOT / line for line in out.splitlines() if line and not line.startswith("spec/prose/")]


def slug(heading: str) -> str:
    """The anchor GitHub generates for a heading."""
    text = re.sub(r"`([^`]*)`", r"\1", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(path: pathlib.Path, cache: dict[pathlib.Path, set[str]]) -> set[str]:
    if path not in cache:
        text = FENCE.sub("", path.read_text())
        cache[path] = {slug(h) for h in HEADING.findall(text)}
    return cache[path]


def main() -> int:
    broken: list[str] = []
    cache: dict[pathlib.Path, set[str]] = {}
    for md in tracked_markdown():
        text = FENCE.sub("", md.read_text())
        for label, target in LINK.findall(text):
            base = md.parent
            for prefix in (REPO_BLOB, REPO_TREE):
                if target.startswith(prefix):
                    target, base = target[len(prefix):], ROOT
            if target.startswith(("http://", "https://", "mailto:", "/")):
                continue
            path_part, _, anchor = target.partition("#")
            resolved = md if not path_part else (base / urllib.parse.unquote(path_part)).resolve()
            rel = md.relative_to(ROOT)
            if not resolved.exists():
                broken.append(f"  {rel}: [{label}]({target}) — target does not exist")
                continue
            if anchor and resolved.suffix == ".md" and anchor not in anchors(resolved, cache):
                broken.append(f"  {rel}: [{label}]({target}) — no heading for #{anchor}")
    if broken:
        print(f"{len(broken)} broken link(s):")
        print("\n".join(broken))
        return 1
    print("  all relative links and anchors resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
