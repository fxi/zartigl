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

- Two consolidated Zarr v2 stores: `timeChunked.zarr` (one time step per chunk,
  for maps and GeoVideo) and `geoChunked.zarr` (long time chunks over small
  tiles, for point series).
- Dimensions `time, latitude, longitude`; latitude ascending, longitude in
  −180…180.
- Time is an integer in `hours since …`: the browser decodes integer arrays
  through float32, so seconds since 1981 would be off by a minute.
- The time coordinate is a single chunk, which the browser reads whole.
- Values are int16 with CF `scale_factor` and a `fill_value`, compressed with
  blosc/lz4. The browser reads `f4`, `f8`, `i2`, `i4` and `i8`, but not `u1`.
- Chunks that are all fill are not written; the browser treats 403/404 as
  missing.
- Objects are `public-read`, and the bucket CORS must allow Range reads.

Readers see a new day only once the consolidated metadata, written last,
lists it. Each run resumes after the last stored day.

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

## CAMS (Copernicus Atmosphere Data Store)

`cams/ads.py` converts any CAMS dataset from its `config.json`. The config holds
the ADS dataset and base request, and for each variable the ADS name, its
netCDF short name, a unit factor, and either an int16 `scaleFactor` or
`dtype: float32`. It also sets the fixed store `grid`, the `start` date and
`requestDays` (days per ADS request, since data older than 30 days is on tape).
Each day is snapped onto the store grid, or interpolated if the provider
changes resolution (the history attribute says so). Days the public ADS
catalogue does not list yet are never requested.

| Product | ADS dataset | Grid, steps | Variables |
|---|---|---|---|
| `cams/global_forecast` → `cams/global-forecast/v1` | `cams-global-atmospheric-composition-forecasts` | 0.4°, 00 UTC run, lead times 0–21 h every 3 h | PM2.5 (µg m⁻³), total column ozone (DU), total and organic-matter AOD at 550 nm, CO column (10¹⁸ molec cm⁻²) |
| `cams/gfas` → `cams/gfas/v1.4.2` | `cams-global-fire-emissions-gfas` | 0.1°, daily | FRP, fraction of area observed, combustion rate, burnt carbon, CO₂/CH₄/N₂O/CO/NOₓ/SO₂/NH₃/PM2.5/BC/OC/TPM fluxes, plume top/bottom, injection heights |

Both start on 2026-01-01. GFAS switched from v1.2 to v1.4.2 on that day, and
the two are not directly comparable, so the store holds only v1.4.2. GFAS
fluxes are float32, because they span orders of magnitude. Zeros (no fire, no
plume) are stored as missing, so empty chunks are skipped and the map is
transparent there. The observed fraction keeps its zeros.

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
