import copy
import unittest

import numpy as np

from archive import (
    chunk_key,
    chunk_period,
    encoding_profile,
    expired_superseded,
    empty_index,
    merge_chunk,
    pending_chunks,
    period_end,
    period_start,
    plan_chunks,
    step_filter,
    window_interval,
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
        restyled["defaults"]["raster"]["vibrance"] = 0.8
        restyled["defaults"]["raster"]["logScale"] = True
        self.assertEqual(self.key(base), self.key(restyled))

    def test_encoding_or_dataset_version_changes_keys(self):
        base = layer()
        domain = copy.deepcopy(base)
        domain["defaults"]["raster"]["colorDomain"] = [0, 32]
        version = copy.deepcopy(base)
        version["sources"][0]["endpoints"]["field"] = "https://example.test/dataset_202511/timeChunked.zarr"
        output = {**ARCHIVE, "output": {"crf": 10}}
        self.assertEqual(len({self.key(base), self.key(domain), self.key(version), self.key(base, output)}), 4)


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

    def test_chunks_stay_sorted_by_period(self):
        index = empty_index(ARCHIVE)
        for start in ("2026-09-01T00:00:00Z", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"):
            index = merge_chunk(index, self.chunk(start[:7], start), ns("2026-10-08"))
        self.assertEqual([chunk["key"] for chunk in index["chunks"]], ["2026-07", "2026-08", "2026-09"])


if __name__ == "__main__":
    unittest.main()
