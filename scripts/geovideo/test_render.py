import unittest

import numpy as np

from render import ScalarFrames, create_manifest, validate_config, validate_monthly_samples


class GeoVideoSamplingTest(unittest.TestCase):
    def config(self):
        return {
            "layerId": "baltic-bottom-oxygen",
            "sampling": {
                "kind": "annual-month",
                "month": 9,
                "yearStart": 1993,
                "yearEnd": 2025,
                "secondsPerSample": 1,
            },
            "bounds": [9.04, 53.01, 30.21, 65.89],
            "style": {"colorDomain": [0, 187.5]},
            "output": {"width": 1024, "height": 1024, "fps": 24},
        }

    def test_annual_sampling_derives_duration_from_encoded_frames(self):
        config = validate_config(self.config())
        self.assertEqual(config["durationSeconds"], 33)
        self.assertEqual(config["sampling"]["month"], 9)

    def test_manifest_records_exact_discrete_samples(self):
        config = validate_config(self.config())
        samples = np.array(["1993-09-01", "1994-09-01"], dtype="datetime64[ns]")
        layer = {
            "id": "baltic-bottom-oxygen",
            "dataset": {"id": "dataset"},
            "variables": {"value": "o2b"},
        }
        manifest = create_manifest(config, layer, "video.mp4", "mask.png", samples)
        self.assertEqual(manifest["timeline"], {
            "kind": "sample-sequence",
            "values": ["1993-09-01T00:00:00Z", "1994-09-01T00:00:00Z"],
        })

    def test_rejects_invalid_sampling_ranges(self):
        config = self.config()
        config["sampling"] = {"kind": "annual-month", "month": 13, "yearStart": 2025, "yearEnd": 1993}
        with self.assertRaisesRegex(ValueError, "sampling range"):
            validate_config(config)

    def test_monthly_sampling_uses_two_real_frames_per_month(self):
        config = self.config()
        config["sampling"] = {
            "kind": "monthly",
            "dateStart": "1993-09-01T00:00:00Z",
            "dateEnd": "2025-09-01T00:00:00Z",
            "framesPerSample": 2,
        }
        result = validate_config(config)
        self.assertEqual(result["sampling"]["sampleCount"], 385)
        self.assertEqual(result["durationSeconds"], 770 / 24)

    def test_monthly_sampling_rejects_missing_or_duplicate_months(self):
        start = np.datetime64("2024-01-01", "ns")
        end = np.datetime64("2024-03-01", "ns")
        with self.assertRaisesRegex(ValueError, "exactly one value"):
            validate_monthly_samples(np.array(["2024-01-01", "2024-03-01"]), start, end)
        with self.assertRaisesRegex(ValueError, "exactly one value"):
            validate_monthly_samples(
                np.array(["2024-01-01", "2024-02-01", "2024-02-15", "2024-03-01"]), start, end,
            )

    def test_sample_frames_repeat_without_interpolation(self):
        frames = ScalarFrames.__new__(ScalarFrames)
        frames.samples = np.array(["2024-01-01", "2024-02-01"], dtype="datetime64[ns]")
        frames.config = {"sampling": {"framesPerSample": 2}}
        frames._frame_at = lambda value: value
        self.assertEqual(frames.frame(0, 4), np.datetime64("2024-01-01", "ns"))
        self.assertEqual(frames.frame(1, 4), np.datetime64("2024-01-01", "ns"))
        self.assertEqual(frames.frame(2, 4), np.datetime64("2024-02-01", "ns"))

    def test_exact_source_time_bypasses_linear_interpolation(self):
        frames = ScalarFrames.__new__(ScalarFrames)
        frames.times = np.array(["2024-01-01", "2024-02-01"], dtype="datetime64[ns]")
        frames.config = {"interpolation": "linear"}
        frames._slice = lambda index: np.array([index], dtype=np.float32)
        np.testing.assert_array_equal(frames._frame_at(frames.times[1]), np.array([1], dtype=np.float32))


if __name__ == "__main__":
    unittest.main()
