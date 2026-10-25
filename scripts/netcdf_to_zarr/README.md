# netCDF → Zarr

Some reference products exist only as files (netCDF over HTTP). These pipelines
convert them into Zarr stores on the zartigl bucket (`mapx-zartigl`) that look
like Copernicus Marine ARCO, so the catalog, the browser runtime and the
GeoVideo archive read them like any other Zarr source.

Layout: one directory per product, `scripts/netcdf_to_zarr/<org>/<product>/`,
publishing to `netcdf-to-zarr/<org>/<product>/<version>/` in the bucket.
`common.py` holds the shared store, append and budget helpers; S3 settings
come from `scripts/s3_bucket.py` (`.env.demo`, `.env`, then the environment).

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
uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py plan
uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py run --budget 90m
uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py sync-geo --budget 90m
# Local dry run, no credentials needed:
uv run scripts/netcdf_to_zarr/noaa/crw_dhw/convert.py run --local /tmp/crw --max-days 3
npm run test:netcdf-to-zarr
```

`run` stops at the first day CRW has not published yet. A day missing that is
older than `publicationDelayDays` is an error, because the time axis has no holes.
`sync-geo` appends to `geoChunked.zarr` only once it lags by
`geoSyncMinLagDays` (7), because every append rewrites all tiles of the open
time chunk. Point series can therefore trail the maps by up to a week.

The first backfill (about 1000 days) does not fit in the daily 90-minute budget.
Dispatch `.github/workflows/netcdf-to-zarr.yml` manually with a budget of `10h` (each of the two steps gets that budget, within the 24 h job limit)
and `force-geo`, and repeat until `plan` shows no pending days.

CRW data are free to use with credit: cite NOAA Coral Reef Watch
(https://coralreefwatch.noaa.gov/satellite/docs/recommendations_crw_citation.php).
The licence text travels in the store attributes.
