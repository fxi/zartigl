"""Open public Copernicus Marine ARCO Zarr stores over HTTP."""

from __future__ import annotations

from typing import Any

from fsspec.implementations.http import HTTPFileSystem


class PublicArcoHttpFileSystem(HTTPFileSystem):
    """Treat CloudFerro's 403 for absent sparse chunks as a normal missing key."""

    def _raise_not_found_for_status(self, response: Any, url: str) -> None:
        if response.status in (403, 404):
            raise FileNotFoundError(url)
        super()._raise_not_found_for_status(response, url)


def open_arco_zarr(url: str, chunks: Any = None) -> Any:
    import xarray as xr

    mapper = PublicArcoHttpFileSystem().get_mapper(url)
    return xr.open_zarr(mapper, consolidated=True, chunks=chunks, zarr_format=2)
