#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "boto3>=1.35",
#   "dask[array]>=2025.1",
#   "fsspec>=2025.3",
#   "h5py>=3.12",
#   "numcodecs>=0.15",
#   "numpy>=2.0",
#   "pyproj>=3.7",
#   "requests>=2.32",
#   "s3fs>=2025.3",
#   "scipy>=1.14",
#   "xarray>=2025.1",
#   "zarr>=3",
# ]
# ///
"""Alplakes Lake Geneva 3D hydrodynamic model (Eawag, Delft3D-Flow) → 3-hourly Zarr on the zartigl bucket.

Alplakes runs a Delft3D-Flow model of Lake Geneva every day and publishes its
raw output as one NetCDF4 file per week, starting on Sunday, with a step every
3 hours (the steps drift by 16 s; they are stamped at the nearest 3-hour slot).
The file holds every model variable on a curvilinear grid in Swiss
coordinates (CH1903 / LV03), about 1.9 GB a week. This pipeline reads only
the temperature and the two horizontal velocities of the days it stores, with
a few HTTP range requests a day, and writes one store with:

- `temperature` (time, depth, latitude, longitude): water temperature in degC;
- `u`, `v` (time, depth, latitude, longitude): eastward and northward water
  velocity in m/s, moved from the staggered velocity points to the cell
  centres and rotated from the grid axes (ALFAS) to east and north.

Depths are the centres of the model's z-layers below the reference level, as
the Alplakes API lists them, surface first. The grid is resampled to a
regular latitude/longitude grid by nearest neighbour (no blending of model
values); cells farther than `maxDistanceMeters` from an active model cell are
fill, which draws the shore.

The API is rate limited: every request (the HDF5 header included) goes
through one throttled session with a descriptive User-Agent, waits
`requestIntervalSeconds` after the previous one, and backs off on 429/503
(Retry-After first). A day is stored only once it is `settleDays` old, so no
forecast step enters the store; a stored step is never rewritten.

Usage:
  uv run scripts/to_zarr/eawag/alplakes_geneva/convert.py plan [--local DIR]
  uv run scripts/to_zarr/eawag/alplakes_geneva/convert.py run [--budget 5h] [--jobs 1] [--max-days N] [--local DIR]
  uv run scripts/to_zarr/eawag/alplakes_geneva/convert.py sync-geo [--budget 5h] [--force] [--local DIR]

Without --local, stores are written to `prefix` of the bucket configured in
.env.demo / .env / the environment (S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET).

Licence: Alplakes data are CC BY 4.0; credit "Data: Alplakes, Eawag (CC BY 4.0)"
and cite Baracchini et al. (2020), doi:10.1016/j.watres.2020.115529.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import io
import json
from pathlib import Path
import sys
import threading
import time
from typing import Any, Callable, Protocol

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import common  # noqa: E402
import contract  # noqa: E402
from common import Product  # noqa: E402

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
FILL = -32768
SCALES = {"temperature": 0.001, "u": 0.0001, "v": 0.0001}
SOURCE_FILL = -999.0
STEP = np.timedelta64(3, "h")
MAX_OFFSET = np.timedelta64(30, "m")
GRID_VARIABLES = ("XZ", "YZ", "ALFAS", "KCS", "KCU", "KCV", "DPS0", "ZK_LYR")
DATA_VARIABLES = ("R1", "U1", "V1")
# Cell centres (LV03 metres) are rewritten with float32 rounding that varies between weeks (3 cm seen from
# 2024-05-19): positions within this tolerance are the same grid. Masks, angles and layers must match exactly.
GRID_TOLERANCE_METERS = {"XZ": 1.0, "YZ": 1.0}
LICENSE = ("CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Data: Alplakes, Eawag. Cite Baracchini, T., "
           "Wüest, A., Bouffard, D. (2020) Meteolakes: An operational online three-dimensional forecasting "
           "platform for lake hydrodynamics. Water Research 172, 115529. Re-packaged by UNEP/GRID-Geneva.")


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text())


# --- Source access ------------------------------------------------------------------------------------------------


class Source(Protocol):
    def read(self, url: str, start: int, size: int) -> tuple[bytes, int] | None:
        """`size` bytes from `start` and the file size, or None when the file does not exist."""


class Throttle:
    """At most one request every `interval` seconds, across threads."""

    def __init__(self, interval: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.interval, self.clock, self.sleep = interval, clock, sleep
        self.lock = threading.Lock()
        self.last = -float("inf")

    def wait(self) -> None:
        with self.lock:
            pause = self.last + self.interval - self.clock()
            if pause > 0:
                self.sleep(pause)
            self.last = self.clock()


class HttpSource:
    """Range requests through one throttled session, backing off on 429 and 5xx answers."""

    RETRY = frozenset({429, 500, 502, 503, 504})

    def __init__(self, user_agent: str, interval: float, *, attempts: int = 6, max_wait: float = 300,
                 session: Any = None, sleep: Callable[[float], None] = time.sleep):
        import requests

        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = user_agent
        self.throttle = Throttle(interval, sleep=sleep)
        self.attempts, self.max_wait, self.sleep = attempts, max_wait, sleep
        self.requests = 0
        self.bytes = 0

    def backoff(self, response: Any, attempt: int) -> float:
        try:
            return min(self.max_wait, max(1.0, float(response.headers.get("Retry-After", ""))))
        except ValueError:
            return min(self.max_wait, 5.0 * 2 ** attempt)

    def read(self, url: str, start: int, size: int) -> tuple[bytes, int] | None:
        for attempt in range(self.attempts):
            self.throttle.wait()
            self.requests += 1
            response = self.session.get(url, headers={"Range": f"bytes={start}-{start + size - 1}"}, timeout=600)
            if response.status_code == 404:
                return None
            if response.status_code in self.RETRY:
                wait = self.backoff(response, attempt)
                print(f"HTTP {response.status_code} on {url}: waiting {wait:g} s", flush=True)
                self.sleep(wait)
                continue
            response.raise_for_status()
            if response.status_code != 206:
                raise RuntimeError(f"{url}: the server ignored the Range header (HTTP {response.status_code})")
            data = response.content
            total = int(response.headers["Content-Range"].rsplit("/", 1)[1])
            if len(data) != min(size, total - start):
                raise RuntimeError(f"{url}: got {len(data)} bytes from {start}, expected {size}")
            self.bytes += len(data)
            return data, total
        raise RuntimeError(f"{url}: still refused after {self.attempts} attempts")


class RangeFile(io.RawIOBase):
    """A read-only file over a Source, in cached blocks, for h5py to parse the HDF5 header."""

    def __init__(self, source: Source, url: str, block: int):
        self.source, self.url, self.block = source, url, block
        self.blocks: dict[int, bytes] = {}
        self.position = 0
        first = source.read(url, 0, block)
        if first is None:
            raise FileNotFoundError(url)
        self.blocks[0], self.size = first

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        self.position = base + offset
        return self.position

    def fetch(self, index: int) -> bytes:
        if index not in self.blocks:
            found = self.source.read(self.url, index * self.block, self.block)
            if found is None:
                raise FileNotFoundError(self.url)
            self.blocks[index] = found[0]
        return self.blocks[index]

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        end = min(self.position + len(view), self.size)
        written = 0
        while self.position < end:
            index, within = divmod(self.position, self.block)
            part = self.fetch(index)[within:within + end - self.position]
            view[written:written + len(part)] = part
            written += len(part)
            self.position += len(part)
        return written


# --- Week files ---------------------------------------------------------------------------------------------------


def week_start(day: date) -> date:
    """The Sunday that names the week file holding `day`."""
    return day - timedelta(days=(day.weekday() + 1) % 7)


def nominal_times(values: np.ndarray) -> np.ndarray:
    """Model times stamped at the nearest 3-hour slot; refused when one is more than 30 min away."""
    values = values.astype("datetime64[s]")
    origin = values.astype("datetime64[D]")
    step = STEP.astype("timedelta64[s]")
    slots = origin + np.round((values - origin) / step).astype(np.int64) * step
    if np.any(np.abs(values - slots) > MAX_OFFSET):
        raise RuntimeError(f"model times {values} are not on the 3-hour grid")
    return slots.astype("datetime64[ns]")


def decode_time(seconds: np.ndarray, units: str) -> np.ndarray:
    since = units.split("since", 1)[1].strip()
    if not units.startswith("seconds"):
        raise RuntimeError(f"time units {units!r}, expected seconds since …")
    return np.datetime64(since.replace(" ", "T"), "s") + seconds.astype(np.int64).astype("timedelta64[s]")


@dataclass
class Layout:
    """Where each time step of a variable lies in the file: one uncompressed block per step."""

    dtype: np.dtype
    shape: tuple[int, ...]
    offsets: list[int]

    @property
    def nbytes(self) -> int:
        return int(np.prod(self.shape)) * self.dtype.itemsize


@dataclass
class WeekIndex:
    times: np.ndarray
    grid: dict[str, np.ndarray]
    layouts: dict[str, Layout]


def layout(dataset: Any) -> Layout:
    if dataset.compression is not None or dataset.id.get_create_plist().get_nfilters():
        raise RuntimeError(f"{dataset.name} is filtered; the pipeline reads raw blocks")
    steps, step_shape = dataset.shape[0], dataset.shape[1:]
    nbytes = int(np.prod(step_shape)) * dataset.dtype.itemsize
    if dataset.chunks is None:
        start = dataset.id.get_offset()
        offsets = [start + index * nbytes for index in range(steps)]
    else:
        if dataset.chunks != (1, *step_shape):
            raise RuntimeError(f"{dataset.name}: chunks {dataset.chunks}, expected one time step per chunk")
        offsets = []
        for index in range(steps):
            info = dataset.id.get_chunk_info_by_coord((index,) + (0,) * len(step_shape))
            if info.size != nbytes or info.filter_mask:
                raise RuntimeError(f"{dataset.name}: step {index} is not a raw block")
            offsets.append(int(info.byte_offset))
    # The on-disk type, byte order included: blocks are decoded from the raw bytes.
    return Layout(np.dtype(dataset.id.get_type().dtype), tuple(step_shape), offsets)


def index_week(handle: Any) -> WeekIndex:
    import h5py

    with h5py.File(handle, "r") as source:
        grid = {name: source[name][...] for name in GRID_VARIABLES}
        units = source["time"].attrs["units"]
        units = units.decode() if isinstance(units, bytes) else str(units)
        times = nominal_times(decode_time(source["time"][...], units))
        layouts = {name: layout(source[name]) for name in DATA_VARIABLES}
    return WeekIndex(times, grid, layouts)


def coalesce(offsets: list[int], size: int, gap: int = 1 << 16) -> list[tuple[int, int, dict[int, int]]]:
    """Blocks merged into (start, length, {block position: offset in the read}) reads.

    Blocks at most `gap` bytes apart share a read: the bytes in between cost less than another request.
    """
    reads: list[tuple[int, int, dict[int, int]]] = []
    for position, offset in sorted(enumerate(offsets), key=lambda item: item[1]):
        if reads and 0 <= offset - (reads[-1][0] + reads[-1][1]) <= gap:
            start, _length, members = reads[-1]
            reads[-1] = (start, offset + size - start, {**members, position: offset - start})
        else:
            reads.append((offset, size, {position: 0}))
    return reads


@dataclass
class Day:
    times: np.ndarray
    grid: dict[str, np.ndarray]
    raw: dict[str, np.ndarray]


@dataclass
class Reader:
    """Week indexes and day reads through one Source; the grid must stay the one of the first week read."""

    config: dict[str, Any]
    source: Source
    today: Callable[[], date] = field(default=lambda: datetime.now(timezone.utc).date())
    weeks: dict[date, WeekIndex | None] = field(default_factory=dict)
    grid: dict[str, np.ndarray] | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def url(self, sunday: date) -> str:
        return self.config["sourceUrl"].format(sunday=f"{sunday:%Y%m%d}")

    def week(self, sunday: date) -> WeekIndex | None:
        with self.lock:
            if sunday not in self.weeks:
                try:
                    handle = RangeFile(self.source, self.url(sunday), int(self.config["headerBlockBytes"]))
                except FileNotFoundError:
                    return None
                index = index_week(handle)
                self.check_grid(sunday, index.grid)
                for old in sorted(self.weeks)[:-1]:
                    del self.weeks[old]
                self.weeks[sunday] = index
            return self.weeks[sunday]

    def check_grid(self, sunday: date, grid: dict[str, np.ndarray]) -> None:
        if self.grid is None:
            self.grid = grid
            return
        for name in GRID_VARIABLES:
            tolerance = GRID_TOLERANCE_METERS.get(name)
            same = (np.array_equal(grid[name], self.grid[name]) if tolerance is None else
                    grid[name].shape == self.grid[name].shape
                    and np.allclose(grid[name], self.grid[name], rtol=0, atol=tolerance, equal_nan=True))
            if not same:
                raise RuntimeError(f"week {sunday}: {name} differs from the first week read; "
                                   "a new model grid needs a new store version")

    def fetch_day(self, _config: dict[str, Any], day: date, _workdir: Path) -> Day | None:
        if day > self.today() - timedelta(days=int(self.config["settleDays"])):
            return None
        index = self.week(week_start(day))
        if index is None:
            return None
        steps = np.flatnonzero(index.times.astype("datetime64[D]") == np.datetime64(day))
        if steps.size != common.steps_per_day(self.config):
            return None
        raw = {}
        for name, place in index.layouts.items():
            blocks: list[np.ndarray | None] = [None] * steps.size
            for start, length, members in coalesce([place.offsets[step] for step in steps], place.nbytes):
                found = self.source.read(self.url(week_start(day)), start, length)
                if found is None:
                    raise RuntimeError(f"{self.url(week_start(day))} vanished while reading {day}")
                for member, within in members.items():
                    blocks[member] = np.frombuffer(found[0], dtype=place.dtype, count=int(np.prod(place.shape)),
                                                   offset=within).reshape(place.shape)
            raw[name] = np.stack(blocks)
        return Day(index.times[steps], index.grid, raw)


# --- Physics and grid ---------------------------------------------------------------------------------------------


def missing(values: np.ndarray) -> np.ndarray:
    return ~np.isfinite(values) | (values <= SOURCE_FILL + 1) | (np.abs(values) > 1e6)


def layers(zk: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Indexes of the layers below the reference level, surface first, and their depth (m, positive down)."""
    below = np.flatnonzero(zk < 0)
    order = below[np.argsort(-zk[below])]
    return order, np.round(-zk[order].astype(np.float64), 2)


def faces(values: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray]:
    """The flow through the faces before and after each cell along `axis` (−2: M, −1: N), and where any is open.

    Delft3D puts U1[m] on the face between cells m and m+1, so cell m lies between faces m−1 and m. A closed face
    (fill), and the face before the first cell, carry no flow.
    """
    open_ = ~missing(values)
    after = np.where(open_, values, 0.0).astype(np.float64)
    before = np.zeros_like(after)
    open_before = np.zeros_like(open_)
    target, source = [slice(None)] * after.ndim, [slice(None)] * after.ndim
    target[axis], source[axis] = slice(1, None), slice(None, -1)
    before[tuple(target)] = after[tuple(source)]
    open_before[tuple(target)] = open_[tuple(source)]
    return 0.5 * (before + after), open_ | open_before


def centred(u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Face velocities averaged to the cell centres, NaN where no face of the cell is open (as the Alplakes API)."""
    u_centre, u_open = faces(u, axis=-2)
    v_centre, v_open = faces(v, axis=-1)
    wet = u_open | v_open
    return np.where(wet, u_centre, np.nan), np.where(wet, v_centre, np.nan)


def rotate(u: np.ndarray, v: np.ndarray, alfas: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Grid-axis velocities to east and north: ALFAS is the angle of the ξ axis from the x axis, counter-clockwise."""
    angle = np.deg2rad(alfas.astype(np.float64))
    cos, sin = np.cos(angle), np.sin(angle)
    return (u * cos - v * sin).astype(np.float32), (u * sin + v * cos).astype(np.float32)


def physical(day: Day) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Temperature and east/north velocity per (time, depth, M, N), NaN outside the water; and the depths."""
    grid = day.grid
    active = grid["KCS"] == 1
    order, depth = layers(grid["ZK_LYR"])
    temperature = day.raw["R1"][:, 0].astype(np.float32)
    temperature = np.where(missing(temperature) | ~active, np.nan, temperature)
    east, north = rotate(*centred(day.raw["U1"], day.raw["V1"]), grid["ALFAS"])
    wet = np.isfinite(temperature)
    fields = {
        "temperature": temperature[:, order],
        "u": np.where(wet, east, np.nan)[:, order],
        "v": np.where(wet, north, np.nan)[:, order],
    }
    return fields, depth


def axes(config: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    grid = config["grid"]
    latitude = np.round(grid["south"] + grid["dlat"] * np.arange(grid["nlat"]), 6)
    longitude = np.round(grid["west"] + grid["dlon"] * np.arange(grid["nlon"]), 6)
    return latitude, longitude


@dataclass
class Regridder:
    """Nearest active model cell of each regular cell centre, within `maxDistanceMeters`; fill beyond."""

    latitude: np.ndarray
    longitude: np.ndarray
    rows: np.ndarray
    cols: np.ndarray
    valid: np.ndarray

    @classmethod
    def build(cls, config: dict[str, Any], grid: dict[str, np.ndarray]) -> Regridder:
        from pyproj import Transformer
        from scipy.spatial import cKDTree

        latitude, longitude = axes(config)
        lon, lat = np.meshgrid(longitude, latitude)
        to_swiss = Transformer.from_crs("EPSG:4326", config["crs"], always_xy=True)
        x, y = to_swiss.transform(lon.ravel(), lat.ravel())
        active = np.argwhere(grid["KCS"] == 1)
        tree = cKDTree(np.column_stack([grid["XZ"][active[:, 0], active[:, 1]],
                                        grid["YZ"][active[:, 0], active[:, 1]]]))
        distance, nearest = tree.query(np.column_stack([x, y]))
        shape = lat.shape
        return cls(latitude, longitude, active[nearest, 0].reshape(shape), active[nearest, 1].reshape(shape),
                   (distance <= config["maxDistanceMeters"]).reshape(shape))

    def apply(self, values: np.ndarray) -> np.ndarray:
        return np.where(self.valid, values[..., self.rows, self.cols], np.nan).astype(np.float32)


# --- Store --------------------------------------------------------------------------------------------------------


def history_line() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (f"{stamp}: Alplakes delft3d-flow geneva weekly files; R1 (temperature), U1/V1 averaged to the cell "
            "centres and rotated by ALFAS to east/north; layers below the reference level, surface first; "
            "nearest-neighbour resampling from CH1903/LV03 to a regular latitude/longitude grid; "
            "by zartigl scripts/to_zarr/eawag/alplakes_geneva")


def dataset(fields: dict[str, np.ndarray], depth: np.ndarray, times: np.ndarray, regridder: Regridder) -> xr.Dataset:
    long_names = {
        "temperature": ("Lake water temperature (Alplakes Delft3D model)", "degC"),
        "u": ("Eastward lake water velocity (Alplakes Delft3D model)", "m s-1"),
        "v": ("Northward lake water velocity (Alplakes Delft3D model)", "m s-1"),
    }
    result = xr.Dataset(
        {name: (contract.DEPTH_DIMS, regridder.apply(values), {"long_name": long_names[name][0],
                                                               "units": long_names[name][1]})
         for name, values in fields.items()},
        coords={"time": times, "depth": depth, "latitude": regridder.latitude, "longitude": regridder.longitude},
    )
    result["u"].attrs["comment"] = result["v"].attrs["comment"] = (
        "Mean of the two staggered faces of each cell, rotated from the model grid axes to east and north")
    result["depth"].attrs = {"standard_name": "depth", "long_name": "Depth of the model layer centre below the "
                             "reference level", "units": "m", "positive": "down"}
    result["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    result["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    result.attrs = {
        "title": "Lake Geneva water temperature and currents, 3-hourly, Alplakes Delft3D-Flow model",
        "source": "Alplakes (Eawag), delft3d-flow geneva simulations, "
                  "https://alplakes-api.eawag.ch/simulations/file/delft3d-flow/geneva/<sunday>",
        "license": LICENSE,
        "history": history_line(),
        "comment": "Model output, not observations; forecast steps are not stored. "
                   "Steps stamped at the nearest 3-hour slot (UTC). Nearest-neighbour resampling of the "
                   "curvilinear model grid; cells farther than the model resolution from an active model cell are fill.",
        "references": "https://www.alplakes.eawag.ch; Baracchini et al. (2020) doi:10.1016/j.watres.2020.115529",
    }
    return result


def encodings(names: list[str]) -> dict[str, dict[str, Any]]:
    from numcodecs import Blosc

    compressor = Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE)
    result: dict[str, dict[str, Any]] = {
        "time": {"units": "hours since 2018-12-30 00:00:00", "calendar": "standard", "dtype": "int32"},
    }
    for name in names:
        result[name] = {"dtype": "int16", "_FillValue": FILL, "scale_factor": SCALES[name],
                        "compressors": (compressor,)}
    return result


def to_store(data: xr.Dataset) -> tuple[xr.Dataset, dict[str, dict[str, Any]]]:
    for name in data.data_vars:
        limit = 32767 * SCALES[name]
        if np.nanmax(np.abs(data[name].values), initial=0) >= limit:
            raise RuntimeError(f"{name} beyond ±{limit:g}: the int16 packing would overflow")
    return data, encodings(list(data.data_vars))


def product(config: dict[str, Any], source: Source | None = None,
            today: Callable[[], date] | None = None) -> Product:
    source = source or HttpSource(config["userAgent"], float(config["requestIntervalSeconds"]))
    reader = Reader(config, source, **({"today": today} if today else {}))
    regridders: dict[int, Regridder] = {}

    def read_day(day: Day, _day: date) -> xr.Dataset:
        key = id(reader.grid)
        if key not in regridders:
            regridders[key] = Regridder.build(config, day.grid)
        fields, depth = physical(day)
        return dataset(fields, depth, day.times, regridders[key])

    return Product("alplakes-geneva", fetch_day=reader.fetch_day, read_day=read_day, to_store=to_store)


def main() -> None:
    common.main(__doc__, CONFIG_PATH, product)


if __name__ == "__main__":
    main()
