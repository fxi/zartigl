import unittest

from copernicus_metadata import arco_store, parse_wmts_visualization, stac_url, valid_start, zarr_valid_start
from query_dataset import parse_vector_pair, select_kind_and_variable


CAPABILITIES = b"""<?xml version="1.0"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0"
 xmlns:ows="http://www.opengis.net/ows/1.1"
 xmlns:xlink="http://www.w3.org/1999/xlink">
 <Contents><Layer>
  <ows:Identifier>product/dataset/o2b</ows:Identifier>
  <ows:Title>Dissolved Oxygen</ows:Title>
  <ows:WGS84BoundingBox><ows:LowerCorner>9 53</ows:LowerCorner><ows:UpperCorner>30 66</ows:UpperCorner></ows:WGS84BoundingBox>
  <Style isDefault="false"><ows:Identifier>cmap:wrong</ows:Identifier></Style>
  <Style isDefault="true">
   <ows:Identifier>cmap:matter</ows:Identifier>
   <LegendURL format="application/json" xlink:href="https://example.test/legend.json?FORMAT=application%252Fjson"/>
  </Style>
 </Layer></Contents>
</Capabilities>"""

LEGEND = {
    "continuous": {
        "clamp": True,
        "logScale": False,
        "valueMin": 65.2,
        "valueMax": 445.4,
        "cmap": {"colorMap": [[1, 2, 3]]},
        "cmapName": "matter",
        "units": "mmol m-3",
    },
}


class CopernicusMetadataTest(unittest.TestCase):
    def test_scalar_selection_is_explicit(self):
        variables = {"chl": {}, "o2b": {}}
        self.assertEqual(
            select_kind_and_variable(variables, "o2b", None),
            ("scalar", "o2b", None),
        )
        with self.assertRaisesRegex(ValueError, "requires --variable"):
            select_kind_and_variable(variables, None, None)

    def test_explicit_vector_pair_overrides_detection(self):
        variables = {"tauuo": {}, "tauvo": {}}
        self.assertEqual(
            select_kind_and_variable(variables, None, None, parse_vector_pair("tauuo, tauvo")),
            ("vector", None, ("tauuo", "tauvo")),
        )
        with self.assertRaisesRegex(ValueError, "unknown variable: tauvx"):
            select_kind_and_variable(variables, None, None, ("tauuo", "tauvx"))
        with self.assertRaisesRegex(ValueError, "mutually exclusive"):
            select_kind_and_variable(variables, "tauuo", None, ("tauuo", "tauvo"))
        with self.assertRaisesRegex(ValueError, "expects"):
            parse_vector_pair("tauuo")

    def test_resolves_default_json_legend(self):
        calls = []
        result = parse_wmts_visualization(
            CAPABILITIES,
            "o2b",
            lambda url: calls.append(url) or LEGEND,
        )
        self.assertEqual(calls, ["https://example.test/legend.json?FORMAT=application%2Fjson"])
        self.assertEqual(result["palette"], "matter")
        self.assertEqual(result["colorDomain"], [65.2, 445.4])
        self.assertEqual(result["bounds"], [9, 53, 30, 66])
        self.assertEqual(result["unit"], "mmol m-3")
        self.assertTrue(result["clamp"])

    def test_requires_explicit_matching_variable(self):
        with self.assertRaisesRegex(ValueError, "found 0"):
            parse_wmts_visualization(CAPABILITIES, "chl", lambda _url: LEGEND)

    def test_rejects_invalid_legend_range(self):
        invalid = {"continuous": {**LEGEND["continuous"], "valueMin": 10, "valueMax": 10}}
        with self.assertRaisesRegex(ValueError, "invalid value range"):
            parse_wmts_visualization(CAPABILITIES, "o2b", lambda _url: invalid)



WIND_FIELD = (
    "https://s3.waw3-1.cloudferro.com/mdl-arco-time-050/arco/WIND_GLO_PHY_L4_NRT_012_004/"
    "cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H_202207/timeChunked.zarr"
)
# Excerpt of the wind dataset STAC: the axis starts in 2020, its data in 2024.
WIND_STAC = {
    "properties": {
        "cube:dimensions": {"time": {"extent": ["2020-07-01T00:00:00Z", "2026-11-01T23:00:00Z"]}},
        "admp_valid_start_date": "2024-06-13T04:00:00.000000000Z",
    },
    "assets": {
        "timeChunked": {"viewDims": {"time": {"validStartDate": "2024-06-13T04:00:00.000000000Z"}}},
        "geoChunked": {"viewDims": {"time": {"validStartDate": "2024-06-14T00:00:00.000000000Z"}}},
    },
}


class ValidStartTest(unittest.TestCase):
    def test_reads_the_producer_valid_start(self):
        self.assertEqual(valid_start(WIND_STAC, "timeChunked"), "2024-06-13T04:00:00Z")

    def test_falls_back_to_the_dataset_valid_start(self):
        self.assertEqual(valid_start({"properties": WIND_STAC["properties"]}, "timeChunked"), "2024-06-13T04:00:00Z")

    def test_none_without_a_declared_start(self):
        self.assertIsNone(valid_start({"properties": {}}, "timeChunked"))

    def test_locates_the_stac_of_an_arco_store(self):
        product, tag, asset = arco_store(WIND_FIELD)
        self.assertEqual(asset, "timeChunked")
        self.assertEqual(
            stac_url(product, tag),
            "https://stac.marine.copernicus.eu/metadata/WIND_GLO_PHY_L4_NRT_012_004/"
            "cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H_202207/dataset.stac.json",
        )

    def test_source_start_is_the_later_of_its_stores(self):
        source = {
            "type": "zarr",
            "provenance": {"provider": "copernicus-marine"},
            "endpoints": {"field": WIND_FIELD, "pointSeries": WIND_FIELD.replace("timeChunked", "geoChunked")},
        }
        self.assertEqual(zarr_valid_start(source, lambda _url: WIND_STAC), "2024-06-14T00:00:00Z")

    def test_ignores_stores_outside_copernicus(self):
        source = {"type": "zarr", "provenance": {"provider": "noaa"}, "endpoints": {"field": WIND_FIELD}}
        self.assertIsNone(zarr_valid_start(source, lambda _url: self.fail("no STAC read")))


if __name__ == "__main__":
    unittest.main()
