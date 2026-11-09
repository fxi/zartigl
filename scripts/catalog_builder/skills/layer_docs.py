"""Layer documentation: the Markdown methodology pages that `publish_catalog.py`
publishes next to the catalog, and that catalog entries link to through
`documentation`.

scripts/catalog_builder/docs.json lists, for each documented entry, its Markdown
source and its version. Each version is published once, immutable, under

  <prefix>/<entry uuid>/v<version>/index.html   immutable: the entry's `documentation`
  <prefix>/<entry uuid>/index.html              latest version, 60 s cache

Changing a published page means bumping its version and the entry's
`documentation` URL: the old version stays where it was cited.
"""

from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DOCS_PATH = ROOT / "scripts" / "catalog_builder" / "docs.json"

STYLE = """
:root { color-scheme: light dark; --fg: #1d232a; --bg: #fdfdfc; --muted: #5b6570; --line: #d9dde1; --code: #f1f3f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ec; --bg: #14181c; --muted: #9aa4ae; --line: #2c333a; --code: #1d232a; } }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
h1 { font-size: 1.8rem; line-height: 1.25; margin: 0 0 1rem; }
h2 { font-size: 1.2rem; margin: 2.2rem 0 .6rem; padding-top: .6rem; border-top: 1px solid var(--line); }
a { color: inherit; }
code { background: var(--code); padding: .1em .3em; border-radius: 3px; font-size: .9em; overflow-wrap: anywhere; }
pre { background: var(--code); padding: .8rem 1rem; border-radius: 4px; overflow-x: auto; }
pre code { padding: 0; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .95em; }
th, td { text-align: left; vertical-align: top; padding: .45rem .6rem; border-bottom: 1px solid var(--line); }
footer { margin-top: 3rem; color: var(--muted); font-size: .85rem; }
"""


def load_registry(path: Path = DOCS_PATH) -> dict[str, Any]:
    return json.loads(path.read_text()) if path.exists() else {"upload": {"prefix": "docs/layers"}, "docs": []}


def version_key(prefix: str, entry_id: str, version: int) -> str:
    return f"{prefix}/{entry_id}/v{version}/index.html"


def latest_key(prefix: str, entry_id: str) -> str:
    return f"{prefix}/{entry_id}/index.html"


def public_base(root: Path = ROOT) -> str:
    """The bucket's public URL, from the committed .env.demo: where `publish_catalog.py` uploads."""
    import sys

    sys.path.insert(0, str(root / "scripts"))
    from s3_bucket import read_dotenv

    env = read_dotenv(root / ".env.demo")
    return f"{env['S3_ENDPOINT'].rstrip('/')}/{env['S3_BUCKET']}"


def check(catalog: dict[str, Any], registry: dict[str, Any], root: Path = ROOT,
          base: str | None = None) -> list[str]:
    """Errors between the catalog's `documentation` links and the registry: each link
    must be the exact URL its page is published at."""
    base = base or public_base(root)
    errors: list[str] = []
    prefix = registry["upload"]["prefix"]
    entries = {layer["id"]: layer for layer in catalog["layers"]}
    documented: set[str] = set()
    for doc in registry["docs"]:
        entry_id, version = doc["catalogEntryId"], doc["version"]
        if entry_id in documented:
            errors.append(f"{entry_id}: documented twice in docs.json")
        documented.add(entry_id)
        if not isinstance(version, int) or version < 1:
            errors.append(f"{entry_id}: docs.json version must be a positive integer")
        if not (root / doc["file"]).is_file():
            errors.append(f"{entry_id}: documentation source {doc['file']} not found")
        entry = entries.get(entry_id)
        if entry is None:
            errors.append(f"{entry_id}: docs.json names an entry that is not in the catalog")
            continue
        expected = f"{base}/{version_key(prefix, entry_id, version)}"
        if entry.get("documentation") != expected:
            errors.append(f"{entry_id}: documentation must link to {expected}")
    for entry_id, entry in entries.items():
        if entry.get("documentation") and entry_id not in documented:
            errors.append(f"{entry_id}: documentation has no source in scripts/catalog_builder/docs.json")
    return errors


def render(markdown_text: str, *, canonical: str, version: int) -> str:
    """A standalone HTML page for one documentation version."""
    import markdown

    body = markdown.markdown(markdown_text, extensions=["tables", "fenced_code"], output_format="html")
    body = body.replace("<table>", '<div class="table"><table>').replace("</table>", "</table></div>")
    title = next((line[2:].strip() for line in markdown_text.splitlines() if line.startswith("# ")), "zartigl layer")
    link = html.escape(canonical, quote=True)
    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        f"<title>{html.escape(title)}</title>\n<link rel=\"canonical\" href=\"{link}\">\n"
        f"<style>{STYLE}</style>\n</head>\n<body>\n<main>\n{body}\n"
        f"<footer>Version {version}. Permanent link: <a href=\"{link}\">{html.escape(canonical)}</a></footer>\n"
        "</main>\n</body>\n</html>\n"
    )


def pages(catalog: dict[str, Any], registry: dict[str, Any], root: Path = ROOT) -> list[dict[str, Any]]:
    """Every page to publish, each version before its latest copy: key, Cache-Control,
    body, whether it is immutable, and the SHA-256 of its Markdown source (stored as
    object metadata, so a changed source under a published version is caught
    without comparing rendered HTML)."""
    prefix = registry["upload"]["prefix"]
    entries = {layer["id"]: layer for layer in catalog["layers"]}
    result = []
    for doc in registry["docs"]:
        entry_id, version = doc["catalogEntryId"], doc["version"]
        source = (root / doc["file"]).read_text()
        body = render(source, canonical=entries[entry_id]["documentation"], version=version).encode()
        digest = hashlib.sha256(f"v{version}\n{source}".encode()).hexdigest()
        for key, cache, immutable in (
            (version_key(prefix, entry_id, version), "public,max-age=31536000,immutable", True),
            (latest_key(prefix, entry_id), "public,max-age=60", False),
        ):
            result.append({"key": key, "cache": cache, "body": body, "immutable": immutable,
                           "source": doc["file"], "sha256": digest})
    return result
