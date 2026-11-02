from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_catalog import with_coverage  # noqa: E402
from test_copernicus_metadata import WIND_FIELD, WIND_STAC  # noqa: E402

SOURCE_ID = "c815028f-1cbf-4592-922a-2e80b3cfae0b"


def catalog(start: str | None = None) -> dict:
    temporal = {"mode": "near-real-time", "cadence": "PT1H", **({"start": start} if start else {})}
    return {"schemaVersion": 2, "layers": [{
        "id": "72aa3549-8cdf-4275-b8f7-5b32ca40a3f2",
        "aliases": ["surface-wind"],
        "sources": [{
            "id": SOURCE_ID,
            "type": "zarr",
            "provenance": {"provider": "copernicus-marine"},
            "temporal": temporal,
            "endpoints": {"field": WIND_FIELD},
        }],
    }]}


def start_of(document: dict) -> str | None:
    return document["layers"][0]["sources"][0]["temporal"].get("start")


class CoverageTest(unittest.TestCase):
    def test_publishes_the_producer_start_without_touching_the_input(self):
        source = catalog()
        resolved, changes, failures = with_coverage(source, None, lambda _url: WIND_STAC)
        self.assertEqual(start_of(resolved), "2024-06-13T04:00:00Z")
        self.assertIsNone(start_of(source))
        self.assertEqual(changes, [{
            "entry": "surface-wind", "sourceId": SOURCE_ID, "from": None, "to": "2024-06-13T04:00:00Z",
        }])
        self.assertEqual(failures, [])

    def test_reports_no_change_once_published(self):
        live = catalog("2024-06-13T04:00:00Z")
        _resolved, changes, _failures = with_coverage(catalog(), live, lambda _url: WIND_STAC)
        self.assertEqual(changes, [])

    def test_keeps_the_live_start_when_the_stac_fails(self):
        def unreachable(_url):
            raise OSError("STAC unreachable")

        live = catalog("2024-05-01T00:00:00Z")
        resolved, changes, failures = with_coverage(catalog(), live, unreachable)
        self.assertEqual(start_of(resolved), "2024-05-01T00:00:00Z")
        self.assertEqual(changes, [])
        self.assertEqual(len(failures), 1)


if __name__ == "__main__":
    unittest.main()
