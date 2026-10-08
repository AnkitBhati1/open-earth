# Design Decisions

## Non-negotiable direction

The design prioritizes **aesthetic + minimal**, clear visual hierarchy, responsive interaction, and an interface understandable at a glance. Avoid crowded GIS toolbars and disorganized panels as features grow.

Keep a light workspace rather than a black/graphite application theme.

The globe uses a soft pale blue-gray backdrop with MapLibre atmosphere, light surrounding controls, OpenStreetMap as default, a QGIS-style top GIS toolbar, and quick layer removal. Avoid decorative illustrations behind the map. Initial/home camera must fit the smaller canvas dimension on mobile.

- The Earth/map is the primary experience, never a landing-page illustration or a decorative card.
- Use a slim navigation rail, one contextual side panel, and an optional code panel. Do not show every tool at once.
- Make basic vector/raster tools discoverable through clear groups and recognizable icons. Advanced options use progressive disclosure.
- Use restrained colors, purposeful typography, consistent spacing, small corner radii, accessible labels, keyboard focus, and visible loading/error states.
- Keep map interactions responsive while Python operations run. Large workloads need explicit limits or background job execution, not a frozen UI.
- Validate real canvas pixels, assets, camera interaction, desktop/mobile framing, and overlapping controls before calling a frontend milestone complete.

## Product contract

Open Earth combines geospatial GUI operations with editable Python and map outputs. Local Python is a first-version requirement. Remote runtimes, SSH, and tunnels are deferred. Optional basemaps include both direct Google Satellite tiles and the credentialed official Map Tiles API integration; availability and use remain subject to provider permissions and terms.

The first slice is globe/basemaps, local raster/vector import, basic GIS processing, MPC STAC discovery/previews, and local Python. Broader temporal analysis, NetCDF/Zarr, model training, and AI pairing are future slices.

## Verified implementation conventions

- React/TypeScript/Vite, MapLibre GL, Terra Draw, Radix tooltips, Lucide icons, Manrope and DM Sans. Current composition uses white and cool-gray surfaces, restrained teal accents, vertical workspace navigation, contextual layers/tools, and a light Python panel.
- FastAPI on loopback serves both the built frontend and API. The Python environment is managed with uv.
- Use `uv run --directory /absolute/path/to/open-earth ...` when launching from another working directory. The editor's terminal tool may strip a leading `cd` in async launches.
- Bundle MapLibre's worker with `?worker&url`, not `?url`: the latter omits shared worker imports. Geometry snapshots alone do not prove rendering. Browser tests must inspect exact draft-color pixels in the drawing region, not bright pixels across satellite imagery.
- EOX's 2016 Web Mercator layer is `s2cloudless_3857`, not `s2cloudless-2016_3857`.
- MPC preview tiles use a fixed-provider local proxy to avoid inconsistent upstream CORS headers. Never turn this into an arbitrary URL proxy.
- Raster styles live in dataset metadata, never modify source values, and apply explicitly. Preserve original defaults and bands before the first edit so Reset survives restart. Known MPC land-cover IDs include io-lulc, io-lulc-9-class, io-lulc-annual-v02, and esa-worldcover.
- Class rendering must avoid rescaling and use nearest sampling plus tile_format=png for MPC. Default JPEG introduces off-palette colors. Verify exact tile/canvas pixels after repaint, not just saved-state text. Local sampled class discovery can miss rare values; do not claim universal semantic classification.
- Python UI is now src/Notebook.tsx, with saved .earth/workspace.ipynb and persistent Jupyter rich outputs. server/workspace.py binds ds (xarray DataTree), dfs (dict of Dask-GeoPandas frames), view and layer_names. Imports include np/pd/gpod/xr/rioxarray. Metadata initialization is not zero I/O, but unchanged binding sync executes zero Dask tasks.
- Notebook bindings are independent lazy viewport copies; edits never automatically publish or alter map layers. Explicit Add copy to map writes raster data at native resolution and vectors up to 5K features into a separate dataset. Notebook bindings still cover only the viewport; restart reopens sources and transformations require rerunning cells. New nodes map via notebook_key. Layer refresh must prefer server metadata and MapWorkspace source/tile keys must include revision.
- Notebook persists while closed, serializes idle sync against cell execution, reconnects existing kernels on reload, and retains current kernel/view in refs for Run all. Imported HTML is sandboxed. Browser fixtures hide prior test dataset IDs and reset only the isolated test notebook; never touch user .earth data for tests.