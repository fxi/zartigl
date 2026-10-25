"""S3 settings and checks shared by the scripts that publish to the zartigl bucket."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def s3_settings() -> dict[str, str]:
    """Public defaults from .env.demo, credentials from .env or the environment."""
    env = {**read_dotenv(ROOT / ".env.demo"), **read_dotenv(ROOT / ".env"), **os.environ}
    required_names = ["S3_ENDPOINT", "S3_KEY", "S3_SECRET", "S3_BUCKET"]
    missing = [name for name in required_names if not env.get(name)]
    if missing:
        raise RuntimeError(f"Missing S3 configuration: {', '.join(missing)}")
    return env


def s3_client() -> tuple[Any, dict[str, str]]:
    import boto3

    env = s3_settings()
    client = boto3.client(
        "s3",
        endpoint_url=env["S3_ENDPOINT"],
        aws_access_key_id=env["S3_KEY"],
        aws_secret_access_key=env["S3_SECRET"],
    )
    return client, env


def require_bucket_cors(client: Any, bucket: str) -> None:
    """Fail early when the bucket cannot serve browser Range reads; never rewrite shared bucket CORS."""
    try:
        rules = client.get_bucket_cors(Bucket=bucket)["CORSRules"]
    except client.exceptions.ClientError as exc:
        raise RuntimeError(
            f"Bucket {bucket} has no readable CORS configuration; configure GET/HEAD with the Range header once"
        ) from exc
    for rule in rules:
        methods = {method.upper() for method in rule.get("AllowedMethods", [])}
        headers = {header.lower() for header in rule.get("AllowedHeaders", [])}
        exposed = {header.lower() for header in rule.get("ExposeHeaders", [])}
        if {"GET", "HEAD"} <= methods and ("range" in headers or "*" in headers) and "content-range" in exposed:
            return
    raise RuntimeError(f"Bucket {bucket} CORS does not allow GET/HEAD Range reads exposing Content-Range")
