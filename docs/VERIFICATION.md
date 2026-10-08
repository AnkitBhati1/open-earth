# Verification

## Historical Checks

The results below describe earlier development snapshots verified on macOS on 2026-09-17 with Python 3.12 and Chromium. Counts, visual descriptions, and behavioral details are historical, not a claim that the current source has passed those suites. In particular, the current light globe backdrop, full catalog extents, and explicit notebook-copy behavior supersede earlier descriptions here. See the README for current behavior and commands.

Latest notebook milestone: 31 Python tests and 6 browser workflows pass. Additional coverage verifies zero Dask tasks during unchanged binding synchronization, full-resolution source preservation after kernel recreation, changed raster/vector previews, named derived nodes, view-scoped previews, valid notebook documents, required imports, rich outputs/errors, run-all variable continuity, interruption/recovery, import/export, cell management, persisted reloads, and exact changed map pixels. Desktop and mobile notebook screenshots were inspected; the mobile layers drawer no longer occludes the notebook. Lint has only the existing inactive-renderer warning.

- Production TypeScript/Vite build passes.
- Python suite: 29 tests pass, including difference/union area checks, convex hull, multipart splitting, interior points, NoData behavior, API access checks, persistent local kernel execution, STAC all-band/subset loading, and date/null properties in vector display/export. Symbology checks cover embedded palettes, exact class pixels, hidden-class transparency, five ramps, unchanged source values, saved bands, reset defaults, Esri/ESA schemas, and generic STAC class metadata. Extent tests verify persisted bounds, transparent boundary pixels and zero upstream requests outside the clip. Polygon tests verify one dataset/file with multiple exported features.
- Playwright suite: 4 tests pass, covering textured globe pixels and zoom response, visible Terra Draw draft pixels, polygon closure/vertex dragging/undo/redo/save, desktop/mobile layout, vector upload/buffer/table/export, persistent Python, and Python-produced GeoTIFF display/calculation. Drawing after reload appends to the same layer and refreshes its map source. A mocked catalog regression confirms loading keeps the searched clipping bounds even after the bounds input changes.
- Screenshots inspected at 1440 x 960 and 390 x 844; generated images live in ignored test-results/.
- Latest browser coverage verifies OSM default, top-toolbar position, bundled star-image availability, removal/undo/reload without deleting stored data, removal persisting after Python refresh, and running convex hull from the toolbar. Desktop/mobile screenshots confirm an uncropped globe against the star field.
- Live EOX satellite imagery renders. MPC Sentinel-2 search returned seven scenes for the example Kathmandu bounds; scene previews render through the local tile proxy. OSM tile availability checked.
- Launcher starts on loopback and selects a different port when occupied.
- Browser symbology coverage verifies editing a class color/label, hiding a class, applying a preset, exact custom-colored canvas pixels, saved styles after reload, and mobile editor bounds. All four browser workflows pass together; repeat-run removal selectors tolerate prior test datasets.
- A live Esri annual land-cover preview returned lossless PNG with all 65,536 pixels matching declared class colors. Categorical MPC requests explicitly omit rescaling and request nearest sampling and PNG.

## Remaining caveats

Google rendering and billing need the user's API credentials and have not been verified. One-click managed environment creation, Windows support, large datasets, and all MPC collections have not been exhaustively tested.

Lint completes with one warning in the inactive Globe.tsx (effect state usage). Vite reports a large main bundle and a legacy runtime-resolved thumbnail path. The active main bundle is about 1.92 MB minified, with a separate 508 KB MapLibre worker; this is not an FPS benchmark. Python dependencies emit deprecation and raster rendering warnings; the tests pass. These are not claims of production readiness or proof of smoothness on every device.

See README.md for exact supported formats, operation limits, security boundaries, and test commands.