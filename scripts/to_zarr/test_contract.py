from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import xarray as xr

sys.path.insert(0, str(Path(__file__).resolve().parent))
import contract  # noqa: E402
from common import local_target, write  # noqa: E402

ENCODINGS = {
    "time": {"units": "hours since 1970-01-01 00:00:00", "calendar": "standard", "dtype": "int32"},
    "v": {"dtype": "int16", "_FillValue": -32768, "scale_factor": 0.1},
}


def good() -> xr.Dataset:
    dataset = xr.Dataset(
        {"v": (("time", "latitude", "longitude"), np.ones((1, 2, 3), np.float32), {"long_name": "V", "units": "1"})},
        coords={"time": np.array(["2026-01-01"], "datetime64[ns]"),
                "latitude": [-10.0, 10.0], "longitude": [-170.0, 0.0, 170.0]},
        attrs={"title": "t", "source": "s", "license": "l", "history": "h"},
    )
    dataset["latitude"].attrs = {"standard_name": "latitude", "units": "degrees_north"}
    dataset["longitude"].attrs = {"standard_name": "longitude", "units": "degrees_east"}
    return dataset


class ContractTest(unittest.TestCase):
    def test_a_conforming_dataset_has_no_problems(self):
        self.assertEqual(contract.problems(good()) + contract.encoding_problems(ENCODINGS), [])

    def test_provider_leftovers_are_refused(self):
        dataset = good()
        dataset["v"].attrs.update(GRIB_paramId=167, standard_name="unknown")
        self.assertEqual(contract.problems(dataset),
                         ["v: attributes outside the contract ['GRIB_paramId', 'standard_name']"])

    def test_layout_breaches_are_named(self):
        dataset = good().isel(latitude=[1, 0]).assign_coords(longitude=[10.0, 180.0, 350.0])
        dataset.attrs.pop("license")
        found = contract.problems(dataset)
        self.assertIn("latitude is not strictly ascending", found)
        self.assertIn("longitude outside -180…180", found)
        self.assertIn("store attributes missing ['license']", found)

    def test_time_and_dtypes_must_suit_the_browser(self):
        found = contract.encoding_problems({
            "time": {"units": "seconds since 1981-01-01", "dtype": "float64"},
            "v": {"dtype": "uint8"},
        })
        self.assertEqual(len(found), 3)

    def test_write_refuses_a_breach_before_touching_the_store(self):
        dataset = good()
        dataset["v"].attrs["GRIB_paramId"] = 167
        with tempfile.TemporaryDirectory() as tmp:
            target = local_target(Path(tmp))
            with self.assertRaisesRegex(ValueError, "GRIB_paramId"):
                write(dataset, target, "timeChunked", {"time": 1, "latitude": 2, "longitude": 3}, ENCODINGS,
                      append=False)
            self.assertFalse((Path(tmp) / "timeChunked.zarr").exists())

    def test_every_product_config_names_a_zarr_prefix(self):
        prefixes = contract.product_prefixes()
        self.assertIn("zarr/noaa/crw-dhw/v3.1", prefixes)
        self.assertTrue(all(prefix.startswith("zarr/") and prefix.count("/") == 3 for prefix in prefixes))


if __name__ == "__main__":
    unittest.main()
