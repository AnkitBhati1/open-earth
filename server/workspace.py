import json
import math
from pathlib import Path
from threading import Lock
from uuid import uuid4

import dask_geopandas as dgpd
import dask.array as da
import geopandas as gpd
import numpy as np
import rioxarray
import xarray as xr
from dask.base import tokenize
from rasterio.warp import transform_bounds
from shapely.geometry import box
from pyproj import Transformer


BOOTSTRAP = """import numpy as np
import pandas as pd
import geopandas as gpod
import xarray as xr
import rioxarray
import dask
import dask_geopandas as dgpd
from server.sdk import earth

ds = xr.DataTree()
dfs = {}
view = {}
"""


def notebook_keys(items, store=None):
    keys = {}
    used = set()
    for item in sorted(items, key=lambda entry: (not bool(entry.get("notebook_key")), entry["id"])):
        base = item.get("notebook_key") or item["name"].replace("/", " - ").strip()
        if base in {"", ".", ".."}:
            base = "Layer"
        key = base
        suffix = 2
        while key in used:
            key = f"{base} ({suffix})"
            suffix += 1
        keys[item["id"]] = key
        used.add(key)
        if store is not None and item.get("notebook_key") != key:
            item["notebook_key"] = key
            metadata = store.path(item["id"]) / f"{uuid4().hex}.tmp"
            metadata.write_text(json.dumps(item))
            metadata.replace(store.path(item["id"]) / "metadata.json")
    return keys


def mask_viewport(block, *, x, y, crs, bounds, block_info=None):
    if block_info is None or not block.size:
        return block
    locations = block_info[0]["array-location"]
    columns = x[slice(*locations[-1])]
    rows = y[slice(*locations[-2])]
    longitude, latitude = Transformer.from_crs(crs, 4326, always_xy=True).transform(*np.meshgrid(columns, rows))
    west, south, east, north = bounds
    inside = (longitude >= west) & (longitude <= east) & (latitude >= south) & (latitude <= north)
    return np.where(inside, block, np.nan)


def compact_dataset(dataset):
    variables = {}
    reference = None
    for name, array in dataset.data_vars.items():
        renamed = {dimension: dimension.removeprefix(f"{name}_") for dimension in array.dims if dimension.startswith(f"{name}_")}
        array = array.rename(renamed) if renamed else array
        if "band" in array.dims and array.sizes["band"] == 1:
            array = array.squeeze("band", drop=True)
        if reference is None:
            reference = array
        elif not all(dimension in array.coords and dimension in reference.coords and array[dimension].equals(reference[dimension]) for dimension in ["x", "y"]):
            array = array.rename({dimension: f"{name}_{dimension}" for dimension in ["x", "y"] if dimension in array.dims})
            array = array.rio.set_spatial_dims(x_dim=f"{name}_x", y_dim=f"{name}_y")
        variables[name] = array
    return xr.Dataset(variables, attrs=dataset.attrs)


class WorkspaceBindings:
    def __init__(self, earth):
        self.earth = earth
        self.loaded = {}
        self.baselines = {}
        self.errors = {}
        self.identifiers = {}
        self.modified = set()
        self.preview_views = {}
        self.sources = {}
        self.windows = {}
        self.edits = {}

    def window(self, value, bounds):
        if not bounds:
            return value
        west, south, east, north = bounds
        if not all(math.isfinite(number) for number in bounds) or south >= north or west >= east:
            raise ValueError("The map viewport needs finite west, south, east, north bounds.")
        if not isinstance(value, xr.Dataset):
            geometry = gpd.GeoSeries([box(west, south, east, north)], crs=4326).to_crs(value.crs).iloc[0]
            return value.clip(geometry)
        variables = {}
        for name, array in value.data_vars.items():
            x_dim = next(dimension for dimension in array.dims if dimension == "x" or dimension.endswith("_x"))
            y_dim = next(dimension for dimension in array.dims if dimension == "y" or dimension.endswith("_y"))
            left, bottom, right, top = transform_bounds("EPSG:4326", array.rio.crs, west, max(-89.9999, south), east, min(89.9999, north), densify_pts=21)
            array = array.isel({x_dim: np.flatnonzero((array[x_dim].values >= left) & (array[x_dim].values <= right)),
                                y_dim: np.flatnonzero((array[y_dim].values >= bottom) & (array[y_dim].values <= top))})
            if array.size and array.rio.crs.to_epsg() != 4326:
                array = array.transpose(..., y_dim, x_dim)
                array = array.copy(data=da.map_blocks(mask_viewport, array.data, x=array[x_dim].values, y=array[y_dim].values,
                                                      crs=array.rio.crs.to_string(), bounds=bounds, dtype=array.dtype))
            variables[name] = array
        return xr.Dataset(variables, attrs=value.attrs)

    def remember(self, identifier, value):
        self.edits.setdefault(identifier, []).append(value)

    def selection(self, identifier, bounds):
        value = self.window(self.sources[identifier], bounds)
        for patch in self.edits.get(identifier, []):
            if not isinstance(value, xr.Dataset):
                value = self.window(patch, bounds).combine_first(value)
                continue
            for name, array in patch.data_vars.items():
                if name not in value:
                    continue
                spatial = [dimension for dimension in array.dims if dimension == "x" or dimension == "y" or dimension.endswith(("_x", "_y"))]
                covered = True
                for dimension in spatial:
                    covered = covered & value[dimension].isin(array[dimension])
                value[name] = xr.where(covered, array.reindex({dimension: value[dimension] for dimension in spatial}), value[name], keep_attrs=True)
        return value

    def raster(self, item):
        assets = self.earth.assets(item["id"]) if item["kind"] == "stac" else {"data": str(self.earth.store.path(item["id"]) / item["filename"])}
        variables = {}
        for name, path in assets.items():
            array = rioxarray.open_rasterio(path, chunks={"band": 1, "x": 512, "y": 512}, masked=True)
            if array.sizes.get("band") == 1:
                array = array.squeeze("band", drop=True)
            if variables:
                reference = next(iter(variables.values()))
                if not all(array[dimension].equals(reference[dimension]) for dimension in ["x", "y"]):
                    array = array.rename({dimension: f"{name}_{dimension}" for dimension in ["x", "y"]})
                    array = array.rio.set_spatial_dims(x_dim=f"{name}_x", y_dim=f"{name}_y")
            variables[name] = array
        return xr.Dataset(variables, attrs={"layer_id": item["id"], "name": item["name"], "kind": item["kind"]})

    def sync(self, namespace, context):
        tree = namespace.setdefault("ds", xr.DataTree())
        frames = namespace.setdefault("dfs", {})
        if not isinstance(tree, xr.DataTree) or not isinstance(frames, dict):
            raise ValueError("Keep ds as an xarray DataTree and dfs as a dictionary of dataframes.")
        viewport = namespace.setdefault("view", {})
        if not isinstance(viewport, dict):
            viewport = {}
            namespace["view"] = viewport
        viewport.clear()
        viewport.update(context.get("view", {}))
        stored = self.earth.store.items()
        keys = notebook_keys(stored, self.earth.store)
        items = {keys[item["id"]]: item for item in stored if item["id"] in context.get("layers", [])}
        bounds = viewport.get("bbox")
        window_signature = tokenize(bounds)
        wanted = set(items)
        for identifier in set(self.loaded) - wanted:
            if identifier in tree.children:
                del tree[identifier]
            frames.pop(identifier, None)
            self.loaded.pop(identifier, None)
            self.baselines.pop(identifier, None)
            self.errors.pop(identifier, None)
            self.identifiers.pop(identifier, None)
            self.modified.discard(identifier)
            self.sources.pop(identifier, None)
            self.windows.pop(identifier, None)
            self.edits.pop(identifier, None)
        for identifier in wanted:
            item = items[identifier]
            self.identifiers[identifier] = item["id"]
            revision = item.get("revision", "")
            if self.loaded.get(identifier) == revision and self.windows.get(identifier) == window_signature:
                continue
            try:
                source_item = item.get("notebook_source", item)
                existing = tree[identifier].to_dataset() if identifier in tree.children else frames.get(identifier)
                if existing is not None and tokenize(existing) != self.baselines.get(identifier):
                    self.remember(identifier, existing)
                extent = source_item.get("bbox")
                outside = bounds and extent and (bounds[2] <= extent[0] or bounds[0] >= extent[2] or bounds[3] <= extent[1] or bounds[1] >= extent[3])
                if outside and source_item["kind"] == "stac" and identifier not in self.sources:
                    value = xr.Dataset({name: xr.DataArray(da.empty((0, 0), chunks=(1, 1)), dims=("y", "x")) for name in source_item["assets"]},
                                       coords={"x": [], "y": []}, attrs={"layer_id": item["id"], "name": item["name"], "kind": "stac"})
                elif identifier not in self.sources or self.loaded.get(identifier) != revision:
                    if source_item["kind"] == "vector":
                        path = str(self.earth.store.path(item["id"]) / source_item["filename"])
                        self.sources[identifier] = dgpd.read_file(path, chunksize=5000)
                    else:
                        self.sources[identifier] = self.raster(source_item)
                    value = self.selection(identifier, bounds)
                else:
                    value = self.selection(identifier, bounds)
                if source_item["kind"] == "vector":
                    frames[identifier] = value.copy()
                    self.baselines[identifier] = tokenize(frames[identifier])
                else:
                    tree[identifier] = value.copy(deep=True)
                    self.baselines[identifier] = tokenize(tree[identifier].to_dataset())
                self.loaded[identifier] = revision
                self.windows[identifier] = window_signature
                self.modified.discard(identifier)
                self.errors.pop(identifier, None)
            except Exception as error:
                self.errors[identifier] = str(error)
        namespace["layer_names"] = {key: item["name"] for key, item in items.items()}
        return self.errors

    def publish(self, namespace):
        return []

    def objects(self, namespace):
        return [{"key": key, "kind": "ds", "name": key, "variables": list(node.data_vars)}
                for key, node in namespace["ds"].children.items()] + [
                    {"key": key, "kind": "dfs", "name": key, "variables": []} for key in namespace["dfs"]]

    def visualize(self, namespace, key, kind="ds"):
        if kind not in {"ds", "dfs"}:
            raise ValueError("Choose a ds Dataset or dfs dataframe.")
        value = namespace[kind][key]
        value = value.to_dataset().copy(deep=True) if kind == "ds" else value.copy()
        base = f"{key} - notebook copy"
        name = base
        used = set(notebook_keys(self.earth.store.items()).values())
        suffix = 2
        while name in used:
            name = f"{base} ({suffix})"
            suffix += 1
        source_id = self.identifiers.get(key)
        source = self.earth.store.get(source_id) if source_id else {}
        snapshot = {"ds": xr.DataTree.from_dict({name: value}) if kind == "ds" else xr.DataTree(),
                    "dfs": {name: value} if kind == "dfs" else {}, "view": dict(namespace.get("view", {})),
                    "styles": {name: {field: source[field] for field in ["bands", "symbology"] if field in source}}}
        exporter = WorkspaceBindings(self.earth)
        identifiers = exporter._publish_snapshot(snapshot)
        return [self.earth.store.get(identifier) for identifier in identifiers]

    def _publish_snapshot(self, namespace):
        tree, frames = namespace.get("ds"), namespace.get("dfs")
        if not isinstance(tree, xr.DataTree) or not isinstance(frames, dict):
            raise ValueError("Keep ds as an xarray DataTree and dfs as a dictionary of dataframes.")
        changed = []
        for identifier in dict.fromkeys([*self.loaded, *tree.children, *frames]):
            value = tree[identifier].to_dataset() if identifier in tree.children else frames.get(identifier)
            if value is None:
                continue
            signature = tokenize(value)
            view_signature = tokenize(namespace.get("view", {}))
            if signature == self.baselines.get(identifier):
                continue
            self.remember(identifier, value)
            stored_id = self.identifiers.get(identifier)
            is_new = stored_id is None
            if is_new:
                stored_id = uuid4().hex
                item = {"id": stored_id, "name": identifier, "notebook_key": identifier, **namespace.get("styles", {}).get(identifier, {})}
            else:
                item = self.earth.store.get(stored_id)
            folder = self.earth.store.path(stored_id)
            folder.mkdir(exist_ok=True)
            revision = uuid4().hex
            if isinstance(value, xr.Dataset):
                variables = list(value.data_vars)
                arrays = []
                for name in variables:
                    array = value[name]
                    x_dim = next((dimension for dimension in array.dims if dimension == "x" or dimension.endswith("_x")), None)
                    y_dim = next((dimension for dimension in array.dims if dimension == "y" or dimension.endswith("_y")), None)
                    if not x_dim or not y_dim or array.rio.crs is None:
                        raise ValueError(f"{name} needs spatial x/y dimensions and a CRS to render.")
                    array = array.rename({x_dim: "x", y_dim: "y"}) if (x_dim, y_dim) != ("x", "y") else array
                    array = array.rio.set_spatial_dims(x_dim="x", y_dim="y")
                    band_dims = [dimension for dimension in array.dims if dimension not in {"x", "y"}]
                    if len(band_dims) > 1:
                        raise ValueError(f"{name} has multiple non-spatial dimensions. Select a time or other dimension explicitly before copying to a raster.")
                    for dimension in band_dims:
                        if dimension != "band":
                            array = array.rename({dimension: "band"})
                    if "band" not in array.dims:
                        array = array.expand_dims(band=[1])
                    if arrays and (array.rio.crs != arrays[0].rio.crs or array.dtype != arrays[0].dtype
                                   or array.rio.transform() != arrays[0].rio.transform()):
                        raise ValueError("Raster variables must share a CRS, grid and dtype. Copy incompatible variables as separate datasets.")
                    arrays.append(array)
                if not arrays:
                    continue
                preview = (arrays[0] if len(arrays) == 1 else xr.concat(arrays, dim="band", join="exact")).transpose("band", "y", "x")
                target = folder / f"notebook-{revision}.tif"
                try:
                    preview.chunk({"x": 512, "y": 512}).rio.to_raster(
                        target, dtype=preview.dtype, compress="deflate", tiled=True, BIGTIFF="IF_SAFER", lock=Lock())
                except Exception:
                    target.unlink(missing_ok=True)
                    raise
            else:
                preview = value.head(5000, npartitions=1) if hasattr(value, "npartitions") else value.head(5000)
                if not isinstance(preview, gpd.GeoDataFrame) or preview.crs is None or preview.empty:
                    raise ValueError("Vector display requires a nonempty GeoDataFrame with a CRS.")
                target = folder / f"notebook-{revision}.gpkg"
                preview.to_file(target, driver="GPKG")
            registered = self.earth.store.register(target, item["name"])
            temporary = self.earth.store.path(registered["id"])
            import shutil
            shutil.rmtree(temporary)
            source_item = item.get("notebook_source", item) if not is_new else {**registered, "id": stored_id, "filename": target.name}
            updated = {**item, **registered, "id": stored_id, "filename": target.name,
                       "revision": revision, "notebook_preview": True,
                       "notebook_source": source_item,
                       "source_filename": item.get("source_filename", item.get("filename"))}
            if item.get("symbology") and registered["kind"] == "raster":
                updated["symbology"] = {**item["symbology"], "bands": None}
                updated.pop("band_names", None)
                updated["bands"] = ",".join(str(index + 1) for index in range(3 if updated["symbology"]["mode"] == "rgb" and registered["count"] >= 3 else 1))
            metadata = folder / f"{revision}.tmp"
            metadata.write_text(json.dumps(updated))
            metadata.replace(folder / "metadata.json")
            previous_preview = item.get("filename", "")
            if item.get("notebook_preview") and previous_preview.startswith("notebook-") and previous_preview != source_item.get("filename"):
                (folder / previous_preview).unlink(missing_ok=True)
            self.loaded[identifier] = revision
            self.sources.setdefault(identifier, value)
            self.baselines[identifier] = signature
            self.identifiers[identifier] = stored_id
            self.modified.add(identifier)
            self.preview_views[identifier] = view_signature
            namespace.setdefault("layer_names", {})[identifier] = item["name"]
            changed.append(stored_id)
        return changed

    def displays(self, namespace):
        from IPython import get_ipython
        shell = get_ipython()
        return {name: shell.display_formatter.format(namespace[name])[0] if shell else {"text/plain": repr(namespace[name])}
                for name in ["ds", "dfs", "view"] if name in namespace}