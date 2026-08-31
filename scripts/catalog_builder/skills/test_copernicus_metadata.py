import unittest

from copernicus_metadata import parse_wmts_visualization
from query_dataset import select_kind_and_variable


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


if __name__ == "__main__":
    unittest.main()
