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
