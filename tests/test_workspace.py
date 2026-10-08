import numpy as np
import geopandas as gpd
import rasterio
import xarray as xr
from dask.callbacks import Callback
from rasterio.transform import from_origin
from shapely.geometry import Point

from server.sdk import Earth


def test_notebook_raster_copy_preserves_native_pixels_and_all_bands(tmp_path, monkeypatch):
    import rioxarray
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    earth = Earth()
    path = tmp_path / "native.tif"
    pixels = np.arange(4 * 601 * 703, dtype="int32").reshape(4, 601, 703) + 16_777_217
    pixels[:, 0, 0] = -9999
    transform = from_origin(85, 28, .001, .001)
    with rasterio.open(path, "w", driver="GTiff", width=703, height=601, count=4, dtype="int32",
                       crs=4326, transform=transform, nodata=-9999) as target:
        target.write(pixels)
    array = rioxarray.open_rasterio(path, chunks={"x": 128, "y": 128})
    earth.sync({"ds": xr.DataTree(), "dfs": {}, "view": {}}, {"layers": [], "view": {}})
    namespace = {"ds": xr.DataTree.from_dict({"native": array.to_dataset(name="data")}), "dfs": {},
                 "view": {"bbox": [85.1, 27.8, 85.2, 27.9]}}
    copied = earth.visualize(namespace, "native")[0]
    with rasterio.open(earth.path(copied["id"])) as result:
        assert result.shape == (601, 703)
        assert result.count == 4
        assert result.dtypes == ("int32",) * 4
        assert result.crs == rasterio.crs.CRS.from_epsg(4326)
        assert result.transform == transform
        assert result.nodata == -9999
        np.testing.assert_array_equal(result.read(), pixels)
    namespace["ds"]["native"]["data"] += 1
    with rasterio.open(earth.path(copied["id"])) as result:
        np.testing.assert_array_equal(result.read(), pixels)
    array.close()


def test_notebook_edits_are_isolated_and_visualize_creates_copies(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    earth = Earth()
    path = tmp_path / "Original.tif"
    with rasterio.open(path, "w", driver="GTiff", width=20, height=20, count=1, dtype="float32",
                       crs=4326, transform=from_origin(85, 28, .01, .01)) as target:
        target.write(np.ones((1, 20, 20), dtype="float32"))
    original = earth.add(path)
    namespace = {"ds": xr.DataTree(), "dfs": {}, "view": {}}
    earth.sync(namespace, {"layers": [original["id"]], "view": {"bbox": [85, 27.8, 85.2, 28]}})
    metadata = (earth.store.path(original["id"]) / "metadata.json").read_bytes()
    namespace["ds"]["Original"]["data"] *= 7
    assert earth.publish(namespace) == []
    assert len(earth.layers()) == 1
    assert (earth.store.path(original["id"]) / "metadata.json").read_bytes() == metadata
    first = earth.visualize(namespace, "Original")[0]
    second = earth.visualize(namespace, "Original")[0]
    assert len({original["id"], first["id"], second["id"]}) == 3
    with rasterio.open(earth.path(first["id"])) as copied:
        np.testing.assert_array_equal(copied.read(), 7)
    namespace["ds"]["Original"]["data"] *= 2
    with rasterio.open(earth.path(first["id"])) as copied:
        np.testing.assert_array_equal(copied.read(), 7)
    with rasterio.open(earth.path(original["id"])) as untouched:
        np.testing.assert_array_equal(untouched.read(), 1)
    assert (earth.store.path(original["id"]) / "metadata.json").read_bytes() == metadata


def test_viewport_bindings_follow_extent_and_open_layers(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    earth = Earth()
    path = tmp_path / "Sentinel VV.tif"
    with rasterio.open(path, "w", driver="GTiff", width=100, height=100, count=1, dtype="float32",
                       crs=4326, transform=from_origin(85, 28, .001, .001)) as target:
        target.write(np.ones((1, 100, 100), dtype="float32"))
    first = earth.add(path)
    second = earth.add(path)
    namespace = {"ds": xr.DataTree(), "dfs": {}, "view": {}}
    context = {"layers": [first["id"]], "view": {"bbox": [85.01, 27.97, 85.03, 27.99]}}
    tasks = []
    with Callback(pretask=lambda *args: tasks.append(args[0])):
        assert earth.sync(namespace, context) == {}
        key = next(iter(namespace["ds"].children))
        assert "Sentinel VV" in key and key != first["id"]
        initial = namespace["ds"][key].to_dataset()
        assert initial.sizes["x"] <= 21 and initial.sizes["y"] <= 21
        context["view"] = {"bbox": [85.06, 27.91, 85.08, 27.93]}
        assert earth.sync(namespace, context) == {}
        moved = namespace["ds"][key].to_dataset()
        assert float(moved.x.min()) >= 85.06 and float(moved.y.max()) <= 27.93
        assert not moved.x.equals(initial.x)
        context["layers"].append(second["id"])
        assert earth.sync(namespace, context) == {}
        assert len(namespace["ds"].children) == 2
        assert all("Sentinel VV" in name for name in namespace["ds"].children)
        context["layers"].remove(first["id"])
        assert earth.sync(namespace, context) == {}
        assert key not in namespace["ds"].children
        assert len(namespace["ds"].children) == 1
        assert earth.publish(namespace) == []
    assert tasks == []


def test_projected_viewport_mask_and_vector_refresh(tmp_path, monkeypatch):
    from pyproj import Transformer
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    earth = Earth()
    path = tmp_path / "Projected.tif"
    with rasterio.open(path, "w", driver="GTiff", width=100, height=100, count=1, dtype="float32",
                       crs=32645, transform=from_origin(300000, 3200000, 1000, 1000)) as target:
        target.write(np.ones((1, 100, 100), dtype="float32"))
    raster = earth.add(path)
    vector_path = tmp_path / "Sites.gpkg"
    gpd.GeoDataFrame({"value": [1, 2]}, geometry=[Point(85.1, 28.1), Point(85.5, 28.5)], crs=4326).to_file(vector_path)
    vector = earth.add(vector_path)
    bounds = [85.05, 28.05, 85.4, 28.4]
    context = {"layers": [raster["id"], vector["id"]], "view": {"bbox": bounds}}
    namespace = {"ds": xr.DataTree(), "dfs": {}}
    tasks = []
    with Callback(pretask=lambda *args: tasks.append(args[0])):
        assert earth.sync(namespace, context) == {}
        earth._bindings.displays(namespace)
    assert tasks == []
    array = namespace["ds"]["Projected"]["data"]
    longitude, latitude = Transformer.from_crs(32645, 4326, always_xy=True).transform(*np.meshgrid(array.x, array.y))
    inside = (longitude >= bounds[0]) & (longitude <= bounds[2]) & (latitude >= bounds[1]) & (latitude <= bounds[3])
    assert inside.any() and (~inside).any()
    np.testing.assert_array_equal(np.isfinite(array.compute()), inside)
    assert namespace["dfs"]["Sites"].compute().value.tolist() == [1]
    namespace["dfs"]["Sites"] = namespace["dfs"]["Sites"].assign(value=3)
    assert earth.publish(namespace) == []
    context["view"] = {"bbox": [85.45, 28.45, 85.55, 28.55]}
    earth.sync(namespace, context)
    assert namespace["dfs"]["Sites"].compute().value.tolist() == [2]
    context["view"] = {"bbox": [0, 0, 1, 1]}
    with Callback(pretask=lambda *args: tasks.append(args[0])):
        assert earth.sync(namespace, context) == {}
        assert namespace["ds"]["Projected"]["data"].size == 0
        assert earth.publish(namespace) == []
    assert tasks == []


def test_datatree_nodes_share_vv_vh_coordinates(tmp_path, monkeypatch):
    import json
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    earth = Earth()
    paths = {}
    for name in ["vv", "vh"]:
        path = tmp_path / f"{name}.tif"
        with rasterio.open(path, "w", driver="GTiff", width=20, height=16, count=1, dtype="float32",
                           crs=4326, transform=from_origin(85, 28, .01, .01)) as target:
            target.write(np.ones((1, 16, 20), dtype="float32"))
        paths[name] = str(path)
    local = earth.add(paths["vv"])
    remote = earth.add(paths["vh"])
    remote.update(kind="stac", assets=paths)
    (earth.store.path(remote["id"]) / "metadata.json").write_text(json.dumps(remote))
    monkeypatch.setattr(earth, "assets", lambda identifier: paths)
    namespace = {"ds": xr.DataTree(), "dfs": {}, "view": {}}
    tasks = []
    with Callback(pretask=lambda *args: tasks.append(args[0])):
        assert earth.sync(namespace, {"layers": [local["id"], remote["id"]]}) == {}
    assert len(namespace["ds"].children) == 2
    dataset = next(node.to_dataset() for node in namespace["ds"].children.values() if node.attrs["layer_id"] == remote["id"])
    assert set(dataset.data_vars) == {"vv", "vh"}
    assert dict(dataset.sizes) == {"y": 16, "x": 20}
    assert dataset.vv.dims == dataset.vh.dims == ("y", "x")
    assert dataset.vv.chunks and dataset.vh.chunks
    assert tasks == []
    from server.workspace import compact_dataset
    old = xr.Dataset({name: dataset[name].rename(x=f"{name}_x", y=f"{name}_y").expand_dims({f"{name}_band": [1]}) for name in ["vv", "vh"]}, attrs=dataset.attrs)
    assert compact_dataset(old).identical(dataset)
    outside = Earth()
    monkeypatch.setattr(outside, "assets", lambda identifier: (_ for _ in ()).throw(AssertionError("Offscreen assets must not be opened")))
    empty = {"ds": xr.DataTree(), "dfs": {}}
    with Callback(pretask=lambda *args: tasks.append(args[0])):
        assert outside.sync(empty, {"layers": [remote["id"]], "view": {"bbox": [0, 0, 1, 1]}}) == {}
        node = next(iter(empty["ds"].children.values()))
        assert set(node.data_vars) == {"vv", "vh"}
        assert node["vv"].size == node["vh"].size == 0
    assert tasks == []


def test_lazy_bindings_and_changed_preview(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_EARTH_DATA", str(tmp_path))
    earth = Earth()
    raster = tmp_path / "sample.tif"
    with rasterio.open(raster, "w", driver="GTiff", width=20, height=20, count=1, dtype="float32",
                       crs=4326, transform=from_origin(85, 28, .01, .01)) as target:
        target.write(np.ones((1, 20, 20), dtype="float32"))
    vector = tmp_path / "sample.gpkg"
    gpd.GeoDataFrame({"value": [1, 2]}, geometry=[Point(85, 28), Point(86, 29)], crs=4326).to_file(vector)
    raster_layer, vector_layer = earth.add(raster), earth.add(vector)
    context = {"layers": [raster_layer["id"], vector_layer["id"]], "view": {"bbox": [85, 27, 86, 29]}}
    namespace = {"ds": xr.DataTree(), "dfs": {}, "view": {}}
    tasks = []
    with Callback(pretask=lambda *args: tasks.append(args[0])):
        assert earth.sync(namespace, context) == {}
        assert earth.sync(namespace, context) == {}
        assert earth.publish(namespace) == []
    assert tasks == []
    raster_key = earth.store.get(raster_layer["id"])["notebook_key"]
    vector_key = earth.store.get(vector_layer["id"])["notebook_key"]
    assert namespace["ds"][raster_key]["data"].chunks is not None
    assert namespace["dfs"][vector_key].npartitions == 1
    assert namespace["view"]["bbox"] == context["view"]["bbox"]
    namespace["ds"][raster_key]["data"] *= 4
    assert earth.publish(namespace) == []
    raster_copy = earth.visualize(namespace, raster_key)[0]
    with rasterio.open(earth.path(raster_copy["id"])) as preview:
        np.testing.assert_array_equal(preview.read(), 4)
    with rasterio.open(raster) as original:
        np.testing.assert_array_equal(original.read(), 1)
    namespace["dfs"][vector_key] = namespace["dfs"][vector_key].assign(value=lambda frame: frame.value * 3)
    assert earth.publish(namespace) == []
    vector_copy = earth.visualize(namespace, vector_key, "dfs")[0]
    assert gpd.read_file(earth.path(vector_copy["id"])).value.tolist() == [3, 6]
    assert gpd.read_file(earth.path(vector_layer["id"])).value.tolist() == [1, 2]
    restarted = Earth()
    restored = {"ds": xr.DataTree(), "dfs": {}, "view": {}}
    restarted.sync(restored, context)
    np.testing.assert_array_equal(restored["ds"][raster_key]["data"].compute(), 1)
    assert restored["dfs"][vector_key].compute().value.tolist() == [1, 2]
    namespace["ds"]["derived"] = namespace["ds"][raster_key].to_dataset() * 2
    assert earth.publish(namespace) == []
    added = earth.visualize(namespace, "derived")
    assert len(added) == 1
    assert added[0]["notebook_key"] == "derived - notebook copy"
    extended = {**context, "layers": [*context["layers"], added[0]["id"]]}
    earth.sync(namespace, extended)
    assert "derived" in namespace["ds"].children
    extended["view"] = {"bbox": [85, 27.9, 85.1, 28]}
    earth.sync(namespace, extended)
    assert earth.publish(namespace) == []
    assert namespace["ds"][raster_key].sizes["x"] <= 11
    np.testing.assert_array_equal(namespace["ds"][raster_key]["data"].compute(), 4)
    earth.sync(namespace, {"layers": [], "view": {"bbox": [0, 0, 1, 1]}})
    assert list(namespace["ds"].children) == ["derived"] and not namespace["dfs"]