#!/usr/bin/env python3
"""
Download a single-timestep, surface-level global subset of Copernicus Marine
ocean current data (uo/vo) and save it as a Zarr v2 store for the zartigl demo.

Usage:
    cd scripts/
    uv run subset_zarr.py

Output: ../public/data/  (Zarr v2 store with consolidated metadata)

Prerequisites:
    - Copernicus Marine account (free): https://data.marine.copernicus.eu/register
    - Set credentials via: copernicusmarine login
      (or env vars COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD)
"""

from pathlib import Path

import copernicusmarine
import xarray as xr
import zarr
import numpy as np

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data"

DATASET_ID = "cmems_mod_glo_phy-cur_anfc_0.083deg_PT6H-i"
VARIABLES = ["uo", "vo"]


def main():
    print("Downloading latest surface current data from Copernicus Marine...")

    ds = copernicusmarine.open_dataset(
        dataset_id=DATASET_ID,
        variables=VARIABLES,
        minimum_depth=0.0,
        maximum_depth=0.5,
    )

    # Take the most recent timestep only
    latest_time = ds.time.values[-1]
    ds = ds.sel(time=[latest_time])

    print(f"  Time: {latest_time}")
    print(f"  Depth levels: {ds.depth.values}")
    print(f"  Lat range: {float(ds.latitude.min()):.2f} to {float(ds.latitude.max()):.2f}")
    print(f"  Lon range: {float(ds.longitude.min()):.2f} to {float(ds.longitude.max()):.2f}")
    print(f"  Grid size: {ds.sizes['latitude']} x {ds.sizes['longitude']}")

    # Coarsen to ~0.25° to keep the store small for GitHub Pages
    # Original is ~0.083° (4320x2041), coarsen by 3 → ~0.25° (1440x680)
    coarsen_factor = 3
    ds = ds.coarsen(
        latitude=coarsen_factor,
        longitude=coarsen_factor,
        boundary="trim",
    ).mean()

    print(f"  Coarsened grid: {ds.sizes['latitude']} x {ds.sizes['longitude']}")

    # Ensure float32 for compact storage
    for var in VARIABLES:
        ds[var] = ds[var].astype(np.float32)

    # Also ensure coordinate arrays are float32 (except time)
    ds["latitude"] = ds["latitude"].astype(np.float32)
    ds["longitude"] = ds["longitude"].astype(np.float32)
    ds["depth"] = ds["depth"].astype(np.float32)

    # Write as Zarr v2 with consolidated metadata
    if OUTPUT_DIR.exists():
        import shutil
        shutil.rmtree(OUTPUT_DIR)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Rechunk for browser-friendly sizes, then compute to avoid dask/zarr conflicts
    chunk_sizes = {
        "time": 1,
        "depth": 1,
        "latitude": 170,
        "longitude": 240,
    }
    ds = ds.chunk(chunk_sizes).compute()

    # Use zlib compressor (supported by zartigl's browser-side ZarrSource)
    import numcodecs
    compressor = numcodecs.Zlib(level=5)

    # Build encoding for all variables (data + coordinates)
    encoding = {}
    for name in list(VARIABLES) + ["time", "depth", "latitude", "longitude"]:
        if name not in ds:
            continue
        enc = {"compressor": compressor}
        if name in VARIABLES:
            enc["chunks"] = tuple(
                chunk_sizes.get(d, s) for d, s in zip(ds[name].dims, ds[name].shape)
            )
        encoding[name] = enc

    ds.to_zarr(
        str(OUTPUT_DIR),
        mode="w",
        consolidated=True,
        encoding=encoding,
    )

    # Verify
    store = zarr.open(str(OUTPUT_DIR), mode="r")
    total_bytes = sum(
        Path(p).stat().st_size
        for p in OUTPUT_DIR.rglob("*")
        if p.is_file()
    )
    print(f"\nZarr store written to: {OUTPUT_DIR}")
    print(f"Total size: {total_bytes / 1024 / 1024:.1f} MB")
    print(f"Variables: {list(store.keys())}")
    print("Done!")


if __name__ == "__main__":
    main()
