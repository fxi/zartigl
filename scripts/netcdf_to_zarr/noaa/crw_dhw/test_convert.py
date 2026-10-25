import argparse
from datetime import date, timedelta
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import convert  # noqa: E402
from common import append_chunks, local_target, open_store, stored_times  # noqa: E402

LAT = np.array([2.5, 1.5, 0.5, -0.5, -1.5, -2.5], dtype=np.float32)
LON = np.array([-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5], dtype=np.float32)
FAMILIES = {
    "degree_heating_week": ("dhw", np.int16, -32768, 0.01),
    "bleaching_alert_area": ("baa", np.uint8, 251, 1),
    "sea_surface_temperature_anomaly": ("ssta", np.int16, -32768, 0.01),
    "hotspot": ("hs", np.int16, -32768, 0.01),
}


def config(start: date) -> dict:
    return {
        **convert.load_config(),
        "start": start.isoformat(),
        "stores": {
            "timeChunked": {"time": 1, "latitude": 3, "longitude": 4},
            "geoChunked": {"time": 3, "latitude": 3, "longitude": 4},
        },
        "geoSyncMinLagDays": 2,
    }


def raw_values(name: str, day: date) -> np.ndarray:
    """Distinct per day and pixel; the north-west pixel is land (fill)."""
    _, dtype, fill, _ = FAMILIES[name]
    values = (np.arange(LAT.size * LON.size).reshape(LAT.size, LON.size) + day.toordinal() % 50).astype(dtype)
    if name == "bleaching_alert_area":
        values = values % 5
    values[0, 0] = fill
    return values


def write_crw_file(directory: Path, name: str, day: date) -> Path:
    family, dtype, fill, scale = FAMILIES[name]
    seconds = int((np.datetime64(day.isoformat()) - np.datetime64("1981-01-01")) / np.timedelta64(1, "s")) + 43200
    attrs = {"_FillValue": dtype(fill), "units": "u", "long_name": name, "valid_min": dtype(0), "valid_max": dtype(4)}
    attrs["scale_factor"] = np.float64(scale) if scale != 1 else np.int64(1)
    dataset = xr.Dataset(
        {
            name: (("time", "lat", "lon"), raw_values(name, day)[None], attrs),
            "mask": (("time", "lat", "lon"), np.zeros((1, LAT.size, LON.size), np.uint8)),
            "crs": ((), np.int16(0)),
        },
        coords={
            "time": ("time", np.array([seconds], np.int32), {"units": "seconds since 1981-01-01 00:00:00"}),
            "lat": LAT,
            "lon": LON,
        },
        attrs={"title": "CRW test", "license": "public"},
    )
    path = directory / f"{family}_{day:%Y%m%d}.nc"
    for variable in dataset.variables.values():
        variable.encoding = {}
    dataset.to_netcdf(path, engine="netcdf4", encoding={name: {"_FillValue": None}})
    return path


def fake_fetch(_config, day, directory):
    return {name: write_crw_file(directory, name, day) for name in FAMILIES}


def cached_fetch(cache: Path):
    """fetch_day over pre-written files: HDF5 is not thread-safe, and fetch_day runs in worker threads."""
    def fetch(_config, day, directory):
        return {name: Path(shutil.copy(cache / f"{FAMILIES[name][0]}_{day:%Y%m%d}.nc", directory)) for name in FAMILIES}
    return fetch


def args(directory: Path, **extra) -> argparse.Namespace:
    return argparse.Namespace(**{"local": str(directory), "budget": 3600.0, "jobs": 2, "max_days": None, "force": False, **extra})


class PureFunctionsTest(unittest.TestCase):
    def test_pending_days_continue_after_last_stored_day(self):
        stored = np.array(["2024-03-01T12:00", "2024-03-02T12:00"], dtype="datetime64[ns]")
        self.assertEqual(convert.pending_days(stored, date(2024, 1, 1), date(2024, 3, 5)),
                         [date(2024, 3, 3), date(2024, 3, 4)])
        self.assertEqual(convert.pending_days(np.array([], "datetime64[ns]"), date(2024, 3, 3), date(2024, 3, 4)),
                         [date(2024, 3, 3)])

    def test_append_chunks_fill_the_open_chunk_first(self):
        self.assertEqual(append_chunks(0, 7, 3), (3, 3, 1))
        self.assertEqual(append_chunks(5, 7, 3), (1, 3, 3))
        self.assertEqual(append_chunks(4, 1, 3), (1,))

    def test_source_url(self):
        self.assertTrue(convert.source_url(convert.load_config(), "dhw", date(2024, 3, 15))
                        .endswith("/daily/dhw/2024/ct5km_dhw_v3.1_20240315.nc"))


class ReadDayTest(unittest.TestCase):
    def test_latitude_ascends_and_values_decode(self):
        with tempfile.TemporaryDirectory() as tmp:
            day = date(2024, 3, 15)
            dataset = convert.read_day(fake_fetch(None, day, Path(tmp)))
        self.assertEqual(dataset["degree_heating_week"].dims, ("time", "latitude", "longitude"))
        self.assertTrue(np.all(np.diff(dataset["latitude"].values) > 0))
        self.assertNotIn("mask", dataset)
        dhw = dataset["degree_heating_week"].values[0]
        expected = raw_values("degree_heating_week", day)[::-1].astype(np.float32) * np.float32(0.01)
        # The land pixel was north-west; after the flip it is the last row.
        self.assertTrue(np.isnan(dhw[-1, 0]))
        np.testing.assert_allclose(dhw[:-1], expected[:-1], rtol=1e-6)
        alert = dataset["bleaching_alert_area"].values[0]
        self.assertTrue(np.isnan(alert[-1, 0]))
        self.assertAlmostEqual(dataset["degree_heating_week"].attrs["valid_max"], 0.04)
        self.assertEqual(dataset.attrs["license"], "public")


class PipelineTest(unittest.TestCase):
    def test_run_appends_without_duplicates_and_geo_store_follows(self):
        start = date.today() - timedelta(days=30)
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "cache"
            cache.mkdir()
            for offset in range(8):
                fake_fetch(None, start + timedelta(days=offset), cache)
            stack = mock.patch.object(convert, "fetch_day", cached_fetch(cache))
            stack.start()
            self.addCleanup(stack.stop)
            out = Path(tmp) / "out"
            settings = config(start)
            convert.run(args(out, max_days=5), settings)
            convert.run(args(out, max_days=2), settings)
            target = local_target(out)
            times = stored_times(target, "timeChunked")
            self.assertEqual(times.size, 7)
            self.assertEqual(np.unique(times).size, 7)
            self.assertEqual(convert.as_day(times[0]), start)

            convert.sync_geo(args(out), settings)
            convert.run(args(out, max_days=1), settings)
            # One day of lag is below geoSyncMinLagDays.
            convert.sync_geo(args(out), settings)
            self.assertEqual(stored_times(target, "geoChunked").size, 7)
            convert.sync_geo(args(out), {**settings, "geoSyncMinLagDays": 1})

            time_store = open_store(target, "timeChunked").load()
            geo_store = open_store(target, "geoChunked").load()
            xr.testing.assert_identical(time_store, geo_store)
            self.assertEqual(open_store(target, "geoChunked")["hotspot"].encoding["chunks"], (3, 3, 4))
            # The browser decodes integer coordinates through float32.
            hours = xr.open_zarr(target.store("timeChunked"), decode_times=False)["time"]
            self.assertTrue(hours.attrs["units"].startswith("hours since"))
            np.testing.assert_array_equal(hours.values.astype(np.float32), hours.values)
            raw = open_store(target, "timeChunked", decode=False)["degree_heating_week"]
            self.assertEqual(raw.dtype, np.int16)
            day = convert.as_day(time_store["time"].values[2])
            np.testing.assert_array_equal(raw.values[2, :-1], raw_values("degree_heating_week", day)[::-1][:-1])


if __name__ == "__main__":
    unittest.main()
