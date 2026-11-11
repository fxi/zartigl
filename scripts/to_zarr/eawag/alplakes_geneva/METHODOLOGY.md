# Lake Geneva Temperature and Currents (Alplakes)

Water temperature and currents of Lake Geneva (Lac Léman) every 3 hours,
from the surface to 300 m on 97 levels, from 30 December 2018 to two days
ago. These are the outputs of the Alplakes three-dimensional hydrodynamic
model run by Eawag, resampled to a regular grid of about 390 m.

## Source

- **Model**: Delft3D-Flow, Lake Geneva setup of
  [Alplakes](https://www.alplakes.eawag.ch) (Eawag, Surface Waters – Research
  and Management), the successor of Meteolakes. See Baracchini et al. (2020) for
  the model setup, forcing and calibration.
- **Access**: the raw weekly model output of the Alplakes API,
  `https://alplakes-api.eawag.ch/simulations/file/delft3d-flow/geneva/<sunday>`.
  This is the "Raw model output" download of the Alplakes website.
- **Grid**: a curvilinear grid of 182 × 36 cells in Swiss coordinates
  (CH1903 / LV03, EPSG:21781), with cells of 340 to 520 m. It has 100
  z-layers, 0.26 m thick at the surface and 14.6 m at the bottom.

## Processing

1. **Steps.** The model writes a step every 3 hours. The steps drift by 16 s
   each, so each one is stamped at the nearest 3-hour slot (UTC). A step more
   than 30 minutes from its slot stops the pipeline.
2. **Levels.** The 97 layers whose centre lies below the model's reference
   level are kept, with the surface first. Each depth is the centre of the
   layer below the reference level, the same values the Alplakes API lists.
   The three layers above the reference level are left out, as in the API.
3. **Temperature.** Taken from the model (`R1`), with fill below the lake
   bed and on land.
4. **Currents.** The model stores velocities on the faces of each cell
   (`U1`, `V1`), along the grid axes. Each cell takes the mean of its two
   faces in each direction. A closed face carries no flow, and a cell with no
   open face is fill. The pair is then rotated by the local grid angle
   (`ALFAS`) to eastward and northward components. These are the same
   operations as the Alplakes API: on 15 July 2025 at 12:00 UTC the values
   match the API's surface layer to its rounding (5 × 10⁻⁶ m/s for the
   currents, 5 × 10⁻⁴ °C for the temperature).
5. **Grid.** Each cell centre of a regular 0.005° × 0.0035° grid (about
   390 m) takes the values of the nearest active model cell, when that cell
   is within 360 m. Otherwise it is fill, which draws the shore. Model values
   are never blended. The grid spans 6.145–6.94° E and 46.2–46.53° N.
6. **Updates.** The nightly zartigl conversion workflow appends the days that
   are at least two days old. The forecast part of each model run never
   enters the stores, and a stored step is never rewritten.

## Variables

| Variable | Meaning | Unit |
| --- | --- | --- |
| `temperature` | Water temperature. **Displayed variable.** | °C |
| `u` | Eastward water velocity | m/s |
| `v` | Northward water velocity | m/s |

All three variables are (time, depth, latitude, longitude). They are stored as
int16, `temperature` with a scale factor of 0.001 °C and `u` and `v` with
0.0001 m/s. Depth is in metres, positive down.

## Data access

Cloud-native Zarr stores, public, on the zartigl bucket:

- maps (one time step, every level, per chunk):
  `https://sos-ch-gva-2.exo.io/mapx-zartigl/zarr/eawag/alplakes-geneva/v1/timeChunked.zarr`
- time series (30 days of one level per chunk):
  `https://sos-ch-gva-2.exo.io/mapx-zartigl/zarr/eawag/alplakes-geneva/v1/geoChunked.zarr`

Each store's `history` attribute records every run.

## Limits

- These are **model outputs, not observations**. Their quality is that of
  the model and of its weather forcing. See Alplakes and Baracchini et al.
  (2020) for its validation.
- 390 m resolution. Bays, harbours and the Rhône delta are coarse, and the
  nearest-neighbour grid shows the model cells as steps along the shore.
- The model is rerun as Alplakes improves it. The stores keep the run that
  was current when each day was read, and a change of model grid starts a new
  store version.
- Velocities are instantaneous every 3 hours, not averages. Internal waves
  (seiches) and wind events shorter than 3 hours are sampled, not resolved.
- The rotation to east and north uses the model's grid angle. The small angle
  between the Swiss grid north and true north (under 1° on the lake) is not
  corrected, as in the Alplakes API.

## Licence and credit

Alplakes data are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit:
"Data: Alplakes, Eawag (CC BY 4.0)". Cite Baracchini, T., Wüest, A.,
Bouffard, D. (2020) Meteolakes: An operational online three-dimensional
forecasting platform for lake hydrodynamics. *Water Research* 172, 115529,
doi:10.1016/j.watres.2020.115529. Re-packaged by UNEP/GRID-Geneva.

## Reproduction

The pipeline is `scripts/to_zarr/eawag/alplakes_geneva/` in
[zartigl](https://github.com/fxi/zartigl) (`convert.py`, `config.json`):

```bash
uv run scripts/to_zarr/eawag/alplakes_geneva/convert.py plan
uv run scripts/to_zarr/eawag/alplakes_geneva/convert.py run --local /tmp/leman --max-days 2 --jobs 1
```
