import json
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import xarray as xr

from render import (
    CodeErrorBudgetError,
    ScalarFrames,
    create_manifest,
    encode_within_budget,
    encoding_ladder,
    ffmpeg_command,
    probe_media,
    render_scalar_luma,
    require_bucket_cors,
    scalar_transfer,
    depth_levels,
    select_level,
    surface_index,
    validation_positions,
    vertical_axis,
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


class ScalarTransferTest(unittest.TestCase):
    def style(self, log_scale):
        return {"style": {"colorDomain": [0.0, 1.0], "logScale": log_scale}}

    def test_log_scaled_codes_follow_the_displayed_curve(self):
        values = np.array([[0.0, 0.01, 0.1, 1.0]], dtype=np.float32)
        linear = render_scalar_luma(values, self.style(False))[0, :, 0]
        logged = render_scalar_luma(values, self.style(True))[0, :, 0]
        np.testing.assert_array_equal(linear, [8, 10, 32, 247])
        # The low end gets far more codes: 0.01 is code 17, not 10.
        np.testing.assert_array_equal(logged, [8, 17, 75, 247])
        # The browser inverts it: t = (10^code - 1) / 9 within half a code.
        code = (logged.astype(float) - 8) / (247 - 8)
        np.testing.assert_allclose((10 ** code - 1) / 9, values[0], atol=0.004)

    def test_manifest_records_the_transfer(self):
        self.assertEqual(scalar_transfer({"logScale": True}), "log10-1p9")
        self.assertEqual(scalar_transfer({"logScale": False}), "linear")


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


# Copernicus global physics (GLORYS-like) depths, metres, positive down.
GLOBAL_DEPTHS = [
    0.494, 1.541, 2.646, 3.819, 5.078, 6.441, 7.93, 9.573, 11.405, 13.467, 15.81, 18.496,
    21.599, 25.211, 29.445, 34.434, 40.344, 47.374, 55.764, 65.807, 77.854, 92.326, 109.729,
    130.666, 155.851, 186.126, 222.475, 266.04, 318.127, 380.213, 453.938, 541.089, 643.567,
    763.333, 902.339, 1062.44, 1245.291, 1452.251, 1684.284, 1941.893, 2225.078, 2533.336,
    2865.703, 3220.82, 3597.032, 3992.484, 4405.224, 4833.291, 5274.784, 5727.917,
]


class DepthLevelTest(unittest.TestCase):
    def test_spaces_levels_geometrically_from_the_surface(self):
        levels = depth_levels(GLOBAL_DEPTHS, 10)
        self.assertEqual(len(levels), 10)
        self.assertEqual((levels[0], levels[-1]), (0.494, 5727.917))
        self.assertTrue(set(levels) <= set(GLOBAL_DEPTHS))
        self.assertEqual(levels, sorted(levels))
        # Dense near the surface: half the levels sit above 50 m.
        self.assertGreaterEqual(sum(level < 50 for level in levels), 5)

    def test_keeps_the_sign_of_elevation_axes(self):
        levels = depth_levels([-value for value in GLOBAL_DEPTHS], 10)
        self.assertEqual((levels[0], levels[-1]), (-0.494, -5727.917))

    def test_a_zero_surface_takes_one_slot(self):
        levels = depth_levels([0.0, 10.0, 100.0, 1000.0], 3)
        self.assertEqual(levels, [0.0, 10.0, 1000.0])

    def test_short_axes_and_single_levels(self):
        self.assertEqual(depth_levels([5.0, 1.0, 2.0], 10), [1.0, 2.0, 5.0])
        self.assertEqual(depth_levels([3.0], 10), [3.0])
        self.assertEqual(depth_levels(GLOBAL_DEPTHS, 1), [0.494])

    def test_identifies_the_shared_vertical_coordinate(self):
        dataset = xr.Dataset(
            {name: (("time", "depth", "latitude", "longitude"), np.zeros((1, 3, 1, 1))) for name in ("uo", "vo")},
            coords={"depth": ("depth", [0.5, 10.0, 100.0], {"units": "m", "positive": "down"})},
        )
        axis = vertical_axis(dataset, ["uo", "vo"])
        self.assertEqual(axis, {"name": "depth", "values": [0.5, 10.0, 100.0], "units": "m", "positive": "down"})
        flat = xr.Dataset({"sst": (("time", "latitude", "longitude"), np.zeros((1, 1, 1)))})
        self.assertIsNone(vertical_axis(flat, ["sst"]))

    def test_refuses_pressure_levels(self):
        dataset = xr.Dataset(
            {"t": (("time", "level", "latitude", "longitude"), np.zeros((1, 2, 1, 1)))},
            coords={"level": ("level", [1000.0, 500.0], {"units": "hPa"})},
        )
        with self.assertRaisesRegex(ValueError, "Unsupported vertical"):
            vertical_axis(dataset, ["t"])


class SelectLevelTest(unittest.TestCase):
    def dataset(self, units="m"):
        values = np.arange(3 * 2).reshape(1, 3, 1, 2).astype(float)
        return xr.Dataset(
            {"thetao": (("time", "elevation", "latitude", "longitude"), values)},
            coords={"elevation": ("elevation", [-0.5, -10.0, -100.0], {"units": units, "positive": "up"})},
        )

    DEPTH = {"name": "elevation", "units": "m", "positive": "up", "value": -10.0}

    def test_selects_the_recorded_level_else_the_surface(self):
        dataset = self.dataset()
        self.assertEqual(select_level(dataset["thetao"], dataset, self.DEPTH).values.ravel().tolist(), [2.0, 3.0])
        self.assertEqual(select_level(dataset["thetao"], dataset, None).values.ravel().tolist(), [0.0, 1.0])

    def test_refuses_a_level_the_store_no_longer_holds(self):
        dataset = self.dataset()
        for depth, message in (({**self.DEPTH, "value": -11.0}, "not found"),
                               ({**self.DEPTH, "name": "depth"}, "not found"),
                               ({**self.DEPTH, "units": "km"}, "units changed")):
            with self.assertRaisesRegex(ValueError, message):
                select_level(dataset["thetao"], dataset, depth)


class ValidationPositionTest(unittest.TestCase):
    def test_validates_the_grid_cells_inside_the_mask(self):
        mask = np.zeros((64, 128), bool)
        mask[:, :64] = True
        positions = validation_positions(mask)
        self.assertTrue(mask.ravel()[positions].all())
        self.assertEqual(positions.size, 32 * 32)

    def test_spreads_over_a_basin_the_grid_misses(self):
        mask = np.zeros((1024, 2048), bool)
        mask[1:9, 1:9] = True  # between grid points every 32 rows and columns
        positions = validation_positions(mask)
        self.assertEqual(positions.size, 64)
        self.assertTrue(mask.ravel()[positions].all())


class EncodingLadderTest(unittest.TestCase):
    OUTPUT = {"width": 64, "height": 32, "fps": 24, "crf": 8, "maxBitrate": "48M", "preset": "fast"}

    def test_raises_the_ceiling_before_lowering_crf(self):
        self.assertEqual(encoding_ladder(self.OUTPUT), [
            {"crf": 8, "maxBitrate": "48M"},
            {"crf": 8, "maxBitrate": "96M"},
            {"crf": 6, "maxBitrate": "96M"},
            {"crf": 4, "maxBitrate": "96M"},
        ])

    def test_never_exceeds_the_level_ceiling(self):
        ladder = encoding_ladder({**self.OUTPUT, "maxBitrate": "96M"})
        self.assertEqual([step["maxBitrate"] for step in ladder], ["96M", "96M", "96M"])
        self.assertEqual([step["crf"] for step in ladder], [8, 6, 4])

    def test_never_retries_lossless(self):
        ladder = encoding_ladder({**self.OUTPUT, "crf": 2, "maxBitrate": "96M"})
        self.assertEqual([step["crf"] for step in ladder], [2, 1])

    def test_rejects_profiles_and_levels_phones_may_not_decode(self):
        for profile, level in (("High 4:4:4 Predictive", 41), ("High", 51)):
            stream = {"codec_name": "h264", "pix_fmt": "yuv420p", "profile": profile, "level": level}
            completed = mock.Mock(stdout=json.dumps({"streams": [stream], "format": {}}))
            with mock.patch("render.shutil.which", return_value="ffprobe"), \
                    mock.patch("render.subprocess.run", return_value=completed):
                with self.assertRaisesRegex(RuntimeError, "High at level 5.0"):
                    probe_media(Path("video.mp4"), {"output": self.OUTPUT}, 1)

    def test_buffer_follows_the_ceiling(self):
        with mock.patch("render.shutil.which", return_value="ffmpeg"):
            command = ffmpeg_command({"output": self.OUTPUT}, Path("video.mp4"), "frames.rgb",
                                     {"crf": 6, "maxBitrate": "96M"})
        self.assertEqual(command[command.index("-bufsize") + 1], "96M")
        self.assertEqual(command[command.index("-crf") + 1], "6")
        self.assertEqual(command[command.index("-i") + 1], "frames.rgb")

    def test_retries_from_raw_frames_until_the_budget_passes(self):
        config = {"output": self.OUTPUT}
        failure = {"p99AbsoluteCodeError": 5, "maxAbsoluteCodeError": 17}
        results = [CodeErrorBudgetError(failure), {"maxAbsoluteCodeError": 11}]

        def validate(*_args):
            result = results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        with mock.patch("render.shutil.which", return_value="ffmpeg"), \
                mock.patch("render.subprocess.run") as run, \
                mock.patch("render.probe_media", return_value={}), \
                mock.patch("render.validate_encoded_values", side_effect=validate):
            encoding, _probe, validation = encode_within_budget(
                config, Path("video.mp4"), Path("frames.rgb"), np.arange(4), 2,
            )
        self.assertEqual(run.call_count, 1)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-maxrate") + 1], "96M")
        self.assertEqual(encoding["maxBitrate"], "96M")
        self.assertEqual(encoding["failedAttempts"][0]["valueValidation"], failure)
        self.assertEqual(validation, {"maxAbsoluteCodeError": 11})

    def test_fails_once_the_ladder_is_exhausted(self):
        config = {"output": {**self.OUTPUT, "maxBitrate": "96M", "crf": 2}}
        with mock.patch("render.shutil.which", return_value="ffmpeg"), \
                mock.patch("render.subprocess.run"), \
                mock.patch("render.probe_media", return_value={}), \
                mock.patch("render.validate_encoded_values", side_effect=CodeErrorBudgetError({})):
            with self.assertRaises(CodeErrorBudgetError):
                encode_within_budget(config, Path("video.mp4"), Path("frames.rgb"), np.arange(4), 2)


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
