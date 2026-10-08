import importlib

from fastapi.testclient import TestClient


def test_session_and_origin_protection(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    with TestClient(module.app) as client:
        assert client.get("/api/layers").status_code == 401
        assert client.get("/api/session", headers={"Origin": "https://evil.example"}).status_code == 403
        assert client.get("/api/session").status_code == 200
        assert client.get("/api/layers").json() == []
        assert client.post("/api/runtime/interrupt").status_code == 403
        assert client.post("/api/runtime/interrupt", headers={"X-Open-Earth": "1"}).status_code == 200


def test_annotation_and_operation_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        result = client.post("/api/annotations", json={"name": "Test polygon", "geojson": {
            "type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "test"},
            "geometry": {"type": "Polygon", "coordinates": [[[85, 27], [85.01, 27], [85.01, 27.01], [85, 27.01], [85, 27]]]}}]}})
        assert result.status_code == 200, result.text
        layer = result.json()
        buffered = client.post("/api/operations", json={"layer": layer["id"], "operation": "buffer", "params": {"distance": 100}})
        assert buffered.status_code == 200, buffered.text
        assert len(client.get("/api/layers").json()) == 2
        assert client.get(f"/api/layers/{layer['id']}/geojson").json()["type"] == "FeatureCollection"
        assert client.get(f"/api/layers/{layer['id']}/download?format=geojson").status_code == 200


def test_vector_dates_render_and_export(tmp_path, monkeypatch):
    import geopandas as gpd
    import pandas as pd
    from shapely.geometry import Point
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    source = tmp_path / "dates.gpkg"
    gpd.GeoDataFrame({"observed": pd.to_datetime(["2024-10-31", None]), "value": [1, 2]},
                     geometry=[Point(85, 27), Point(86, 28)], crs=4326).to_file(source)
    layer = module.STORE.register(source)
    with TestClient(module.app) as client:
        client.get("/api/session")
        for suffix in ["geojson", "download?format=geojson"]:
            response = client.get(f"/api/layers/{layer['id']}/{suffix}")
            assert response.status_code == 200, response.text
            features = response.json()["features"]
            assert features[0]["properties"]["observed"] == "2024-10-31T00:00:00"
            assert features[1]["properties"]["observed"] is None
            assert features[0]["properties"]["value"] == 1


def test_polygons_append_to_one_persistent_file(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    feature = {"type": "Feature", "properties": {"source": "user drawn"},
               "geometry": {"type": "Polygon", "coordinates": [[[85, 27], [86, 27], [86, 28], [85, 27]]]}}
    body = {"editable": True, "geojson": {"type": "FeatureCollection", "features": [feature]}}
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        first = client.post("/api/annotations", json=body).json()
        source = module.STORE.source(first["id"])
        body["identifier"] = first["id"]
        result = client.post("/api/annotations", json=body)
        assert result.status_code == 200, result.text
        assert result.json()["id"] == first["id"]
        assert result.json()["count"] == 2
        assert module.STORE.source(first["id"]) == source
        assert len(module.STORE.items()) == 1
        assert len(list(source.parent.glob("*.gpkg"))) == 1
        exported = client.get(f"/api/layers/{first['id']}/download?format=geojson").json()
        assert len(exported["features"]) == 2
        assert module.STORE.get(first["id"])["count"] == 2


def test_catalog_raster_operations_use_native_asset(tmp_path, monkeypatch):
    import json
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin
    from server import processing
    monkeypatch.setenv('OPEN_EARTH_DATA', str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    source = tmp_path / 'classes.tif'
    with rasterio.open(source, 'w', driver='GTiff', width=8, height=8, count=1, dtype='uint8', crs=4326, transform=from_origin(85, 28, .01, .01), nodata=0) as dataset:
        dataset.write(np.full((1, 8, 8), 7, dtype='uint8'))
    alternate = tmp_path / 'alternate.tif'
    with rasterio.open(alternate, 'w', driver='GTiff', width=8, height=8, count=1, dtype='uint8', crs=4326, transform=from_origin(85, 28, .01, .01), nodata=0) as dataset:
        dataset.write(np.full((1, 8, 8), 3, dtype='uint8'))
    identifier = 'c' * 32
    folder = module.STORE.path(identifier)
    folder.mkdir()
    original = {'id': identifier, 'name': 'Esri land cover', 'kind': 'stac', 'assets': {'data': {'href': str(source)}, 'alternate': {'href': str(alternate)}}, 'symbology': {'mode': 'classes', 'palette': 'gray', 'classes': [{'value': 7, 'label': 'Built area', 'color': '#ed022a', 'visible': True}]}}
    (folder / 'metadata.json').write_text(json.dumps(original))
    monkeypatch.setattr(processing.planetary_computer, 'sign', lambda href: href)
    with TestClient(module.app) as client:
        client.get('/api/session')
        client.headers['X-Open-Earth'] = '1'
        boundary = client.post('/api/annotations', json={'name': 'Boundary', 'geojson': {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon', 'coordinates': [[[85.02, 27.94], [85.06, 27.94], [85.06, 27.98], [85.02, 27.98], [85.02, 27.94]]]}}]}}).json()
        for operation, params in [('clip', {}), ('calculator', {'expression': 'b1 * 2'}), ('reproject', {'crs': 'EPSG:3857'}), ('resample', {'resolution': .02}), ('polygonize', {'band': 1}), ('rasterize', {}), ('zonal', {})]:
            response = client.post('/api/operations', json={'layer': identifier, 'operation': operation, 'params': {'asset': 'data', **params}, 'other': boundary['id']})
            assert response.status_code == 200, (operation, response.text)
            result = response.json()
            if operation in {'clip', 'calculator'}:
                with rasterio.open(module.STORE.source(result['id'])) as output:
                    assert np.all(output.read(1, masked=True).compressed() == (14 if operation == 'calculator' else 7))
                    if operation == 'clip':
                        assert output.width < 8 and output.height < 8
                        assert result['symbology']['classes'] == original['symbology']['classes']
                        inferred = client.get(f"/api/layers/{result['id']}/symbology", params={'band': '1'}).json()
                        assert inferred['recommendation']['classes'] == original['symbology']['classes']
        assert client.post('/api/operations', json={'layer': identifier, 'operation': 'clip', 'params': {'asset': 'missing'}, 'other': boundary['id']}).status_code == 400
        response = client.post('/api/operations', json={'layer': identifier, 'operation': 'calculator', 'params': {'asset': 'alternate', 'expression': 'b1 * 2'}})
        assert response.status_code == 200, response.text
        with rasterio.open(module.STORE.source(response.json()['id'])) as output:
            assert np.all(output.read(1) == 6)
        monkeypatch.setattr(processing, 'MAX_CELLS', 32)
        assert client.post('/api/operations', json={'layer': identifier, 'operation': 'calculator', 'params': {'asset': 'data'}}).status_code == 400
        assert client.post('/api/operations', json={'layer': identifier, 'operation': 'clip', 'params': {'asset': 'data'}, 'other': boundary['id']}).status_code == 200
        assert module.STORE.get(identifier) == original
        legacy = {**original, 'collection': 'io-lulc-annual-v02'}
        legacy.pop('symbology')
        (folder / 'metadata.json').write_text(json.dumps(legacy))
        response = client.post('/api/operations', json={'layer': identifier, 'operation': 'clip', 'params': {'asset': 'data'}, 'other': boundary['id']})
        assert response.status_code == 200, response.text
        assert response.json()['symbology']['mode'] == 'classes'
        assert any(entry['value'] == 7 and entry['label'] == 'Built area' for entry in response.json()['symbology']['classes'])


def test_raster_export_preserves_style_and_pixels(tmp_path, monkeypatch):
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    source = tmp_path / "io-lulc-annual-v02.tif"
    pixels = np.array([[0, 1], [7, 11]], dtype="uint8")
    with rasterio.open(source, "w", driver="GTiff", width=2, height=2, count=1,
                       dtype="uint8", crs=4326, transform=from_origin(85, 28, .01, .01), nodata=0) as dataset:
        dataset.write(pixels, 1)
    layer = module.STORE.register(source)
    original_bytes = module.STORE.source(layer["id"]).read_bytes()
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        style = {**layer["symbology"], "bands": ["1"]}
        style["classes"][0].update(label="Open water", visible=False)
        assert client.post(f"/api/layers/{layer['id']}/symbology", json=style).status_code == 200
        exported = client.get(f"/api/layers/{layer['id']}/download")
        assert exported.status_code == 200
        with MemoryFile(exported.content) as memory, memory.open() as dataset:
            np.testing.assert_array_equal(dataset.read(1), pixels)
            assert dataset.nodata == 0
        imported = client.post("/api/upload", files={"file": ("renamed.tif", exported.content, "image/tiff")})
        assert imported.status_code == 200, imported.text
        assert imported.json()["symbology"]["classes"] == style["classes"]
        assert module.STORE.source(layer["id"]).read_bytes() == original_bytes


def test_pixel_inspection_all_bands_masks_projection_and_edges(tmp_path, monkeypatch):
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import transform
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    path = tmp_path / "pixels.tif"
    data = np.array([[[0, 12], [13, 14]], [[-9999, 22], [23, 24]], [[np.nan, 32], [33, 34]]], dtype="float32")
    with rasterio.open(path, "w", driver="GTiff", width=2, height=2, count=3, dtype="float32", crs="EPSG:3857", transform=from_origin(0, 2000, 1000, 1000), nodata=-9999) as source:
        source.write(data)
        source.set_band_description(1, "Elevation")
        source.set_band_unit(1, "m")
        source.scales = (2, 1, 1)
        source.offsets = (10, 0, 0)
    layer = module.STORE.register(path)
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        def inspect(easting, northing):
            longitudes, latitudes = transform(3857, 4326, [easting], [northing])
            result = client.post(f"/api/layers/{layer['id']}/inspect", json={"longitude": longitudes[0], "latitude": latitudes[0]})
            assert result.status_code == 200, result.text
            return result.json()["bands"]
        bands = inspect(500, 1500)
        assert [band["value"] for band in bands] == [0, None, None]
        assert [band["status"] for band in bands] == ["value", "nodata", "nodata"]
        assert bands[0]["name"] == "Elevation"
        assert (bands[0]["unit"], bands[0]["scale"], bands[0]["offset"]) == ("m", 2, 10)
        assert (bands[0]["row"], bands[0]["column"]) == (0, 0)
        assert [band["value"] for band in inspect(1500, 500)] == [14, 24, 34]
        assert all(band["status"] == "outside" for band in inspect(-1, 1500))
        assert all(band["status"] == "outside" for band in inspect(2001, 1500))
        assert client.post(f"/api/layers/{layer['id']}/inspect", json={"longitude": 181, "latitude": 0}).status_code == 422


def test_pixel_inspection_stac_reads_every_asset_and_keeps_partial_results(tmp_path, monkeypatch):
    import json
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin
    from server import inspection
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    path = tmp_path / "asset.tif"
    with rasterio.open(path, "w", driver="GTiff", width=2, height=2, count=1, dtype="uint16", crs=4326, transform=from_origin(85, 28, .5, .5)) as source:
        source.write(np.full((1, 2, 2), 1234, dtype="uint16"))
    identifier = "a" * 32
    folder = module.STORE.path(identifier)
    folder.mkdir()
    (folder / "metadata.json").write_text(json.dumps({"id": identifier, "kind": "stac", "bands": "red", "assets": {"red": {"href": str(path)}, "nir": {"href": str(path)}, "bad": {"href": str(tmp_path / 'missing.tif')}}}))
    monkeypatch.setattr(inspection.planetary_computer, "sign", lambda href: href)
    with TestClient(module.app) as client:
        client.get("/api/session")
        result = client.post(f"/api/layers/{identifier}/inspect", headers={"X-Open-Earth": "1"}, json={"longitude": 85.25, "latitude": 27.75})
        assert result.status_code == 200, result.text
        bands = result.json()["bands"]
        assert [band["name"] for band in bands] == ["red", "nir", "bad"]
        assert [band["value"] for band in bands] == [1234, 1234, None]
        assert bands[-1]["status"] == "error"


def test_local_python_persists_variables(tmp_path, monkeypatch):
    import sys
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        result = client.post("/api/runtime/start", json={"executable": sys.executable})
        assert result.status_code == 200, result.text
        assert "earth is ready" in result.json()["output"]
        client.post("/api/runtime/execute", json={"code": "saved_value = 21"})
        result = client.post("/api/runtime/execute", json={"code": "print(saved_value * 2)\nprint(earth.layers())"})
        assert "42" in result.json()["output"]
        assert "[]" in result.json()["output"]
        result = client.post("/api/runtime/execute", json={"code": "display(pd.DataFrame({'value': [1, 2]}))\nprint(type(ds).__name__, type(dfs).__name__, gpod.__name__)", "context": {"layers": [], "view": {"bbox": [0, 0, 1, 1]}}})
        assert result.json()["status"] == "ok", result.text
        assert "DataTree dict geopandas" in result.json()["output"]
        assert any("text/html" in entry.get("data", {}) for entry in result.json()["outputs"])
        assert result.json()["execution_count"] > 0
        result = client.post("/api/runtime/execute", json={"code": "1 / 0"})
        assert result.json()["status"] == "error"
        assert result.json()["outputs"][0]["ename"] == "ZeroDivisionError"


def test_notebook_document_roundtrip(tmp_path, monkeypatch):
    import nbformat
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        document = client.get("/api/notebook").json()
        assert "import geopandas as gpod" in document["cells"][0]["source"]
        document["cells"].append(nbformat.v4.new_markdown_cell("# Analysis", metadata={"language": "markdown"}))
        assert client.post("/api/notebook", json=document).status_code == 200
        loaded = client.get("/api/notebook").json()
        nbformat.validate(nbformat.from_dict(loaded))
        assert loaded["cells"][-1]["metadata"]["language"] == "markdown"
        assert loaded["cells"][-1]["metadata"]["id"]


def test_stac_keeps_all_bands_and_defaults_to_rgb(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    scene = {"bbox": [85, 27, 86, 28], "assets": {name: {"type": "image/tiff", "href": f"https://example.blob.core.windows.net/{name}.tif"} for name in ["B02", "B03", "B04", "B08"]}}
    class Response:
        def raise_for_status(self):
            pass
        def json(self):
            return scene
    monkeypatch.setattr(module.httpx.Client, "get", lambda *args, **kwargs: Response())
    result = module.load_stac(module.StacLoad(collection="sentinel-2-l2a", item="scene"))
    assert result["count"] == 4
    assert result["bands"] == "B04,B03,B02"
    assert set(result["assets"]) == {"B02", "B03", "B04", "B08"}
    subset = module.load_stac(module.StacLoad(collection="sentinel-2-l2a", item="scene", assets=["B08"]))
    assert subset["band_names"] == ["B08"]
    assert subset["bands"] == "B08"
    module.save_symbology(result["id"], module.Symbology(mode="continuous", bands=["B08"]))
    assert module.STORE.get(result["id"])["bands"] == "B08"
    module.default_symbology.cache_clear()
    assert module.get_symbology(result["id"])["defaults"]["bands"] == ["B04", "B03", "B02"]


def test_class_tiles_preserve_ids_nodata_and_saved_styles(tmp_path, monkeypatch):
    import io
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.transform import from_bounds
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    path = tmp_path / "landcover.tif"
    values = np.repeat(np.array([[0, 1, 2, 7]], dtype="uint8"), 64, axis=1).repeat(256, axis=0)
    extent = 20037508.342789244
    with rasterio.open(path, "w", driver="GTiff", width=256, height=256, count=1, dtype="uint8", nodata=0,
                       crs=3857, transform=from_bounds(-extent, -extent, extent, extent, 256, 256)) as target:
        target.write(values, 1)
    layer = module.STORE.register(path)
    with TestClient(module.app) as client:
        client.get("/api/session")
        client.headers["X-Open-Earth"] = "1"
        endpoint = f"/api/layers/{layer['id']}/symbology"
        detected = client.get(endpoint).json()
        assert detected["presets"] == {}
        style = detected["defaults"]
        assert [entry["value"] for entry in style["classes"]] == [1, 2, 7]
        analysis = client.get(endpoint, params={"band": "1"}).json()
        assert analysis["recommendation"]["bands"] == ["1"]
        assert analysis["distribution"]["valid"] == 49152
        assert len(analysis["distribution"]["histogram"]) == 32
        assert analysis["distribution"]["sampled"] is False
        assert client.get(endpoint, params={"band": "2"}).status_code == 400
        assert client.post(endpoint, json=style).status_code == 200
        url = f"/api/layers/{layer['id']}/tiles/0/0/0.png"
        response = client.get(url)
        assert response.status_code == 200, response.text
        pixels = Image.open(io.BytesIO(response.content)).convert("RGBA")
        assert pixels.getpixel((32, 128))[3] == 0
        for position, entry in zip([96, 160, 224], style["classes"]):
            assert pixels.getpixel((position, 128)) == (*bytes.fromhex(entry["color"][1:]), 255)
        style["classes"][0]["color"] = "#445566"
        style["classes"][1]["visible"] = False
        assert client.post(endpoint, json=style).status_code == 200
        changed = Image.open(io.BytesIO(client.get(url).content)).convert("RGBA")
        assert changed.getpixel((96, 128)) == (68, 85, 102, 255)
        assert changed.getpixel((160, 128))[3] == 0
        assert client.get(endpoint).json()["style"]["classes"][0]["color"] == "#445566"
        assert client.post(endpoint, json={"mode": "continuous", "minimum": 9, "maximum": 2}).status_code == 422
        for palette in ["gray", "viridis", "terrain", "magma", "blues"]:
            assert client.post(endpoint, json={"mode": "continuous", "palette": palette, "minimum": 1, "maximum": 7}).status_code == 200
            ramp = Image.open(io.BytesIO(client.get(url).content)).convert("RGBA")
            assert ramp.getpixel((96, 128)) != ramp.getpixel((224, 128))
            assert ramp.getpixel((32, 128))[3] == 0
    with rasterio.open(module.STORE.source(layer["id"])) as dataset:
        np.testing.assert_array_equal(dataset.read(1), values)


def test_esri_stac_uses_raw_class_colormap(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    requests = []
    class Response:
        def __init__(self, data):
            self.data = data
        def raise_for_status(self):
            pass
        def json(self):
            return self.data
    def get(client, url, **kwargs):
        requests.append(kwargs.get("params", {}))
        if "/items/" in url:
            return Response({"bbox": [85, 27, 86, 28], "assets": {"data": {"type": "image/tiff", "href": "https://example.blob.core.windows.net/lulc.tif"}}})
        return Response({"tiles": ["https://planetarycomputer.microsoft.com/tiles/{z}/{x}/{y}.png"]})
    monkeypatch.setattr(module.httpx.Client, "get", get)
    layer = module.load_stac(module.StacLoad(collection="io-lulc-annual-v02", item="scene"))
    assert layer["symbology"]["mode"] == "classes"
    assert len(layer["symbology"]["classes"]) == 9
    module.render_stac(layer["id"], {})
    assert "rescale" not in requests[-1]
    assert requests[-1]["resampling"] == "nearest"
    assert requests[-1]["tile_format"] == "png"
    assert json.loads(requests[-1]["colormap"])["1"] == [26, 91, 171, 255]
    from server.symbology import stac_style
    worldcover = stac_style("esa-worldcover", {}, "map")
    assert len(worldcover["classes"]) == 11
    assert next(entry for entry in worldcover["classes"] if entry["value"] == 80)["color"] == "#0064c8"
    generic = stac_style("other", {"data": {"file:values": [{"values": [0], "summary": "No Data"}, {"values": [8], "summary": "Forest"}]}}, "data")
    assert generic["classes"][0]["label"] == "Forest"
    assert len(generic["classes"]) == 1


def test_stac_extent_clips_tiles_and_skips_outside_requests(tmp_path, monkeypatch):
    import io
    import json
    from PIL import Image
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    import server.main
    module = importlib.reload(server.main)
    buffer = io.BytesIO()
    Image.new("RGBA", (256, 256), (26, 91, 171, 255)).save(buffer, "PNG")
    calls = []
    class Response:
        status_code = 200
        content = buffer.getvalue()
        headers = {"content-type": "image/png"}
        def raise_for_status(self):
            pass
        def json(self):
            return {"bbox": [-180, -80, 180, 80], "assets": {"data": {"type": "image/tiff"}},
                    "tiles": ["https://planetarycomputer.microsoft.com/tiles/{z}/{x}/{y}.png"]}
    def get(*args, **kwargs):
        calls.append(args)
        return Response()
    monkeypatch.setattr(module.httpx.Client, "get", get)
    bounds = [0, 0, 90, 60]
    layer = module.load_stac(module.StacLoad(collection="io-lulc-annual-v02", item="scene", bbox=bounds))
    assert layer["bbox"] == [-180, -80, 180, 80]
    assert module.STORE.get(layer["id"])["clip_bbox"] is None
    layer["bbox"] = bounds
    layer["clip_bbox"] = bounds
    (module.STORE.path(layer["id"]) / "metadata.json").write_text(json.dumps(layer))
    preview = module.render_stac(layer["id"], {})
    assert preview["bounds"] == [-180, -80, 180, 80]
    restored = module.STORE.get(layer["id"])
    assert restored["clip_bbox"] is None
    assert restored["bbox"] == preview["bounds"]
    identifier = preview["tiles"][0].split("/")[4]
    assert module.STAC_TILES[identifier][1] is None
    full_pixels = Image.open(io.BytesIO(module.stac_tile(identifier, 0, 0, 0).body))
    assert full_pixels.getpixel((100, 100))[3] == 255
    preview = module.stac_preview(module.StacPreview(collection=layer["collection"], item=layer["item"], asset="data", bbox=bounds))
    assert preview["bounds"] == bounds
    identifier = preview["tiles"][0].split("/")[4]
    pixels = Image.open(io.BytesIO(module.stac_tile(identifier, 0, 0, 0).body))
    assert pixels.getpixel((160, 100)) == (26, 91, 171, 255)
    assert pixels.getpixel((100, 100))[3] == 0
    assert pixels.getpixel((160, 160))[3] == 0
    count = len(calls)
    outside = Image.open(io.BytesIO(module.stac_tile(identifier, 2, 0, 0).body))
    assert outside.getbbox() is None
    assert len(calls) == count