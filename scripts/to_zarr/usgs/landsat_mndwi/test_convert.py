"""Tests for the Landsat MNDWI pipeline, on synthetic scenes already on the store grid."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
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

CONFIG = {
    "bbox": {"west": 0.0, "south": 0.0, "east": 0.2, "north": 0.1},
    "cell": 0.1,
    "firstYear": 2000,
    "lastYear": 2002,
    "prefix": "zarr/test/landsat/v1",
    "stores": {
        "timeChunked": {"time": 1, "latitude": 1, "longitude": 2},
        "geoChunked": {"time": 3, "latitude": 1, "longitude": 2},
    },
}


def dn(reflectance: float) -> int:
    scale, offset = convert.REFLECTANCE
    return round((reflectance - offset) / scale)


class Item:
    def __init__(self, year: int, green: float, swir: float, qa: int = 1 << 6) -> None:
        self.datetime = datetime(year, 6, 1)
        self.bands = (green, swir, qa)


def reader(item: Item, _config: dict) -> convert.Scene:
    green, swir, qa = item.bands
    shape = (1, 2)
    return (np.full(shape, dn(green), np.uint16), np.full(shape, dn(swir), np.uint16),
            np.full(shape, qa, np.uint16))


class MndwiTest(unittest.TestCase):
    def test_water_is_positive_and_clouds_are_dropped(self) -> None:
        green = np.array([[dn(0.10), dn(0.10)]], np.uint16)
        swir = np.array([[dn(0.02), dn(0.30)]], np.uint16)
        qa = np.array([[1 << 6, 1 << 6]], np.uint16)
        values = convert.mndwi(green, swir, qa)
        self.assertGreater(values[0, 0], 0.5)
        self.assertLess(values[0, 1], -0.4)
        cloudy = convert.mndwi(green, swir, np.array([[1 << 3, 1 << 6]], np.uint16))
        self.assertTrue(np.isnan(cloudy[0, 0]))

    def test_negative_reflectance_is_not_an_observation(self) -> None:
        # Haze over-corrected over deep water: green below zero would read as land.
        green = np.array([[dn(-0.03)]], np.uint16)
        swir = np.array([[dn(0.02)]], np.uint16)
        values = convert.mndwi(green, swir, np.array([[1 << 6]], np.uint16))
        self.assertTrue(np.isnan(values[0, 0]))

    def test_missing_years_carry_the_nearest_value(self) -> None:
        values = np.array([[np.nan], [0.5], [np.nan], [-0.2]], np.float32)[:, :, None]
        np.testing.assert_allclose(convert.carry_forward(values)[:, 0, 0], [0.5, 0.5, 0.5, -0.2])


class PoolTest(unittest.TestCase):
    def test_early_frames_pool_the_years_before(self) -> None:
        config = {**CONFIG, "pool": {"until": 2001, "years": 2}}
        items = [Item(1999, 0.10, 0.30), Item(2000, 0.10, 0.02), Item(2002, 0.10, 0.02)]
        _, swirs, counts = convert.composite(config, items, reader)
        # 2000 pools 1999 and 2000, 2001 pools 2000 and 2001, 2002 stands alone.
        self.assertEqual(counts[:, 0, 0].tolist(), [2, 1, 1])
        self.assertEqual([convert.pool_years(config, year) for year in (2000, 2001, 2002)], [2, 2, 1])
        self.assertAlmostEqual(float(swirs[0, 0, 0]), 0.16, places=3)  # median of 0.30 and 0.02


class BuildTest(unittest.TestCase):
    def test_stores_meet_the_contract(self) -> None:
        items = [Item(2000, 0.10, 0.02), Item(2000, 0.10, 0.03), Item(2002, 0.05, 0.30),
                 Item(2001, 0.10, 0.02, qa=1 << 3)]
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory))
            convert.run(CONFIG, target, items=items, reader=reader)
            for name in CONFIG["stores"]:
                store = xr.open_zarr(target.store(name), consolidated=True, zarr_format=2)
                self.assertEqual(contract.problems(store), [])
                mndwi = store["mndwi"].values[:, 0, 0]
                self.assertGreater(mndwi[0], 0.5)  # water in 2000
                self.assertAlmostEqual(mndwi[1], mndwi[0], places=4)  # 2001 is all cloud: carried
                self.assertLess(mndwi[2], 0)  # land in 2002
                swir = store["swir1"].values[:, 0, 0]
                np.testing.assert_allclose(swir, [0.025, 0.025, 0.30], atol=1e-3)  # median of 0.02, 0.03
                self.assertEqual(store["observed"].values[:, 0, 0].tolist(), [2, 0, 1])

    def test_later_runs_append_the_new_complete_years(self) -> None:
        config = {key: value for key, value in CONFIG.items() if key != "lastYear"}
        items = [Item(2000, 0.10, 0.02), Item(2001, 0.05, 0.30), Item(2002, 0.05, 0.30)]
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory))
            convert.run(config, target, today=date(2002, 3, 1), items=items, reader=reader)
            self.assertIn("nothing to do", convert.plan(config, target, today=date(2002, 12, 31)))
            self.assertIn("run writes 2002–2002", convert.plan(config, target, today=date(2003, 1, 1)))
            # 2002 has no clear scene: it starts from the last stored frame.
            convert.run(config, target, today=date(2003, 1, 1), items=items[:2] + [Item(2002, 0.1, 0.0, 1 << 3)],
                        reader=reader)
            for name in CONFIG["stores"]:
                store = xr.open_zarr(target.store(name), consolidated=True, zarr_format=2)
                self.assertEqual(contract.problems(store), [])
                self.assertEqual([str(t)[:4] for t in store["time"].values], ["2000", "2001", "2002"])
                np.testing.assert_allclose(store["swir1"].values[:, 0, 0], [0.02, 0.30, 0.30], atol=1e-3)
                self.assertEqual(store["observed"].values[:, 0, 0].tolist(), [1, 1, 0])
                self.assertEqual(store.attrs["history"].count("\n"), 1)

    def test_rebuild_starts_again(self) -> None:
        items = [Item(2000, 0.10, 0.02)]
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory))
            convert.run(CONFIG, target, items=items, reader=reader)
            convert.run(CONFIG, target, items=items, reader=reader, rebuild=True)
            store = xr.open_zarr(target.store("timeChunked"), consolidated=True, zarr_format=2)
            self.assertEqual(store.sizes["time"], 3)


if __name__ == "__main__":
    unittest.main()
