"""Shared deterministic readers for Copernicus Marine visualization metadata."""

from __future__ import annotations

import json
from typing import Any, Callable
from urllib.parse import unquote
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


WMTS_NS = {
    "wmts": "http://www.opengis.net/wmts/1.0",
    "ows": "http://www.opengis.net/ows/1.1",
    "xlink": "http://www.w3.org/1999/xlink",
}
XLINK_HREF = "{http://www.w3.org/1999/xlink}href"


def fetch_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "zartigl-catalog-builder/1"})
    with urlopen(request, timeout=30) as response:
        return response.read()


def fetch_json(url: str) -> Any:
    return json.loads(fetch_bytes(url))


def default_wmts_layer(root: ET.Element, variable: str) -> ET.Element:
    suffix = f"/{variable}"
    layers = root.findall(".//wmts:Contents/wmts:Layer", WMTS_NS)
    matches = [
        layer for layer in layers
        if (layer.findtext("ows:Identifier", namespaces=WMTS_NS) or "").endswith(suffix)
    ]
    if len(matches) != 1:
        raise ValueError(f"WMTS expected one layer ending in {suffix!r}; found {len(matches)}")
    return matches[0]


def parse_wmts_visualization(
    capabilities: bytes | str,
    variable: str,
    json_loader: Callable[[str], Any] = fetch_json,
) -> dict[str, Any]:
    """Resolve the default WMTS JSON legend for one variable."""
    root = ET.fromstring(capabilities)
    layer = default_wmts_layer(root, variable)
    layer_id = layer.findtext("ows:Identifier", namespaces=WMTS_NS)
    title = layer.findtext("ows:Title", namespaces=WMTS_NS)
    box = layer.find("ows:WGS84BoundingBox", WMTS_NS)
    if box is None:
        raise ValueError(f"WMTS layer {layer_id} has no WGS84 bounding box")
    lower = [float(value) for value in (box.findtext("ows:LowerCorner", namespaces=WMTS_NS) or "").split()]
    upper = [float(value) for value in (box.findtext("ows:UpperCorner", namespaces=WMTS_NS) or "").split()]
    if len(lower) != 2 or len(upper) != 2:
        raise ValueError(f"WMTS layer {layer_id} has an invalid WGS84 bounding box")

    styles = layer.findall("wmts:Style", WMTS_NS)
    style = next((item for item in styles if item.get("isDefault") == "true"), None)
    if style is None:
        raise ValueError(f"WMTS layer {layer_id} has no default style")
    style_id = style.findtext("ows:Identifier", namespaces=WMTS_NS)
    legend_url = next((
        item.get(XLINK_HREF) for item in style.findall("wmts:LegendURL", WMTS_NS)
        if item.get("format") == "application/json"
    ), None)
    if not legend_url:
        raise ValueError(f"WMTS layer {layer_id} default style has no JSON legend")
    # Copernicus capabilities percent-encode the JSON MIME type twice
    # (application%252Fjson). Decode one URL layer before requesting it.
    legend_url = unquote(legend_url)
    payload = json_loader(legend_url)
    continuous = payload.get("continuous") if isinstance(payload, dict) else None
    if not isinstance(continuous, dict):
        raise ValueError(f"WMTS legend for {layer_id} is not continuous")
    color_map = continuous.get("cmap")
    if not isinstance(color_map, dict):
        raise ValueError(f"WMTS legend for {layer_id} has no color map")
    value_min = continuous.get("valueMin")
    value_max = continuous.get("valueMax")
    if not isinstance(value_min, (int, float)) or not isinstance(value_max, (int, float)) or value_min >= value_max:
        raise ValueError(f"WMTS legend for {layer_id} has an invalid value range")

    return {
        "authority": "copernicus-marine-wmts-legend",
        "layer": layer_id,
        "title": title,
        "bounds": [lower[0], lower[1], upper[0], upper[1]],
        "style": style_id,
        "legendUrl": legend_url,
        "palette": continuous.get("cmapName") or color_map.get("cmapName"),
        "colorDomain": [float(value_min), float(value_max)],
        "logScale": bool(continuous.get("logScale", False)),
        "clamp": bool(continuous.get("clamp", False)),
        "unit": continuous.get("units") or color_map.get("units"),
        "colors": color_map.get("colorMap"),
    }


def discover_wmts_visualization(capabilities_url: str, variable: str) -> dict[str, Any]:
    return parse_wmts_visualization(fetch_bytes(capabilities_url), variable)


def palette_id(style: str | None, discovered: str | None) -> str | None:
    if discovered:
        return discovered
    if style and style.startswith("cmap:"):
        return style.removeprefix("cmap:").split(",", 1)[0]
    return None
