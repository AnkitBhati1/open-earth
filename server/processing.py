import filecmp
import json
import re
import zipfile
from pathlib import Path
from uuid import uuid4

import geopandas as gpd
import numexpr as ne
import numpy as np
import planetary_computer
import rasterio
from rasterio import features
from rasterio.enums import Resampling
from rasterio.mask import mask
from rasterio.warp import calculate_default_transform, reproject, transform_bounds
from shapely.geometry import Polygon, shape
from server.symbology import raster_style, stac_style

MAX_CELLS = 24_000_000

BASEMAPS = {
    "osm": ("OpenStreetMap", "https://tile.openstreetmap.org/{z}/{x}/{y}.png", 19, "OpenStreetMap contributors | https://www.openstreetmap.org/copyright"),
    "earth": ("Blue Marble", "https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/{z}/{y}/{x}.jpg", 8, "NASA Blue Marble / EOX | https://maps.eox.at/"),
    "satellite": ("Satellite", "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg", 14, "EOX Sentinel-2 cloudless 2016 / CC BY 4.0 | https://cloudless.eox.at/"),
    "google-satellite": ("Google Satellite", "https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", 20, "Google Maps | https://www.google.com/maps"),
}


def clip_basemap(provider, output, params, boundary_path):
    import io
    from concurrent.futures import ThreadPoolExecutor
    import httpx
    import mercantile
    from PIL import Image
    from rasterio.io import MemoryFile
    from rasterio.transform import from_bounds

    name, template, maximum, attribution = BASEMAPS[provider]
    try:
        zoom = float(params.get("zoom", 12))
    except (ValueError, TypeError):
        raise ValueError("Tile zoom must be a whole number.") from None
    if not np.isfinite(zoom) or not zoom.is_integer() or not 0 <= zoom <= maximum:
        raise ValueError(f"Tile zoom must be between 0 and {maximum}.")
    zoom = int(zoom)
    if not boundary_path:
        raise ValueError("Choose a polygon boundary or raster extent.")
    boundary = gpd.read_file(boundary_path)
    boundary = boundary[boundary.geometry.notna() & ~boundary.geometry.is_empty].copy()
    if boundary.empty or not boundary.geom_type.isin(["Polygon", "MultiPolygon"]).all():
        raise ValueError("Basemap clipping requires polygon boundaries.")
    boundary.geometry = boundary.geometry.make_valid()
    west, south, east, north = finite_bounds(boundary.to_crs(4326).total_bounds)
    if west < -180 or east > 180 or south < -85.05112878 or north > 85.05112878 or east - west > 180:
        raise ValueError("Choose a boundary within Web Mercator coverage that does not cross the date line.")
    first = mercantile.tile(west, north, zoom)
    last = mercantile.tile(np.nextafter(east, west), np.nextafter(south, north), zoom)
    columns, rows = last.x - first.x + 1, last.y - first.y + 1
    if columns <= 0 or rows <= 0 or columns * rows > 64:
        raise ValueError("Basemap clip exceeds 64 tiles. Lower Tile zoom or choose a smaller boundary.")
    width, height = columns * 256, rows * 256
    if width * height * 4 > MAX_CELLS:
        raise ValueError("Basemap clip exceeds the preview cell limit.")
    tiles = [mercantile.Tile(column, row, zoom) for row in range(first.y, last.y + 1) for column in range(first.x, last.x + 1)]
    mosaic = np.zeros((4, height, width), dtype="uint8")
    with httpx.Client(timeout=20, headers={"User-Agent": "OpenEarth/0.1 (local geospatial workspace)"}) as client:
        def fetch_tile(tile):
            response = client.get(template.format(z=tile.z, x=tile.x, y=tile.y))
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                if image.size != (256, 256):
                    raise ValueError("Basemap provider returned an unexpected tile size.")
                return tile, np.array(image.convert("RGBA")).transpose(2, 0, 1)

        with ThreadPoolExecutor(max_workers=2) as pool:
            for tile, pixels in pool.map(fetch_tile, tiles):
                row, column = (tile.y - first.y) * 256, (tile.x - first.x) * 256
                mosaic[:, row:row + 256, column:column + 256] = pixels
    upper = mercantile.xy_bounds(first)
    lower = mercantile.xy_bounds(last)
    transform = from_bounds(upper.left, lower.bottom, lower.right, upper.top, width, height)
    profile = {"driver": "GTiff", "height": height, "width": width, "count": 4, "dtype": "uint8", "crs": "EPSG:3857", "transform": transform}
    with MemoryFile() as memory:
        with memory.open(**profile) as dataset:
            dataset.write(mosaic)
            dataset.colorinterp = (rasterio.enums.ColorInterp.red, rasterio.enums.ColorInterp.green, rasterio.enums.ColorInterp.blue, rasterio.enums.ColorInterp.alpha)
            clipped, transform = mask(dataset, boundary.to_crs(3857).geometry, crop=True, filled=False)
    pixels = clipped.filled(0)
    if not pixels[3].any():
        raise ValueError("The boundary contains no pixels at this Tile zoom. Increase Tile zoom.")
    profile.update(transform=transform)
    write_raster(output, pixels, profile)
    display = {"mode": "rgb", "bands": ["1", "2", "3"], "minimum": 0, "maximum": 255, "palette": "gray", "classes": [], "source": f"{name} rendered tiles"}
    with rasterio.open(output, "r+") as dataset:
        dataset.colorinterp = (rasterio.enums.ColorInterp.red, rasterio.enums.ColorInterp.green, rasterio.enums.ColorInterp.blue, rasterio.enums.ColorInterp.alpha)
        dataset.update_tags(ATTRIBUTION=attribution, BASEMAP=provider, TILE_ZOOM=str(zoom), OPEN_EARTH_SYMBOLOGY=json.dumps(display))
    return display


def read_vector(source, layer=None):
    source = Path(source)
    suffix = source.suffix.lower()
    if suffix in {".parquet", ".geoparquet", ".pq", ".feather", ".arrow"}:
        if layer is not None:
            raise ValueError("Parquet and Feather contain one vector layer; leave the layer name empty.")
        reader = gpd.read_parquet if suffix in {".parquet", ".geoparquet", ".pq"} else gpd.read_feather
        try:
            return reader(source)
        except (ValueError, TypeError) as error:
            raise ValueError("Use GeoParquet or geospatial Feather/Arrow with geometry and CRS metadata, not a plain table.") from error
    if suffix == ".zip":
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
                raise ValueError("Uncompressed archive exceeds 512 MB.")
            names = {entry.filename.lower() for entry in entries}
            for name in names:
                if name.endswith(".shp"):
                    stem = name[:-4]
                    if any(stem + extension not in names for extension in (".shx", ".dbf", ".prj")):
                        raise ValueError("Each zipped Shapefile needs matching .shp, .shx, .dbf and .prj files in the same folder.")
    try:
        return gpd.read_file(source, **({"layer": layer} if layer is not None else {}))
    except Exception as error:
        raise ValueError(f"Cannot open this vector dataset with the installed GDAL drivers: {error}") from error


def finite_bounds(bounds):
    result = [float(value) for value in bounds]
    if len(result) != 4 or not np.isfinite(result).all():
        raise ValueError("Dataset has no finite geographic extent.")
    return result


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, identifier):
        if not identifier.isalnum() or len(identifier) != 32:
            raise ValueError("Invalid dataset ID.")
        return self.root / identifier

    def get(self, identifier):
        return json.loads((self.path(identifier) / "metadata.json").read_text())

    def source(self, identifier):
        item = self.get(identifier)
        return self.path(identifier) / item["filename"]

    def items(self):
        return [json.loads(path.read_text()) for path in sorted(self.root.glob("*/metadata.json"))]

    def raster_symbology(self, dataset, preview, name, band=None):
        style = raster_style(dataset, preview, band=band, name=name)
        exported = re.fullmatch(r"open-earth-([0-9a-f]{8})(?:\.tiff?)?", name)
        if exported and style["source"] in {"Sampled values", "Unique values"}:
            for path in self.root.glob(f"{exported[1]}*/metadata.json"):
                original = json.loads(path.read_text())
                source = path.parent / original["filename"]
                if original["kind"] == "raster" and filecmp.cmp(dataset.name, source, shallow=False):
                    return raster_style(dataset, preview, band=band, name=original["name"])
        return style

    def register(self, source, name=None, layer=None):
        source = Path(source)
        identifier = uuid4().hex
        folder = self.path(identifier)
        folder.mkdir()
        if source.suffix.lower() in {".tif", ".tiff"}:
            import shutil
            target = folder / "data.tif"
            shutil.copyfile(source, target)
            with rasterio.open(target) as dataset:
                if dataset.crs is None:
                    raise ValueError("Raster has no CRS. Assign one before importing.")
                preview = dataset.read(out_shape=(dataset.count, min(dataset.height, 256), min(dataset.width, 256)), masked=True)
                ranges = []
                for band in preview:
                    values = band.compressed()
                    values = values[np.isfinite(values)]
                    low, high = np.percentile(values, [2, 98]) if values.size else (0, 255)
                    ranges.append([float(low), float(high if high > low else low + 1)])
                item = {
                    "kind": "raster", "crs": str(dataset.crs), "count": dataset.count,
                    "width": dataset.width, "height": dataset.height,
                    "dtype": dataset.dtypes[0], "ranges": ranges,
                    "symbology": self.raster_symbology(dataset, preview, name or source.stem),
                    "bbox": finite_bounds(transform_bounds(dataset.crs, "EPSG:4326", *dataset.bounds)),
                }
        else:
            frame = read_vector(source, layer=layer)
            if frame.empty or frame.crs is None:
                raise ValueError("Vector must contain features and a defined CRS.")
            if len(frame) > 100_000:
                raise ValueError("This preview supports up to 100,000 vector features.")
            frame.geometry = frame.geometry.make_valid()
            target = folder / "data.gpkg"
            for column in frame.select_dtypes(include="geometry").columns:
                if column != frame.geometry.name:
                    frame[column] = frame[column].to_wkt()
            for column in frame.columns:
                if column != frame.geometry.name and frame[column].dtype == object:
                    frame[column] = frame[column].map(lambda value: json.dumps(value.tolist() if isinstance(value, np.ndarray) else value, default=str) if isinstance(value, (dict, list, tuple, np.ndarray)) else value)
            frame.to_file(target, driver="GPKG", index=False)
            item = {
                "kind": "vector", "crs": str(frame.crs), "count": len(frame),
                "fields": [column for column in frame.columns if column != frame.geometry.name],
                "bbox": finite_bounds(frame.to_crs(4326).total_bounds),
            }
        if item.get("symbology", {}).get("bands"):
            item["bands"] = ",".join(item["symbology"]["bands"])
        item.update(id=identifier, name=name or source.stem, filename=target.name)
        (folder / "metadata.json").write_text(json.dumps(item))
        return item


def check_size(dataset):
    if dataset.width * dataset.height * dataset.count > MAX_CELLS:
        raise ValueError("Operation exceeds the 24-million-cell preview limit. Clip a smaller area first or use Python.")


def write_raster(path, array, profile):
    profile.update(driver="GTiff", count=array.shape[0], height=array.shape[1], width=array.shape[2], compress="deflate")
    with rasterio.open(path, "w", **profile) as destination:
        destination.write(array)


def vector_operation(source, operation, params, other=None):
    frame = gpd.read_file(source)
    if operation == "buffer":
        distance = float(params.get("distance", 100))
        if not np.isfinite(distance) or distance <= 0:
            raise ValueError("Buffer distance must be positive meters.")
        geographic = frame.to_crs(4326)
        if geographic.total_bounds[2] - geographic.total_bounds[0] > 12:
            raise ValueError("Metric buffer requires a regional dataset spanning at most 12 degrees longitude.")
        metric = frame.estimate_utm_crs()
        if metric is None:
            raise ValueError("Cannot choose a local metric CRS for this dataset.")
        projected = frame.to_crs(metric)
        projected.geometry = projected.buffer(distance)
        frame = projected.to_crs(frame.crs)
    elif operation == "dissolve":
        field = params.get("field") or None
        frame = frame.dissolve(by=field).reset_index()
    elif operation == "centroid":
        metric = frame.estimate_utm_crs()
        projected = frame.to_crs(metric)
        projected.geometry = projected.centroid
        frame = projected.to_crs(frame.crs)
    elif operation == "reproject":
        frame = frame.to_crs(params.get("crs", "EPSG:4326"))
    elif operation == "convex_hull":
        frame.geometry = frame.geometry.convex_hull
    elif operation == "explode":
        frame = frame.explode(index_parts=False).reset_index(drop=True)
    elif operation == "point_on_surface":
        frame.geometry = frame.geometry.representative_point()
    elif operation in {"clip", "intersect", "merge", "difference", "union"}:
        if other is None:
            raise ValueError("Choose a second vector layer.")
        overlay = gpd.read_file(other).to_crs(frame.crs)
        if operation == "clip":
            frame = gpd.clip(frame, overlay)
        elif operation == "intersect":
            frame = gpd.overlay(frame, overlay, how="intersection", keep_geom_type=False)
        elif operation in {"difference", "union"}:
            frame = gpd.overlay(frame, overlay, how=operation, keep_geom_type=False)
        else:
            import pandas as pd
            frame = gpd.GeoDataFrame(pd.concat([frame, overlay], ignore_index=True), crs=frame.crs)
    elif operation == "filter":
        field = params.get("field", "")
        if field not in frame.columns or field == frame.geometry.name:
            raise ValueError("Choose an attribute field.")
        frame = frame[frame[field].astype(str) == str(params.get("value", ""))]
    else:
        raise ValueError("Unsupported vector operation.")
    if frame.empty:
        raise ValueError("Operation returned no features.")
    return frame


def raster_operation(source, output, operation, params, other=None):
    with rasterio.open(source) as dataset:
        profile = dataset.profile.copy()
        if operation == "clip":
            if not other:
                raise ValueError("Choose a polygon boundary.")
            boundary = gpd.read_file(other).to_crs(dataset.crs)
            from rasterio.features import geometry_window
            window = geometry_window(dataset, boundary.geometry)
            if window.width * window.height * dataset.count > MAX_CELLS:
                raise ValueError("Clip extent exceeds the preview limit.")
            array, transform = mask(dataset, boundary.geometry, crop=True, filled=False)
            array = array.astype("float32").filled(np.nan)
            profile.update(transform=transform, dtype="float32", nodata=np.nan)
        elif operation in {"reproject", "resample"}:
            crs = params.get("crs") or dataset.crs
            resolution = params.get("resolution")
            if resolution is not None and (not np.isfinite(float(resolution)) or float(resolution) <= 0):
                raise ValueError("Resolution must be a positive value in target CRS units.")
            transform, width, height = calculate_default_transform(
                dataset.crs, crs, dataset.width, dataset.height, *dataset.bounds,
                **({"resolution": float(resolution)} if resolution else {}),
            )
            if width * height * dataset.count > MAX_CELLS:
                raise ValueError("Output exceeds the 24-million-cell preview limit.")
            array = np.full((dataset.count, height, width), np.nan, dtype="float32")
            method = Resampling[params.get("method", "nearest")]
            for index in range(dataset.count):
                reproject(rasterio.band(dataset, index + 1), array[index], src_transform=dataset.transform,
                          src_crs=dataset.crs, src_nodata=dataset.nodata, dst_transform=transform,
                          dst_crs=crs, dst_nodata=np.nan, resampling=method)
            profile.update(transform=transform, crs=crs, dtype="float32", nodata=np.nan)
        elif operation == "calculator":
            check_size(dataset)
            values = dataset.read(masked=True).astype("float32")
            variables = {f"b{index + 1}": band.filled(np.nan) for index, band in enumerate(values)}
            expression = params.get("expression", "b1")
            if len(expression) > 500:
                raise ValueError("Expression is too long.")
            calculated = ne.evaluate(expression, local_dict=variables, global_dict={})
            if calculated.shape != (dataset.height, dataset.width):
                raise ValueError("Expression must return one raster band (use b1, b2, etc.).")
            calculated = np.where(np.isfinite(calculated), calculated, np.nan)
            array = calculated[np.newaxis].astype("float32")
            profile.update(dtype="float32", nodata=np.nan)
        elif operation == "polygonize":
            check_size(dataset)
            band = dataset.read(int(params.get("band", 1)), masked=True)
            if np.unique(band.compressed()).size > 256:
                raise ValueError("Polygonize requires a categorical raster with at most 256 values.")
            polygons = []
            for geometry, value in features.shapes(band.filled(0).astype("float32"), mask=~np.ma.getmaskarray(band), transform=dataset.transform):
                polygons.append({"geometry": shape(geometry), "value": value})
                if len(polygons) > 100_000:
                    raise ValueError("Polygonized output exceeds the preview feature limit.")
            if not polygons:
                raise ValueError("Raster has no valid pixels.")
            return gpd.GeoDataFrame(polygons, crs=dataset.crs)
        elif operation == "rasterize":
            check_size(dataset)
            if not other:
                raise ValueError("Choose a vector layer to burn into this raster grid.")
            vectors = gpd.read_file(other).to_crs(dataset.crs)
            array = features.rasterize(((geometry, 1) for geometry in vectors.geometry),
                                      out_shape=(dataset.height, dataset.width), transform=dataset.transform,
                                      fill=0, dtype="uint8")[np.newaxis]
            profile.update(dtype="uint8", nodata=0)
        else:
            raise ValueError("Unsupported raster operation.")
        write_raster(output, array, profile)
    return None


def zonal_statistics(source, boundary):
    frame = gpd.read_file(boundary)
    means, minimums, maximums, counts = [], [], [], []
    with rasterio.open(source) as dataset:
        for geometry in frame.to_crs(dataset.crs).geometry:
            try:
                from rasterio.features import geometry_window
                window = geometry_window(dataset, [geometry])
                if window.width * window.height > MAX_CELLS:
                    raise ValueError("Zone exceeds the preview cell limit.")
                values, _ = mask(dataset, [geometry], crop=True, filled=False, indexes=1)
                valid = values.compressed()
                valid = valid[np.isfinite(valid)]
            except (rasterio.errors.WindowError, ValueError) as error:
                if "limit" in str(error):
                    raise
                valid = np.array([])
            counts.append(int(valid.size))
            means.append(float(valid.mean()) if valid.size else None)
            minimums.append(float(valid.min()) if valid.size else None)
            maximums.append(float(valid.max()) if valid.size else None)
    return frame.assign(mean=means, minimum=minimums, maximum=maximums, pixels=counts)


def run_operation(store, identifier, operation, params=None, other_id=None):
    params = params or {}
    provider = identifier.removeprefix("basemap:") if identifier.startswith("basemap:") else None
    if provider is not None and (provider not in BASEMAPS or operation != "clip"):
        raise ValueError("This basemap supports no export, or the operation is not Clip.")
    item = {"kind": "basemap", "name": BASEMAPS[provider][0]} if provider is not None else store.get(identifier)
    display = item.get('symbology')
    if item['kind'] == 'stac':
        assets = item.get('assets', {})
        asset = params.get('asset') or next(iter(assets), None)
        if asset not in assets:
            raise ValueError('Choose an available raster asset.')
        if display is None:
            display = stac_style(item.get('collection', ''), assets, item.get('bands', asset))
        source = planetary_computer.sign(assets[asset]['href'])
    elif provider is not None:
        source = None
    else:
        source = store.source(identifier)
    boundary_item = store.get(other_id) if other_id else None
    other = store.source(other_id) if boundary_item and boundary_item["kind"] == "vector" else None
    import tempfile
    with tempfile.TemporaryDirectory() as directory, rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='30', GDAL_HTTP_CONNECTTIMEOUT='10', GDAL_HTTP_MAX_RETRY='1'):
        output = Path(directory) / "output.tif"
        if boundary_item and boundary_item["kind"] in {"raster", "stac"}:
            if operation not in {"clip", "zonal"}:
                raise ValueError("This operation requires a vector layer, not a raster extent.")
            if other_id == identifier:
                boundary_source = source
            elif boundary_item["kind"] == "stac":
                assets = boundary_item.get("assets", {})
                asset = boundary_item.get("bands", "").split(",")[0]
                asset = asset if asset in assets else next(iter(assets), None)
                if asset is None:
                    raise ValueError("The boundary has no raster assets.")
                boundary_source = planetary_computer.sign(assets[asset]["href"])
            else:
                boundary_source = store.source(other_id)
            with rasterio.open(boundary_source) as boundary_dataset:
                footprint = Polygon([boundary_dataset.transform * corner for corner in
                                     [(0, 0), (boundary_dataset.width, 0), (boundary_dataset.width, boundary_dataset.height), (0, boundary_dataset.height)]])
                boundary = gpd.GeoDataFrame({"name": [boundary_item["name"]]}, geometry=[footprint], crs=boundary_dataset.crs)
            other = Path(directory) / "boundary.gpkg"
            boundary.to_file(other, driver="GPKG")
        if provider is not None:
            display = clip_basemap(provider, output, params, other)
            frame = None
        elif item["kind"] == "vector":
            frame = vector_operation(source, operation, params, other)
        elif operation == "zonal":
            if not other:
                raise ValueError("Choose a polygon layer.")
            frame = zonal_statistics(source, other)
        else:
            frame = raster_operation(source, output, operation, params, other)
        if frame is not None:
            output = Path(directory) / "output.gpkg"
            frame.to_file(output, driver="GPKG")
        result = store.register(output, f"{item['name']} / {operation}")
        if provider is not None:
            result.update(symbology=display, default_symbology=display, bands="1,2,3", stretch=False,
                          attribution=BASEMAPS[provider][3], basemap=provider, tile_zoom=int(float(params.get("zoom", 12))))
            (store.path(result['id']) / 'metadata.json').write_text(json.dumps(result))
        if result['kind'] == 'raster' and operation in {'clip', 'reproject', 'resample'} and params.get('method', 'nearest') == 'nearest' and (display or {}).get('mode') == 'classes':
            result['symbology'] = {**display, 'bands': ['1']}
            result['default_symbology'] = {**display, 'bands': ['1']}
            (store.path(result['id']) / 'metadata.json').write_text(json.dumps(result))
        return result