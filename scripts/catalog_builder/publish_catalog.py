#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.35", "jsonschema>=4.0"]
# ///
"""Publish the built-in catalog to the zartigl bucket, where apps built against
an older package (MapX) read it live: `loadCatalog()` in @fxi/zartigl/catalog.

  catalog/v<schema>/catalog.json            live, rewritten on each change, 60 s cache
  catalog/v<schema>/releases/<version>.json immutable copy of a release (--release)

The catalog is validated first. The published document adds `minEngine`, the
package version: an older engine still reads it and ignores newer style keys.

Usage:
  uv run scripts/catalog_builder/publish_catalog.py [--release] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "catalog_builder" / "skills"))
import validate_catalog  # noqa: E402
from s3_bucket import require_bucket_cors, s3_client  # noqa: E402

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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", action="store_true", help="Also write the immutable copy of this version")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print the targets only")
    args = parser.parse_args()

    validate_catalog.main()
    catalog = json.loads(CATALOG_PATH.read_text())
    version = json.loads(PACKAGE_PATH.read_text())["version"]
    body = (json.dumps(published(catalog, version), ensure_ascii=False, indent=2) + "\n").encode()
    keys = targets(catalog["schemaVersion"], version, args.release)
    if args.dry_run:
        for key, cache in keys:
            print(f"would publish {len(catalog['layers'])} layers, minEngine {version}, to {key} ({cache})")
        return

    client, env = s3_client()
    bucket = env["S3_BUCKET"]
    require_bucket_cors(client, bucket)
    for key, cache in keys:
        if cache.endswith("immutable"):
            try:
                client.head_object(Bucket=bucket, Key=key)
                print(f"{key} exists; releases are immutable, skipped")
                continue
            except client.exceptions.ClientError:
                pass
        client.put_object(Bucket=bucket, Key=key, Body=body, ACL="public-read",
                          ContentType="application/json; charset=utf-8", CacheControl=cache)
        print(f"published {len(catalog['layers'])} layers to {env['S3_ENDPOINT'].rstrip('/')}/{bucket}/{key}")


if __name__ == "__main__":
    main()
