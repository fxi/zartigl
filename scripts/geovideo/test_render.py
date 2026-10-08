import unittest

import numpy as np
import xarray as xr

from render import (
    ScalarFrames,
    create_manifest,
    require_bucket_cors,
    surface_index,
    validate_config,
    validate_monthly_samples,
)


class GeoVideoSamplingTest(unittest.TestCase):
    def config(self):
        return {
            "catalogEntryId": "89f148bd-dd9d-4428-85ee-21f8af513627",
            "id": "f65db382-5a6e-442b-a7e1-f79898487ec9",
            "sampling": {
                "kind": "annual-month",
                "month": 9,
                "yearStart": 1993,
                "yearEnd": 2025,
                "secondsPerSample": 1,
            },
            "bounds": [9.04, 53.01, 30.21, 65.89],
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
            "id": "89f148bd-dd9d-4428-85ee-21f8af513627",
            "sources": [{
                "id": "e6412d90-decd-46b2-9794-66f21cbf3893", "type": "zarr",
                "provenance": {"provider": "test", "identifiers": {"dataset": "dataset"}},
                "endpoints": {"field": "https://example.test/data.zarr"},
                "variables": {"kind": "scalar", "value": "o2b"},
            }],
        }
        manifest = create_manifest(config, layer, "video.mp4", "mask.png", samples)
        self.assertEqual(manifest["schemaVersion"], 3)
        self.assertEqual(manifest["provenance"]["inputSourceId"], "e6412d90-decd-46b2-9794-66f21cbf3893")
        self.assertEqual(manifest["timeline"], {
            "kind": "sample-sequence",
            "values": ["1993-09-01T00:00:00Z", "1994-09-01T00:00:00Z"],
        })

    def test_rejects_invalid_sampling_ranges(self):
        config = self.config()
        config["sampling"] = {"kind": "annual-month", "month": 13, "yearStart": 2025, "yearEnd": 1993}
        with self.assertRaisesRegex(ValueError, "sampling range"):
            validate_config(config)

    def test_rejects_mutable_names_as_artifact_identity(self):
        config = self.config()
        config["catalogEntryId"] = "baltic-bottom-oxygen"
        with self.assertRaisesRegex(ValueError, "UUIDv4"):
            validate_config(config)

    def test_rejects_style_duplicated_outside_catalog(self):
        config = self.config()
        config["style"] = {"palette": "matter", "colorDomain": [0, 1]}
        with self.assertRaisesRegex(ValueError, "resolved from catalog defaults"):
            validate_config(config)

    def test_rejects_uppercase_uuid_identity_fields(self):
        config = self.config()
        config["id"] = config["id"].upper()
        with self.assertRaisesRegex(ValueError, "lowercase UUIDv4"):
            validate_config(config)
        config = self.config()
        config["catalogEntryId"] = config["catalogEntryId"].upper()
        with self.assertRaisesRegex(ValueError, "lowercase UUIDv4"):
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

    def test_native_sampling_encodes_exact_source_timestamps(self):
        config = self.config()
        config["sampling"] = {
            "kind": "native",
            "values": ["2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z", "2024-01-03T00:00:00Z"],
            "framesPerSample": 2,
        }
        result = validate_config(config)
        self.assertEqual(result["sampling"]["sampleCount"], 3)
        self.assertEqual(result["durationSeconds"], 6 / 24)
        config["sampling"]["values"] = ["2024-01-02T00:00:00Z", "2024-01-01T00:00:00Z"]
        with self.assertRaisesRegex(ValueError, "strictly increasing"):
            validate_config(config)
        config["sampling"]["values"] = []
        with self.assertRaisesRegex(ValueError, "non-empty"):
            validate_config(config)

    def test_native_sampling_requires_source_timestamps(self):
        frames = ScalarFrames.__new__(ScalarFrames)
        frames.times = np.array(["2024-01-01", "2024-01-02"], dtype="datetime64[ns]")
        frames.dataset = {"time": None}
        frames.config = {"sampling": {"kind": "native", "values": ["2024-01-01T00:00:00Z", "2024-01-01T12:00:00Z"]}}
        with self.assertRaisesRegex(ValueError, "not source timestamps"):
            frames._resolve_sample_times()
        frames.config["sampling"]["values"] = ["2024-01-02T00:00:00Z"]
        np.testing.assert_array_equal(frames._resolve_sample_times(), frames.times[1:])

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


class SurfaceIndexTest(unittest.TestCase):
    def test_picks_the_level_nearest_the_surface_in_either_order(self):
        depth = xr.Dataset(coords={"depth": [0.5, 10.0, 100.0]})
        elevation = xr.Dataset(coords={"elevation": [-4000.0, -100.0, -1.5]})
        self.assertEqual(surface_index(depth, "depth"), 0)
        self.assertEqual(surface_index(elevation, "elevation"), 2)
        self.assertEqual(surface_index(xr.Dataset(), "level"), 0)


class FakeCorsClient:
    class exceptions:
        class ClientError(Exception):
            pass

    def __init__(self, rules=None):
        self.rules = rules

    def get_bucket_cors(self, Bucket):
        if self.rules is None:
            raise self.exceptions.ClientError("NoSuchCORSConfiguration")
        return {"CORSRules": self.rules}

    def put_bucket_cors(self, **kwargs):
        raise AssertionError("publish must not rewrite bucket CORS")


class BucketCorsTest(unittest.TestCase):
    RANGE_RULE = {
        "AllowedMethods": ["GET", "HEAD"],
        "AllowedOrigins": ["*"],
        "AllowedHeaders": ["Range"],
        "ExposeHeaders": ["Accept-Ranges", "Content-Length", "Content-Range", "ETag"],
    }

    def test_accepts_range_read_rule(self):
        require_bucket_cors(FakeCorsClient([self.RANGE_RULE]), "bucket")

    def test_rejects_missing_configuration(self):
        with self.assertRaisesRegex(RuntimeError, "no readable CORS"):
            require_bucket_cors(FakeCorsClient(), "bucket")

    def test_rejects_rule_without_range_header(self):
        rule = {**self.RANGE_RULE, "AllowedHeaders": []}
        with self.assertRaisesRegex(RuntimeError, "Range reads"):
            require_bucket_cors(FakeCorsClient([rule]), "bucket")


if __name__ == "__main__":
    unittest.main()
