import asyncio
import io
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse
from uuid import uuid4

import geopandas as gpd
import httpx
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from jupyter_client import KernelManager
from PIL import Image
from pydantic import BaseModel, Field
from rio_tiler.errors import TileOutsideBounds
from rio_tiler.io import Reader
from rio_tiler.colormap import cmap
import rasterio

from server.processing import Store, run_operation
from server.inspection import inspect_raster
from server.symbology import Symbology, raster_distribution, raster_style, stac_style
from server.workspace import BOOTSTRAP

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("OPEN_EARTH_DATA", ROOT / ".earth"))
STORE = Store(DATA / "datasets")
TOKEN = secrets.token_urlsafe(32)
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
KERNEL = None
CLIENT = None
KERNEL_LOCK = threading.Lock()
GOOGLE_SESSION = {}
GEOCODE_CACHE = {}
GEOCODE_LOCK = threading.Lock()
LAST_GEOCODE = 0
STAC_TILES = {}
ANNOTATION_LOCK = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    yield
    if KERNEL is not None:
        KERNEL.shutdown_kernel(now=True)


app = FastAPI(title="Open Earth", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.middleware("http")
async def local_security(request: Request, call_next):
    host = urlparse(f"http://{request.headers.get('host', '')}").hostname
    origin = request.headers.get("origin")
    if host not in {"127.0.0.1", "localhost", "testserver"}:
        return JSONResponse({"detail": "Loopback access only."}, status_code=403)
    if origin and urlparse(origin).netloc != request.headers.get("host"):
        return JSONResponse({"detail": "Cross-origin access denied."}, status_code=403)
    if request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "Cross-site access denied."}, status_code=403)
    if request.url.path.startswith("/api/") and request.url.path != "/api/session":
        if not secrets.compare_digest(request.cookies.get("earth_session", ""), TOKEN):
            return JSONResponse({"detail": "Open Earth session required. Reload the app."}, status_code=401)
        if request.method not in {"GET", "HEAD"} and request.headers.get("x-open-earth") != "1":
            return JSONResponse({"detail": "Missing request verification."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def value_error(request, error):
    return JSONResponse({"detail": str(error)}, status_code=400)


@app.exception_handler(FileNotFoundError)
async def missing_file(request, error):
    return JSONResponse({"detail": "Dataset or file no longer exists."}, status_code=404)


@app.get("/api/session")
def session():
    response = JSONResponse({"python": sys.version.split()[0], "executable": sys.executable,
                             "google": bool(os.environ.get("GOOGLE_MAPS_API_KEY")), "stac": STAC})
    response.set_cookie("earth_session", TOKEN, httponly=True, samesite="strict")
    return response


@app.get("/api/layers")
def layers():
    items = [restore_stac_extent(item) for item in STORE.items()]
    from server.workspace import notebook_keys
    keys = notebook_keys(items, STORE)
    for item in items:
        item["notebook_key"] = keys[item["id"]]
        if item["kind"] in {"raster", "stac"} and "symbology" not in item:
            item["symbology"] = default_symbology(item["id"])
    return items


@lru_cache(maxsize=256)
def default_symbology(identifier):
    item = STORE.get(identifier)
    if "default_symbology" in item and item["default_symbology"].get("source") not in {"Sampled values", "Unique values"}:
        return item["default_symbology"]
    if item["kind"] == "stac":
        style = stac_style(item["collection"], item["assets"], item["bands"])
    elif item["kind"] == "raster":
        with rasterio.open(STORE.source(identifier)) as dataset:
            preview = dataset.read(out_shape=(dataset.count, min(dataset.height, 256), min(dataset.width, 256)), masked=True)
            style = STORE.raster_symbology(dataset, preview, item["name"])
    else:
        raise ValueError("Raster symbology requires a raster dataset.")
    count = 3 if style["mode"] == "rgb" else 1
    available = item.get("band_names") or [str(index + 1) for index in range(item["count"])]
    bands = style.get("bands") or item.get("bands", "").split(",")
    style["bands"] = bands if len(bands) == count and all(band in available for band in bands) else available[:count]
    return style


@lru_cache(maxsize=256)
def band_symbology(identifier, band):
    item = STORE.get(identifier)
    available = item.get("band_names") or [str(index + 1) for index in range(item["count"])]
    if band not in available:
        raise ValueError("Choose an available raster band.")
    distribution = None
    if item["kind"] == "stac":
        style = stac_style(item["collection"], {band: item["assets"][band]}, band)
    elif item["kind"] == "raster":
        with rasterio.open(STORE.source(identifier)) as dataset:
            preview = dataset.read([int(band)], out_shape=(1, min(dataset.height, 256), min(dataset.width, 256)), masked=True)
            style = STORE.raster_symbology(dataset, preview, item["name"], band=int(band))
            distribution = raster_distribution(preview, dataset)
        inherited = item.get("default_symbology", {})
        if inherited.get("mode") == "classes" and inherited.get("bands") == [band] and not (
            inherited.get("source") in {"Sampled values", "Unique values"} and style.get("source") == "Dataset classification"
        ):
            style = dict(inherited)
    else:
        raise ValueError("Raster symbology requires a raster dataset.")
    style["bands"] = [band]
    return {"recommendation": style, "distribution": distribution}


@app.get("/api/layers/{identifier}/symbology")
def get_symbology(identifier: str, band: str | None = None):
    item = STORE.get(identifier)
    defaults = default_symbology(identifier)
    return {"style": item.get("symbology", defaults), "defaults": defaults, "presets": {},
            **(band_symbology(identifier, band) if band is not None else {})}


@app.post("/api/layers/{identifier}/symbology")
def save_symbology(identifier: str, body: Symbology):
    item = STORE.get(identifier)
    if item["kind"] not in {"raster", "stac"}:
        raise ValueError("Raster symbology requires a raster dataset.")
    if body.mode == "rgb" and item["count"] < 3:
        raise ValueError("RGB needs at least three bands.")
    available = item.get("band_names") or [str(index + 1) for index in range(item["count"])]
    count = 3 if body.mode == "rgb" else 1
    selected = body.bands if body.bands is not None else available[:count]
    if len(selected) != count or any(band not in available for band in selected):
        raise ValueError("Choose valid display bands for this rendering mode.")
    item.setdefault("default_symbology", default_symbology(identifier))
    body = body.model_copy(update={"bands": selected})
    item["bands"] = ",".join(selected)
    item["symbology"] = body.model_dump()
    path = STORE.path(identifier) / "metadata.json"
    temporary = path.with_suffix(f".{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(item))
    temporary.replace(path)
    tile.cache_clear()
    return item["symbology"]


@app.get("/api/geocode")
def geocode(q: str):
    global LAST_GEOCODE
    query = q.strip()[:200]
    if not query:
        return []
    with GEOCODE_LOCK:
        if query in GEOCODE_CACHE:
            return GEOCODE_CACHE[query]
        if time.monotonic() - LAST_GEOCODE < 1:
            raise HTTPException(429, "Please wait a moment before searching again.")
        LAST_GEOCODE = time.monotonic()
        try:
            with httpx.Client(timeout=20, headers={"User-Agent": "OpenEarthLocalPreview/0.1 (local GIS development app)"}) as client:
                response = client.get("https://nominatim.openstreetmap.org/search", params={"q": query, "format": "jsonv2", "limit": 3})
                response.raise_for_status()
                GEOCODE_CACHE[query] = response.json()
                return GEOCODE_CACHE[query]
        except httpx.HTTPError as error:
            raise HTTPException(502, "Place search is unavailable. Enter longitude, latitude instead.") from error


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), companions: list[UploadFile] = File(default=[]), layer: str | None = Form(default=None)):
    suffix = Path(file.filename or "").suffix.lower()
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / f"upload{suffix}"
        size = 0
        sidecars = {".shx", ".dbf", ".prj", ".cpg", ".sbn", ".sbx", ".qix"}
        received = set()
        for part in [file, *companions]:
            extension = Path(part.filename or "").suffix.lower()
            if part is not file:
                if suffix != ".shp" or extension not in sidecars or Path(part.filename or "").stem.lower() != Path(file.filename or "").stem.lower():
                    raise ValueError("Shapefile sidecars must match the .shp filename.")
            if extension in received:
                raise ValueError("Duplicate file extension in uploaded dataset.")
            received.add(extension)
            with (Path(directory) / f"upload{extension}").open("wb") as target:
                while chunk := await part.read(1024 * 1024):
                    size += len(chunk)
                    if size > 256 * 1024 * 1024:
                        raise HTTPException(413, "Upload limit is 256 MB per dataset. Use a local path for larger files.")
                    target.write(chunk)
        if suffix == ".shp" and not {".shx", ".dbf", ".prj"}.issubset(received):
            raise ValueError("Select the matching .shp, .shx, .dbf and .prj files together, or upload their ZIP.")
        return await asyncio.to_thread(STORE.register, path, Path(file.filename or "upload").stem, layer=layer or None)


class LocalFile(BaseModel):
    path: str
    layer: str | None = None


@app.post("/api/import")
def import_path(body: LocalFile):
    path = Path(body.path).expanduser().resolve()
    if not path.is_file() and not (path.is_dir() and path.suffix.lower() == ".gdb"):
        raise ValueError("Choose an existing raster/vector file or a File Geodatabase (.gdb) directory.")
    return STORE.register(path, layer=body.layer or None)


@app.get("/api/layers/{identifier}/geojson")
def geojson(identifier: str):
    with ANNOTATION_LOCK:
        item = STORE.get(identifier)
        data = json.loads(gpd.read_file(STORE.source(identifier)).to_crs(4326).to_json(default=jsonable_encoder))
        for index, feature in enumerate(data["features"]):
            feature["id"] = f"{item.get('revision', 'initial')}:{index}"
        return data


class FeatureDeletion(BaseModel):
    feature_ids: list[str] = Field(min_length=1, max_length=100_000)


@app.post("/api/layers/{identifier}/features/delete")
def delete_features(identifier: str, body: FeatureDeletion):
    with ANNOTATION_LOCK:
        item = STORE.get(identifier)
        if item["kind"] != "vector":
            raise ValueError("Only vector features can be deleted.")
        frame = gpd.read_file(STORE.source(identifier))
        revision = item.get("revision", "initial")
        positions = {f"{revision}:{index}": index for index in range(len(frame))}
        if any(feature_id not in positions for feature_id in body.feature_ids):
            raise HTTPException(409, "The layer changed. Select the feature again before deleting.")
        remaining = frame.drop(index=[frame.index[positions[feature_id]] for feature_id in set(body.feature_ids)])
        folder = STORE.path(identifier)
        target = folder / f"features-{uuid4().hex}.gpkg"
        metadata = folder / f"{uuid4().hex}.tmp"
        previous = {key: value for key, value in item.items() if key != "feature_undo"}
        try:
            remaining.to_file(target, driver="GPKG", index=False)
            item.update(filename=target.name, count=len(remaining), revision=uuid4().hex, feature_undo=previous)
            if not remaining.empty:
                item["bbox"] = remaining.to_crs(4326).total_bounds.tolist()
            metadata.write_text(json.dumps(item, allow_nan=False))
            metadata.replace(folder / "metadata.json")
        except Exception:
            target.unlink(missing_ok=True)
            metadata.unlink(missing_ok=True)
            raise
        return item


class FeatureRestore(BaseModel):
    revision: str


@app.post("/api/layers/{identifier}/features/restore")
def restore_features(identifier: str, body: FeatureRestore):
    with ANNOTATION_LOCK:
        item = STORE.get(identifier)
        if item.get("revision") != body.revision or not item.get("feature_undo"):
            raise HTTPException(409, "The layer changed. This deletion can no longer be undone.")
        restored = {**item, **{key: item["feature_undo"][key] for key in ("filename", "count", "bbox")}, "revision": uuid4().hex}
        restored.pop("feature_undo")
        folder = STORE.path(identifier)
        metadata = folder / f"{uuid4().hex}.tmp"
        metadata.write_text(json.dumps(restored, allow_nan=False))
        metadata.replace(folder / "metadata.json")
        return restored


@app.get("/api/layers/{identifier}/download")
def download(identifier: str, format: str = "native"):
    item = STORE.get(identifier)
    if format == "geojson" and item["kind"] == "vector":
        content = gpd.read_file(STORE.source(identifier)).to_crs(4326).to_json(default=jsonable_encoder)
        return Response(content, media_type="application/geo+json", headers={"Content-Disposition": 'attachment; filename="layer.geojson"'})
    if item["kind"] == "raster":
        import shutil
        import tempfile
        from starlette.background import BackgroundTask
        with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as temporary:
            exported = Path(temporary.name)
        try:
            shutil.copyfile(STORE.source(identifier), exported)
            with rasterio.open(exported, "r+") as dataset:
                dataset.update_tags(OPEN_EARTH_SYMBOLOGY=json.dumps(item.get("symbology") or default_symbology(identifier)))
        except Exception:
            exported.unlink(missing_ok=True)
            raise
        return FileResponse(exported, filename=f"open-earth-{identifier[:8]}.tif", background=BackgroundTask(exported.unlink, missing_ok=True))
    return FileResponse(STORE.source(identifier), filename=f"open-earth-{identifier[:8]}{STORE.source(identifier).suffix}")


class InspectPoint(BaseModel):
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)


@app.post("/api/layers/{identifier}/inspect")
def inspect_point(identifier: str, body: InspectPoint):
    return inspect_raster(STORE, identifier, body.longitude, body.latitude)


@app.get("/api/layers/{identifier}/tiles/{zoom}/{column}/{row}.png")
@lru_cache(maxsize=256)
def tile(identifier: str, zoom: int, column: int, row: int, bands: str = "", stretch: bool = True, style: str = ""):
    item = STORE.get(identifier)
    display = Symbology.model_validate_json(style) if style else Symbology.model_validate(item.get("symbology") or default_symbology(identifier))
    selection = bands or ",".join(display.bands or [])
    indexes = tuple(int(value) for value in selection.split(",")) if selection else ((1, 2, 3) if display.mode == "rgb" else (1,))
    if len(indexes) not in {1, 3} or any(index < 1 or index > item["count"] for index in indexes):
        raise ValueError("Select one band or three valid RGB bands.")
    if display.mode == "classes" and len(indexes) != 1:
        raise ValueError("Class colors require one band.")
    with Reader(str(STORE.source(identifier))) as source:
        try:
            image = source.tile(column, row, zoom, indexes=indexes, tilesize=256, resampling_method="nearest")
            if display.mode == "classes":
                colors = display.colormap()
            else:
                ranges = [(display.minimum, display.maximum)] * len(indexes) if display.minimum is not None else ([item["ranges"][index - 1] for index in indexes] if stretch else [(0, 255)] * len(indexes))
                image.rescale(ranges)
                colors = cmap.get(display.palette) if len(indexes) == 1 else None
            return Response(image.render(img_format="PNG", colormap=colors), media_type="image/png")
        except TileOutsideBounds:
            buffer = io.BytesIO()
            Image.new("RGBA", (256, 256)).save(buffer, "PNG")
            return Response(buffer.getvalue(), media_type="image/png")


class Operation(BaseModel):
    layer: str
    operation: str
    params: dict = Field(default_factory=dict)
    other: str | None = None


@app.post("/api/operations")
def operation(body: Operation):
    try:
        return run_operation(STORE, body.layer, body.operation, body.params, body.other)
    except Exception as error:
        raise HTTPException(400, str(error)) from error


class Annotation(BaseModel):
    name: str = "Study area"
    geojson: dict
    identifier: str | None = None
    editable: bool = False


@app.post("/api/annotations")
def annotation(body: Annotation):
    with ANNOTATION_LOCK, tempfile.TemporaryDirectory() as directory:
        if body.identifier:
            import pandas as pd
            item = STORE.get(body.identifier)
            if item["kind"] != "vector" or not item.get("editable"):
                raise ValueError("Choose a drawing layer to append polygons.")
            existing = gpd.read_file(STORE.source(body.identifier))
            added = gpd.GeoDataFrame.from_features(body.geojson["features"], crs=4326).to_crs(existing.crs)
            if added.empty or not added.geometry.geom_type.isin(["Polygon", "MultiPolygon"]).all() or not added.geometry.is_valid.all():
                raise ValueError("Draw valid polygons before saving.")
            frame = gpd.GeoDataFrame(pd.concat([existing, added], ignore_index=True), crs=existing.crs)
            if len(frame) > 100_000:
                raise ValueError("Drawing layer exceeds the feature limit.")
            folder = STORE.path(body.identifier)
            target = folder / f"drawing-{uuid4().hex}.gpkg"
            frame.to_file(target, driver="GPKG")
            item.update(count=len(frame), bbox=frame.to_crs(4326).total_bounds.tolist(), revision=uuid4().hex)
            metadata = folder / f"{uuid4().hex}.tmp"
            metadata.write_text(json.dumps(item))
            target.replace(STORE.source(body.identifier))
            metadata.replace(folder / "metadata.json")
            return item
        path = Path(directory) / "annotation.geojson"
        path.write_text(json.dumps(body.geojson))
        item = STORE.register(path, body.name)
        if body.editable:
            item["editable"] = True
            (STORE.path(item["id"]) / "metadata.json").write_text(json.dumps(item))
        return item


@app.get("/api/stac/collections")
def collections():
    try:
        with httpx.Client(timeout=30) as client:
            response = client.get(f"{STAC}/collections")
            response.raise_for_status()
            return [{"id": entry["id"], "title": entry.get("title", entry["id"])} for entry in response.json()["collections"]]
    except httpx.HTTPError as error:
        raise HTTPException(502, "Planetary Computer catalog is currently unavailable.") from error


class Search(BaseModel):
    collection: str = "sentinel-2-l2a"
    bbox: list[float] = Field(min_length=4, max_length=4)
    start: str
    end: str
    cloud: int = Field(default=30, ge=0, le=100)


@app.post("/api/stac/search")
def search(body: Search):
    west, south, east, north = body.bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("Use west,south,east,north bounds that do not cross the antimeridian.")
    payload = {"collections": [body.collection], "bbox": body.bbox,
               "datetime": f"{body.start}T00:00:00Z/{body.end}T23:59:59Z", "limit": 12}
    if body.collection in {"sentinel-2-l2a", "landsat-c2-l2"}:
        payload["query"] = {"eo:cloud_cover": {"lt": body.cloud}}
    try:
        with httpx.Client(timeout=45) as client:
            response = client.post(f"{STAC}/search", json=payload)
            response.raise_for_status()
            return response.json()["features"]
    except httpx.HTTPError as error:
        raise HTTPException(502, "Catalog search failed. Check the collection, dates, or network.") from error


class StacPreview(BaseModel):
    collection: str
    item: str
    asset: str
    rescale: str = "0,3000"
    assets: list[str] = Field(default_factory=list)
    symbology: Symbology | None = None
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)


@app.post("/api/stac/preview")
def stac_preview(body: StacPreview):
    params = {"collection": body.collection, "item": body.item, "assets": body.assets or [body.asset]}
    if body.symbology and body.symbology.mode == "classes":
        params["colormap"] = json.dumps(body.symbology.colormap())
        params["resampling"] = "nearest"
        params["tile_format"] = "png"
    elif body.asset not in {"visual", "rendered_preview"}:
        params["rescale"] = body.rescale
        if body.symbology and body.symbology.minimum is not None:
            params["rescale"] = f"{body.symbology.minimum},{body.symbology.maximum}"
        if body.symbology and len(params["assets"]) == 1:
            params["colormap_name"] = body.symbology.palette
    try:
        with httpx.Client(timeout=60) as client:
            response = client.get("https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json", params=params)
            response.raise_for_status()
            result = response.json()
            template = result["tiles"][0]
            if urlparse(template).hostname != "planetarycomputer.microsoft.com":
                raise ValueError("Unexpected tile provider.")
            identifier = secrets.token_hex(16)
            STAC_TILES[identifier] = (template, body.bbox)
            if body.bbox:
                result["bounds"] = body.bbox
            result["tiles"] = [f"/api/stac/tiles/{identifier}/{{z}}/{{x}}/{{y}}.png"]
            return result
    except httpx.HTTPError as error:
        raise HTTPException(502, "This asset cannot be previewed by the Planetary Computer tile service. Try a raster data asset.") from error


class StacLoad(BaseModel):
    collection: str
    item: str
    assets: list[str] | None = None
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)


@app.post("/api/stac/load")
def load_stac(body: StacLoad):
    if any("/" in value or ".." in value for value in [body.collection, body.item]):
        raise ValueError("Invalid STAC identifier.")
    with httpx.Client(timeout=45) as client:
        response = client.get(f"{STAC}/collections/{body.collection}/items/{body.item}")
        response.raise_for_status()
        scene = response.json()
    available = {key: asset for key, asset in scene["assets"].items()
                 if "tiff" in asset.get("type", "").lower() and key not in {"visual", "rendered_preview", "thumbnail"}}
    if not available:
        available = {key: asset for key, asset in scene["assets"].items() if "tiff" in asset.get("type", "").lower()}
    chosen = list(available) if body.assets is None else body.assets
    if not chosen or any(key not in available for key in chosen):
        raise ValueError("Choose at least one available raster band.")
    rgb = []
    for color in ["red", "green", "blue"]:
        match = next((key for key in chosen if key == color or any(band.get("common_name") == color for band in available[key].get("eo:bands", []))), None)
        if match:
            rgb.append(match)
    if len(rgb) != 3:
        rgb = [key for key in ["B04", "B03", "B02"] if key in chosen]
    display = rgb if len(rgb) == 3 else [chosen[0]]
    bounds = scene["bbox"]
    identifier = uuid4().hex
    folder = STORE.path(identifier)
    folder.mkdir()
    item = {"id": identifier, "kind": "stac", "name": f"{body.collection} / {body.item}",
            "crs": "EPSG:3857", "count": len(chosen), "bbox": bounds, "clip_bbox": None,
            "collection": body.collection, "item": body.item, "assets": {key: available[key] for key in chosen},
            "band_names": chosen, "bands": ",".join(display), "rescale": "0,0.3" if body.collection == "sentinel-1-rtc" else "0,3000",
            "attribution": f"Microsoft Planetary Computer / {body.collection}"}
    item["symbology"] = stac_style(body.collection, item["assets"], item["bands"])
    if item["symbology"].get("bands"):
        item["bands"] = ",".join(item["symbology"]["bands"])
    (folder / "metadata.json").write_text(json.dumps(item))
    return item


@app.post("/api/layers/{identifier}/render")
def render_stac(identifier: str, body: dict):
    item = restore_stac_extent(STORE.get(identifier))
    assets = body.get("bands", item["bands"]).split(",")
    if len(assets) not in {1, 3} or any(asset not in item["assets"] for asset in assets):
        raise ValueError("Select one band or three RGB bands from this dataset.")
    display = Symbology.model_validate(body.get("symbology") or item.get("symbology") or default_symbology(identifier))
    if display.mode == "classes" and len(assets) != 1:
        raise ValueError("Class colors require one band.")
    preview = stac_preview(StacPreview(collection=item["collection"], item=item["item"], asset=assets[0],
                                      assets=assets, rescale=body.get("rescale", item["rescale"]), symbology=display))
    return {**preview, "bounds": item["bbox"]}


def restore_stac_extent(item):
    if item.get("kind") != "stac" or not item.get("clip_bbox"):
        return item
    full = next((candidate for candidate in STORE.items()
                 if candidate.get("kind") == "stac" and not candidate.get("clip_bbox")
                 and candidate.get("collection") == item["collection"] and candidate.get("item") == item["item"]), None)
    if full is None:
        with httpx.Client(timeout=45) as client:
            response = client.get(f"{STAC}/collections/{item['collection']}/items/{item['item']}")
            response.raise_for_status()
            full = response.json()
    updated = {**item, "bbox": full["bbox"], "clip_bbox": None, "revision": uuid4().hex}
    metadata = STORE.path(item["id"]) / f"{updated['revision']}.tmp"
    metadata.write_text(json.dumps(updated))
    metadata.replace(STORE.path(item["id"]) / "metadata.json")
    return updated


@app.get("/api/stac/tiles/{identifier}/{zoom}/{column}/{row}.png")
def stac_tile(identifier: str, zoom: int, column: int, row: int):
    preview = STAC_TILES.get(identifier)
    if not preview:
        raise HTTPException(404, "Preview session expired. Search and add this scene again.")
    if not (0 <= zoom <= 22 and 0 <= column < 2 ** zoom and 0 <= row < 2 ** zoom):
        raise ValueError("Invalid tile coordinates.")
    template, clip_bbox = preview
    extent = 20037508.342789244
    span = 2 * extent / 2 ** zoom
    tile_bounds = (-extent + column * span, extent - (row + 1) * span,
                   -extent + (column + 1) * span, extent - row * span)
    clipped = None
    if clip_bbox:
        from rasterio.warp import transform_bounds
        clipped = transform_bounds("EPSG:4326", "EPSG:3857", *clip_bbox)
        if clipped[2] <= tile_bounds[0] or clipped[0] >= tile_bounds[2] or clipped[3] <= tile_bounds[1] or clipped[1] >= tile_bounds[3]:
            buffer = io.BytesIO()
            Image.new("RGBA", (256, 256)).save(buffer, "PNG")
            return Response(buffer.getvalue(), media_type="image/png")
    url = template.replace("{z}", str(zoom)).replace("{x}", str(column)).replace("{y}", str(row))
    try:
        with httpx.Client(timeout=45) as client:
            response = client.get(url)
            if response.status_code in {204, 404}:
                buffer = io.BytesIO()
                Image.new("RGBA", (256, 256)).save(buffer, "PNG")
                return Response(buffer.getvalue(), media_type="image/png")
            response.raise_for_status()
            if clipped:
                from rasterio.features import geometry_mask
                from rasterio.transform import from_bounds
                from shapely.geometry import box, mapping
                image = Image.open(io.BytesIO(response.content)).convert("RGBA")
                pixels = np.array(image)
                inside = geometry_mask([mapping(box(*clipped))], out_shape=(image.height, image.width),
                                       transform=from_bounds(*tile_bounds, image.width, image.height), invert=True)
                pixels[:, :, 3] = np.where(inside, pixels[:, :, 3], 0)
                buffer = io.BytesIO()
                Image.fromarray(pixels).save(buffer, "PNG")
                return Response(buffer.getvalue(), media_type="image/png")
            return Response(response.content, media_type=response.headers.get("content-type", "image/png"))
    except httpx.HTTPError as error:
        raise HTTPException(502, "Planetary Computer tile is temporarily unavailable.") from error


def kernel_execute(code, timeout=120, rich=False):
    if CLIENT is None:
        raise ValueError("Start a local Python kernel first.")
    message_id = CLIENT.execute(code, allow_stdin=False)
    deadline = time.monotonic() + timeout
    output = []
    outputs = []
    execution_count = None
    failed = False
    clear_pending = False
    while time.monotonic() < deadline:
        try:
            message = CLIENT.get_iopub_msg(timeout=1)
        except Exception:
            continue
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        kind, content = message["msg_type"], message["content"]
        if clear_pending and kind in {"stream", "execute_result", "display_data", "error"}:
            output.clear()
            outputs.clear()
            clear_pending = False
        if kind == "execute_input":
            execution_count = content.get("execution_count")
        if kind == "stream":
            output.append(content["text"])
            outputs.append({"output_type": "stream", "name": content.get("name", "stdout"), "text": content["text"]})
        elif kind in {"execute_result", "display_data"}:
            output.append(content.get("data", {}).get("text/plain", ""))
            entry = {"output_type": kind, "data": content.get("data", {}), "metadata": content.get("metadata", {})}
            if kind == "execute_result":
                entry["execution_count"] = content.get("execution_count")
            outputs.append(entry)
        elif kind == "error":
            failed = True
            output.append(f"{content['ename']}: {content['evalue']}")
            outputs.append({"output_type": "error", "ename": content["ename"], "evalue": content["evalue"], "traceback": content.get("traceback", [])})
        elif kind == "clear_output":
            clear_pending = content.get("wait", False)
            if not clear_pending:
                output.clear()
                outputs.clear()
        elif kind == "status" and content["execution_state"] == "idle":
            text = "\n".join(output)[-100_000:]
            return {"output": text, "outputs": outputs, "execution_count": execution_count, "status": "error" if failed else "ok"} if rich else text
    KERNEL.interrupt_kernel()
    raise ValueError("Execution exceeded 120 seconds and was interrupted.")


@app.get("/api/runtime")
def runtime():
    candidates = [Path(sys.executable)]
    candidates.extend(Path.home().glob(".venvs/*/bin/python"))
    candidates.extend((DATA / "environments").glob("*/bin/python"))
    return {"running": bool(KERNEL and KERNEL.is_alive()), "busy": KERNEL_LOCK.locked(), "environments": sorted({str(path) for path in candidates if path.exists()})}


class PythonEnvironment(BaseModel):
    executable: str = sys.executable


@app.post("/api/runtime/start")
def start_kernel(body: PythonEnvironment):
    global KERNEL, CLIENT
    executable = Path(body.executable).expanduser()
    if not executable.is_file():
        raise ValueError("Python executable does not exist.")
    if not KERNEL_LOCK.acquire(blocking=False):
        raise HTTPException(409, "Python is busy. Interrupt it before switching environments.")
    try:
        if KERNEL:
            KERNEL.shutdown_kernel(now=True)
        KERNEL = KernelManager()
        KERNEL.kernel_spec.argv = [str(executable), "-m", "ipykernel_launcher", "-f", "{connection_file}"]
        KERNEL.start_kernel(cwd=str(ROOT), env={**os.environ, "OPEN_EARTH_DATA": str(DATA), "PYTHONPATH": str(ROOT)})
        CLIENT = KERNEL.client()
        CLIENT.start_channels()
        CLIENT.wait_for_ready(timeout=25)
        initialized = kernel_execute(BOOTSTRAP + "\nimport sys\nprint('Python', sys.version.split()[0])\nprint('earth is ready')", rich=True)
        if initialized["status"] == "error":
            raise ValueError(initialized["output"])
        output = initialized["output"]
        return {"output": output}
    except Exception as error:
        if KERNEL:
            KERNEL.shutdown_kernel(now=True)
        KERNEL = CLIENT = None
        raise HTTPException(400, f"Could not start this environment. Install ipykernel and the Open Earth Python dependencies. {type(error).__name__}") from error
    finally:
        KERNEL_LOCK.release()


@app.post("/api/runtime/create")
def create_environment():
    uv = shutil.which("uv")
    if not uv:
        raise ValueError("Install uv to create a managed environment.")
    path = DATA / "environments" / f"geo-{time.time_ns()}"
    subprocess.run([uv, "venv", str(path), "--python", sys.executable], check=True, timeout=60, capture_output=True)
    executable = path / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run([uv, "pip", "install", "--python", str(executable), "-r", str(ROOT / "pyproject.toml")],
                   check=True, timeout=600, capture_output=True)
    return {"executable": str(executable)}


class Code(BaseModel):
    code: str = Field(max_length=100_000)
    context: dict | None = None


@app.post("/api/runtime/execute")
def execute(body: Code):
    if not KERNEL_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A Python cell is already running.")
    try:
        binding_errors = {}
        if body.context is not None:
            synced = kernel_execute(f"_earth_errors = earth.sync(globals(), {body.context!r})\nprint(__import__('json').dumps(_earth_errors))", rich=True)
            if synced["status"] == "error":
                return synced
            binding_errors = json.loads(synced["output"])
        result = kernel_execute(body.code, rich=True)
        if body.context is not None and result["status"] == "ok":
            inventory = kernel_execute("print(__import__('json').dumps(earth._bindings.objects(globals())))", rich=True)
            if inventory["status"] == "ok":
                result["objects"] = json.loads(inventory["output"])
        result["binding_errors"] = binding_errors
        return result
    finally:
        KERNEL_LOCK.release()


class WorkspaceContext(BaseModel):
    layers: list[str] = Field(default_factory=list, max_length=1000)
    view: dict = Field(default_factory=dict)


@app.post("/api/runtime/sync")
def sync_workspace(body: WorkspaceContext):
    if not KERNEL or not KERNEL.is_alive():
        return {"running": False}
    if not KERNEL_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A Python cell is running; workspace sync will resume afterward.")
    try:
        result = kernel_execute(f"_earth_errors = earth.sync(globals(), {body.model_dump()!r})\nprint(__import__('json').dumps({{'errors': _earth_errors, 'changed': [], 'displays': earth._bindings.displays(globals()), 'objects': earth._bindings.objects(globals())}}))", rich=True)
        return {"running": True, **(json.loads(result["output"]) if result["status"] == "ok" else {"errors": {"workspace": result["output"]}})}
    finally:
        KERNEL_LOCK.release()


class NotebookCopy(BaseModel):
    key: str = Field(min_length=1, max_length=1000)
    kind: Literal["ds", "dfs"] = "ds"


@app.post("/api/notebook/visualize")
def visualize_notebook(body: NotebookCopy):
    if not KERNEL_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A Python cell is running. Try again when it finishes.")
    try:
        result = kernel_execute(f"print(__import__('json').dumps(earth.visualize(globals(), {body.key!r}, {body.kind!r})))", rich=True)
        if result["status"] != "ok":
            raise HTTPException(400, result["output"])
        return {"layers": json.loads(result["output"])}
    finally:
        KERNEL_LOCK.release()


@app.get("/api/notebook")
def get_notebook():
    import nbformat
    path = DATA / "workspace.ipynb"
    if path.exists():
        return json.loads(path.read_text())
    notebook = nbformat.v4.new_notebook(cells=[
        nbformat.v4.new_code_cell(BOOTSTRAP, metadata={"language": "python", "earth_bootstrap": True}),
        nbformat.v4.new_code_cell("ds", metadata={"language": "python"}),
    ], metadata={"kernelspec": {"display_name": "Open Earth Python", "language": "python", "name": "python3"},
                 "language_info": {"name": "python"}})
    for cell in notebook.cells:
        cell.metadata["id"] = cell.id
    return notebook


@app.post("/api/notebook")
def save_notebook(body: dict):
    import nbformat
    if len(json.dumps(body)) > 20_000_000 or len(body.get("cells", [])) > 500:
        raise ValueError("Notebook limit is 500 cells and 20 MB.")
    notebook = nbformat.from_dict(body)
    for cell in notebook.cells:
        cell.setdefault("id", uuid4().hex)
        cell.setdefault("metadata", {})
        cell.metadata["id"] = cell.id
        cell.metadata["language"] = "markdown" if cell.cell_type == "markdown" else "python"
    nbformat.validate(notebook)
    path = DATA / f"notebook-{uuid4().hex}.tmp"
    path.write_text(nbformat.writes(notebook))
    path.replace(DATA / "workspace.ipynb")
    return {"saved": True}


@app.post("/api/runtime/interrupt")
def interrupt():
    if KERNEL:
        KERNEL.interrupt_kernel()
    return {"ok": True}


@app.get("/api/google/session")
def google_session():
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise HTTPException(400, "Set GOOGLE_MAPS_API_KEY and restart the local service to enable Google satellite imagery.")
    if float(GOOGLE_SESSION.get("expiry", 0)) < time.time() + 60:
        with httpx.Client(timeout=30) as client:
            response = client.post("https://tile.googleapis.com/v1/createSession", params={"key": key},
                                   json={"mapType": "satellite", "language": "en-US", "region": os.environ.get("GOOGLE_MAPS_REGION", "US")})
            if not response.is_success:
                raise HTTPException(502, "Google rejected the session. Check API enablement, billing, and key restrictions.")
            GOOGLE_SESSION.update(response.json())
    return {**GOOGLE_SESSION, "key": key}


@app.get("/api/google/viewport")
def google_viewport(north: float, south: float, east: float, west: float, zoom: int):
    details = google_session()
    with httpx.Client(timeout=20) as client:
        response = client.get("https://tile.googleapis.com/tile/v1/viewport", params={
            "key": details["key"], "session": details["session"], "north": north, "south": south,
            "east": east, "west": west, "zoom": zoom,
        })
        if not response.is_success:
            raise HTTPException(502, "Google viewport attribution could not be loaded.")
        return response.json()


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="web")