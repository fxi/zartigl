import copy
import unittest
from unittest import mock

import render

import numpy as np

from archive import (
    failure_kind,
    record_failure,
    record_success,
    run_failed,
    run_summary,
    depth_archives,
    refresh_root_depths,
    depth_id,
    object_prefix,
    prefix_bytes,
    root_depths,
    validate_depths,
    backfill_times,
    chunk_key,
    chunk_period,
    covered_times,
    encoding_profile,
    expired_superseded,
    empty_index,
    interleave,
    is_transient,
    merge_chunk,
    pending_chunks,
    period_end,
    period_start,
    plan_chunks,
    step_filter,
    summarize_plan,
    window_interval,
    without_gaps,
)

ENTRY = "89f148bd-dd9d-4428-85ee-21f8af513627"
SOURCE = "f65db382-5a6e-442b-a7e1-f79898487ec9"


def ns(value: str) -> np.datetime64:
    return np.datetime64(value, "ns")


def hourly(start: str, end: str) -> np.ndarray:
    return np.arange(ns(start), ns(end), np.timedelta64(1, "h"))


def layer(mode="analysis-forecast", cadence="PT1H", **defaults):
    return {
        "id": ENTRY,
        "kind": "scalar",
        "sources": [{
            "id": "e6412d90-decd-46b2-9794-66f21cbf3893", "type": "zarr",
            "temporal": {"mode": mode, "cadence": cadence},
            "endpoints": {"field": "https://example.test/dataset_202406/timeChunked.zarr"},
            "variables": {"kind": "scalar", "value": "thetao"},
        }],
        "defaults": {"palette": "thermal", "raster": {"colorDomain": [0, 30], "vibrance": 0.1, **defaults}},
    }


ARCHIVE = {"sourceId": SOURCE, "catalogEntryId": ENTRY, "windows": [{"full": True}]}


class PeriodTest(unittest.TestCase):
    def test_calendar_alignment(self):
        self.assertEqual(period_start(ns("2026-12-31T23:00"), "P1M"), ns("2026-12-01"))
        self.assertEqual(period_end(ns("2026-12-01"), "P1M"), ns("2027-01-01"))
        self.assertEqual(period_start(ns("2026-07-04"), "P1Y"), ns("2026-01-01"))
        self.assertEqual(period_start(ns("2029-07-04"), "P10Y"), ns("2020-01-01"))
        self.assertEqual(period_end(ns("2020-01-01"), "P10Y"), ns("2030-01-01"))

    def test_chunk_period_depends_on_finality(self):
        self.assertEqual(chunk_period(ARCHIVE, layer("historical", "P1D")), "P1Y")
        self.assertEqual(chunk_period(ARCHIVE, layer("analysis-forecast", "P1D")), "P1M")
        self.assertEqual(chunk_period(ARCHIVE, layer("historical", "P1M")), "P10Y")
        self.assertEqual(chunk_period({**ARCHIVE, "chunk": "P1Y"}, layer("historical", "P1M")), "P1Y")
        with self.assertRaisesRegex(ValueError, "set chunk explicitly"):
            chunk_period(ARCHIVE, layer("historical", "PT15M"))

    def test_window_shapes(self):
        now = ns("2026-10-08")
        self.assertEqual(window_interval({"rolling": "P10D"}, now), (ns("2026-09-28"), now))
        self.assertEqual(window_interval({"start": "2025-03-01T00:00:00Z", "end": "2025-03-10T00:00:00Z"}, now),
                         (ns("2025-03-01"), ns("2025-03-10")))
        # Open-ended: from a date, such as where upstream data begins, up to now.
        self.assertEqual(window_interval({"start": "2024-06-01T00:00:00Z"}, now), (ns("2024-06-01"), now))
        for invalid in ({"full": False}, {"rolling": "P1X"}, {"start": "2025-03-10", "end": "2025-03-01"}, {}):
            with self.assertRaises(ValueError):
                window_interval(invalid, now)


class PlanTest(unittest.TestCase):
    def test_full_history_in_decades_newest_first(self):
        times = np.arange(np.datetime64("1987-01", "M"), np.datetime64("2023-06", "M")).astype("datetime64[ns]")
        chunks = plan_chunks(times, [{"full": True}], "P10Y", ns("2026-10-08"))
        self.assertEqual([chunk["period"]["start"][:4] for chunk in chunks], ["2020", "2010", "2000", "1990", "1980"])
        self.assertEqual(len(chunks[0]["samples"]), 41)
        self.assertEqual(len(chunks[-1]["samples"]), 36)
        self.assertTrue(all(chunk["revision"] is None for chunk in chunks))

    def test_rolling_window_selects_whole_periods_and_excludes_forecasts(self):
        times = hourly("2026-08-01", "2026-10-15")
        now = ns("2026-10-08T12:00")
        chunks = plan_chunks(times, [{"rolling": "P10D"}], "P1M", now)
        self.assertEqual([chunk["period"]["start"] for chunk in chunks], ["2026-10-01T00:00:00Z", "2026-09-01T00:00:00Z"])
        self.assertEqual(chunks[1]["samples"][0], "2026-09-01T00:00:00Z")
        self.assertEqual(len(chunks[1]["samples"]), 30 * 24)
        self.assertEqual(chunks[0]["samples"][-1], "2026-10-08T12:00:00Z")

    def test_sliding_window_keeps_settled_chunk_keys(self):
        times = hourly("2026-08-01", "2026-10-15")
        profile = encoding_profile(ARCHIVE, layer())
        keys = []
        for now in (ns("2026-10-12"), ns("2026-10-13")):
            chunks = plan_chunks(times, [{"rolling": "P20D"}], "P1M", now, horizon=np.timedelta64(10, "D"))
            september = next(chunk for chunk in chunks if chunk["period"]["start"].startswith("2026-09"))
            october = next(chunk for chunk in chunks if chunk["period"]["start"].startswith("2026-10"))
            self.assertIsNone(september["revision"])
            self.assertIsNotNone(october["revision"])
            keys.append((chunk_key(profile, september), chunk_key(profile, october)))
        self.assertEqual(keys[0][0], keys[1][0])
        self.assertNotEqual(keys[0][1], keys[1][1])

    def test_fixed_window_expands_to_its_period(self):
        times = hourly("2025-01-01", "2025-12-31")
        chunks = plan_chunks(times, [{"start": "2025-03-05T00:00:00Z", "end": "2025-03-15T00:00:00Z"}], "P1M",
                             ns("2026-10-08"))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["period"], {"start": "2025-03-01T00:00:00Z", "end": "2025-04-01T00:00:00Z"})
        self.assertEqual(len(chunks[0]["samples"]), 31 * 24)

    def test_step_is_anchored_to_the_epoch(self):
        times = hourly("2026-09-01T01:00", "2026-09-01T12:00")
        kept = step_filter(times, np.timedelta64(3, "h"))
        self.assertEqual([str(value)[11:13] for value in kept], ["03", "06", "09"])

    def test_single_sample_chunks_wait_for_more_data(self):
        times = hourly("2026-09-01", "2026-10-01T01:00")
        chunks = plan_chunks(times, [{"full": True}], "P1M", ns("2026-10-08"))
        self.assertEqual([chunk["period"]["start"][:7] for chunk in chunks], ["2026-09"])


class KeyTest(unittest.TestCase):
    def setUp(self):
        self.chunk = {"samples": ["2026-09-01T00:00:00Z", "2026-09-30T23:00:00Z"], "revision": None}

    def key(self, entry, archive=ARCHIVE):
        return chunk_key(encoding_profile(archive, entry), self.chunk)

    def test_any_timestamp_change_changes_the_key(self):
        profile = encoding_profile(ARCHIVE, layer())
        base = {"samples": ["2026-09-01T00:00:00Z", "2026-09-15T00:00:00Z", "2026-09-30T00:00:00Z"], "revision": None}
        moved = {**base, "samples": ["2026-09-01T00:00:00Z", "2026-09-16T00:00:00Z", "2026-09-30T00:00:00Z"]}
        self.assertNotEqual(chunk_key(profile, base), chunk_key(profile, moved))

    def test_style_only_changes_keep_keys(self):
        base = layer()
        restyled = copy.deepcopy(base)
        restyled["defaults"]["palette"] = "viridis"
        restyled["defaults"]["reversePalette"] = True
        restyled["defaults"]["raster"]["vibrance"] = 0.8
        restyled["defaults"]["raster"]["alphaFadeLow"] = 0.3
        self.assertEqual(self.key(base), self.key(restyled))

    def test_log_scale_sets_the_transfer_and_only_then_changes_the_key(self):
        # Linear profiles carry no transfer, so archives made before it keep their keys.
        self.assertNotIn("transfer", encoding_profile(ARCHIVE, layer()))
        logged = layer(logScale=True)
        self.assertEqual(encoding_profile(ARCHIVE, logged)["transfer"], "log10-1p9")
        self.assertNotEqual(self.key(layer()), self.key(logged))

    def test_encoding_or_dataset_version_changes_keys(self):
        base = layer()
        domain = copy.deepcopy(base)
        domain["defaults"]["raster"]["colorDomain"] = [0, 32]
        version = copy.deepcopy(base)
        version["sources"][0]["endpoints"]["field"] = "https://example.test/dataset_202511/timeChunked.zarr"
        output = {**ARCHIVE, "output": {"crf": 10}}
        self.assertEqual(len({self.key(base), self.key(domain), self.key(version), self.key(base, output)}), 4)


class ScheduleTest(unittest.TestCase):
    def test_interleave_is_round_robin_and_keeps_each_archive_order(self):
        queues = [{"name": "a", "pending": ["a3", "a2", "a1"]}, {"name": "b", "pending": []},
                  {"name": "c", "pending": ["c2", "c1"]}]
        order = [chunk for _queue, chunk in interleave(queues)]
        self.assertEqual(order, ["a3", "c2", "a2", "c1", "a1"])
        self.assertEqual(interleave([]), [])

    def test_encoder_threads_are_not_part_of_the_key(self):
        chunk = {"samples": ["2026-09-01T00:00:00Z", "2026-09-30T23:00:00Z"], "revision": None}
        threaded = {**ARCHIVE, "output": {"threads": 2}}
        self.assertEqual(chunk_key(encoding_profile(threaded, layer()), chunk),
                         chunk_key(encoding_profile(ARCHIVE, layer()), chunk))


class CoverageTest(unittest.TestCase):
    LAYER = {"sources": [{"type": "zarr", "endpoints": {"field": "https://example.test/a.zarr"}}]}

    def test_drops_steps_before_the_declared_start(self):
        times = np.array([ns("2020-07-01"), ns("2024-06-13T03:00"), ns("2024-06-13T04:00"), ns("2024-07-01")])
        with mock.patch("archive.zarr_valid_start", return_value="2024-06-13T04:00:00Z"):
            kept = covered_times(times, self.LAYER)
        self.assertEqual(list(kept), [ns("2024-06-13T04:00"), ns("2024-07-01")])

    def test_keeps_the_axis_without_a_declared_start(self):
        times = np.array([ns("2020-07-01"), ns("2024-07-01")])
        with mock.patch("archive.zarr_valid_start", return_value=None):
            self.assertEqual(len(covered_times(times, self.LAYER)), 2)


DEPTHS = {"name": "elevation", "units": "m", "positive": "up", "surface": -0.494,
          "values": [-92.326, -1.541, -763.333]}


class DepthArchiveTest(unittest.TestCase):
    def test_expands_the_surface_then_depths_shallow_to_deep(self):
        archives = depth_archives({**ARCHIVE, "depths": DEPTHS})
        self.assertNotIn("depth", archives[0])
        self.assertEqual([item["depth"]["value"] for item in archives[1:]], [-1.541, -92.326, -763.333])
        self.assertEqual(archives[1]["depth"], {"name": "elevation", "units": "m", "positive": "up",
                                                "value": -1.541})
        self.assertEqual(depth_archives(ARCHIVE), [ARCHIVE])

    def test_a_depth_lives_beside_its_own_index(self):
        surface, deep = depth_archives({**ARCHIVE, "depths": DEPTHS})[:2]
        base = f"geovideo/{ENTRY}/{SOURCE}"
        self.assertEqual(object_prefix({}, surface), base)
        self.assertEqual(object_prefix({}, deep), f"{base}/depths/{depth_id(deep['depth'])}")
        self.assertRegex(depth_id(deep["depth"]), r"^d[0-9a-f]{10}$")
        self.assertEqual(depth_id(dict(deep["depth"])), depth_id(deep["depth"]))

    def test_only_a_depth_enters_the_key(self):
        layer = {"id": ENTRY, "kind": "vector", "sources": [{"type": "zarr", "endpoints": {"field": "f"},
                                                             "variables": {"kind": "vector"}}]}
        surface, deep = depth_archives({**ARCHIVE, "depths": DEPTHS})[:2]
        self.assertEqual(encoding_profile(surface, layer), encoding_profile(ARCHIVE, layer))
        self.assertNotIn("vertical", encoding_profile(surface, layer))
        self.assertEqual(encoding_profile(deep, layer)["vertical"], deep["depth"])

    def test_root_lists_playable_depths_only(self):
        deep = depth_archives({**ARCHIVE, "depths": DEPTHS})
        played = merge_chunk(empty_index(deep[2]), {"period": {"start": "2026-09-01T00:00:00Z",
                                                               "end": "2026-10-01T00:00:00Z"},
                                                    "samples": ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
                                                    "revision": None, "key": "k"}, ns("2026-10-08"))
        entries = root_depths([(deep[2]["depth"], played), (deep[1]["depth"], empty_index(deep[1]))])
        self.assertEqual(entries, [{**deep[2]["depth"],
                                    "indexUrl": f"depths/{depth_id(deep[2]['depth'])}/index.json"}])
        self.assertEqual(empty_index(deep[2])["vertical"], deep[2]["depth"])

    def test_rejects_malformed_depths(self):
        for depths in ({"values": [-1.0]}, {**DEPTHS, "values": []}, {**DEPTHS, "values": [-1.0, -1.0]},
                       {**DEPTHS, "surface": None}, {**DEPTHS, "surface": -1.541}):
            with self.assertRaises(ValueError):
                validate_depths({**ARCHIVE, "depths": depths})
        validate_depths({**ARCHIVE, "depths": DEPTHS})


class FakeBucket:
    def __init__(self, fail=False):
        self.fail, self.puts = fail, []

    def put_object(self, **kwargs):
        if self.fail:
            raise OSError("bucket unavailable")
        self.puts.append(kwargs["Key"])


class ListingBucket:
    def list_objects_v2(self, **kwargs):
        return {"Contents": [{"Key": "p/k/video.mp4", "Size": 10}, {"Key": "p/index.json", "Size": 1},
                             {"Key": "p/depths/d1/k/video.mp4", "Size": 7}]}


class InventoryTest(unittest.TestCase):
    def test_separates_surface_and_depth_storage(self):
        self.assertEqual(prefix_bytes(ListingBucket(), "b", "p"), (11, 7))


class RootDepthsTest(unittest.TestCase):
    def queues(self):
        surface, deep = depth_archives({**ARCHIVE, "depths": DEPTHS})[:2]
        chunk = {"period": {"start": "2026-09-01T00:00:00Z", "end": "2026-10-01T00:00:00Z"},
                 "samples": ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"], "revision": None, "key": "k"}
        child = {"archive": deep, "index": merge_chunk(empty_index(deep), chunk, ns("2026-10-08"))}
        root = {"archive": surface, "label": "root", "prefix": "p", "index": empty_index(surface),
                "depthQueues": [child], "unread": set()}
        return root, deep

    def test_lists_a_published_depth_once(self):
        root, deep = self.queues()
        bucket = FakeBucket()
        refresh_root_depths(root, bucket, "b")
        refresh_root_depths(root, bucket, "b")
        self.assertEqual(bucket.puts, ["p/index.json"])
        self.assertEqual([entry["value"] for entry in root["index"]["depths"]], [deep["depth"]["value"]])
        self.assertEqual(root["index"]["surface"], {"name": "elevation", "units": "m", "positive": "up",
                                                    "value": -0.494})

    def test_a_failed_write_leaves_the_root_to_retry(self):
        root, _deep = self.queues()
        with self.assertRaises(OSError):
            refresh_root_depths(root, FakeBucket(fail=True), "b")
        self.assertNotIn("depths", root["index"])
        bucket = FakeBucket()
        refresh_root_depths(root, bucket, "b")
        self.assertEqual(bucket.puts, ["p/index.json"])

    def test_keeps_a_depth_whose_index_was_not_read(self):
        root, deep = self.queues()
        refresh_root_depths(root, FakeBucket(), "b")
        published = root["index"]["depths"]
        root["depthQueues"], root["unread"] = [], {depth_id(deep["depth"])}
        refresh_root_depths(root, FakeBucket(), "b")
        self.assertEqual(root["index"]["depths"], published)


class RunOutcomeTest(unittest.TestCase):
    def queue(self, pending=4, depth=None):
        archive = {**ARCHIVE, "title": "Currents", **({"depth": depth} if depth else {})}
        return {"archive": archive, "pending": [{}] * pending}

    def test_classifies_failures(self):
        self.assertEqual(failure_kind(ValueError("No valid upstream data in the 10 frames")), "no-data")
        self.assertEqual(failure_kind(render.EmptySamplesError(["2026-11-01"])), "no-data")
        self.assertEqual(failure_kind(RuntimeError("Vector GeoVideo exceeds its code error budget: {}")), "budget")
        self.assertEqual(failure_kind(ConnectionError("reset")), "network")
        self.assertEqual(failure_kind(RuntimeError("ffmpeg failed")), "other")

    def test_a_queue_goes_on_until_three_failures_in_a_row(self):
        queue = self.queue()
        self.assertFalse(record_failure(queue, RuntimeError("a")))
        self.assertFalse(record_failure(queue, RuntimeError("b")))
        record_success(queue)
        self.assertFalse(record_failure(queue, RuntimeError("c")))
        self.assertFalse(record_failure(queue, RuntimeError("d")))
        self.assertTrue(record_failure(queue, RuntimeError("e")))
        self.assertTrue(queue["failed"])
        self.assertEqual(queue["stats"]["firstError"], "other: a")

    def test_fails_a_run_beyond_the_floor_and_the_rate(self):
        ok, broken = self.queue(pending=100), self.queue(pending=100)
        for _ in range(97):
            record_success(ok)
        for _ in range(3):
            record_failure(broken, RuntimeError("x"))
            record_success(broken)
        # 3 failures out of 100 attempts: within the floor of 3.
        self.assertFalse(run_failed([ok, broken], 3, 0.05))
        record_failure(broken, RuntimeError("y"))
        self.assertTrue(run_failed([ok, broken], 3, 0.01))
        self.assertFalse(run_failed([ok, broken], 3, 0.05))
        self.assertTrue(run_failed([ok, {**self.queue(), "setupError": "setup: index"}], 3, 0.05))
        self.assertTrue(run_failed([ok, {**self.queue(), "publishError": "publication: root"}], 3, 0.05))

    def test_summarizes_the_queues_the_run_touched(self):
        surface, deep, idle = self.queue(), self.queue(depth={"value": -5727.9, "units": "m"}), self.queue()
        record_success(surface)
        record_failure(deep, ValueError("No valid upstream data"))
        table = run_summary([surface, deep, idle]).splitlines()
        self.assertEqual(len(table), 5)
        self.assertIn("| Currents | 1 | 0 | 3 | ok |", table[2])
        # A failed chunk stays to publish.
        self.assertIn("| Currents @ -5727.9 m | 0 | 1 | 4 | with failures | no-data: No valid upstream data |",
                      table[3])
        # Totals count the queue the run did not touch too.
        self.assertEqual(table[4], "| **Total** | 1 | 1 | 11 | | |")


class GapTest(unittest.TestCase):
    def test_gaps_are_dropped_recorded_and_keep_the_planned_key(self):
        chunk = {"period": {"start": "2020-01-01T00:00:00Z", "end": "2030-01-01T00:00:00Z"}, "key": "k",
                 "samples": ["2021-06-01T00:00:00Z", "2021-07-01T00:00:00Z", "2021-08-01T00:00:00Z"],
                 "revision": None}
        kept = without_gaps(chunk, ["2021-07-01T00:00:00Z"])
        self.assertEqual(kept["samples"], ["2021-06-01T00:00:00Z", "2021-08-01T00:00:00Z"])
        self.assertEqual((kept["key"], kept["gaps"]), ("k", ["2021-07-01T00:00:00Z"]))
        entry = merge_chunk(empty_index(ARCHIVE), kept, ns("2026-10-08"))["chunks"][0]
        self.assertEqual((entry["samples"], entry["gaps"]), (2, ["2021-07-01T00:00:00Z"]))
        with self.assertRaisesRegex(ValueError, "fewer than two"):
            without_gaps(chunk, chunk["samples"][1:])


class IndexTest(unittest.TestCase):
    def chunk(self, key, start="2026-09-01T00:00:00Z"):
        return {"period": {"start": start, "end": "2026-10-01T00:00:00Z"},
                "samples": [start, "2026-09-30T23:00:00Z"], "revision": None, "key": key}

    def test_merge_replaces_a_period_and_keeps_the_old_key_for_a_grace_period(self):
        now = ns("2026-10-08")
        index = merge_chunk(empty_index(ARCHIVE), self.chunk("aaa"), now)
        self.assertEqual(pending_chunks([self.chunk("aaa")], index), [])
        self.assertEqual(merge_chunk(index, self.chunk("aaa"), now)["superseded"], [])
        index = merge_chunk(index, self.chunk("bbb"), now)
        self.assertEqual([chunk["key"] for chunk in index["chunks"]], ["bbb"])
        self.assertEqual(index["chunks"][0]["manifestUrl"], "bbb/manifest.json")
        self.assertEqual(index["superseded"], [{"key": "aaa", "at": "2026-10-08T00:00:00Z"}])
        expired, kept = expired_superseded(index, ns("2026-10-08T12:00"))
        self.assertEqual((expired, len(kept["superseded"])), ([], 1))
        expired, kept = expired_superseded(index, ns("2026-10-09"))
        self.assertEqual((expired, kept["superseded"]), (["aaa"], []))

    def test_records_the_encoded_sample_times(self):
        entry = merge_chunk(empty_index(ARCHIVE), self.chunk("aaa"), ns("2026-10-08"))["chunks"][0]
        self.assertEqual(entry["times"], ["2026-09-01T00:00:00Z", "2026-09-30T23:00:00Z"])

    def test_backfills_times_from_manifests_once(self):
        index = merge_chunk(empty_index(ARCHIVE), self.chunk("aaa"), ns("2026-10-08"))
        legacy = {**index, "chunks": [{k: v for k, v in index["chunks"][0].items() if k != "times"}]}
        manifests = {"aaa/manifest.json": {"timeline": {"values": ["2026-09-01T00:00:00Z", "2026-09-30T23:00:00Z"]}}}
        filled, changed = backfill_times(legacy, manifests.__getitem__)
        self.assertTrue(changed)
        self.assertEqual(filled, index)
        self.assertEqual(backfill_times(filled, self.fail), (filled, False))

    def test_backfill_rejects_a_manifest_that_disagrees(self):
        index = merge_chunk(empty_index(ARCHIVE), self.chunk("aaa"), ns("2026-10-08"))
        legacy = {**index, "chunks": [{k: v for k, v in index["chunks"][0].items() if k != "times"}]}
        with self.assertRaisesRegex(RuntimeError, "do not match"):
            backfill_times(legacy, lambda _url: {"timeline": {"values": ["2026-09-01T00:00:00Z"]}})

    def test_chunks_stay_sorted_by_period(self):
        index = empty_index(ARCHIVE)
        for start in ("2026-09-01T00:00:00Z", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"):
            index = merge_chunk(index, self.chunk(start[:7], start), ns("2026-10-08"))
        self.assertEqual([chunk["key"] for chunk in index["chunks"]], ["2026-07", "2026-08", "2026-09"])


if __name__ == "__main__":
    unittest.main()


class SummaryTest(unittest.TestCase):
    def test_lists_incomplete_and_failing_archives_then_the_total(self):
        pending = [{"period": "2026-09-01T00:00:00Z", "samples": 30, "key": "a", "provisional": False}]
        results = [
            {"sourceId": SOURCE, "title": "Done", "required": 3, "present": 3, "pending": []},
            {"sourceId": SOURCE, "title": "Running", "required": 4, "present": 1, "pending": pending * 3},
            {"sourceId": ENTRY, "title": None, "error": "index unreadable"},
        ]
        self.assertEqual(summarize_plan(results).splitlines(), [
            "   1/4     Running",
            f"    error  {ENTRY}: index unreadable",
            "Total 4/7 chunks (57.1%); 1/3 archives complete",
        ])


class ClientError(Exception):
    """Stands for aiohttp's base class, matched by name."""


class ServerDisconnectedError(ClientError):
    pass


class RetryTest(unittest.TestCase):
    def test_network_failures_are_transient_and_rendering_failures_are_not(self):
        self.assertTrue(is_transient(ServerDisconnectedError("Server disconnected")))
        self.assertTrue(is_transient(ConnectionResetError()))
        self.assertTrue(is_transient(TimeoutError()))
        try:
            try:
                raise ServerDisconnectedError("Server disconnected")
            except ServerDisconnectedError as cause:
                raise RuntimeError("Zarr read failed") from cause
        except RuntimeError as wrapped:
            self.assertTrue(is_transient(wrapped))
        self.assertFalse(is_transient(RuntimeError("Scalar-luma artifact exceeds its code error budget")))
        self.assertFalse(is_transient(ValueError("No valid upstream data")))

    def test_a_dropped_connection_retries_the_chunk(self):
        import archive
        from unittest import mock

        chunk = {"period": {"start": "2026-06-01T00:00:00Z"}, "key": "abc"}
        attempts = mock.Mock(side_effect=[ServerDisconnectedError("Server disconnected"), chunk])
        with mock.patch.object(archive, "render_chunk", attempts), \
                mock.patch.object(archive.render, "publish") as publish, \
                mock.patch.object(archive.time, "sleep") as sleep:
            self.assertIs(archive.render_and_publish({"sourceId": SOURCE}, {}, chunk, {}, "prefix", None), chunk)
        self.assertEqual(attempts.call_count, 2)
        sleep.assert_called_once_with(archive.TRANSIENT_RETRY_DELAYS[0])
        publish.assert_called_once()

    def test_a_rendering_failure_is_not_retried(self):
        import archive
        from unittest import mock

        chunk = {"period": {"start": "2026-06-01T00:00:00Z"}, "key": "abc"}
        failing = mock.Mock(side_effect=RuntimeError("exceeds its code error budget"))
        with mock.patch.object(archive, "render_chunk", failing), mock.patch.object(archive.time, "sleep"):
            with self.assertRaises(RuntimeError):
                archive.render_and_publish({"sourceId": SOURCE}, {}, chunk, {}, "prefix", None)
        self.assertEqual(failing.call_count, 1)
