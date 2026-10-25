"""Shared plumbing for the netCDF → Zarr pipelines: store targets, appends, budgets.

Each product converts provider files into two Zarr v2 stores shaped like
Copernicus Marine ARCO, which zartigl and the GeoVideo renderer already read:
`timeChunked.zarr` (one time step per chunk, for maps) and `geoChunked.zarr`
(long time chunks over small tiles, for point series). Stores are written in
place; readers only see a new time step once the consolidated metadata,
written last, lists it.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from s3_bucket import require_bucket_cors, s3_client  # noqa: E402

STORE_NAMES = ("timeChunked", "geoChunked")
# The time coordinate is read whole by the browser, so it lives in a single chunk.
TIME_COORDINATE_CHUNK = 1 << 16


@dataclass(frozen=True)
class Target:
    """Where a product's stores live: a bucket prefix, or a local directory for tests and dry runs."""

    root: str
    storage_options: dict[str, Any] | None = None
    public_base: str | None = None

    def store(self, name: str) -> Any:
        if self.storage_options is None:
            return str(Path(self.root) / f"{name}.zarr")
        import fsspec

        return fsspec.get_mapper(f"{self.root}/{name}.zarr", **self.storage_options)

    def public_url(self, name: str) -> str | None:
        return f"{self.public_base}/{name}.zarr" if self.public_base else None


def local_target(directory: Path) -> Target:
    directory.mkdir(parents=True, exist_ok=True)
    return Target(root=str(directory))


def bucket_target(prefix: str) -> Target:
    """Public-read objects under `prefix` of the zartigl bucket, after checking its CORS rules."""
    client, env = s3_client()
    require_bucket_cors(client, env["S3_BUCKET"])
    return Target(
        root=f"s3://{env['S3_BUCKET']}/{prefix.strip('/')}",
        storage_options={
            "key": env["S3_KEY"],
            "secret": env["S3_SECRET"],
            "client_kwargs": {"endpoint_url": env["S3_ENDPOINT"]},
            "s3_additional_kwargs": {"ACL": "public-read"},
        },
        public_base=f"{env['S3_ENDPOINT'].rstrip('/')}/{env['S3_BUCKET']}/{prefix.strip('/')}",
    )


def target_from_args(args: argparse.Namespace, prefix: str) -> Target:
    if args.local:
        return local_target(Path(args.local))
    return bucket_target(prefix)


def stored_times(target: Target, name: str) -> np.ndarray:
    """Time axis of a store, empty when it does not exist yet."""
    try:
        dataset = xr.open_zarr(target.store(name), consolidated=True, zarr_format=2)
    except (FileNotFoundError, KeyError, ValueError):
        return np.array([], dtype="datetime64[ns]")
    return dataset["time"].values.astype("datetime64[ns]")


def open_store(target: Target, name: str, *, decode: bool = True) -> xr.Dataset:
    return xr.open_zarr(target.store(name), consolidated=True, zarr_format=2, mask_and_scale=decode)


def write(dataset: xr.Dataset, target: Target, name: str, chunks: dict[str, int],
          encodings: dict[str, dict[str, Any]], *, append: bool) -> None:
    """Create the store or append along time; dask chunks must already match the store chunks."""
    store = target.store(name)
    if append:
        dataset.to_zarr(store, append_dim="time", consolidated=True, zarr_format=2, write_empty_chunks=False)
        return
    encoding = {
        variable: {**encodings[variable], "chunks": tuple(chunks[dim] for dim in dataset[variable].dims)}
        for variable in dataset.data_vars
    }
    encoding["time"] = {**encodings["time"], "chunks": (TIME_COORDINATE_CHUNK,)}
    dataset.to_zarr(store, mode="w-", consolidated=True, zarr_format=2, encoding=encoding,
                    write_empty_chunks=False)


def append_chunks(existing: int, count: int, size: int) -> tuple[int, ...]:
    """Dask time chunks for appending `count` steps so each write fills exactly one store chunk."""
    first = min(count, (-existing) % size or size)
    rest = count - first
    return (first,) + (size,) * (rest // size) + ((rest % size,) if rest % size else ())


def parse_budget(value: str) -> float:
    units = {"s": 1, "m": 60, "h": 3600}
    if not value or value[-1] not in units or not value[:-1].replace(".", "", 1).isdigit():
        raise argparse.ArgumentTypeError("budget must look like 90m or 5h")
    return float(value[:-1]) * units[value[-1]]
