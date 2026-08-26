# Story data builder

`build.py` creates the small, versioned JSON extracts used by `src/demo-story`.
It reads the catalog for ENSO provenance and never modifies the built-in catalog.

```bash
uv run --project scripts python scripts/story_data/build.py
uv run --project scripts python -m unittest discover -s scripts/story_data -p 'test_*.py'
```

The ENSO output contains exact latitude-weighted means for the four standard
Niño regions over the published GeoVideo timeline. The generated file is
committed so normal frontend builds remain reproducible without network access.

The Baltic hypoxia output uses every monthly mean from September 1993 through
September 2025. It sums the exact spherical area of valid native-grid cells
whose bottom oxygen is strictly below 62.5 mmol m-3 (2 mg/L). The story readout
follows these monthly values, while the plotted comparison and trailing
five-year mean use September only. Method, limitations, and references are
embedded alongside the values.
