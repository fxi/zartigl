"""Tests for the GODAS pipeline, on year files shaped like PSL's pottmp.<year>.nc."""

from __future__ import annotations

from datetime import date
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import common  # noqa: E402
import contract  # noqa: E402
import convert  # noqa: E402

# The first GODAS levels, down to the one whose layer reaches past 300 m.
LEVELS = np.array([5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175, 185, 195,
                   205, 215, 225, 238, 262, 303, 366, 459], np.float32)
LAT = np.array([-1.0, 0.0, 1.0], np.float32)
LON = np.array([0.5, 90.5, 180.5, 270.5], np.float32)
MISSING = np.float32(-9.96921e36)
CONFIG = {
    "sourceUrl": "unused/{year}",
    "firstYear": 2025,
    "baseline": [2023, 2025],
    "prefix": "zarr/test/godas/v2",
    "stores": {
        "timeChunked": {"time": 1, "depth": 1, "latitude": 3, "longitude": 4},
        "geoChunked": {"time": 5, "depth": 1, "latitude": 2, "longitude": 2},
    },
}


def profile(month: int) -> np.ndarray:
    """28 °C in the top 100 m, then 0.1 °C colder per metre, never below 2 °C: 20 °C at 180 m."""
    celsius = np.where(LEVELS <= 100, 28.0, np.maximum(28.0 - 0.1 * (LEVELS - 100), 2.0)) + month * 0.01
    return (celsius + convert.KELVIN).astype(np.float32)


def write_year(directory: Path, year: int, months: int, warming: float = 0.0) -> Path:
    """A year file with `months` months; each longitude adds its own offset, and (lat 1, lon 270.5) is land.

    `warming` is added to the whole column, so the years of a baseline can differ.
    """
    values = np.empty((months, LEVELS.size, LAT.size, LON.size), np.float32)
    for month in range(months):
        values[month] = profile(month + 1)[:, None, None] + (np.arange(LON.size) * 0.1)[None, None, :] + warming
    values[:, :, 2, 3] = MISSING
    times = [(np.datetime64(f"{year}-{month + 1:02d}-01") - np.datetime64("1800-01-01")).astype(int)
             for month in range(months)]
    source = xr.Dataset(
        {
            "pottmp": (("time", "level", "lat", "lon"), values,
                       {"units": "degK", "missing_value": MISSING, "long_name": "Potential temperature"}),
            "date": (("time",), np.arange(months, dtype=np.int32)),
        },
        coords={"time": ("time", np.array(times, np.float64),
                         {"units": "days since 1800-01-01 00:00:0.0", "calendar": "standard"}),
                "level": LEVELS, "lat": LAT, "lon": LON},
    )
    path = directory / f"pottmp.{year}.nc"
    source.to_netcdf(path)
    return path


def fetcher(files: dict[int, Path]) -> convert.Fetcher:
    return lambda _config, year, _directory: files.get(year)


def baseline_files(directory: Path) -> dict[int, Path]:
    """2023–2025, each 0.5 °C warmer than the year before: the climatology is 2024."""
    return {year: write_year(directory, year, 12, warming=0.5 * (year - 2024)) for year in (2023, 2024, 2025)}


class ClimatologyTest(unittest.TestCase):
    def test_monthly_means_over_the_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            files = baseline_files(Path(directory))
            normals = convert.climatology([convert.read_year(files[year]) for year in sorted(files)])
            middle = convert.read_year(files[2024])
        self.assertEqual(normals.attrs["baseline"], [2023, 2025])
        self.assertEqual(normals["pottmp"].dims, ("month", "depth", "latitude", "longitude"))
        self.assertEqual(normals["d20"].dims, ("month", "latitude", "longitude"))
        np.testing.assert_allclose(normals["pottmp"].values, middle.values, atol=1e-4)
        depth = middle["depth"].values
        np.testing.assert_allclose(normals["t300"].values, convert.upper_mean(middle.values, depth), atol=1e-4)
        # 0.5 °C warmer deepens d20 by 5 m: the mean of the three years is the middle one.
        np.testing.assert_allclose(normals["d20"].values, convert.isotherm_depth(middle.values, depth), atol=1e-2)
        self.assertTrue(np.isnan(normals["pottmp"].sel(latitude=1.0, longitude=-89.5).values).all())

    def test_a_cell_valid_in_too_few_years_has_no_climatology(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            files = baseline_files(Path(directory))
            years = [convert.read_year(files[year]) for year in sorted(files)]
        # Two of three years lose the surface of one cell: 1 valid year < 2 needed.
        for year in years[:2]:
            year.values[:, 0, 0, 0] = np.nan
        normals = convert.climatology(years)
        self.assertTrue(np.isnan(normals["pottmp"].values[:, 0, 0, 0]).all())
        self.assertTrue(np.isnan(normals["d20"].values[:, 0, 0]).all())
        self.assertFalse(np.isnan(normals["pottmp"].values[:, 1, 0, 0]).any())

    def test_run_computes_a_missing_climatology_before_the_first_month(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            files = baseline_files(Path(directory))
            target = common.local_target(Path(directory) / "stores")
            self.assertIn("climatology_2023_2025 missing", convert.plan(CONFIG, target, today=date(2026, 4, 20)))
            convert.run(CONFIG, target, today=date(2025, 12, 31), fetch=fetcher(files))
            self.assertIn("climatology_2023_2025 ready", convert.plan(CONFIG, target, today=date(2026, 4, 20)))
            # Lost once the stores hold anomalies: rebuilding it silently could change their reference.
            shutil.rmtree(Path(directory) / "stores" / "climatology_2023_2025.zarr")
            with self.assertRaisesRegex(RuntimeError, "new store version"):
                convert.run(CONFIG, target, today=date(2026, 4, 20), fetch=fetcher(files))

    def test_a_climatology_is_only_overwritten_with_force(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            files = baseline_files(Path(directory))
            target = common.local_target(Path(directory) / "stores")
            convert.write_climatology(CONFIG, target, fetch=fetcher(files))
            with self.assertRaisesRegex(RuntimeError, "pass --force"):
                convert.write_climatology(CONFIG, target, fetch=fetcher(files))
            convert.write_climatology(CONFIG, target, fetch=fetcher(files), force=True)
            # Once the stores hold anomalies, the climatology is frozen, even with --force.
            convert.run(CONFIG, target, today=date(2025, 12, 31), fetch=fetcher(files))
            with self.assertRaisesRegex(RuntimeError, "new version"):
                convert.write_climatology(CONFIG, target, fetch=fetcher(files), force=True)

    def test_a_year_without_twelve_distinct_months_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            year = convert.read_year(write_year(Path(directory), 2024, 12))
        times = year["time"].values.copy()
        times[1] = times[0]  # two Januaries, no February
        with self.assertRaisesRegex(RuntimeError, "not January to December"):
            convert.climatology([year.assign_coords(time=times)])


class ProfileTest(unittest.TestCase):
    def test_upper_mean_weights_layers_by_thickness(self) -> None:
        temperature = np.broadcast_to(profile(0)[None, :, None, None] - convert.KELVIN, (1, LEVELS.size, 1, 1))
        edges = convert.layer_edges(LEVELS.astype(np.float64))
        self.assertEqual(edges[0], 0)
        self.assertEqual(edges[1], 10)
        # 28 °C over 0–100 m, then linear down to 8 °C at 300 m: mean of 28 over 1/3 and 18 over 2/3.
        mean = convert.upper_mean(temperature, LEVELS.astype(np.float64))
        self.assertAlmostEqual(float(mean[0, 0, 0]), 28 / 3 + 18 * 2 / 3, delta=0.2)

    def test_upper_mean_is_missing_above_shallow_bottoms(self) -> None:
        temperature = np.full((1, LEVELS.size, 1, 1), 25.0, np.float32)
        temperature[0, 25:] = np.nan  # bottom at 282 m
        self.assertTrue(np.isnan(convert.upper_mean(temperature, LEVELS.astype(np.float64))[0, 0, 0]))
        temperature[0, 25] = 25.0  # bottom between 303 m and 366 m
        self.assertEqual(float(convert.upper_mean(temperature, LEVELS.astype(np.float64))[0, 0, 0]), 25.0)

    def test_isotherm_depth_interpolates_the_first_crossing(self) -> None:
        temperature = (profile(0) - convert.KELVIN)[None, :, None, None]
        self.assertAlmostEqual(float(convert.isotherm_depth(temperature, LEVELS)[0, 0, 0]), 180.0, places=3)
        cold = np.full((1, LEVELS.size, 1, 1), 15.0, np.float32)
        self.assertTrue(np.isnan(convert.isotherm_depth(cold, LEVELS)[0, 0, 0]))
        warm_shelf = np.full((1, LEVELS.size, 1, 1), np.nan, np.float32)
        warm_shelf[0, :4] = 26.0
        self.assertTrue(np.isnan(convert.isotherm_depth(warm_shelf, LEVELS)[0, 0, 0]))


class ReadTest(unittest.TestCase):
    def test_a_year_file_is_rolled_to_the_store_layout_in_celsius(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data = convert.read_year(write_year(Path(directory), 2025, 2))
        self.assertEqual(data.dims, contract.DEPTH_DIMS)
        self.assertEqual(data["longitude"].values.tolist(), [-179.5, -89.5, 0.5, 90.5])
        self.assertEqual(str(data["time"].values[1])[:10], "2025-02-01")
        # 0.5 E keeps offset 0, 180.5 E (now −179.5) offset 0.2; land is NaN.
        self.assertAlmostEqual(float(data.sel(longitude=0.5).values[0, 0, 0]), 28.01, places=3)
        self.assertAlmostEqual(float(data.sel(longitude=-179.5).values[0, 0, 0]), 28.21, places=3)
        self.assertTrue(np.isnan(data.sel(latitude=1.0, longitude=-89.5).values).all())


class RunTest(unittest.TestCase):
    def test_stores_meet_the_contract_and_take_new_months(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory) / "stores")
            convert.write_climatology(CONFIG, target, fetch=fetcher(baseline_files(Path(directory))))
            files = Path(directory) / "files"
            files.mkdir()
            # 2025 is the climatology; 2026 is 1 °C warmer over the whole column.
            sources = {2025: write_year(files, 2025, 12), 2026: write_year(files, 2026, 3, warming=1.0)}
            self.assertIn("climatology_2023_2025 ready", convert.plan(CONFIG, target, today=date(2026, 4, 20)))
            convert.run(CONFIG, target, today=date(2026, 4, 20), fetch=fetcher(sources))
            self.assertIn("timeChunked until 2026-03", convert.plan(CONFIG, target, today=date(2026, 4, 20)))
            self.assertIn("run reads 2026–2026", convert.plan(CONFIG, target, today=date(2026, 4, 20)))
            # PSL rewrites the 2026 file with April; no 2027 file yet in January.
            sources[2026] = write_year(files, 2026, 4, warming=1.0)
            convert.run(CONFIG, target, today=date(2027, 1, 10), fetch=fetcher(sources))
            for name in CONFIG["stores"]:
                store = xr.open_zarr(target.store(name), consolidated=True, zarr_format=2)
                self.assertEqual(contract.problems(store), [])
                self.assertEqual(store.sizes["time"], 16)
                self.assertEqual(str(store["time"].values[-1])[:10], "2026-04-01")
                self.assertEqual(store["pottmp"].dims, contract.DEPTH_DIMS)
                self.assertEqual(store["depth"].attrs["positive"], "down")
                column = store.sel(latitude=0.0, longitude=0.5)
                self.assertAlmostEqual(float(column["pottmp"].values[-1, 0]), 29.04, places=2)
                self.assertAlmostEqual(float(column["d20"].values[-1]), 190.4, places=1)
                self.assertTrue(np.isnan(store["t300"].sel(latitude=1.0, longitude=-89.5).values).all())
                for name in ("pottmp_anom", "t300_anom", "d20_anom"):
                    self.assertIn("2023–2025 monthly climatology", store[name].attrs["comment"])
                # 2025 matches its climatology; 2026 is 1 °C warmer, so d20 is 10 m deeper.
                np.testing.assert_allclose(column["pottmp_anom"].values[:12], 0, atol=2e-3)
                np.testing.assert_allclose(column["pottmp_anom"].values[12:], 1, atol=2e-3)
                np.testing.assert_allclose(column["t300_anom"].values[12:], 1, atol=2e-3)
                np.testing.assert_allclose(column["d20_anom"].values[12:], 10, atol=0.2)
                self.assertTrue(np.isnan(store["d20_anom"].sel(latitude=1.0, longitude=-89.5).values).all())
                self.assertIn("2025-01 to 2026-04", store.attrs["history"])
            raw = xr.open_zarr(target.store("timeChunked"), consolidated=True, zarr_format=2, decode_times=False)
            self.assertTrue(raw["time"].attrs["units"].startswith("hours since"))

    def test_a_missing_past_year_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory) / "stores")
            convert.write_climatology(CONFIG, target, fetch=fetcher(baseline_files(Path(directory))))
            with self.assertRaisesRegex(RuntimeError, "pottmp.2025.nc is missing"):
                convert.run(CONFIG, target, today=date(2026, 4, 20), fetch=fetcher({}))

    def test_a_store_behind_the_other_catches_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory) / "stores")
            normals = convert.write_climatology(CONFIG, target, fetch=fetcher(baseline_files(Path(directory))))
            files = Path(directory) / "files"
            files.mkdir()
            sources = {2025: write_year(files, 2025, 12)}
            data = convert.read_year(sources[2025])
            # An interrupted run: timeChunked has the year, geoChunked only its first months.
            convert.write_months({**CONFIG, "stores": {"timeChunked": CONFIG["stores"]["timeChunked"]}},
                                 target, data, normals)
            convert.write_months({**CONFIG, "stores": {"geoChunked": CONFIG["stores"]["geoChunked"]}},
                                 target, data.isel(time=slice(0, 7)), normals)
            convert.run(CONFIG, target, today=date(2025, 12, 31), fetch=fetcher(sources))
            times = [common.stored_times(target, name) for name in common.STORE_NAMES]
            np.testing.assert_array_equal(times[0], times[1])


if __name__ == "__main__":
    unittest.main()
