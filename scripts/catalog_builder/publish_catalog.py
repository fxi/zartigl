#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.35", "jsonschema>=4.0", "markdown>=3.5"]
# ///
"""Publish the built-in catalog to the zartigl bucket, where apps built against
an older package (MapX) read it live: `loadCatalog()` in @fxi/zartigl/catalog.

  catalog/v<schema>/catalog.json            live, rewritten on each change, 60 s cache
  catalog/v<schema>/releases/<version>.json immutable copy of a release (--release)
  docs/layers/<uuid>/v<n>/index.html        layer documentation, immutable (see skills/layer_docs.py)
  docs/layers/<uuid>/index.html             latest documentation of the layer, 60 s cache

The catalog is validated first. The published document adds `minEngine`, the
package version: an older engine still reads it and ignores newer style keys.

Copernicus Zarr sources also get the `temporal.start` their producer declares
(STAC `validStartDate`): store time axes can begin with empty years, and
rolling NRT archives move that start. It is resolved at each publish, run
nightly, and never written to the repository catalog. A source whose STAC
cannot be read keeps its live value and fails the run once published.

Usage:
  uv run scripts/catalog_builder/publish_catalog.py [--release] [--dry-run]
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "catalog_builder" / "skills"))
import validate_catalog  # noqa: E402
import layer_docs  # noqa: E402
from copernicus_metadata import fetch_json, zarr_valid_start  # noqa: E402
from s3_bucket import read_dotenv, require_bucket_cors, s3_client  # noqa: E402

CATALOG_PATH = ROOT / "src" / "catalog" / "catalog.json"
PACKAGE_PATH = ROOT / "package.json"


def published(catalog: dict, version: str) -> dict:
    return {"schemaVersion": catalog["schemaVersion"], "minEngine": version,
            **{key: value for key, value in catalog.items() if key != "schemaVersion"}}


def targets(schema: int, version: str, release: bool) -> list[tuple[str, str]]:
    """Object keys and their Cache-Control."""
    keys = [(f"catalog/v{schema}/catalog.json", "public,max-age=60")]
    if release:
        keys.append((f"catalog/v{schema}/releases/{version}.json", "public,max-age=31536000,immutable"))
    return keys


def source_starts(catalog: dict | None) -> dict[str, str]:
    """Declared `temporal.start` of every source, by source id."""
    return {
        source["id"]: source["temporal"]["start"]
        for layer in (catalog or {}).get("layers", [])
        for source in layer["sources"]
        if (source.get("temporal") or {}).get("start")
    }


def with_coverage(
    catalog: dict, live: dict | None, fetch: Callable[[str], Any] = fetch_json,
) -> tuple[dict, list[dict], list[str]]:
    """
    The catalog with producer-declared starts on its Copernicus Zarr sources,
    the start changes against the live catalog, and the sources whose start
    could not be resolved (they keep their live value).
    """
    resolved = copy.deepcopy(catalog)
    previous = source_starts(live)
    changes: list[dict] = []
    failures: list[str] = []
    for layer in resolved["layers"]:
        for source in layer["sources"]:
            try:
                start = zarr_valid_start(source, fetch)
            except Exception as exc:  # noqa: BLE001 - reported, the run fails
                failures.append(f"{layer['id']} {source['id']}: {exc}")
                start = previous.get(source["id"])
            if not start:
                continue
            source["temporal"] = {**source["temporal"], "start": start}
            if previous.get(source["id"]) != start:
                changes.append({
                    "entry": (layer.get("aliases") or [layer["id"]])[0],
                    "sourceId": source["id"],
                    "from": previous.get(source["id"]),
                    "to": start,
                })
    return resolved, changes, failures


def live_catalog(key: str) -> dict | None:
    """The published catalog at `key`, None before its first publish."""
    env = {**read_dotenv(ROOT / ".env.demo"), **os.environ}
    url = f"{env['S3_ENDPOINT'].rstrip('/')}/{env['S3_BUCKET']}/{key}"
    try:
        return fetch_json(url)
    except HTTPError as exc:
        if exc.code in (403, 404):
            return None
        raise


MISSING = {"404", "NoSuchKey", "NotFound"}


def head_or_none(client: Any, bucket: str, key: str) -> dict | None:
    """The object's HEAD, None only when it does not exist: any other error
    (denied, server) is raised, so an immutable object is never taken for
    missing and rewritten."""
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except client.exceptions.ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code")) in MISSING:
            return None
        raise


def publish_docs(client: Any, bucket: str, docs: list[dict[str, Any]]) -> list[str]:
    """
    Uploads the documentation pages. A published version is never rewritten:
    if its Markdown source changed, the run fails and asks for a new version.
    Returns the errors; the latest copies are written only when every version
    is consistent.
    """
    errors: list[str] = []
    writes: list[dict[str, Any]] = []
    for page in docs:
        head = head_or_none(client, bucket, page["key"])
        if head is None:
            writes.append(page)
            continue
        published_sha = head.get("Metadata", {}).get("source-sha256")
        if published_sha == page["sha256"]:
            print(f"{page['key']} unchanged")
        elif page["immutable"]:
            errors.append(f"{page['key']}: {page['source']} changed since this version was published; "
                          "bump its version in scripts/catalog_builder/docs.json and the entry's documentation")
        else:
            writes.append(page)
    if errors:
        return errors
    for page in writes:
        client.put_object(Bucket=bucket, Key=page["key"], Body=page["body"], ACL="public-read",
                          ContentType="text/html; charset=utf-8", CacheControl=page["cache"],
                          Metadata={"source-sha256": page["sha256"]})
        print(f"published {page['source']} to {page['key']}")
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", action="store_true", help="Also write the immutable copy of this version")
    parser.add_argument("--dry-run", action="store_true", help="Validate, resolve, and print the coverage changes only")
    args = parser.parse_args()

    validate_catalog.main()
    catalog = json.loads(CATALOG_PATH.read_text())
    version = json.loads(PACKAGE_PATH.read_text())["version"]
    keys = targets(catalog["schemaVersion"], version, args.release)
    live = live_catalog(keys[0][0])
    catalog, changes, failures = with_coverage(catalog, live)
    print(json.dumps({"coverageChanges": changes, "coverageFailures": failures}, indent=2))
    document = published(catalog, version)
    body = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode()
    docs = layer_docs.pages(catalog, layer_docs.load_registry())
    if args.dry_run:
        for page in docs:
            print(f"would publish {page['source']} to {page['key']} ({page['cache']})")
        for key, cache in keys:
            print(f"would publish {len(catalog['layers'])} layers, minEngine {version}, to {key} ({cache})")
        return 1 if failures else 0

    client, env = s3_client()
    bucket = env["S3_BUCKET"]
    require_bucket_cors(client, bucket)
    # Pages first: the catalog never links to a page that is not there yet.
    doc_errors = publish_docs(client, bucket, docs)
    if doc_errors:
        print("Documentation not published:\n" + "\n".join(doc_errors), file=sys.stderr)
        return 1
    for key, cache in keys:
        if cache.endswith("immutable"):
            if head_or_none(client, bucket, key) is not None:
                print(f"{key} exists; releases are immutable, skipped")
                continue
        elif live == document:
            print(f"{key} unchanged")
            continue
        client.put_object(Bucket=bucket, Key=key, Body=body, ACL="public-read",
                          ContentType="application/json; charset=utf-8", CacheControl=cache)
        print(f"published {len(catalog['layers'])} layers to {env['S3_ENDPOINT'].rstrip('/')}/{bucket}/{key}")
    if failures:
        print("Coverage unresolved, live values kept:\n" + "\n".join(failures), file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
