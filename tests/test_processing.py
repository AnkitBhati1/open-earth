import geopandas as gpd
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from server.processing import Store, run_operation


@pytest.fixture
def datasets(tmp_path):
    raster = tmp_path / "scene.tif"
    with rasterio.open(raster, "w", driver="GTiff", width=10, height=10, count=2,
                       dtype="float32", crs="EPSG:4326", transform=from_origin(85, 28, .01, .01), nodata=-9999) as target:
        values = np.full((2, 10, 10), 4, dtype="float32")
        values[1] = 8
        values[:, 0, 0] = -9999
        target.write(values)
    vector = tmp_path / "area.geojson"
    gpd.GeoDataFrame({"name": ["west", "east"]}, geometry=[box(85, 27.95, 85.05, 28), box(85.05, 27.95, 85.1, 28)], crs=4326).to_file(vector)
    store = Store(tmp_path / "store")
    return store, store.register(raster), store.register(vector)


def test_import_and_calculator_preserve_nodata(datasets):
    store, raster, _ = datasets
    result = run_operation(store, raster["id"], "calculator", {"expression": "(b2-b1)/(b2+b1)"})
    with rasterio.open(store.source(result["id"])) as output:
        assert output.crs.to_epsg() == 4326
        assert output.count == 1
        assert output.read(masked=True).mask[0, 0, 0]
        assert output.read(1)[1, 1] == pytest.approx(1 / 3)


def test_categorical_defaults_and_embedded_colors(tmp_path):
    path = tmp_path / "classes.tif"
    with rasterio.open(path, "w", driver="GTiff", width=2, height=2, count=1,
                       dtype="uint8", crs=4326, transform=from_origin(85, 28, .01, .01), nodata=0) as target:
        target.write(np.array([[0, 1], [2, 7]], dtype="uint8"), 1)
    store = Store(tmp_path / "store")
    sampled = store.register(path)["symbology"]
    assert sampled["mode"] == "classes"
    assert [entry["value"] for entry in sampled["classes"]] == [1, 2, 7]
    with rasterio.open(path, "r+") as target:
        target.write_colormap(1, {0: (0, 0, 0, 0), 1: (26, 91, 171, 255), 2: (53, 130, 33, 255)})
    embedded = store.register(path)["symbology"]
    assert embedded["source"] == "Embedded color table"
    assert next(entry for entry in embedded["classes"] if entry["value"] == 1)["color"] == "#1a5bab"


def test_adaptive_raster_defaults(tmp_path):
    from rasterio.enums import ColorInterp
    from server.symbology import stac_style
    path = tmp_path / "adaptive.tif"
    store = Store(tmp_path / "store")
    with rasterio.open(path, "w", driver="GTiff", width=4, height=4, count=1,
                       dtype="float32", crs=4326, transform=from_origin(85, 28, .01, .01), nodata=-9999) as target:
        target.write(np.array([[-9999, 0, 1, 7]] * 4, dtype="float32"), 1)
    inferred = store.register(path)["symbology"]
    assert inferred["source"] == "Unique values"
    assert [entry["value"] for entry in inferred["classes"]] == [0, 1, 7]
    with rasterio.open(path, "r+") as target:
        target.set_band_unit(1, "m")
    assert store.register(path)["symbology"]["mode"] == "continuous"
    with rasterio.open(path, "w", driver="GTiff", width=4, height=4, count=4,
                       dtype="float32", crs=4326, transform=from_origin(85, 28, .01, .01)) as target:
        target.write(np.ones((4, 4, 4), dtype="float32"))
        target.colorinterp = (ColorInterp.undefined, ColorInterp.blue, ColorInterp.green, ColorInterp.red)
    assert store.register(path)["symbology"]["bands"] == ["4", "3", "2"]
    with rasterio.open(path, "r+") as target:
        target.colorinterp = (ColorInterp.undefined,) * 4
    assert store.register(path)["symbology"]["mode"] == "continuous"
    assets = {"data": {"raster:bands": [{"nodata": 0}], "classification:classes": [
        {"value": 0, "name": "No data"}, {"value": 42, "name": "Wetland", "color_hint": "12ab34"}]}}
    classified = stac_style("io-lulc-annual-v02", assets, "data")
    assert classified["source"] == "Class metadata"
    assert classified["classes"] == [{"value": 42, "label": "Wetland", "color": "#12ab34", "visible": True}]
    standard = stac_style("io-lulc-annual-v02", {"data": {"file:values": [
        {"values": [1], "summary": "Water"}, {"values": [7], "summary": "Built area"}]}}, "data")
    assert [entry["color"] for entry in standard["classes"]] == ["#1a5bab", "#ed022a"]
    rgb = stac_style("unknown", {name: {"eo:bands": [{"common_name": channel}]} for name, channel in
                               [("B2", "blue"), ("B3", "green"), ("B4", "red")]}, "B2")
    assert rgb["bands"] == ["B4", "B3", "B2"]
    from server.symbology import raster_distribution, raster_style
    with rasterio.open(path) as dataset:
        empty = np.ma.masked_all((1, 4, 4), dtype="float32")
        assert raster_style(dataset, empty, band=1)["mode"] == "continuous"
        assert raster_distribution(empty, dataset) == {"histogram": [], "valid": 0, "sampled": False, "range": None}
    measured = stac_style("unknown", {"data": {"raster:bands": [{"statistics": {"minimum": -0.7, "maximum": 0.9}}]}}, "data")
    assert measured["minimum"] == -0.7
    assert measured["maximum"] == 0.9


def test_landcover_identity_and_export_recovery(tmp_path):
    import shutil
    import json
    from server.symbology import esri_style
    path = tmp_path / "io-lulc-annual-v02.tif"
    with rasterio.open(path, "w", driver="GTiff", width=4, height=4, count=1,
                       dtype="uint8", crs=4326, transform=from_origin(85, 28, .01, .01), nodata=0) as target:
        target.write(np.array([[1, 2, 7, 11]] * 4, dtype="uint8"), 1)
    store = Store(tmp_path / "store")
    original = store.register(path)
    assert original["symbology"] == esri_style()
    exported = tmp_path / f"open-earth-{original['id'][:8]}.tif"
    shutil.copyfile(store.source(original["id"]), exported)
    assert store.register(exported)["symbology"] == esri_style()
    assert store.register(exported, "Unidentified mask")["symbology"]["source"] == "Unique values"
    with rasterio.open(exported, "r+") as target:
        target.write(np.full((4, 4), 7, dtype="uint8"), 1)
    assert store.register(exported)["symbology"]["source"] == "Unique values"
    style = {**esri_style(), "bands": ["1"]}
    with rasterio.open(exported, "r+") as target:
        target.update_tags(OPEN_EARTH_SYMBOLOGY=json.dumps(style))
    assert store.register(exported, "Renamed export")["symbology"]["classes"] == style["classes"]


def test_band_recommendations_follow_values_not_band_count(tmp_path, monkeypatch):
    import importlib
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path / "data"))
    import server.main
    module = importlib.reload(server.main)
    path = tmp_path / "mixed.tif"
    with rasterio.open(path, "w", driver="GTiff", width=16, height=16, count=2,
                       dtype="float32", crs=4326, transform=from_origin(85, 28, .01, .01)) as target:
        target.write(np.tile([0, 7], (16, 8)).astype("float32"), 1)
        target.write(np.linspace(-1, 1, 256).reshape(16, 16).astype("float32"), 2)
    layer = module.STORE.register(path)
    classes = module.band_symbology(layer["id"], "1")
    continuous = module.band_symbology(layer["id"], "2")
    assert [entry["value"] for entry in classes["recommendation"]["classes"]] == [0, 7]
    assert continuous["recommendation"]["mode"] == "continuous"
    assert continuous["recommendation"]["bands"] == ["2"]
    assert continuous["distribution"]["range"][0] < 0 < continuous["distribution"]["range"][1]


def test_raster_extents_as_operation_boundaries(datasets, tmp_path):
    store, raster, vector = datasets
    whole = run_operation(store, raster["id"], "clip", other_id=raster["id"])
    with rasterio.open(store.source(whole["id"])) as result, rasterio.open(store.source(raster["id"])) as source:
        assert result.shape == source.shape
        assert result.transform == source.transform
        np.testing.assert_array_equal(result.read(masked=True).mask, source.read(masked=True).mask)
    stats = run_operation(store, raster["id"], "zonal", other_id=raster["id"])
    frame = gpd.read_file(store.source(stats["id"]))
    assert frame["mean"].tolist() == [4]
    assert frame["pixels"].tolist() == [99]
    boundary_path = tmp_path / "boundary.tif"
    with rasterio.open(boundary_path, "w", driver="GTiff", width=5, height=5, count=1,
                       dtype="uint8", crs=4326, transform=from_origin(85, 28, .01, .01)) as target:
        target.write(np.zeros((5, 5), dtype="uint8"), 1)
    boundary = store.register(boundary_path)
    clipped = run_operation(store, raster["id"], "clip", other_id=boundary["id"])
    assert 5 <= clipped["width"] <= 6 and 5 <= clipped["height"] <= 6
    with rasterio.open(store.source(clipped["id"])) as result:
        assert result.read(1, masked=True).count() == 24
    assert run_operation(store, vector["id"], "clip", other_id=boundary["id"])["kind"] == "vector"
    with pytest.raises(ValueError, match="requires a vector"):
        run_operation(store, raster["id"], "rasterize", other_id=boundary["id"])


def test_clip_zonal_and_vector_buffer(datasets):
    store, raster, vector = datasets
    clipped = run_operation(store, raster["id"], "clip", other_id=vector["id"])
    assert clipped["height"] <= 6
    stats = run_operation(store, raster["id"], "zonal", other_id=vector["id"])
    frame = gpd.read_file(store.source(stats["id"]))
    assert frame["mean"].tolist() == [4, 4]
    buffered = run_operation(store, vector["id"], "buffer", {"distance": 100})
    original = gpd.read_file(store.source(vector["id"])).to_crs(32645)
    result = gpd.read_file(store.source(buffered["id"])).to_crs(32645)
    assert (result.area > original.area).all()


@pytest.mark.parametrize("operation,params", [("dissolve", {}), ("centroid", {}), ("reproject", {"crs": "EPSG:3857"}), ("filter", {"field": "name", "value": "west"})])
def test_vector_tools(datasets, operation, params):
    store, _, vector = datasets
    result = run_operation(store, vector["id"], operation, params)
    assert result["count"] >= 1


@pytest.mark.parametrize("operation", ["clip", "intersect", "merge"])
def test_vector_overlay(datasets, operation):
    store, _, vector = datasets
    result = run_operation(store, vector["id"], operation, other_id=vector["id"])
    assert result["count"] >= 2


@pytest.mark.parametrize("operation,params", [("reproject", {"crs": "EPSG:3857"}), ("resample", {"resolution": .02}), ("polygonize", {}), ("rasterize", {})])
def test_raster_tools(datasets, operation, params):
    store, raster, vector = datasets
    result = run_operation(store, raster["id"], operation, params, vector["id"])
    assert result["count"] >= 1


def test_validation(datasets):
    store, raster, vector = datasets
    with pytest.raises(ValueError):
        run_operation(store, raster["id"], "resample", {"resolution": -1})
    with pytest.raises(ValueError):
        run_operation(store, vector["id"], "filter", {"field": "missing"})
    with pytest.raises(ValueError):
        store.source("../../etc/passwd")


@pytest.mark.parametrize("operation", ["convex_hull", "explode", "point_on_surface"])
def test_additional_vector_tools(datasets, operation):
    store, _, vector = datasets
    original = gpd.read_file(store.source(vector["id"]))
    result = run_operation(store, vector["id"], operation)
    output = gpd.read_file(store.source(result["id"]))
    assert output.crs == original.crs
    assert output["name"].tolist() == original["name"].tolist()
    assert output.geometry.is_valid.all()
    if operation == "point_on_surface":
        assert original.geometry.covers(output.geometry).all()


@pytest.mark.parametrize("operation", ["difference", "union"])
def test_additional_overlays(datasets, tmp_path, operation):
    store, _, vector = datasets
    boundary = tmp_path / "overlay.geojson"
    gpd.GeoDataFrame(geometry=[box(85.025, 27.95, 85.075, 28)], crs=4326).to_file(boundary)
    other = store.register(boundary)
    result = run_operation(store, vector["id"], operation, other_id=other["id"])
    output = gpd.read_file(store.source(result["id"]))
    assert output.geometry.is_valid.all()
    expected = .0025 if operation == "difference" else .005
    assert output.geometry.union_all().area == pytest.approx(expected)