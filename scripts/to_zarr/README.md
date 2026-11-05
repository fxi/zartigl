# Files → Zarr

Some reference products exist only as files (netCDF over HTTP, Atmosphere Data
Store downloads). These pipelines convert them into Zarr stores on the zartigl
bucket (`mapx-zartigl`) that look like Copernicus Marine ARCO, so the catalog,
the browser runtime and the GeoVideo archive read them like any other Zarr
source.

Layout: one directory per product, `scripts/to_zarr/<org>/<product>/`,
publishing to `zarr/<org>/<product>/<version>/` in the bucket:

```
mapx-zartigl/zarr/
  noaa/crw-dhw/v3.1/{timeChunked,geoChunked}.zarr
  noaa/godas/v1/{timeChunked,geoChunked}.zarr
  cams/global-forecast/v1/{timeChunked,geoChunked}.zarr
  cams/gfas/v1.4.2/{timeChunked,geoChunked}.zarr
```

- `<org>/<product>` mirrors the script directory, with hyphens.
- `<version>` is the upstream product version when there is one (CRW `v3.1`,
  GFAS `v1.4.2`). Otherwise it is our own layout version (`v1`), bumped only on
  a breaking store change (grid, encoding, variable names). A new version is a
  new store, never a rewrite in place.
- One store per product, holding only variables that share a grid and time axis.
- The store attributes carry the provider, source, request and licence.

`common.py` holds the shared store, append and budget helpers and the day
driver (`plan`, `run`, `sync-geo`) that each product's `convert.py` plugs into.
A day is appended whole, whatever its number of steps (`stepsPerDay`). S3
settings come from `scripts/s3_bucket.py` (`.env.demo`, `.env`, then the
environment).

```bash
npm run test:to-zarr
```

## Store contract

`contract.py` holds the rules marked ✓ as code. `common.write` refuses any
write that breaks them, before touching the store, and the workflow checks
each published store after its nightly update.

- Two consolidated Zarr v2 stores: `timeChunked.zarr` (one time step per chunk,
  for maps and GeoVideo) and `geoChunked.zarr` (long time chunks over small
  tiles, for point series). ✓ `geoChunked` holds a prefix of the same time axis.
- ✓ Dimensions `time, latitude, longitude`, or `time, depth, latitude,
  longitude` for variables with levels; latitude strictly ascending in
  −90…90, longitude strictly ascending in −180…180, with `degrees_north` and
  `degrees_east` units; depth strictly ascending from 0, in `m` with
  `positive: down`. Variables with and without levels can share a store: the
  browser offers the depth axis only for the variables that have it.
- ✓ Time is an integer in `hours since …`: the browser decodes integer arrays
  through float32, so seconds since 1981 would be off by a minute.
- ✓ The time coordinate is a single chunk, which the browser reads whole.
- ✓ Values are int16 with CF `scale_factor` and a fill value, or float32 with
  NaN for fields spanning orders of magnitude; compressed with blosc/lz4. The
  browser reads `f4`, `f8`, `i2`, `i4` and `i8`, but not `u1`.
- ✓ Each variable describes itself with `long_name` and `units` (required) and
  at most `valid_min`, `valid_max`, `flag_values`, `flag_meanings` and
  `comment`, in the units the store holds. Provider attributes never pass
  through: no `GRIB_*`, no provider `standard_name` (it names the provider's
  units, not ours). Set the attributes, never extend the provider's: xarray
  keeps a variable's attributes through arithmetic.
- ✓ The store attributes include `title`, `source`, `license` and `history`.
- Chunks that are all fill are not written; the browser treats 403/404 as
  missing.
- Objects are `public-read`, and the bucket CORS must allow Range reads.

Readers see a new day only once the consolidated metadata, written last,
lists it. Each run resumes after the last stored day.

```bash
uv run scripts/to_zarr/contract.py              # check every published product
uv run scripts/to_zarr/contract.py cams/gfas    # one product
```

## Adding a product

1. Check that no public, browser-readable Zarr already exists (Copernicus
   Marine ARCO first, see `scripts/catalog_builder/DEVELOPERS.md`).
2. Pick the bucket path before writing anything: `zarr/<org>/<product>/<version>/`,
   with the upstream version, or `v1` when the provider has none. Starting from
   a version boundary (GFAS v1.2 → v1.4.2 on 2026-01-01) keeps one version per store.
3. Download one or two real days first and look at them: dimension and
   variable names, time stamps (a daily mean may be stamped at the end of its
   window), latitude order, longitude range, units and value ranges. Check that
   int16 at the chosen scale holds the observed extremes.
4. Add `scripts/to_zarr/<org>/<product>/` with `config.json` (`prefix`,
   `start`, `stepsPerDay`, `publicationDelayDays`, store chunks), a
   `convert.py` built on `common.main` (or only a `config.json` for a CAMS
   dataset, see below), and tests that run on fixtures shaped like the real
   files. Netcdf fixtures are written before a run starts, never in worker
   threads: HDF5 is not thread-safe.
5. Run `convert.py run --local <dir> --max-days 2`, then check the local stores
   with xarray: orientation against known geography, units, timestamps.
6. Add the product to the matrix of `.github/workflows/to-zarr.yml` and any
   provider key as a repository secret. Backfill by dispatching the workflow
   with a long budget and `force-geo`, then run `contract.py` on the product.
7. Only then propose catalog entries (`scripts/catalog_builder/DEVELOPERS.md`).

Changing a store in place is limited to its metadata. Anything else (grid,
encoding, variable set, adding a variable) means a new store version, or a
deleted and rebuilt store when nothing reads it yet.

## NOAA Coral Reef Watch heat stress (`noaa/crw_dhw`)

The CRW Daily Global 5 km v3.1 products, from 2023-01-01 on: `degree_heating_week`,
`bleaching_alert_area`, `sea_surface_temperature_anomaly` and `hotspot`, in a
global grid of 7200 × 3600 cells. That is about 38 MB per day per store.

```bash
uv run scripts/to_zarr/noaa/crw_dhw/convert.py plan
uv run scripts/to_zarr/noaa/crw_dhw/convert.py run --budget 90m
uv run scripts/to_zarr/noaa/crw_dhw/convert.py sync-geo --budget 90m
# Local dry run, no credentials needed:
uv run scripts/to_zarr/noaa/crw_dhw/convert.py run --local /tmp/crw --max-days 3
npm run test:to-zarr
```

`run` stops at the first day CRW has not published yet. A day missing that is
older than `publicationDelayDays` is an error, because the time axis has no holes.
`sync-geo` appends to `geoChunked.zarr` only once it lags by
`geoSyncMinLagDays` (7), because every append rewrites all tiles of the open
time chunk. Point series can therefore trail the maps by up to a week.

The first backfill (about 1000 days) does not fit in the daily 90-minute budget.
Dispatch `.github/workflows/to-zarr.yml` (input `product: noaa/crw_dhw`) manually with a budget of `10h` (each of the two steps gets that budget, within the 24 h job limit)
and `force-geo`, and repeat until `plan` shows no pending days.

CRW data are free to use with credit: cite NOAA Coral Reef Watch
(https://coralreefwatch.noaa.gov/satellite/docs/recommendations_crw_citation.php).
The licence text travels in the store attributes.

## NCEP GODAS ocean temperature (`noaa/godas`)

The monthly GODAS potential temperature from NOAA PSL (`pottmp.<year>.nc`,
the bias-corrected files), from 1980 on: 40 levels from 5 m to 4478 m, 1° in
longitude by 1/3° in latitude, 74.5° S to 64.5° N. One store holds:
- `pottmp` (time, depth, latitude, longitude), in degC: the source is in
  Kelvin, and longitudes are rolled from 0…360 to −180…180;
- two fields derived for the upper-ocean heat content, both
  (time, latitude, longitude):
  - `t300`, the thickness-weighted mean temperature of the upper 300 m (fill
    where the water column is shallower);
  - `d20`, the depth of the 20 °C isotherm, interpolated between level
    centres.

All three are int16 (0.002 °C, 0.1 m). Months are stamped at their first day,
as in the source. These are absolute values, not anomalies, and not the CPC
pentad equatorial Pacific departures.

PSL rewrites the file of the current year when it adds a month, about two
weeks after the month ends. `run` reads the year files from the year of the
last stored month on and appends the months each store lacks, to both stores
(`sync-geo` is a no-op). A stored month is never rewritten, so a PSL revision
of past months needs a new store version. Missing files for the current year
are expected in January; for an earlier year they are an error. A year takes
about 25 s and adds about 70 MB per store. The 1980–2026 backfill fits in a
few daily budgets, or in one dispatch with a budget of `2h`.

```bash
uv run scripts/to_zarr/noaa/godas/convert.py plan
uv run scripts/to_zarr/noaa/godas/convert.py run --local /tmp/godas --max-years 1
```

GODAS data are in the public domain; acknowledge "GODAS data provided by the
NOAA PSL, Boulder, Colorado, USA, from their website at https://psl.noaa.gov".

## CAMS (Copernicus Atmosphere Data Store)

`cams/ads.py` converts any CAMS dataset from its `config.json`. The config holds
the ADS dataset and base request, and for each variable the ADS name, its
netCDF short name, a unit factor, and either an int16 `scaleFactor` or
`dtype: float32`. It also sets the fixed store `grid`, the `start` date and
`requestDays` (days per ADS request, since data older than 30 days is on tape).
Each day is snapped onto the store grid, or interpolated if the provider
changes resolution (the history attribute says so). Days after the end date
of the public ADS catalogue are never requested, and a day missing from a
download counts as not published yet: the catalogue lists GFAS's hourly data
for today before the daily mean is out.

| Product | ADS dataset | Grid, steps | Variables |
|---|---|---|---|
| `cams/global_forecast` → `cams/global-forecast/v1` | `cams-global-atmospheric-composition-forecasts` | 0.4°, 00 UTC run, lead times 0–21 h every 3 h | PM2.5 (µg m⁻³), total column ozone (DU), total and organic-matter AOD at 550 nm, CO column (10¹⁸ molec cm⁻²), 2 m air temperature (°C) |
| `cams/gfas` → `cams/gfas/v1.4.2` | `cams-global-fire-emissions-gfas` | 0.1°, daily | FRP, fraction of area observed, combustion rate, burnt carbon, CO₂/CH₄/N₂O/CO/NOₓ/SO₂/NH₃/PM2.5/BC/OC/TPM fluxes, plume top/bottom, injection heights |

Both start on 2026-01-01. GFAS switched from v1.2 to v1.4.2 on that day, and
the two are not directly comparable, so the store holds only v1.4.2. GFAS
fluxes are float32, because they span orders of magnitude. Zeros (no fire, no
plume) are stored as zeros: point series read 0, and GeoVideo, whose validity
mask is the intersection over a chunk's frames, keeps a full mask. The catalog
styles make them transparent with `raster.alphaFadeLow` (curve `exp`).

```bash
uv run scripts/to_zarr/cams/gfas/convert.py plan
uv run scripts/to_zarr/cams/gfas/convert.py run --local /tmp/gfas --max-days 2
uv run scripts/to_zarr/cams/global_forecast/convert.py run --budget 90m
```

They need an ADS key (`ADS_KEY` in the environment or `.env`, or
`~/.cdsapirc`). The account must have accepted the ADS terms of use, the
privacy statement and the CAMS licence of each dataset. On bigproc the key is
the `ADS_KEY` repository secret.

Licence: "Generated using Copernicus Atmosphere Monitoring Service information
<year>"; the full text travels in the store attributes.

## Yearly products

Two products have one value per year and are written whole rather than day by
day. They keep the `plan`, `run` and `sync-geo` commands, so the nightly
workflow runs them like the others: `plan` says what is missing, `run` writes
it, and both do nothing on the other days. `sync-geo` is a no-op, because
`run` writes `geoChunked.zarr` together with `timeChunked.zarr`. `--budget`
and `--force` are accepted and ignored. `run --rebuild` deletes the stores
and builds them again; use it only on a store nothing reads yet, otherwise
bump the version. Time stamps are the last day of each year (the state at
the end of the year). Neither product needs a provider key.

### JRC Tropical Moist Forests, Congo Basin (`jrc/tmf`)

From the JRC maps of the year of first degradation and of first
deforestation (`DegradationYear`, `DeforestationYear`, v1.2025, 30 m), read
from the COG mirror on source.coop at overview 0 (60 m, `nearest`, so pixel
counts are an unbiased sample). Two variables, `degraded` and `deforested`:
the cumulative share of each 0.005° cell first degraded (or deforested)
between 1990 and the year, 0–1, int16 at 1e-4. Box 8–32° E, 6° S–6° N,
36 years. A build reads 16 tiles in about 6 minutes and writes about 850 MB.

`run` builds the stores once; it marks them `completed` last, so an
interrupted build is redone by the next run. A new JRC release is a new
store: change `prefix` and `lastYear` in `config.json`.

```bash
uv run scripts/to_zarr/jrc/tmf/convert.py plan
uv run scripts/to_zarr/jrc/tmf/convert.py run --local /tmp/tmf
```

Licence: Copernicus / JRC open data, free of charge without restriction of
use. Name the JRC as the source ("Source: EC JRC") and cite Vancutsem et al.
(2021), Science Advances 7(10), eabe1603.

### Landsat land and water, Malé atoll (`usgs/landsat_mndwi`)

Every Landsat 5, 7, 8 and 9 Collection 2 Level-2 scene of the area (Microsoft
Planetary Computer STAC, no key), warped onto a 0.00027° grid (about 30 m),
keeping clear pixels (QA_PIXEL) with a positive surface reflectance. Per
year: the median SWIR1 surface reflectance (`swir1`: land, sand and buildings
are bright, water is dark), the median MNDWI (`mndwi`, kept for comparison:
haze and glint bias it towards land over deep water in Landsat 8 and 9) and
the number of clear observations (`observed`). Until 2012 (Landsat 7 only,
1–6 scenes a year), each frame pools its year and the two before. A pixel
without a clear observation keeps the value of the previous year; `observed`
is 0 there.

`run` builds the stores from 2001 to the last complete year, then appends one
year each January.

```bash
uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py plan
uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py run --local /tmp/male
```

Licence: Landsat data are in the public domain; credit "Landsat imagery
courtesy of the U.S. Geological Survey".
