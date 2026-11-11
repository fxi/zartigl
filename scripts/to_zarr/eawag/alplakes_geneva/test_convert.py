import argparse
from datetime import date, timedelta
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import common  # noqa: E402
import contract  # noqa: E402
import convert  # noqa: E402

SUNDAY = date(2025, 11, 2)
M, N = 6, 4
ZK = np.array([-40.0, -20.0, -10.0, -2.0, 0.5], np.float32)  # bottom first; the last layer is above the datum
ANGLE = 30.0
SPACING = 400.0
EAST = 0.1  # m/s of the uniform eastward flow written in grid axes
STEP_SECONDS = 10816  # the model's 3-hour step drifts by 16 s


def grid(shift: float = 0.0) -> dict[str, np.ndarray]:
    """A curvilinear grid rotated by ANGLE near Geneva in LV03; cell (0, 3) is land."""
    m, n = np.meshgrid(np.arange(M), np.arange(N), indexing="ij")
    a = np.radians(ANGLE)
    kcs = np.ones((M, N), np.int32)
    kcs[0, 3] = 0
    return {
        "XZ": (500000 + shift + SPACING * (m * np.cos(a) - n * np.sin(a))).astype(np.float64),
        "YZ": (118000 + SPACING * (m * np.sin(a) + n * np.cos(a))).astype(np.float64),
        "ALFAS": np.full((M, N), ANGLE, np.float32),
        "KCS": kcs,
        "KCU": np.ones((M, N), np.int32),
        "KCV": np.ones((M, N), np.int32),
        "DPS0": np.full((M, N), 40.0, np.float32),
        "ZK_LYR": ZK,
    }


def temperature(step: int) -> np.ndarray:
    """(layer, M, N): warmer upwards and with time; the deepest layer is below the bed in row m = 5."""
    values = np.empty((ZK.size, M, N), np.float32)
    for layer in range(ZK.size):
        values[layer] = 5 + layer + 0.01 * step + 0.001 * np.arange(M * N).reshape(M, N)
    values[0, 5, :] = -999.0
    values[:, 0, 3] = -999.0
    return values


def velocities() -> tuple[np.ndarray, np.ndarray]:
    """A uniform eastward EAST m/s, in the grid axes (ξ rotated by ANGLE from east); the land cell's faces closed."""
    a = np.radians(ANGLE)
    u = np.full((ZK.size, M, N), EAST * np.cos(a), np.float32)
    v = np.full((ZK.size, M, N), -EAST * np.sin(a), np.float32)
    u[:, 0, 3] = v[:, 0, 3] = -999.0
    return u, v


def write_week(path: Path, sunday: date, *, shift: float = 0.0) -> Path:
    import h5py

    steps = 56
    with h5py.File(path, "w") as out:
        for name, values in grid(shift).items():
            out.create_dataset(name, data=values)
        origin = (np.datetime64(sunday) - np.datetime64("2008-03-01")) / np.timedelta64(1, "s")
        seconds = origin + STEP_SECONDS * np.arange(steps)
        out.create_dataset("time", data=seconds.astype(np.float64))
        out["time"].attrs["units"] = b"seconds since 2008-03-01 00:00:00"
        r1 = out.create_dataset("R1", (steps, 1, ZK.size, M, N), np.float32, chunks=(1, 1, ZK.size, M, N))
        u1 = out.create_dataset("U1", (steps, ZK.size, M, N), np.float32, chunks=(1, ZK.size, M, N))
        v1 = out.create_dataset("V1", (steps, ZK.size, M, N), np.float32, chunks=(1, ZK.size, M, N))
        u, v = velocities()
        for step in range(steps):
            r1[step, 0] = temperature(step)
            u1[step], v1[step] = u, v
    return path


class LocalSource:
    """Range reads from files named by URL, counting requests."""

    def __init__(self, files: dict[str, Path]):
        self.files = files
        self.requests = 0

    def read(self, url: str, start: int, size: int):
        self.requests += 1
        path = self.files.get(url)
        if path is None:
            return None
        data = path.read_bytes()
        return data[start:start + size], len(data)


def lonlat() -> tuple[np.ndarray, np.ndarray]:
    from pyproj import Transformer

    g = grid()
    return Transformer.from_crs("EPSG:21781", "EPSG:4326", always_xy=True).transform(g["XZ"], g["YZ"])


def config(start: date = SUNDAY) -> dict:
    lon, lat = lonlat()
    step = 0.002
    west, south = float(lon.min()) - step, float(lat.min()) - step
    return {
        **convert.load_config(),
        "start": start.isoformat(),
        "headerBlockBytes": 4096,
        "grid": {"west": west, "south": south, "dlon": step, "dlat": step,
                 "nlon": int((lon.max() - west) / step) + 3, "nlat": int((lat.max() - south) / step) + 3},
        "maxDistanceMeters": 300,
        "stores": {
            "timeChunked": {"time": 1, "depth": 4, "latitude": 8, "longitude": 8},
            "geoChunked": {"time": 8, "depth": 1, "latitude": 4, "longitude": 4},
        },
        "geoSyncMinLagDays": 1,
    }


class Fixture(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="alplakes-test-"))
        self.config = config()
        self.url = self.config["sourceUrl"].format(sunday=f"{SUNDAY:%Y%m%d}")
        self.source = LocalSource({self.url: write_week(self.directory / "week.nc", SUNDAY)})

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def reader(self, today: date = date(2025, 12, 1)) -> convert.Reader:
        return convert.Reader(self.config, self.source, today=lambda: today)


class WeekTest(Fixture):
    def test_week_start_is_the_sunday_before(self):
        self.assertEqual(convert.week_start(date(2025, 11, 5)), SUNDAY)
        self.assertEqual(convert.week_start(SUNDAY), SUNDAY)
        self.assertEqual(convert.week_start(date(2025, 11, 8)), SUNDAY)

    def test_drifting_steps_are_stamped_at_their_slot(self):
        seconds = np.arange(56) * STEP_SECONDS
        times = convert.nominal_times(np.datetime64("2025-11-02") + seconds.astype("timedelta64[s]"))
        self.assertEqual(times[-1], np.datetime64("2025-11-08T21:00", "ns"))
        self.assertTrue(np.all(np.diff(times) == np.timedelta64(3, "h")))

    def test_a_step_off_the_grid_is_refused(self):
        with self.assertRaises(RuntimeError):
            convert.nominal_times(np.array(["2025-11-02T01:31"], "datetime64[s]"))

    def test_close_blocks_share_a_read(self):
        reads = convert.coalesce([100, 0, 210, 10_000_000], 100, gap=16)
        self.assertEqual(reads, [(0, 310, {1: 0, 0: 100, 2: 210}), (10_000_000, 100, {3: 0})])

    def test_index_reads_the_layout_and_times(self):
        index = self.reader().week(SUNDAY)
        self.assertEqual(index.times[0], np.datetime64("2025-11-02", "ns"))
        self.assertEqual(index.layouts["R1"].shape, (1, ZK.size, M, N))
        self.assertEqual(len(index.layouts["U1"].offsets), 56)

    def test_a_day_is_read_in_few_requests(self):
        reader = self.reader()
        reader.week(SUNDAY)
        before = self.source.requests
        day = reader.fetch_day(self.config, date(2025, 11, 4), self.directory)
        self.assertLessEqual(self.source.requests - before, 3)
        self.assertEqual(day.raw["R1"].shape, (8, 1, ZK.size, M, N))
        np.testing.assert_array_equal(day.raw["R1"][0, 0], temperature(16))

    def test_recent_days_are_not_read(self):
        reader = self.reader(today=date(2025, 11, 5))
        self.assertIsNone(reader.fetch_day(self.config, date(2025, 11, 4), self.directory))
        self.assertEqual(self.source.requests, 0)

    def test_a_missing_week_is_not_published(self):
        self.assertIsNone(self.reader().fetch_day(self.config, date(2025, 11, 10), self.directory))

    def test_a_new_model_grid_is_refused(self):
        later = SUNDAY + timedelta(days=7)
        url = self.config["sourceUrl"].format(sunday=f"{later:%Y%m%d}")
        self.source.files[url] = write_week(self.directory / "moved.nc", later, shift=50.0)
        reader = self.reader()
        reader.week(SUNDAY)
        with self.assertRaises(RuntimeError):
            reader.week(later)


class PhysicsTest(Fixture):
    def day(self) -> convert.Day:
        return self.reader().fetch_day(self.config, date(2025, 11, 4), self.directory)

    def test_layers_above_the_datum_are_dropped_surface_first(self):
        order, depth = convert.layers(ZK)
        np.testing.assert_array_equal(depth, [2.0, 10.0, 20.0, 40.0])
        np.testing.assert_array_equal(order, [3, 2, 1, 0])

    def test_fill_below_the_bed_and_on_land(self):
        fields, _depth = convert.physical(self.day())
        self.assertTrue(np.isnan(fields["temperature"][0, 3, 5]).all())  # 40 m in row 5: below the bed
        self.assertTrue(np.isnan(fields["temperature"][:, :, 0, 3]).all())  # land
        self.assertTrue(np.isnan(fields["u"][:, :, 0, 3]).all())
        self.assertAlmostEqual(float(fields["temperature"][0, 0, 2, 1]), temperature(16)[3, 2, 1], places=5)

    def test_velocities_are_centred_and_rotated_to_east_and_north(self):
        fields, _depth = convert.physical(self.day())
        interior = (slice(None), slice(None), slice(2, None), slice(1, None))  # away from the land cell's closed faces
        np.testing.assert_allclose(fields["u"][interior][np.isfinite(fields["u"][interior])], EAST, atol=1e-6)
        np.testing.assert_allclose(fields["v"][interior][np.isfinite(fields["v"][interior])], 0.0, atol=1e-6)

    def test_closed_faces_carry_no_flow(self):
        u = np.array([[1.0, 1.0, -999.0]]).T  # faces after cells 0, 1, 2 along M
        centre, open_ = convert.faces(u[None], axis=-2)
        np.testing.assert_allclose(centre[0, :, 0], [0.5, 1.0, 0.5])
        self.assertTrue(open_.all())

    def test_regridding_keeps_model_values_and_fills_away_from_cells(self):
        day = self.day()
        regridder = convert.Regridder.build(self.config, day.grid)
        fields, _depth = convert.physical(day)
        out = regridder.apply(fields["temperature"])
        self.assertTrue(np.isnan(out[..., 0, 0]).all())  # the south-west corner is away from the rotated grid
        valid = out[0, 0][np.isfinite(out[0, 0])]
        self.assertTrue(np.isin(valid, fields["temperature"][0, 0]).all())


class HttpTest(unittest.TestCase):
    class Response:
        def __init__(self, status, body=b"", headers=None):
            self.status_code, self.content, self.headers = status, body, headers or {}

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(self.status_code)

    class Session:
        def __init__(self, responses):
            self.responses, self.headers, self.calls = list(responses), {}, []

        def get(self, url, headers, timeout):
            self.calls.append(headers["Range"])
            return self.responses.pop(0)

    def source(self, *responses):
        self.waits = []
        session = self.Session(responses)
        return convert.HttpSource("test-agent", 0, session=session, sleep=self.waits.append), session

    def test_waits_as_told_on_429_then_reads(self):
        source, session = self.source(self.Response(429, headers={"Retry-After": "7"}),
                                      self.Response(206, b"abcd", {"Content-Range": "bytes 10-13/100"}))
        self.assertEqual(source.read("u", 10, 4), (b"abcd", 100))
        self.assertEqual(session.headers["User-Agent"], "test-agent")
        self.assertEqual(session.calls, ["bytes=10-13", "bytes=10-13"])
        self.assertIn(7.0, self.waits)

    def test_backs_off_without_retry_after_and_gives_up(self):
        source, _session = self.source(*[self.Response(503)] * 6)
        with self.assertRaises(RuntimeError):
            source.read("u", 0, 4)
        self.assertEqual([wait for wait in self.waits if wait >= 5], [5.0, 10.0, 20.0, 40.0, 80.0, 160.0])

    def test_404_is_not_published_and_a_full_answer_is_refused(self):
        source, _session = self.source(self.Response(404), self.Response(200, b"x"))
        self.assertIsNone(source.read("u", 0, 4))
        with self.assertRaises(RuntimeError):
            source.read("u", 0, 4)

    def test_requests_are_spaced(self):
        clock = iter([0.0, 0.0, 0.5, 2.0])
        waits = []
        throttle = convert.Throttle(2.0, clock=lambda: next(clock), sleep=waits.append)
        throttle.wait()
        throttle.wait()
        self.assertEqual(waits, [1.5])


class RunTest(Fixture):
    def args(self, **values):
        defaults = {"local": str(self.directory / "stores"), "max_days": None, "budget": float("inf"),
                    "jobs": 1, "force": True}
        return argparse.Namespace(**{**defaults, **values})

    def test_run_writes_contract_stores_and_sync_geo_follows(self):
        product = convert.product(self.config, source=self.source, today=lambda: date(2025, 12, 1))
        common.run(self.args(max_days=3), self.config, product)  # common.run lists days up to the real today
        common.sync_geo(self.args(), self.config)
        target = common.local_target(self.directory / "stores")
        for name in common.STORE_NAMES:
            store = common.open_store(target, name)
            self.assertEqual(contract.problems(store), [])
            self.assertEqual(store["temperature"].dims, contract.DEPTH_DIMS)
            self.assertEqual(store["depth"].attrs["positive"], "down")
            np.testing.assert_array_equal(store["depth"].values, [2.0, 10.0, 20.0, 40.0])
            self.assertEqual(store.sizes["time"], 24)
        store = common.open_store(target, "timeChunked")
        self.assertEqual(store["time"].values[-1], np.datetime64("2025-11-04T21:00", "ns"))
        raw = xr.open_zarr(target.store("timeChunked"), consolidated=True, zarr_format=2, decode_times=False)
        self.assertTrue(raw["time"].attrs["units"].startswith("hours since"))
        surface = store["temperature"].isel(time=0, depth=0).values
        self.assertTrue(np.isfinite(surface).any())
        self.assertTrue(np.isnan(surface).any())
        speed = np.hypot(store["u"].isel(time=0).values, store["v"].isel(time=0).values)
        self.assertLessEqual(float(np.nanmax(speed)), EAST + 1e-3)

    def test_an_interrupted_run_catches_up(self):
        product = convert.product(self.config, source=self.source, today=lambda: date(2025, 12, 1))
        common.run(self.args(max_days=1), self.config, product)
        common.run(self.args(max_days=2), self.config, product)
        store = common.open_store(common.local_target(self.directory / "stores"), "timeChunked")
        times = store["time"].values
        self.assertEqual(times.size, 24)
        self.assertTrue(np.all(np.diff(times) == np.timedelta64(3, "h")))


if __name__ == "__main__":
    unittest.main()
