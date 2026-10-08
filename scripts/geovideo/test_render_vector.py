import unittest

import numpy as np
import xarray as xr

from render_vector import (
    CODE_MAX,
    CODE_MIN,
    block_mean,
    crop,
    decode_values,
    derive_uv,
    encode_values,
    luma_frame,
    parse_step,
    validate_config,
)

LAYER = {"id": "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2", "kind": "vector", "defaults": {"palette": "rdylbu"}}
CONFIG = {
    "id": "382973a2-4c6a-422d-8963-964f6b99b58d",
    "catalogEntryId": "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2",
    "dateStart": "2024-12-12T00:00:00Z",
    "dateEnd": "2024-12-16T23:00:00Z",
}


class QuantizationTest(unittest.TestCase):
    def test_round_trip_error_is_bounded_and_sqrt_favors_slow_flows(self):
        values = np.linspace(-2, 2, 4001, dtype=np.float32)
        for transfer in ("linear", "sqrt"):
            codes = encode_values(values, 2.0, transfer)
            self.assertEqual(int(codes.min()), CODE_MIN)
            self.assertEqual(int(codes.max()), CODE_MAX)
            self.assertLess(float(np.max(np.abs(decode_values(codes, 2.0, transfer) - values))), 0.04)
        slow = np.float32(0.01)
        linear_error = abs(decode_values(encode_values(slow, 2.0, "linear"), 2.0, "linear") - slow)
        sqrt_error = abs(decode_values(encode_values(slow, 2.0, "sqrt"), 2.0, "sqrt") - slow)
        self.assertLess(sqrt_error, linear_error)

    def test_values_beyond_the_domain_saturate(self):
        self.assertEqual(int(encode_values(np.float32(9), 2.0, "sqrt")), CODE_MAX)
        self.assertEqual(int(encode_values(np.float32(-9), 2.0, "sqrt")), CODE_MIN)


class FieldTest(unittest.TestCase):
    def test_from_direction_points_toward_the_opposite_bearing(self):
        derivation = {"direction_convention": "from", "output_direction": "toward"}
        u, v = derive_uv(np.array([0.0], np.float32), np.array([2.0], np.float32), derivation)
        self.assertAlmostEqual(float(u[0]), 0.0, places=5)
        self.assertAlmostEqual(float(v[0]), -2.0, places=5)

    def test_block_mean_requires_a_valid_majority(self):
        a = np.array([[1, 1, np.nan, np.nan], [1, np.nan, np.nan, np.nan]], np.float32)
        out = block_mean(a, 2)
        self.assertEqual(out.shape, (1, 2))
        self.assertAlmostEqual(float(out[0, 0]), 1.0)
        self.assertTrue(np.isnan(out[0, 1]))

    def test_calm_cells_inside_the_mask_encode_zero(self):
        u = np.array([[1.0, np.nan], [0.5, 0.5]], np.float32)
        v = np.array([[1.0, np.nan], [0.5, 0.5]], np.float32)
        static_valid = np.ones((2, 2), bool)
        codes = luma_frame(u, v, static_valid, 2.0, "sqrt")
        zero = int(encode_values(np.float32(0), 2.0, "sqrt"))
        self.assertEqual(codes.shape, (4, 2))
        self.assertEqual(int(codes[0, 1]), zero)
        self.assertEqual(int(codes[2, 1]), zero)


class CropTest(unittest.TestCase):
    def test_crop_keeps_the_region_with_even_block_grid(self):
        dataset = xr.Dataset(
            {"u": (("latitude", "longitude"), np.zeros((181, 361), np.float32))},
            coords={"latitude": np.arange(-90, 91, 1.0), "longitude": np.arange(-180, 181, 1.0)},
        )
        out = crop(dataset, [25, -35, 75, 5], 1)
        self.assertEqual(out.sizes["latitude"] % 2, 0)
        self.assertEqual(out.sizes["longitude"] % 2, 0)
        self.assertGreaterEqual(float(out.latitude.min()), -35)
        self.assertLessEqual(float(out.longitude.max()), 75)


class ConfigTest(unittest.TestCase):
    def test_steps_and_bounds(self):
        self.assertEqual(parse_step("PT3H"), np.timedelta64(3, "h"))
        self.assertEqual(parse_step("P1D"), np.timedelta64(1, "D"))
        with self.assertRaises(ValueError):
            parse_step("PT30M")
        self.assertEqual(validate_config({**CONFIG, "bounds": [25, -35, 75, 5]}, LAYER)["bounds"], [25, -35, 75, 5])
        with self.assertRaises(ValueError):
            validate_config({**CONFIG, "bounds": [170, -10, -170, 10]}, LAYER)

    def test_optional_settings_do_not_change_the_normalized_config(self):
        normalized = validate_config(CONFIG, LAYER)
        self.assertNotIn("bounds", normalized)
        self.assertNotIn("domainPercentile", normalized["output"])
        with self.assertRaises(ValueError):
            validate_config({**CONFIG, "output": {"domainPercentile": 0}}, LAYER)


    def test_explicit_times_and_pinned_domain(self):
        times = ["2024-12-12T00:00:00Z", "2024-12-12T03:00:00Z"]
        config = validate_config({**CONFIG, "times": times, "output": {"valueDomain": 38}}, LAYER)
        self.assertEqual((config["times"], config["output"]["valueDomain"]), (times, 38))
        for invalid in (times[:1], times[::-1], ["2024-12-11T00:00:00Z", "2024-12-12T00:00:00Z"]):
            with self.assertRaises(ValueError):
                validate_config({**CONFIG, "times": invalid}, LAYER)
        for domain in (0, -1, True, "38"):
            with self.assertRaisesRegex(ValueError, "valueDomain"):
                validate_config({**CONFIG, "output": {"valueDomain": domain}}, LAYER)


if __name__ == "__main__":
    unittest.main()
