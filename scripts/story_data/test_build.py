import unittest

import numpy as np
import xarray as xr

from build import (
    hypoxia_area_statistics,
    region_statistics,
    region_subset,
    require_complete_month_axis,
    spherical_cell_areas,
    trailing_mean,
)


class StoryDataTest(unittest.TestCase):
    def test_area_weighted_stats_ignore_missing_values(self):
        values = xr.DataArray(
            np.array([[[1.0, 3.0], [2.0, np.nan]]]),
            coords={"time": [0], "latitude": [-60.0, 0.0], "longitude": [0.0, 1.0]},
            dims=("time", "latitude", "longitude"),
        )
        result = region_statistics(values).compute()
        expected = (1 * 0.5 + 3 * 0.5 + 2 * 1.0) / 2.0
        self.assertAlmostEqual(float(result["mean"].values[0]), expected)
        self.assertEqual(int(result["count"].values[0]), 3)

    def test_region_subset_handles_descending_latitude_and_antimeridian(self):
        values = xr.DataArray(
            np.zeros((1, 3, 5)),
            coords={"time": [0], "latitude": [10.0, 0.0, -10.0], "longitude": [-170.0, -150.0, 0.0, 160.0, 175.0]},
            dims=("time", "latitude", "longitude"),
        )
        result = region_subset(values, {"west": 160, "south": -5, "east": -150, "north": 5})
        self.assertEqual(result.latitude.values.tolist(), [0.0])
        self.assertEqual(result.longitude.values.tolist(), [160.0, 175.0, -170.0, -150.0])

    def test_hypoxia_area_excludes_missing_and_threshold_values(self):
        values = xr.DataArray(
            np.array([[[10.0, 62.5], [70.0, np.nan]]]),
            coords={"time": [0], "latitude": [1.0, 0.0], "longitude": [0.0, 1.0]},
            dims=("time", "latitude", "longitude"),
        )
        result = hypoxia_area_statistics(values, 62.5).compute()
        areas = spherical_cell_areas(values.latitude.values, values.longitude.values)
        self.assertAlmostEqual(float(result["hypoxic_area_km2"].values[0]), float(areas[0, 0]))
        self.assertAlmostEqual(float(result["valid_area_km2"].values[0]), float(areas[0, 0] + areas[0, 1] + areas[1, 0]))

    def test_trailing_mean_waits_for_complete_window(self):
        self.assertEqual(trailing_mean([1, 2, 3, 4, 5, 6], 5), [None, None, None, None, 3.0, 4.0])

    def test_month_axis_requires_one_value_per_calendar_month(self):
        start = np.datetime64("2024-01-01")
        end = np.datetime64("2024-03-01")
        require_complete_month_axis(np.array(["2024-01-01", "2024-02-01", "2024-03-01"]), start, end)
        with self.assertRaisesRegex(RuntimeError, "one sample for every month"):
            require_complete_month_axis(np.array(["2024-01-01", "2024-03-01"]), start, end)

if __name__ == "__main__":
    unittest.main()
