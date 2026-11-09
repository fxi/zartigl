# Land and Water from Landsat, Malé Atoll

Yearly land and water composites around Malé, Maldives, at about 30 m, from
2001 to the last complete year. Islands reclaimed from the lagoon
(Hulhumalé, Thilafushi, Gulhifalhu, the airport extension) appear as they
are built: land, sand and buildings are bright, water is dark.

Catalog entry `92d7a79b-68ba-47f7-b4e4-ef4d5757a966` (aliases
`coastal-land-male`, `male-reclamation`) of the zartigl catalog.

## Source

- **Imagery**: USGS Landsat Collection 2 Level-2 surface reflectance,
  Landsat 5, 7, 8 and 9.
- **Access**: Microsoft Planetary Computer STAC
  (`https://planetarycomputer.microsoft.com/api/stac/v1`, collection
  `landsat-c2-l2`), every scene intersecting the area with a scene cloud
  cover below 80 %.
- **Area**: 73.38–73.56° E, 4.13–4.27° N (Malé atoll, North Malé).

## Processing

1. **Grid.** Each scene's green, SWIR1 (1.6 µm) and `QA_PIXEL` bands are
   warped, nearest neighbour, onto a regular 0.00027° grid (about 30 m),
   WGS 84 (EPSG:4326).
2. **Surface reflectance.** Digital numbers are converted with the
   Collection 2 Level-2 scaling: `DN × 0.0000275 − 0.2`.
3. **Clear pixels.** A pixel is kept when `QA_PIXEL` flags none of fill,
   dilated cloud, cloud or cloud shadow, and its green reflectance is above
   0.001 and its SWIR1 reflectance above −0.001. Over-corrected haze and sun
   glint give negative reflectances over deep water, which would otherwise
   read as land.
4. **Per scene**, for each clear pixel: the SWIR1 surface reflectance,
   clipped to 0–1, and MNDWI = (green − SWIR1) / (green + SWIR1), clipped
   to −1–1.
5. **Yearly composite.** Per pixel, the median of the clear observations of
   the year, and their number.
6. **Pooling before 2013.** Until 2012, few scenes reach the Maldives
   (Landsat 7 only, 1 to 6 a year, with the scan-line gaps of its failed
   corrector after 2003). Each frame up to 2012 pools the scenes of its year
   and of the two years before it.
7. **Gaps.** A pixel without a clear observation in a year keeps the value of
   the nearest earlier year (or, before its first observation, of the first
   year it is observed). Its `observed` count is 0 for that year.
8. **Updates.** The stores are extended with each new complete year, on
   1 January of the next, by the nightly zartigl conversion workflow.

## Variables

| Variable | Meaning | Range |
| --- | --- | --- |
| `swir1` | Yearly median SWIR1 surface reflectance. Land, sand and buildings are bright, water is dark. **Displayed variable.** | 0–1 |
| `mndwi` | Yearly median MNDWI: land below 0, water above. Kept for comparison: haze and glint in Landsat 8 and 9 scenes bias it towards land over deep water, where `swir1` separates land from water more reliably. | −1–1 |
| `observed` | Clear Landsat observations behind the yearly value; 0 where the value comes from another year. | ≥ 0 |

Time stamps are 31 December of each year. All three variables are stored as
int16: `swir1` and `mndwi` with a scale factor of 0.0001, `observed` as a plain
count.

## Data access

Cloud-native Zarr stores, public, on the zartigl bucket:

- map tiles (one time step per chunk):
  `https://sos-ch-gva-2.exo.io/mapx-zartigl/zarr/usgs/landsat-mndwi-male/v1/timeChunked.zarr`
- time series (25 years per chunk):
  `https://sos-ch-gva-2.exo.io/mapx-zartigl/zarr/usgs/landsat-mndwi-male/v1/geoChunked.zarr`

Each store's `history` attribute records every run.

## Limits

- 30 m resolution: narrow features (jetties, small reclaimed strips) mix with
  water in one pixel.
- A yearly median shows the state over the year, not at a date; land built
  late in a year can first appear the year after.
- Pooled frames up to 2012 lag reclamation by up to two years.
- Carried values hide persistent cloud cover: check `observed`.
- Bright shallow sand banks and reef flats at low tide can read as land.

## Licence and credit

Landsat data are in the public domain. Landsat imagery courtesy of the U.S.
Geological Survey. Composited by UNEP/GRID-Geneva.

## Reproduction

The pipeline is `scripts/to_zarr/usgs/landsat_mndwi/` in
[zartigl](https://github.com/fxi/zartigl) (`convert.py`, `config.json`):

```bash
uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py plan
uv run scripts/to_zarr/usgs/landsat_mndwi/convert.py run --local /tmp/male
```
