from concurrent.futures import ThreadPoolExecutor
import math

import numpy as np
import planetary_computer
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window


def sample_pixel(path, longitude, latitude, asset=None):
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_TIMEOUT="12", GDAL_HTTP_CONNECTTIMEOUT="5", GDAL_HTTP_MAX_RETRY="1"):
        with rasterio.open(path) as source:
            if source.crs is None:
                raise ValueError("Raster has no coordinate reference system.")
            eastings, northings = transform("EPSG:4326", source.crs, [longitude], [latitude])
            if not math.isfinite(eastings[0]) or not math.isfinite(northings[0]):
                raise ValueError("Point cannot be transformed to the raster CRS.")
            row, column = source.index(eastings[0], northings[0])
            inside = 0 <= row < source.height and 0 <= column < source.width
            values = source.read(window=Window(column, row, 1, 1), masked=True)[:, 0, 0] if inside else None
            bands = []
            for offset in range(source.count):
                value = values[offset] if values is not None else None
                valid = value is not None and not np.ma.is_masked(value) and np.isfinite(value)
                raw = value.item() if valid else None
                if isinstance(raw, complex):
                    raw = str(raw)
                name = source.descriptions[offset] or f"Band {offset + 1}"
                if asset:
                    name = asset if source.count == 1 else f"{asset} / {name}"
                bands.append({"name": name, "band": offset + 1, "asset": asset, "value": raw,
                              "status": "value" if valid else "nodata" if inside else "outside",
                              "unit": source.units[offset], "scale": source.scales[offset], "offset": source.offsets[offset],
                              "row": row if inside else None, "column": column if inside else None})
            return bands


def inspect_raster(store, identifier, longitude, latitude):
    item = store.get(identifier)
    if item["kind"] == "vector":
        raise ValueError("Pixel inspection requires a raster layer.")
    if item["kind"] == "stac":
        def sample_asset(entry):
            name, asset = entry
            try:
                return sample_pixel(planetary_computer.sign(asset["href"]), longitude, latitude, name)
            except Exception:
                return [{"name": name, "asset": name, "value": None, "status": "error", "error": "Asset could not be read. Try again."}]
        with ThreadPoolExecutor(max_workers=4) as pool:
            groups = list(pool.map(sample_asset, item["assets"].items()))
        bands = [band for group in groups for band in group]
    else:
        bands = sample_pixel(store.source(identifier), longitude, latitude)
    return {"layer": identifier, "longitude": longitude, "latitude": latitude, "bands": bands}