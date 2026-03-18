# Catalog Builder — Agentic Prompt

You are adding or updating views in `public/data/catalog.json` for the zartigl map visualization app.
Read this document fully before doing anything else.

---

## 1. View Schema

Each entry in `catalog.json["views"]` must follow this structure:

```json
{
  "id":             "kebab-case-slug",
  "label":          "Human Readable Name",
  "description":    "One sentence describing what this view shows.",
  "category":       "Ocean | Atmosphere | Biology | Waves | Ice",
  "type":           "vector | scalar",
  "source_dataset": "<copernicus_dataset_id>",
  "zarr_url_geo":   "https://...timeChunked.zarr",
  "zarr_url_time":  "https://...geoChunked.zarr",

  // vector only:
  "variable_u": "<eastward_component_short_name>",
  "variable_v": "<northward_component_short_name>",

  // scalar only:
  "variable": "<short_name>",

  // always:
  "variable_meta": {
    "standard_name": "<CF standard name or descriptive string>",
    "units": "<unit string>"
  },
  "dimensions": {
    "time":      { "axis": "t", "size": N, "min": ms, "max": ms, "step": ms, "chunk_size": 1, "units": "..." },
    "latitude":  { "axis": "y", "size": N, "min": ..., "max": ..., "step": ..., "chunk_size": ..., "units": "degrees_north" },
    "longitude": { "axis": "x", "size": N, "min": ..., "max": ..., "step": ..., "chunk_size": ..., "units": "degrees_east" },
    "depth":     { "axis": "z", "values": [...], "size": N, "chunk_size": 1, "units": "m" }  // if present
  },
  "vertical_label": "depth | pressure",  // only if a z-axis exists
  "defaults": { ... }                     // see Section 4
}
```

### Field rules

| Field | Rules |
|-------|-------|
| `id` | Lowercase kebab-case, unique across all views. Descriptive, not the Copernicus dataset ID. |
| `category` | Must be one of: `Ocean`, `Atmosphere`, `Biology`, `Waves`, `Ice`. Add new categories only if none fit. |
| `source_dataset` | Must be unique — no two views from the same dataset. |
| `zarr_url_geo` | Use `arco-geo-series` / `timeChunked.zarr` URL from `query_dataset.py` output. |
| `zarr_url_time` | Use `arco-time-series` / `geoChunked.zarr` URL. Omit if unavailable. |
| `variable_u/v` | For vectors: the eastward and northward component short names. |
| `variable` | For scalars: the single variable to display (pick the primary one if multiple exist). |
| `variable_meta` | Provide a human-intelligible `standard_name`. For vectors, use a combined name like `"sea_water_velocity"`. |

---

## 2. Vector vs Scalar Detection

A dataset is **vector** if `query_dataset.py` reports `suggested_type: "vector"` (eastward + northward pair found).

Exception: if only direction + magnitude are available (e.g., wave mean direction VMDR + significant height VHM0),
decompose at catalog-build time:
- u = magnitude × sin(direction_rad)
- v = magnitude × cos(direction_rad)
Note this in the description and confirm decomposition is not already provided as u/v components
(always run `query_dataset.py` first to check).

---

## 3. Per-Category Display Guidelines

Use these as starting defaults — tune after visual inspection:

| Category | renderMode | logScale | palette | Notes |
|----------|-----------|----------|---------|-------|
| Ocean | `raster+particles` | false | `rdylbu` | Particles trace currents |
| Atmosphere | `particles` | true | `rdylbu` | Wind streaks dominant |
| Biology | `raster` | true | `balance` | Log scale essential for chl-a |
| Waves | `raster+particles` | false | `rdylbu` | Raster = height, particles = direction |
| Ice | `raster` | false | `blues` | No particles needed |

---

## 4. Defaults Reference

All fields are optional but recommended for vector views:

```json
{
  "palette":         "rdylbu",
  "renderMode":      "raster+particles",
  "particleDensity": 0.05,
  "speedMin":        0.01,
  "speedMax":        1.0,
  "fadeMin":         0.9,
  "fadeMax":         0.96,
  "dropRate":        0.003,
  "dropRateBump":    0.0,
  "opacity":         1.0,
  "logScale":        false,
  "vibrance":        0.0
}
```

Scalar views only need: `palette`, `renderMode`, `opacity`, `logScale`, `vibrance`.

---

## 5. Skills Reference

Run these tools to gather information. All are in `scripts/catalog_builder/skills/`.

### `list_views.py` — check existing views
```bash
uv run scripts/catalog_builder/skills/list_views.py
```
Use first to avoid duplicating `source_dataset`.

### `search_products.py` — find candidate datasets
```bash
uv run scripts/catalog_builder/skills/search_products.py <keyword> [keyword2 ...]
```
Returns JSON array of candidates with dataset IDs, variables, and zarr service availability.
Pick datasets that have both `arco-geo-series` and `arco-time-series` zarr services.

### `query_dataset.py` — inspect a specific dataset
```bash
uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>
```
Returns full metadata: zarr URLs, all variables with standard_names, dimensions, suggested type/variables.

### `validate_catalog.py` — validate after editing
```bash
uv run scripts/catalog_builder/skills/validate_catalog.py
```
Must pass (exit 0) before considering the work done.

---

## 6. Agentic Workflow

When asked to add a new view (e.g., "add waves"):

1. **Check existing views**
   ```bash
   uv run scripts/catalog_builder/skills/list_views.py
   ```
   Confirm no existing view covers the requested topic.

2. **Search for candidates**
   ```bash
   uv run scripts/catalog_builder/skills/search_products.py <topic keywords>
   ```
   Prefer ARCO datasets with both geo and time series zarr services.
   Note any promising `dataset_id` values.

3. **Query the chosen dataset**
   ```bash
   uv run scripts/catalog_builder/skills/query_dataset.py <dataset_id>
   ```
   Extract: zarr URLs, type, variable names, dimensions.

4. **Propose the view entry**
   Compose the full JSON view object following Section 1 schema.
   Apply category defaults from Section 3.
   Show the proposed entry to the user and ask for approval or adjustments.

5. **Append to catalog.json**
   After approval, append the new view to the `views` array in `public/data/catalog.json`.
   Update `"generated"` to current ISO timestamp.

6. **Validate**
   ```bash
   uv run scripts/catalog_builder/skills/validate_catalog.py
   ```
   Fix any errors reported. Only finish when this passes.

---

## 7. Editing Existing Views

To update defaults for an existing view:
1. Load the app, tune visual parameters using the Export > Copy settings button
2. Paste the copied YAML values into the view's `defaults` block in `catalog.json`
3. Run `validate_catalog.py`

To update metadata (zarr URLs, variable names, dimensions):
1. Run `query_dataset.py <source_dataset>` to get fresh metadata
2. Update the relevant fields
3. Run `validate_catalog.py`
