import unittest

import numpy as np
import xarray as xr

from build import region_statistics, region_subset


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

if __name__ == "__main__":
    unittest.main()
