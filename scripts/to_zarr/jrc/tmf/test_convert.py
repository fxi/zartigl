"""Tests for the JRC TMF pipeline, on synthetic tiles shaped like the COG overviews."""

from __future__ import annotations

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
    "sourceUrl": "mem://{tile}/{product}",
    "tiles": ["N0_E0"],
    "overviewLevel": 0,
    "bbox": {"west": 0.0, "south": -1.0, "east": 1.0, "north": 0.0},
    "cell": 0.5,
    "firstYear": 1990,
    "lastYear": 1992,
    "variables": {"degraded": "DegradationYear", "deforested": "DeforestationYear"},
    "prefix": "zarr/test/tmf/v1",
    "stores": {
        "timeChunked": {"time": 1, "latitude": 1, "longitude": 2},
        "geoChunked": {"time": 3, "latitude": 1, "longitude": 2},
    },
}

# 4 x 4 pixels of 0.25 degree over 0–1 E, 0–1 S: one 0.5 degree cell is 2 x 2 pixels.
PIXELS = {
    "DeforestationYear": np.array([
        [1990, 0, 0, 0],
        [1991, 1985, 0, 0],
        [0, 0, 1992, 1992],
        [0, 0, 1992, 2030],
    ], dtype=np.uint16),
    "DegradationYear": np.zeros((4, 4), dtype=np.uint16),
}


def reader(url: str, _overview: str, south: float, north: float):
    values = PIXELS[url.rsplit("/", 1)[1]]
    lat = -0.125 - 0.25 * np.arange(4)
    lon = 0.125 + 0.25 * np.arange(4)
    rows = (lat > south) & (lat < north)
    yield values[rows], lat[rows], lon


class SharesTest(unittest.TestCase):
    def test_cumulative_share_of_each_cell(self) -> None:
        lat, lon = convert.grid(CONFIG)
        counts, totals = convert.band(CONFIG, "DeforestationYear", -1.0, 2, 2, reader, with_totals=True)
        codes = convert.shares(counts, totals)
        # Rows go south to north: row 0 is -1..-0.5, the two bottom pixel rows.
        self.assertEqual(lat.tolist(), [-0.75, -0.25])
        self.assertEqual(codes[:, 1, 0].tolist(), [2500, 5000, 5000])  # 1990, then 1991; 1985 is before
        self.assertEqual(codes[:, 0, 1].tolist(), [0, 0, 7500])  # three 1992 pixels; 2030 is ignored
        self.assertEqual(codes[:, 0, 0].tolist(), [0, 0, 0])

    def test_cells_without_pixels_are_fill(self) -> None:
        counts = np.zeros((2, 1, 2), dtype=np.uint32)
        totals = np.array([[4, 0]], dtype=np.uint32)
        self.assertEqual(convert.shares(counts, totals)[:, 0, 1].tolist(), [convert.FILL, convert.FILL])


class BuildTest(unittest.TestCase):
    def test_stores_meet_the_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory))
            convert.build(CONFIG, target, rows=1, reader=reader)
            for name in CONFIG["stores"]:
                store = xr.open_zarr(target.store(name), consolidated=True, zarr_format=2)
                self.assertEqual(contract.problems(store), [])
                self.assertEqual(store["deforested"].shape, (3, 2, 2))
                self.assertAlmostEqual(float(store["deforested"][2, 0, 1]), 0.75, places=4)
                self.assertEqual(str(store["time"].values[0])[:10], "1990-12-31")

    def test_run_builds_once_then_does_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory))
            self.assertIn("missing", convert.plan(CONFIG, target))
            convert.run(CONFIG, target, rows=1, reader=reader)
            self.assertIn("nothing to do", convert.plan(CONFIG, target))
            calls = []
            convert.run(CONFIG, target, rows=1, reader=lambda *args: calls.append(args) or iter(()))
            self.assertEqual(calls, [])
            convert.run(CONFIG, target, rows=1, reader=reader, rebuild=True)
            self.assertIn("nothing to do", convert.plan(CONFIG, target))

    def test_an_unfinished_build_is_redone(self) -> None:
        def failing(url: str, overview: str, south: float, north: float):
            if south > -0.6:
                raise RuntimeError("network down")
            yield from reader(url, overview, south, north)

        with tempfile.TemporaryDirectory() as directory:
            target = common.local_target(Path(directory))
            with self.assertRaises(RuntimeError):
                convert.run(CONFIG, target, rows=1, reader=failing)
            self.assertIn("unfinished", convert.plan(CONFIG, target))
            convert.run(CONFIG, target, rows=1, reader=reader)
            self.assertIn("nothing to do", convert.plan(CONFIG, target))


if __name__ == "__main__":
    unittest.main()
