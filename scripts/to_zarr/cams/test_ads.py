import argparse
from datetime import date, timedelta
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import zipfile

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ads  # noqa: E402
from common import local_target, open_store, stored_times, sync_geo, run  # noqa: E402

HERE = Path(__file__).resolve().parent
# Coarse grids in the provider layout: latitude descending, longitude 0…360.
LAT = np.array([60.0, 20.0, -20.0, -60.0])
LON = np.array([0.0, 90.0, 180.0, 270.0])
GRID = {"latitude": [-60, 60, 4], "longitude": [-180, 90, 4]}


def gfas_config(start: date) -> dict:
    config = ads.load_config(HERE / "gfas" / "config.json")
    return {
        **config,
        "variables": {name: config["variables"][name] for name in ("frpfire", "offire", "apt")},
        "grid": GRID,
        "start": start.isoformat(),
        "requestDays": 3,
        "stores": {"timeChunked": {"time": 1, "latitude": 2, "longitude": 4},
                   "geoChunked": {"time": 4, "latitude": 2, "longitude": 2}},
        "geoSyncMinLagDays": 1,
    }


def forecast_config(start: date) -> dict:
    config = ads.load_config(HERE / "global_forecast" / "config.json")
    return {
        **config,
        "variables": {name: config["variables"][name] for name in ("pm2p5", "gtco3", "t2m")},
        "grid": GRID,
        "start": start.isoformat(),
        "requestDays": 2,
        "stores": {"timeChunked": {"time": 1, "latitude": 4, "longitude": 4},
                   "geoChunked": {"time": 16, "latitude": 2, "longitude": 2}},
        "geoSyncMinLagDays": 1,
    }


def field(day: date, step: int, offset: float = 0) -> np.ndarray:
    """Distinct per day, step and pixel; the north-west pixel (lon 270) is zero."""
    values = np.arange(LAT.size * LON.size, dtype=np.float32).reshape(LAT.size, LON.size) + 1
    values = values + (day.toordinal() % 7) * 100 + step + offset
    values[0, 3] = 0
    return values


def write_gfas(config: dict, first: date, last: date, path: Path) -> None:
    """Daily means stamped at the end of their window, D+1 00:00, as ADS does."""
    days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
    names = [spec["source"] for spec in config["variables"].values()]
    dataset = xr.Dataset(
        {name: (("valid_time", "latitude", "longitude"), np.stack([field(day, 0, index) * 1e-3 for day in days]))
         for index, name in enumerate(names)},
        coords={"valid_time": np.array([np.datetime64(day + timedelta(days=1)) for day in days], "datetime64[ns]"),
                "latitude": LAT, "longitude": LON},
    )
    dataset.to_netcdf(path, engine="netcdf4")


def write_forecast(config: dict, first: date, last: date, path: Path) -> None:
    """Zipped netCDF with (forecast_period, forecast_reference_time, latitude, longitude), one file per variable."""
    days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
    leads = np.array([int(hour) for hour in config["request"]["leadtime_hour"]])
    references = np.array([np.datetime64(day.isoformat()) for day in days], "datetime64[ns]")
    valid = references[None, :] + leads[:, None].astype("timedelta64[h]")
    directory = path.with_suffix(".parts")
    directory.mkdir()
    with zipfile.ZipFile(path, "w") as archive:
        for index, spec in enumerate(config["variables"].values()):
            data = np.stack([np.stack([field(day, int(lead), index) for day in days]) for lead in leads]) * 1e-9
            dataset = xr.Dataset(
                {spec["source"]: (("forecast_period", "forecast_reference_time", "latitude", "longitude"), data,
                                  {"GRIB_paramId": 167, "units": "K"})},
                coords={"forecast_period": leads.astype("timedelta64[h]").astype("timedelta64[ns]"),
                        "forecast_reference_time": references,
                        "valid_time": (("forecast_period", "forecast_reference_time"), valid.astype("datetime64[ns]")),
                        "latitude": LAT, "longitude": LON},
            )
            part = directory / f"data_{index}.nc"
            dataset.to_netcdf(part, engine="netcdf4")
            archive.write(part, part.name)


class FakeADS:
    """Stands in for the ADS client and catalogue; records the requested blocks.

    Every block is written up front: retrieve runs in the driver's worker
    threads, and HDF5 is not thread-safe while the main thread reads netCDF.
    """

    def __init__(self, config: dict, writer, last: date, cache: Path) -> None:
        self.last_day, self.requests, self.cache = last, [], cache
        start = date.fromisoformat(config["start"])
        days = [start + timedelta(days=offset) for offset in range((last - start).days + 1)]
        # Any day a run may start from (the floor), and any later day it may ask for.
        for floor in days:
            for day in days:
                if day >= floor:
                    first, end = ads.request_range(config, day, last, floor)
                    path = self.block(first, end)
                    if not path.exists():
                        writer(config, first, end, path)

    def block(self, first: date, last: date) -> Path:
        return self.cache / f"{first:%Y%m%d}_{last:%Y%m%d}"

    def fetcher(self) -> ads.Fetcher:
        fetcher = ads.Fetcher(retrieve=self.retrieve)
        fetcher._last = self.last_day
        return fetcher

    def retrieve(self, _dataset, request, destination):
        first, last = (date.fromisoformat(part) for part in request["date"][0].split("/"))
        self.requests.append((first, last))
        shutil.copy(self.block(first, last), destination)


def args(directory: Path, **extra) -> argparse.Namespace:
    return argparse.Namespace(**{"local": str(directory), "budget": 3600.0, "jobs": 2, "max_days": None,
                                 "force": False, **extra})


class PureFunctionsTest(unittest.TestCase):
    def test_request_blocks_align_on_start_and_stop_at_last(self):
        config = {"start": "2026-01-01", "requestDays": 7}
        self.assertEqual(ads.request_range(config, date(2026, 1, 9), date(2026, 3, 1)),
                         (date(2026, 1, 8), date(2026, 1, 14)))
        self.assertEqual(ads.request_range(config, date(2026, 1, 9), date(2026, 1, 10)),
                         (date(2026, 1, 8), date(2026, 1, 10)))
        # A run whose first pending day is 10 Jan does not fetch 8 and 9 Jan again.
        self.assertEqual(ads.request_range(config, date(2026, 1, 11), date(2026, 3, 1), date(2026, 1, 10)),
                         (date(2026, 1, 10), date(2026, 1, 14)))

    def test_request_lists_every_variable_and_the_date_range(self):
        config = gfas_config(date(2026, 1, 1))
        request = ads.ads_request(config, date(2026, 1, 1), date(2026, 1, 3))
        self.assertEqual(request["date"], ["2026-01-01/2026-01-03"])
        self.assertEqual(request["variable"], ["wildfire_radiative_power", "wildfire_fraction_of_area_observed",
                                               "altitude_of_plume_top"])
        self.assertEqual(request["temporal_aggregation"], ["daily"])

    def test_configs_cover_every_variable_with_an_encoding(self):
        for product in ("gfas", "global_forecast"):
            config = ads.load_config(HERE / product / "config.json")
            for name, spec in config["variables"].items():
                self.assertTrue(spec.get("dtype") == "float32" or "scaleFactor" in spec, name)
            self.assertEqual(config["grid"]["latitude"][2] * config["grid"]["longitude"][2] > 0, True)
            self.assertTrue(config["prefix"].startswith("zarr/cams/"))

    def test_regridding_interpolates_across_the_antimeridian(self):
        row = [0.0, 1.0, 2.0, 3.0]
        dataset = xr.Dataset({"v": (("latitude", "longitude"), np.array([row, row]))},
                             coords={"latitude": [1.0, -1.0], "longitude": [0.0, 90.0, 180.0, 270.0]})
        result, interpolated = ads.on_grid(dataset, {"latitude": [-1, 1, 2], "longitude": [-135, 135, 4]})
        self.assertTrue(interpolated)
        # On −180…90 the row reads 2, 3, 0, 1; 135 lies between 90 (1) and the wrapped 180 (2).
        np.testing.assert_allclose(result["v"].values[0], [2.5, 1.5, 0.5, 1.5])


class ReadDayTest(unittest.TestCase):
    def test_gfas_day_is_flipped_and_shifted_with_its_zeros(self):
        config = gfas_config(date(2026, 1, 1))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gfas.nc"
            write_gfas(config, date(2026, 1, 1), date(2026, 1, 3), path)
            dataset = ads.read_day(config, [path], date(2026, 1, 2))
            masked = ads.read_day(
                {**config, "variables": {"frpfire": {**config["variables"]["frpfire"], "zeroAsFill": True}}},
                [path], date(2026, 1, 2))
        self.assertEqual(dataset["frpfire"].dims, ("time", "latitude", "longitude"))
        np.testing.assert_array_equal(dataset["time"].values, [np.datetime64("2026-01-02T12:00", "ns")])
        np.testing.assert_array_equal(dataset["latitude"], [-60, -20, 20, 60])
        np.testing.assert_array_equal(dataset["longitude"], [-180, -90, 0, 90])
        expected = field(date(2026, 1, 2), 0)[::-1][:, [2, 3, 0, 1]] * np.float32(1e-3)
        frp = dataset["frpfire"].values[0]
        # The zero pixel (north, lon 270 → −90) stays 0: no fire is a value, made transparent by style.
        self.assertEqual(frp[3, 1], 0)
        np.testing.assert_allclose(frp, expected, rtol=1e-6)
        # zeroAsFill, still available, turns it into missing.
        self.assertTrue(np.isnan(masked["frpfire"].values[0, 3, 1]))
        self.assertIn("Copernicus Atmosphere Monitoring Service information 2026", dataset.attrs["license"])

    def test_forecast_steps_become_valid_times_in_store_units(self):
        config = forecast_config(date(2026, 1, 1))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "forecast.download"
            write_forecast(config, date(2026, 1, 1), date(2026, 1, 2), path)
            dataset = ads.read_day(config, ads.unpack(path), date(2026, 1, 2))
        self.assertEqual(dataset.sizes["time"], 8)
        np.testing.assert_array_equal(
            dataset["time"].values,
            np.datetime64("2026-01-02") + np.arange(0, 24, 3).astype("timedelta64[h]"))
        expected = field(date(2026, 1, 2), 21)[::-1][:, [2, 3, 0, 1]] * np.float32(1e-9) * np.float32(1e9)
        np.testing.assert_allclose(dataset["pm2p5"].values[-1], expected, rtol=1e-5)
        self.assertEqual(dataset["gtco3"].attrs["units"], "DU")
        # Kelvin to Celsius through the offset; t2m is the third variable written.
        kelvin = field(date(2026, 1, 2), 21, 2)[::-1][:, [2, 3, 0, 1]] * np.float32(1e-9)
        np.testing.assert_allclose(dataset["t2m"].values[-1], kelvin - np.float32(273.15), atol=1e-4)
        self.assertEqual(dataset["t2m"].attrs, {"long_name": "Air temperature at 2 m", "units": "degC"})

    def test_a_missing_short_name_names_what_the_file_holds(self):
        config = gfas_config(date(2026, 1, 1))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gfas.nc"
            write_gfas(config, date(2026, 1, 1), date(2026, 1, 1), path)
            config["variables"]["frpfire"] = {**config["variables"]["frpfire"], "source": "nope"}
            with self.assertRaisesRegex(KeyError, "frpfire"):
                ads.read_day(config, [path], date(2026, 1, 1))


class PipelineTest(unittest.TestCase):
    def check(self, config: dict, writer, days: int, per_day: int):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        cache = Path(tmp) / "cache"
        cache.mkdir()
        fake = FakeADS(config, writer, date.fromisoformat(config["start"]) + timedelta(days=days - 1), cache)
        out = Path(tmp) / "out"
        start = date.fromisoformat(config["start"])
        run(args(out, max_days=3), config, ads.product(config, "test", fake.fetcher()))
        first_run, fake.requests = fake.requests, []
        run(args(out), config, ads.product(config, "test", fake.fetcher()))
        target = local_target(out)
        times = stored_times(target, "timeChunked")
        self.assertEqual(times.size, days * per_day)
        self.assertEqual(np.unique(times).size, times.size)
        # Each run asks only from its first pending day, in blocks that end where aligned blocks end.
        self.assertEqual(min(first for first, _ in first_run), start)
        self.assertEqual(min(first for first, _ in fake.requests), start + timedelta(days=3))
        for first, last in first_run + fake.requests:
            self.assertEqual(ads.request_range(config, first, fake.last_day)[1], last)
        self.assertEqual(len(fake.requests), len(set(fake.requests)))
        sync_geo(args(out, force=True), config)
        xr.testing.assert_identical(open_store(target, "timeChunked").load(),
                                    open_store(target, "geoChunked").load())
        hours = xr.open_zarr(target.store("timeChunked"), decode_times=False)["time"]
        np.testing.assert_array_equal(hours.values.astype(np.float32), hours.values)
        return target

    def test_gfas_stores_float_fluxes_and_int16_heights(self):
        start = date.today() - timedelta(days=5)
        config = gfas_config(start)
        target = self.check(config, write_gfas, days=5, per_day=1)
        raw = open_store(target, "timeChunked", decode=False)
        self.assertEqual(raw["frpfire"].dtype, np.float32)
        self.assertEqual(raw["apt"].dtype, np.int16)

    def test_a_day_missing_from_the_download_waits_for_the_next_run(self):
        # The catalogue lists a day whose daily mean is not out yet (GFAS, 28 Oct 2026).
        start = date.today() - timedelta(days=3)
        config = gfas_config(start)
        listed = start + timedelta(days=2)
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "early").mkdir()
        (tmp / "late").mkdir()

        def published_until(day):
            def writer(config, first, last, path):
                # A block holding no published day is never requested in this scenario.
                if first <= day:
                    write_gfas(config, first, min(last, day), path)
            return writer

        early = FakeADS(config, published_until(listed - timedelta(days=1)), listed, tmp / "early")
        run(args(tmp / "out"), config, ads.product(config, "test", early.fetcher()))
        target = local_target(tmp / "out")
        self.assertEqual(stored_times(target, "timeChunked").size, 2)

        late = FakeADS(config, write_gfas, listed, tmp / "late")
        run(args(tmp / "out"), config, ads.product(config, "test", late.fetcher()))
        self.assertEqual(stored_times(target, "timeChunked").size, 3)
        self.assertEqual(late.requests, [(listed, listed)])

    def test_forecast_appends_eight_steps_a_day(self):
        start = date.today() - timedelta(days=4)
        config = forecast_config(start)
        target = self.check(config, write_forecast, days=4, per_day=8)
        raw = open_store(target, "timeChunked", decode=False)
        self.assertEqual(raw["gtco3"].dtype, np.int16)
        self.assertEqual(raw["gtco3"].attrs["scale_factor"], 0.1)


if __name__ == "__main__":
    unittest.main()
