# Open Earth

A local-first geospatial workspace: explore the Earth, bring in data, run GIS operations, and edit Python alongside the map.

Built with React, TypeScript, MapLibre GL, FastAPI, GeoPandas, Rasterio, and Jupyter. The web app and Python service run locally; no hosted compute account is required.

**Development preview.** Python runs with your local user permissions. Use trusted data and code, keep the service on loopback, and do not expose it as a public or multi-user server.

[Architecture](docs/ARCHITECTURE.md) | [Design decisions](docs/MEMORY.md) | [Verification notes](docs/VERIFICATION.md)

## Run locally

Prerequisites: Node.js 22.12+ (or a compatible newer version), npm, and [uv](https://docs.astral.sh/uv/). Python 3.12 is recommended; uv can install it. First setup needs internet access.

```sh
git clone https://github.com/AnkitBhati1/open-earth.git
cd open-earth
npm ci
uv sync --python 3.12 --inexact
npm run build
npm start
```

Open the URL printed in the terminal, normally **http://127.0.0.1:8765**. The launcher chooses another local port if that port is occupied. It serves both the web app and Python API, with no hosted compute service.

To request a particular port, use `npm start -- --port 8770`. The `--inexact` setup option preserves extra packages you may have installed for local notebooks instead of removing them during dependency synchronization.

For frontend development, run `uv run uvicorn server.main:app --host 127.0.0.1 --port 8765` and `npm run dev` in separate terminals. Vite proxies `/api` to the local Python service. Rebuild before using the non-development launcher.

## Included in this preview

- MapLibre GL globe and 2D map, location search, zoom, north reset, Terra Draw polygon creation with editable vertices and undo/redo, and Turf geodesic distance measurement.
- OpenStreetMap by default, with optional EOX Sentinel-2 cloudless 2016 imagery, NASA Blue Marble via EOX, Google Satellite direct tiles, and configurable official Google satellite tiles. Basemaps require network access. The globe uses a pale blue-gray backdrop and a soft MapLibre atmosphere, coordinated with the light workspace controls.
- GeoTIFF/COG raster imports; GeoParquet (`.parquet`, `.geoparquet`, `.pq`), geospatial Feather/Arrow, and vector formats readable by the installed GDAL drivers, including GeoJSON, GeoPackage, Shapefile, FlatGeobuf, KML, GPX and GML. Select a Shapefile's matching `.shp`, `.shx`, `.dbf` and `.prj` files together, upload their ZIP, or import the local `.shp` path. File Geodatabases can be opened by their local `.gdb` directory path. Plain Parquet/Arrow tables without geospatial metadata are not automatically interpreted as spatial data. A defined CRS is required; support for other formats depends on installed drivers.
- Layer visibility, opacity, vector colors, raster band selection and contrast stretch, extent navigation, and attribute tables.
- Adaptive raster symbology with metadata-based RGB and class detection, per-band recommendations, local distribution previews, categorical palette swatches, five continuous ramps and editable ranges. Auto applies the recommendation; individual colors, labels, values, visibility and bands remain editable with Apply style. Reset stages the original dataset style. Saved styles persist without changing source pixels.
- QGIS-inspired top toolbar for sketch, vector, and raster actions. Vector buffer (meters, regional UTM), clip, intersect, difference, union, dissolve, merge, centroids, convex hull per feature, multipart-to-singlepart splitting, interior points, reprojection, and exact attribute filtering.
- Raster clip, reprojection, resampling, single-raster band calculator, categorical polygonization, binary rasterization on an existing raster grid, and zonal statistics of band 1.
- MPC collection discovery, bounded/date-filtered search, cloud filtering where supported, and scene footprints. Load all raster bands by default or a selected subset, with independent display bands. Known Esri land-cover and ESA WorldCover collections receive named class palettes; other collections use available classification metadata or RGB/continuous defaults. Initial shortcuts include Sentinel-2, Sentinel-1 RTC, Landsat, NAIP, Copernicus DEM, and Esri annual land cover.
- Cell-based Python notebook with code/Markdown, rich table/image/error outputs, execution counts, run-all, interruption/restart, cell reorder/duplicate/delete/undo, output clearing, autosave, and validated `.ipynb` import/export. Local environment selection and managed environment creation remain available.
- GUI operations expose equivalent Python code; `earth.add(path)` publishes Python-produced data back to the layer list after execution.
- Native GeoTIFF/GeoPackage output downloads and GeoJSON export. Save/restore a workspace view in browser storage.

## Processing tools

The top bar puts Clip, Buffer, Dissolve, Reproject, Raster calculator, Zonal statistics, and the attribute table within one click. All tools opens a compact grouped list with All/Vector/Raster filters and recent tools. Search matches standard GIS names and common terms such as crop, erase, pixel size, and NDVI (which opens the calculator, not an automatic band-specific index).

Opening a tool retains a compatible selected input, otherwise prefills an available layer. Compatibility depends on raster/vector data, not whether it was imported, drawn, generated, or loaded from the catalog. Boundary tools prefill a unique vector candidate or the sole available raster extent; ambiguous choices remain explicit. Swap inputs is available only for compatible vector pairs. Parameter values are remembered during the current page session, including when returning to All operations, with inline checks for missing or invalid values. Run creates a separate output layer; single-line fields support Enter to run. Calculator band buttons insert at the cursor or replace selected text. Python code remains available under a collapsed disclosure.

Raster tools accept local files and catalog rasters directly. Catalog operations sign and read the native analytical asset, not rendered tile colors. Single-asset datasets such as Esri LULC need no extra choice; multi-asset datasets expose a Raster asset selector and process one asset at a time, including its internal bands. Separate assets are not automatically stacked or aligned. Clip and Zonal statistics accept polygons, Entire input raster, or another local/catalog raster's extent. Extents use the native raster corners and CRS, including rotated grids, as temporary footprints without adding polygon layers. Zonal statistics exclude NoData; Rasterize still requires vectors. Clip reads the boundary's source window; existing size guards remain, so large scenes may need clipping first. Outputs are independent local datasets. Clip and nearest-neighbor reprojection/resampling retain categorical styles, including known Esri schemas for older metadata. Network access is required for remote inputs.

The interaction follows familiar [QGIS toolbox](https://docs.qgis.org/latest/en/docs/user_manual/processing/toolbox.html) conventions for keyword search, grouped operations, recent access and parameter defaults, while retaining the compact map-first layout.

## Raster styling

Catalog search bounds only select matching items. Loading a dataset retains the full item extent and selected assets, streamed on demand rather than downloaded in full. Notebook bindings independently select the current map viewport. Reload older clipped catalog records to restore their full item extent.

Drawing starts in Continuous mode: closing a polygon saves it and keeps the tool ready for the next polygon, without zooming, opening the sidebar, or interrupting the map view. New layers use an automatic Annotations name; features get sequential Polygon names and unique annotation IDs. Saves are queued to keep rapid drawings in the same GeoPackage and export. The toolbar shows vertex/save status and lets you choose New annotation layer or an existing drawing layer. Done returns to navigation while queued saves continue; Escape does the same when no unfinished polygon remains. A separate Discard current draft action never removes saved or pending polygons. Disable Continuous to adjust a closed polygon's vertices: Finish polygon saves and continues, while Done saves and leaves drawing. Failed saves leave their draft on the map for retry with Finish polygon. The browser warns before leaving with drafts or saves outstanding; these drafts are not crash-recovery storage. Imported vectors and scene footprints are not modified by drawing.

The map's Layers control provides visibility, selected-layer opacity, feature/band counts, CRS, filtering for longer lists, and explicit zoom-to-layer without opening Visualize. A metric scale follows the viewport. Vector revisions update their existing map source rather than removing and rebuilding it.

Click or tap visible features or raster coverage while no sketch tool is active to inspect them directly. A compact, scrollable panel shows polygon attributes or native pixel values for every band, including all assets registered in a catalog layer, independently of its display bands. Overlapping results use a selector. The panel can collapse to its header, closes with Escape or map movement, and never moves the camera or opens the sidebar.

To delete a saved polygon, leave drawing with Done, click the polygon, select the intended result if features overlap, and use Delete selected feature in the inspector. Confirming removes that whole feature (including every part of a MultiPolygon), not its layer or neighboring features. Undo deletion restores the last deletion while the layer is unchanged. Deleting the last feature keeps an empty layer; drawing layers can accept new polygons. Stale selections are rejected after a layer changes. Edits switch the workspace layer to a new GeoPackage and retain its previous file; originally imported files and existing independent notebook objects are not modified.

Raster inspection transforms the clicked coordinates into each source CRS and reads a native one-pixel window, not the rendered tile color. Zero values remain zero; NoData, outside coverage, and unavailable remote assets are distinguished. Source scale/offset and units appear when supplied by the raster. Remote sampling requires network access and offers retry on failure. Continuous rasters show a compact color ramp with the active display range, not guaranteed full-dataset extrema; categorical legends stay collapsed until opened.

Raster styling follows metadata-first conventions from [GDAL](https://gdal.org/en/stable/user/raster_data_model.html) and [QGIS](https://docs.qgis.org/latest/en/docs/user_manual/working_with_raster/raster_properties.html). Explicit RGB interpretations or red/green/blue descriptions select the correct local channel order; catalog common-name metadata identifies RGB assets. Band count alone does not make an arbitrary local scientific stack RGB. Embedded palettes, catalog classification metadata and known dataset schemas retain their class colors and labels automatically. Vendor-specific schemas are no longer interchangeable menu presets.

For local single-band data or a selected band, a preview of at most 256 by 256 cells can identify small integer-valued category sets (1-32 values), including floating-point masks. Declared units, scale or offset favor continuous rendering. Detected values without class metadata get generic labels, not invented meanings. Sampled classes are identified as estimates and may omit rare classes; manual class editing remains available. Local continuous displays retain the 2nd-98th percentile stretch, with a compact distribution preview. Catalog band statistics supply ranges when available; otherwise the existing dataset range is used. Catalog recommendations use metadata without downloading scenes; remote histograms are not computed.

Changing a single display band updates its recommendation and clears the previous band's class table. Auto applies that recommendation in one action. Dataset, soft and high-contrast palette swatches change colors only, preserving values, labels and visibility. Opening the panel does not overwrite saved custom styles. Clipping and nearest-neighbor raster operations retain the inherited categorical default. Vector styling remains a single layer color and opacity.

Categorical tiles preserve raw IDs, use nearest-neighbor sampling, and use lossless PNG for MPC previews. NoData, hidden classes, and values absent from the style are transparent. Apply style saves display metadata only; source raster values are unchanged. Automatic semantic labeling is limited to recognized schemas and supplied metadata, not arbitrary datasets. Recognized land-cover filenames and metadata recover standard class colors; class numbers alone do not identify a product. Raster downloads embed the current style in a separate TIFF copy, preserving labels, colors, visibility, and display bands when re-imported, even under a different filename. Older Open Earth exports can recover a recognized source classification when their export ID and file contents match a source still in the workspace.

## Google imagery

**Google Satellite** uses the direct `mt0` through `mt3.google.com` raster tile URLs from the [Made With MapLibre example](https://madewithmaplibre.com/basemaps/styles/google-satellite), without an API key. Google Maps attribution is displayed on the map. This example is not a license grant or an availability guarantee; use remains subject to the provider's terms and your deployment's permissions.

**Google Satellite (API)** retains the official Map Tiles API integration. Enable Map Tiles API and billing in your Google Cloud project, configure a suitable key restriction, and provide the key in your local process environment before starting the app:

```sh
# Set GOOGLE_MAPS_API_KEY privately in your terminal or environment manager.
export GOOGLE_MAPS_REGION=US
npm start
```

Alternatively, create a local `.env` from `.env.example` using your editor and launch with `uv run --env-file .env python scripts/serve.py`. `npm start` does not automatically load `.env`.

OpenStreetMap remains the default even when a Google key is configured; choose Google explicitly in the basemap picker. Key validity, billing, live Google rendering, and provider-specific zoom limits require verification with your credentials. The browser receives the key for direct tile requests; use a dedicated, restricted, quota-limited demo key. Do not commit keys.

The Google API-backed option remains display-only. Its session creation and viewport attribution use official endpoints. The direct Google Satellite option can be explicitly clipped as described below, subject to your provider permissions. This is a local development preview, not a production compliance certification. Review the [Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies) before distribution.

## Clip a basemap

Clip's Input layer selector includes **Current basemap** for OpenStreetMap, Blue Marble, EOX Sentinel-2 and direct Google Satellite. Select a polygon layer or raster extent as the boundary. Tile zoom defaults to the current map detail level, capped at the provider maximum. Each request is limited to 64 tiles and two concurrent downloads; lower Tile zoom or reduce the boundary for larger areas. This is an explicit small-area export, not a bulk or offline tile downloader.

The result is a Web Mercator RGB GeoTIFF with an alpha band outside the boundary, provider attribution and tile zoom metadata. It is a rendered map image, not raw satellite measurements or underlying OSM vector features. Only the final clipped raster is registered. Attribution must be retained when sharing exports, and provider terms and permissions still apply. Python uses the same operation: `earth.run("basemap:osm", "clip", params={"zoom": 12}, other=polygon_layer_id)`.

## Python workflow

The app starts with its own isolated `.venv`. The runtime dialog also discovers `~/.venvs/*/bin/python` and managed environments; other Conda/virtualenv executables can be entered directly. An existing environment needs `ipykernel` and this project's geospatial dependencies. Selecting an environment never installs into it automatically.

The notebook is saved to `.earth/workspace.ipynb`. Its top imports initialize `numpy as np`, `pandas as pd`, `geopandas as gpod`, `xarray as xr`, `rioxarray`, Dask, and the Earth SDK. The imports are shown in a collapsible first cell. Code runs in one persistent kernel; Shift+Enter runs and advances, and Ctrl/Cmd+Enter runs the current cell. Imported notebook code is never executed automatically. HTML outputs are sandboxed; interactive JavaScript widgets and stdin prompts are not supported. Outputs arrive when a cell finishes, not as a live stream.

- `ds` is an xarray `DataTree` with one Dataset child per opened raster layer, using readable layer names as stable keys (duplicate names receive numbered suffixes). Each node contains only the current viewport at native resolution, selected lazily from the full source. Offscreen layers have empty nodes. Aligned Sentinel-1 assets are simply `vv(y, x)` and `vh(y, x)`, sharing coordinates. Only different grids need separate dimensions. Local rasters use the `data` variable.
- Drag the divider between map and notebook to resize them. Desktop widths and mobile heights are remembered separately. The divider also supports arrow keys and double-click to reset.
- `dfs` is a dictionary of Dask-GeoPandas frames, using readable vector layer names and clipped lazily to the current viewport, with 5,000-row source partitions.
- `view` contains the current geographic `bbox` and map `zoom`. Idle synchronization follows movement, resize, and layer add/remove, retrying when the kernel is busy. A running cell gets the current view at execution start, with later movement synchronized afterward. Existing cells displaying only `ds`, `dfs`, or `view` refresh their displayed metadata without rerunning user code.
- `layer_names` maps notebook keys to display names. Session data lists both imported and derived notebook datasets. Click a name to insert its reference. Drag a dataset onto the map, or use its Add copy to map button, to create an independent visualization layer. Focus mode expands the notebook; cells support collapse, execution timing, and keyboard navigation.

Notebook bindings are independent copies: editing `ds` or `dfs`, including adding derived children, never automatically publishes changes or alters an existing map layer. Opening/synchronizing sources reads metadata and may sign remote URLs, but does not compute Dask arrays or vector partitions. Projected rasters are masked lazily at the geographic viewport boundary. Panning updates bindings without computing previews; notebook edits remain associated with their edited coordinates. Explicit drag/drop or Add copy to map snapshots the chosen object into a new layer with its own ID and files. Later notebook edits do not alter that copy. `earth.publish()` no longer performs automatic publication.

Creating a raster visualization copy writes the selected notebook dataset at native resolution, preserving all pixels, bands and dtype without additional viewport clipping or downsampling. Chunked writes limit working memory without reducing resolution; the map renders tiles from the resulting GeoTIFF, and downloads retain its native resolution. Variables combined into one raster must share a CRS, grid and dtype; select extra dimensions explicitly or copy incompatible variables separately. Notebook ds bindings themselves still represent the current viewport, so copying one does not recover pixels outside that dataset. Vector copies contain at most 5,000 features from the first partition. Original map layers and files are untouched. After kernel restart, source graphs reopen at the current viewport; rerun cells to reconstruct transformations. Full-scene analysis requires opening original sources or signed assets through the SDK. Python remains a local, unsandboxed kernel: explicit filesystem writes or SDK operations are not blocked by this binding isolation.

```python
raster_key = next(iter(ds.children))
ds["scaled"] = ds[raster_key].to_dataset() * 2

vector_key = next(iter(dfs))
dfs["selection"] = dfs[vector_key][dfs[vector_key].geometry.notnull()]

viewport_result = ds["scaled"].to_dataset().compute()
viewport_result["data"].rio.to_raster("scaled-viewport.tif")
earth.add("scaled-viewport.tif", "Native-resolution viewport result")
```

```python
from server.sdk import earth

datasets = earth.layers()
path = earth.path(datasets[0]["id"])

result = earth.run(datasets[0]["id"], "buffer", {"distance": 250})
earth.add("/absolute/path/to/prediction.tif", name="Prediction")
```

Choose the correct dataset kind for an operation. GUI operations currently run in the service's Python environment; editable code runs in the selected kernel. Both call the same processing module and dataset store. Arbitrary code does not round-trip into GUI parameters. A restart clears variables; closing only the tab does not stop the service/kernel. Cells have a 120-second execution limit in this preview.

## Data and security

Imported files are copied into `.earth/datasets/` and outputs create new datasets. Original files are not overwritten. Each layer row has a quick remove button, with Undo for the latest removal. Removal is non-destructive and persists in this browser across reloads and Python refreshes. Restoring a saved workspace can re-add its layers. Saved views hold local dataset references and code, not portable data or Python variables. Registered MPC datasets retain asset metadata; display URLs are renewed when layers load after a service restart.

The service binds to loopback, checks Host/Origin/fetch-site, uses an HttpOnly SameSite session cookie, and requires a custom header for state-changing requests. Python is **not sandboxed**: it runs with your user account's file and process permissions. Run only trusted code and open trusted geospatial files. This is not safe for untrusted multi-user hosting. Do not bind it publicly or expose it through a tunnel.

Catalog searches send the selected extent and dates to Microsoft. Place searches go to Nominatim only on explicit submission, with a one-request-per-second limit and in-process result caching. Tile providers receive viewport tile requests. Display attribution must remain visible. See [provider inventory](configs/providers.json); frontend basemap definitions live in `src/MapWorkspace.tsx`.

## Current boundaries

- Not a full QGIS replacement. No NetCDF/Zarr multidimensional reader, editing of existing imported features, spatial joins, batch point sampling/export, multi-raster alignment/mosaics, terrain elevation, temporal charts, or curated AI training UI yet. Disable Continuous to edit new polygons before saving by closing the ring and dragging its handles.
- MPC scenes retain remote analytical asset references, not downloaded local rasters. GUI raster tools read the chosen asset directly and create local outputs. Use `earth.assets(id)` for signed URLs in Python. No curated model-training interface or remote runtimes.
- Upload limit: 256 MB per file. Local-path imports bypass upload size but still copy the source. In-memory raster operations are capped at 24 million cells; clipping checks the requested output window. Vector rendering is limited to 100,000 features and can be slow near that limit.
- Multi-layer datasets open their default/first vector layer; the import API accepts an optional `layer` name (JSON for local imports, form field for uploads). ZIP datasets are limited to 512 MB uncompressed; uploaded datasets to 256 MB including sidecars. Source CRS must exist. Buffering requires a regional footprint spanning at most 12 degrees longitude. Raster calculator uses `b1`, `b2`, etc., from one aligned input and propagates invalid/NoData values. Zonal statistics use pixel-center inclusion.
- Tested primarily on macOS. Windows environment discovery and packaging need additional work.
- External basemap/catalog availability and quotas are outside this app's control. EOX's 2016 layer is CC BY 4.0; other years have different terms. OSM's public tile service is for light interactive use, not bulk/offline downloads.

## Repository

```text
src/                  React workspace, MapLibre/Terra Draw renderer, API client
server/               FastAPI, geoprocessing, local Python SDK
configs/              Provider inventory
public/samples/       Illustrative Kathmandu study boundary
scripts/              Local launcher
tests/                Python and browser tests
docs/                 Architecture, design memory, verification
.earth/               Ignored local datasets and managed environments
outputs/              Ignored local research runs and generated artifacts
```

The repository contains the application, dependency lockfiles, small sample assets, tests, and documentation. Imported datasets, notebook state, model weights, research outputs, credentials, dependencies, and generated builds remain local and are not uploaded. A fresh clone starts without the datasets or analysis state from another machine.

## Verification

```sh
npm run build
npm run lint
uv run pytest -q
npx playwright install chromium
npm test
```

Browser tests launch a separate loopback service on port 8766 and use `.earth-e2e/`, not your working datasets. Screenshots are saved in ignored `test-results/`. See [verification notes](docs/VERIFICATION.md).

## Licensing

A project license has not yet been selected. Third-party dependencies and data providers retain their own licenses and usage terms. Downloaded datasets and trained model weights are not distributed with this source repository.
