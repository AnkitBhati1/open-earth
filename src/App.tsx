import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Earth, Layers, Database, SlidersHorizontal, Plus, Search, X, ArrowUpRight, ChevronDown,
  Eye, EyeOff, Crosshair, Trash2, Download, Upload, FileCode2, Play,
  Minus, Compass, Pentagon, Ruler, Check, Grid2X2, Image, Table2, Cpu, CircleHelp,
  ArrowLeft, LoaderCircle, FolderOpen, Map, Globe2, Settings2, Save, ArrowRight,
  Scissors, Combine, CircleDot, Filter, GitMerge, Calculator, Scan, BarChart3, Undo2, Redo2,
  ArrowLeftRight, Shapes, Merge, CopyMinus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import * as Tooltip from '@radix-ui/react-tooltip'
import Notebook from './Notebook'
import { NotebookDropTarget } from './NotebookData'
import type { NotebookObject } from './NotebookData'
import WorkspaceDivider from './WorkspaceDivider'
import type { CellResult } from './Notebook'
import Globe from './MapWorkspace'
import RasterDisplay, { RasterLegend } from './RasterDisplay'
import type { Basemap, Drawing, GlobeHandle } from './Globe'
import { api, palette } from './api'
import type { Layer } from './api'
import './App.css'
import './Workspace.css'
import './Notebook.css'

type Panel = 'layers' | 'catalog' | 'tools' | null
type Modal = 'import' | 'runtime' | 'basemap' | 'table' | 'about' | null
interface Tool { id: string; name: string; icon: LucideIcon; kinds: string[]; second?: boolean }
function supportsLayer(tool: Tool, layer: Layer) {
  return tool.kinds.includes(layer.kind === 'stac' ? 'raster' : layer.kind)
}
function boundaryLayers(tool: Tool | null, layers: Layer[], inputId: string) {
  return layers.filter(layer => layer.kind === 'vector' ? layer.id !== inputId : !!tool && ['clip', 'zonal'].includes(tool.id))
}
function defaultBoundary(boundaries: Layer[]) {
  const vectors = boundaries.filter(layer => layer.kind === 'vector')
  return vectors.length === 1 ? vectors[0].id : boundaries.length === 1 ? boundaries[0].id : ''
}
function rasterAsset(layer: Layer | undefined, preferred?: string) {
  if (layer?.kind !== 'stac') return ''
  const assets = Object.keys(layer.assets ?? {})
  return assets.includes(preferred ?? '') ? preferred! : assets.includes(layer.bands?.split(',')[0] ?? '') ? layer.bands!.split(',')[0] : assets[0] ?? ''
}
const tools: Tool[] = [
  { id: 'buffer', name: 'Buffer', icon: CircleDot, kinds: ['vector'] },
  { id: 'clip', name: 'Clip', icon: Scissors, kinds: ['vector', 'raster'], second: true },
  { id: 'intersect', name: 'Intersect', icon: Combine, kinds: ['vector'], second: true },
  { id: 'dissolve', name: 'Dissolve', icon: Merge, kinds: ['vector'] },
  { id: 'merge', name: 'Merge', icon: GitMerge, kinds: ['vector'], second: true },
  { id: 'centroid', name: 'Centroids', icon: Crosshair, kinds: ['vector'] },
  { id: 'difference', name: 'Difference', icon: CopyMinus, kinds: ['vector'], second: true },
  { id: 'union', name: 'Union', icon: Shapes, kinds: ['vector'], second: true },
  { id: 'convex_hull', name: 'Convex hull', icon: Pentagon, kinds: ['vector'] },
  { id: 'explode', name: 'Multipart to singleparts', icon: Grid2X2, kinds: ['vector'] },
  { id: 'point_on_surface', name: 'Point on surface', icon: CircleDot, kinds: ['vector'] },
  { id: 'filter', name: 'Filter attributes', icon: Filter, kinds: ['vector'] },
  { id: 'reproject', name: 'Reproject', icon: Globe2, kinds: ['vector', 'raster'] },
  { id: 'resample', name: 'Resample', icon: Grid2X2, kinds: ['raster'] },
  { id: 'calculator', name: 'Raster calculator', icon: Calculator, kinds: ['raster'] },
  { id: 'zonal', name: 'Zonal statistics', icon: BarChart3, kinds: ['raster'], second: true },
  { id: 'polygonize', name: 'Polygonize', icon: Pentagon, kinds: ['raster'] },
  { id: 'rasterize', name: 'Rasterize', icon: Scan, kinds: ['raster'], second: true },
]
const toolGroups = [
  { name: 'Common', ids: ['clip', 'buffer', 'dissolve', 'reproject', 'calculator', 'zonal'] },
  { name: 'Overlay & attributes', ids: ['intersect', 'difference', 'union', 'merge', 'filter'] },
  { name: 'Geometry', ids: ['centroid', 'point_on_surface', 'convex_hull', 'explode'] },
  { name: 'Raster conversion', ids: ['resample', 'polygonize', 'rasterize'] },
]
const toolAliases: Record<string, string> = {
  clip: 'crop cut mask boundary', buffer: 'distance radius proximity', dissolve: 'combine boundaries group',
  reproject: 'projection coordinate system crs epsg', calculator: 'math expression ndvi index bands',
  zonal: 'summarize statistics mean min max zones', intersect: 'intersection overlap', difference: 'erase subtract',
  union: 'overlay combine', merge: 'append concatenate', filter: 'select extract attribute query',
  centroid: 'center centre points', point_on_surface: 'interior points', convex_hull: 'envelope bounding',
  explode: 'split multipart singlepart', resample: 'resize resolution pixel size',
  polygonize: 'raster to vector polygons', rasterize: 'vector to raster binary mask grid',
}
const basemaps: { id: Basemap; name: string; source: string; image: string }[] = [
  { id: 'earth', name: 'Blue Marble', source: 'NASA / EOX', image: 'https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/0/0/0.jpg' },
  { id: 'satellite', name: 'Satellite', source: 'EOX · Sentinel-2 · 2016', image: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/0/0/0.jpg' },
  { id: 'osm', name: 'OpenStreetMap', source: 'Streets & places', image: 'https://tile.openstreetmap.org/4/10/6.png' },
  { id: 'google-satellite', name: 'Google Satellite', source: 'Google Maps', image: 'https://mt0.google.com/vt/lyrs=s&x=10&y=6&z=4' },
  { id: 'google', name: 'Google Satellite (API)', source: 'API key required', image: '' },
]
const defaultCollections = [
  { id: 'sentinel-2-l2a', title: 'Sentinel-2 L2A' }, { id: 'sentinel-1-rtc', title: 'Sentinel-1 RTC' },
  { id: 'landsat-c2-l2', title: 'Landsat Collection 2' }, { id: 'naip', title: 'NAIP aerial imagery' },
  { id: 'cop-dem-glo-30', title: 'Copernicus DEM 30 m' },
  { id: 'io-lulc-annual-v02', title: 'Esri / IO Land Cover (9-class)' },
]
interface StacItem {
  id: string; collection: string; bbox: number[]; geometry: object
  properties: { datetime?: string; 'eo:cloud_cover'?: number; start_datetime?: string }
  assets: Record<string, { href: string; title?: string; type?: string; roles?: string[] }>
}
function IconButton({ icon: Icon, label, onClick, active, disabled, className = '' }: {
  icon: LucideIcon; label: string; onClick: () => void; active?: boolean; disabled?: boolean; className?: string
}) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}><Icon size={18} strokeWidth={1.7} /></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tool-tip" sideOffset={8}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}
function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const reference = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = reference.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={reference} className={`dialog ${wide ? 'wide' : ''}`} onCancel={onClose} onClick={event => { if (event.target === reference.current) onClose() }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton icon={X} label="Close dialog" onClick={onClose} /></div>
    <div className="dialog-content">{children}</div>
  </dialog>
}
function CatalogResult({ item, busy, onPreview, onFootprint }: { item: StacItem; busy: boolean; onPreview: (assets: string[] | null) => void; onFootprint: () => void }) {
  const assets = Object.entries(item.assets).filter(([key, value]) => value.type?.includes('tiff') && !['visual', 'rendered_preview', 'thumbnail'].includes(key))
  const [subset, setSubset] = useState<string[] | null>(null)
  return <article className="catalog-result">
    <div className="result-heading"><span className="result-date">{(item.properties.datetime ?? item.properties.start_datetime ?? '').slice(0, 10) || 'Undated'}</span>{item.properties['eo:cloud_cover'] !== undefined && <span>{item.properties['eo:cloud_cover'].toFixed(0)}% cloud</span>}</div>
    <p className="scene-name" title={item.id}>{item.id}</p>
    <div className="scene-band-summary"><span>{subset === null ? 'All' : subset.length} bands</span><span>Auto symbology</span></div>
    <details className="band-subset"><summary>Band selection</summary><label className="checkbox"><input type="checkbox" checked={subset === null} onChange={event => setSubset(event.target.checked ? null : assets.map(([key]) => key))} />All bands</label><div className="band-checks">{assets.map(([key]) => <label key={key}><input type="checkbox" checked={subset === null || subset.includes(key)} onChange={event => setSubset(previous => event.target.checked ? [...(previous ?? assets.map(([name]) => name)), key] : (previous ?? assets.map(([name]) => name)).filter(name => name !== key))} />{key}</label>)}</div></details>
    <div className="button-row"><button className="primary" disabled={busy || subset?.length === 0} onClick={() => onPreview(subset)}><Plus size={15} />Load dataset</button><button className="text-button" disabled={busy} onClick={onFootprint}><Pentagon size={15} />Footprint</button></div>
  </article>
}

function MapLayers({ layers, selectedId, onSelect, onChange, onZoom }: { layers: Layer[]; selectedId: string; onSelect: (id: string) => void; onChange: (id: string, update: Partial<Layer>) => void; onZoom: (layer: Layer) => void }) {
  const disclosure = useRef<HTMLDetailsElement>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (disclosure.current && !disclosure.current.contains(event.target as Node)) disclosure.current.open = false }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && disclosure.current?.open) { disclosure.current.open = false; disclosure.current.querySelector('summary')?.focus(); event.stopPropagation() } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [])
  return <details className="map-layers" ref={disclosure}><summary aria-label="Map layers" title="Map layers"><Layers size={17} /><span>{layers.filter(layer => layer.visible !== false).length}/{layers.length}</span></summary><section className="map-layers-panel" aria-label="Map layer controls"><div className="map-layers-heading"><strong>Layers</strong><span>{layers.filter(layer => layer.visible !== false).length} visible</span></div>{layers.length > 5 && <input aria-label="Filter map layers" placeholder="Filter layers" value={filter} onChange={event => setFilter(event.target.value)} />}{!layers.length && <p>No layers</p>}<div className="map-layers-list">{[...layers].reverse().filter(layer => layer.name.toLowerCase().includes(filter.toLowerCase())).map(layer => <div key={layer.id} className={`map-layer-item ${selectedId === layer.id ? 'selected' : ''}`}><div className="map-layer-row"><IconButton icon={layer.visible === false ? EyeOff : Eye} label={`${layer.visible === false ? 'Show' : 'Hide'} ${layer.name}`} onClick={() => onChange(layer.id, { visible: layer.visible === false })} /><button className="map-layer-name" onClick={() => onSelect(layer.id)} title={layer.name}><i style={{ background: layer.color }} /><span>{layer.name}</span></button><IconButton icon={Crosshair} label={`Zoom to ${layer.name}`} onClick={() => onZoom(layer)} /></div>{selectedId === layer.id && <div className="map-layer-info"><span>{layer.kind === 'vector' ? `${layer.count.toLocaleString()} features` : `${layer.count} bands`}</span><span>{layer.crs}</span><label>Opacity<input aria-label={`Opacity for ${layer.name}`} type="range" min="0" max="1" step="0.05" value={layer.opacity ?? 1} onChange={event => onChange(layer.id, { opacity: Number(event.target.value) })} /><output>{Math.round((layer.opacity ?? 1) * 100)}%</output></label></div>}</div>)}</div></section></details>
}

export default function App() {
  const globe = useRef<GlobeHandle>(null)
  const [requestedLayer] = useState(() => new URLSearchParams(window.location.search).get('layer'))
  const requestedLayerOpened = useRef(false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const expressionInput = useRef<HTMLTextAreaElement>(null)
  const [panel, setPanel] = useState<Panel>(window.innerWidth < 760 ? null : 'layers')
  const [modal, setModal] = useState<Modal>(null)
  const [basemap, setBasemap] = useState<Basemap>(() => new URLSearchParams(window.location.search).get('basemap') === 'google-satellite' ? 'google-satellite' : 'osm')
  const removedIds = useRef<Set<string>>(new Set())
  const [removedLayer, setRemovedLayer] = useState<Layer | null>(null)
  const [featureUndo, setFeatureUndo] = useState<Layer | null>(null)
  const [layers, setLayers] = useState<Layer[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connected, setConnected] = useState(false)
  const [globeReady, setGlobeReady] = useState(false)
  const [position, setPosition] = useState('')
  const [flat, setFlat] = useState(false)
  const [drawing, setDrawing] = useState<Drawing>(null)
  const [continuous, setContinuous] = useState(true)
  const [draft, setDraft] = useState({ vertices: 0, complete: false })
  const [savingPolygons, setSavingPolygons] = useState(0)
  const annotationQueue = useRef<Promise<unknown>>(Promise.resolve())
  const annotationTarget = useRef<{ id?: string; name: string; count: number } | null>(null)
  const [measurement, setMeasurement] = useState(0)
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [codeOpen, setCodeOpen] = useState(false)
  const [code, setCode] = useState('')
  const [pythonRunning, setPythonRunning] = useState(false)
  const [view, setView] = useState<{ bbox: number[]; zoom?: number }>({ bbox: [-180, -80, 180, 80] })
  const [workspaceErrors, setWorkspaceErrors] = useState<Record<string, string>>({})
  const [notebookObjects, setNotebookObjects] = useState<NotebookObject[]>([])
  const [workspaceDisplays, setWorkspaceDisplays] = useState<Record<string, Record<string, string | string[]>>>({})
  const runtimeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const kernelConnected = useRef(false)
  const executingPython = useRef(false)
  const [pythonPath, setPythonPath] = useState('')
  const [environments, setEnvironments] = useState<string[]>([])
  const [kernelReady, setKernelReady] = useState(false)
  const [pythonVersion, setPythonVersion] = useState('')
  const [googleAvailable, setGoogleAvailable] = useState(false)
  const [tool, setTool] = useState<Tool | null>(null)
  const [toolKind, setToolKind] = useState('all')
  const [toolSearch, setToolSearch] = useState('')
  const [recentTools, setRecentTools] = useState<string[]>([])
  const toolParameters = useRef<Record<string, Record<string, string>>>({})
  const [other, setOther] = useState('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [collections, setCollections] = useState(defaultCollections)
  const [collection, setCollection] = useState('sentinel-2-l2a')
  const [bbox, setBbox] = useState('85.2,27.6,85.5,27.85')
  const [start, setStart] = useState('2024-10-01')
  const [end, setEnd] = useState('2024-11-01')
  const [cloud, setCloud] = useState(30)
  const [results, setResults] = useState<StacItem[]>([])
  const [searched, setSearched] = useState(false)
  const [polygonLayerId, setPolygonLayerId] = useState('auto')
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const basemapMaximum = { earth: 8, satellite: 14, osm: 19, google: 19, 'google-satellite': 20 }[basemap]
  const basemapClipZoom = Number(params.zoom ?? Math.min(basemapMaximum, Math.max(0, Math.floor(view.zoom ?? 0) + 1)))
  const currentBasemap: Layer = { id: 'current-basemap', name: `Current basemap / ${basemaps.find(entry => entry.id === basemap)?.name}`, kind: 'raster', crs: 'EPSG:3857', count: 3, bbox: view.bbox }
  const basemapInput = tool?.id === 'clip' && selectedId === currentBasemap.id
  const selected = basemapInput && panel === 'tools' ? currentBasemap : layers.find(layer => layer.id === selectedId)
  const eligibleTools = tools.filter(entry => (toolKind === 'all' || entry.kinds.includes(toolKind)) && `${entry.name} ${toolAliases[entry.id]}`.toLowerCase().includes(toolSearch.trim().toLowerCase()))
  const operationInputs = tool ? [...layers.filter(layer => supportsLayer(tool, layer)), ...(tool.id === 'clip' ? [currentBasemap] : [])] : []
  const operationAsset = rasterAsset(selected, params.asset)
  const assetMetadata = selected?.assets?.[operationAsset]
  const operationBandCount = selected?.kind === 'stac' ? assetMetadata?.['raster:bands']?.length || assetMetadata?.['eo:bands']?.length || 1 : selected?.count ?? 0
  const operationBoundaries = boundaryLayers(tool, layers, selectedId)
  const operationIssue = !tool ? '' : !selected || !supportsLayer(tool, selected) ? 'Choose a compatible input layer.'
    : basemapInput && basemap === 'google' ? 'Google Satellite (API) is display-only. Choose another basemap.'
    : basemapInput && (!Number.isInteger(basemapClipZoom) || basemapClipZoom < 0 || basemapClipZoom > basemapMaximum) ? `Choose a Tile zoom between 0 and ${basemapMaximum}.`
    : selected.kind === 'stac' && !operationAsset ? 'No raster assets are available.'
    : tool.second && !operationBoundaries.some(layer => layer.id === other) ? (['clip', 'zonal'].includes(tool.id) ? 'Choose polygons or a raster extent.' : 'Choose a second layer.')
    : tool.id === 'buffer' && !(Number(params.distance) > 0 && Number.isFinite(Number(params.distance))) ? 'Enter a positive distance.'
    : tool.id === 'resample' && !(Number(params.resolution) > 0 && Number.isFinite(Number(params.resolution))) ? 'Enter a positive pixel size.'
    : tool.id === 'reproject' && !params.crs?.trim() ? 'Enter a target CRS.'
    : tool.id === 'filter' && !selected.fields?.includes(params.field) ? 'Choose an attribute.'
    : tool.id === 'calculator' && !params.expression?.trim() ? 'Enter an expression.'
    : tool.id === 'polygonize' && !(Number.isInteger(Number(params.band ?? 1)) && Number(params.band ?? 1) >= 1 && Number(params.band ?? 1) <= operationBandCount) ? 'Choose a valid band.' : ''
  const drawingLayers = layers.filter(layer => layer.editable)
  const polygonLayer = polygonLayerId === 'auto' ? (selected?.editable ? selected : drawingLayers.at(-1)) : drawingLayers.find(layer => layer.id === polygonLayerId)
  const currentWorkspace = useRef({ layers: [] as string[], view })

  useEffect(() => {
    if (!drawing) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], dialog'))) return
      if (drawing === 'polygon' && draft.vertices && !draft.complete) return
      event.preventDefault()
      if (drawing === 'polygon' && draft.complete) globe.current?.finish()
      setDrawing(null)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [drawing, draft])

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy('') }
  }
  async function refresh() {
    const items = await api<Layer[]>('/layers')
    setLayers(previous => {
      const known = new globalThis.Map(previous.map(layer => [layer.id, layer]))
      return items.filter(layer => !removedIds.current.has(layer.id) || (!requestedLayerOpened.current && layer.focus_on_load)).map((layer, index) => ({ color: palette[index % palette.length], visible: true, ...known.get(layer.id), ...layer }))
    })
  }
  function removeLayer(layer: Layer) {
    removedIds.current.add(layer.id)
    localStorage.setItem('open-earth-removed', JSON.stringify([...removedIds.current]))
    setLayers(previous => previous.filter(entry => entry.id !== layer.id))
    if (selectedId === layer.id) setSelectedId('')
    setRemovedLayer(layer)
  }
  function undoRemoval() {
    if (!removedLayer) return
    removedIds.current.delete(removedLayer.id)
    localStorage.setItem('open-earth-removed', JSON.stringify([...removedIds.current]))
    setLayers(previous => previous.some(layer => layer.id === removedLayer.id) ? previous : [...previous, removedLayer])
    setRemovedLayer(null)
  }
  function addLayer(layer: Layer, focus = true) {
    setLayers(previous => previous.some(entry => entry.id === layer.id) ? previous.map(entry => entry.id === layer.id ? { ...entry, ...layer } : entry) : [...previous, { ...layer, visible: true, color: palette[previous.length % palette.length] }])
    setSelectedId(previous => focus ? layer.id : previous || layer.id)
    if (focus) { setPanel('layers'); setModal(null); globe.current?.fly(layer.bbox) }
  }
  function changeLayer(update: Partial<Layer>) {
    setLayers(previous => previous.map(layer => layer.id === selectedId ? { ...layer, ...update } : layer))
  }
  function savePolygon(coordinates: number[][]) {
    if (!annotationTarget.current) annotationTarget.current = { id: polygonLayer?.id, name: polygonLayer?.name ?? `Annotations ${drawingLayers.length + 1}`, count: polygonLayer?.count ?? 0 }
    const target = annotationTarget.current
    setSavingPolygons(count => count + 1)
    const saved = annotationQueue.current.catch(() => undefined).then(async () => {
      const layer = await api<Layer>('/annotations', { identifier: target.id, editable: true, name: target.name, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { annotation_id: crypto.randomUUID(), name: `Polygon ${target.count + 1}`, source: 'user drawn' }, geometry: { type: 'Polygon', coordinates: [coordinates] } }] } })
      target.id = layer.id; target.count = layer.count
      if (annotationTarget.current === target) setPolygonLayerId(layer.id)
      if (!removedIds.current.has(layer.id)) addLayer(layer, false)
    }).finally(() => setSavingPolygons(count => count - 1))
    annotationQueue.current = saved
    return saved
  }
  function deleteFeature(layer: Layer, featureId: string | number) {
    const deleted = annotationQueue.current.catch(() => undefined).then(async () => {
      const updated = await api<Layer>(`/layers/${layer.id}/features/delete`, { feature_ids: [String(featureId)] })
      if (annotationTarget.current?.id === updated.id) annotationTarget.current = null
      if (!removedIds.current.has(updated.id)) addLayer(updated, false)
      setFeatureUndo(updated)
      setNotice('Feature deleted')
    })
    annotationQueue.current = deleted
    return deleted
  }
  function undoFeatureDeletion() {
    if (!featureUndo) return
    const target = featureUndo
    return perform('Restoring feature', async () => {
      const restored = annotationQueue.current.catch(() => undefined).then(async () => {
        const updated = await api<Layer>(`/layers/${target.id}/features/restore`, { revision: target.revision })
        if (annotationTarget.current?.id === updated.id) annotationTarget.current = null
        if (!removedIds.current.has(updated.id)) addLayer(updated, false)
        setFeatureUndo(null)
        setNotice('Feature restored')
      })
      annotationQueue.current = restored
      await restored
    })
  }
  useEffect(() => {
    if (!savingPolygons && !draft.vertices) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [savingPolygons, draft.vertices])
  useEffect(() => {
    let disposed = false
    try { removedIds.current = new Set(JSON.parse(localStorage.getItem('open-earth-removed') ?? '[]')) } catch { removedIds.current.clear() }
    if (requestedLayer) removedIds.current.delete(requestedLayer)
    void api<{ python: string; executable: string; google: boolean }>('/session').then(async result => {
      if (disposed) return
      setConnected(true); setPythonPath(result.executable); setPythonVersion(result.python); setGoogleAvailable(result.google)
      await refresh()
      const runtime = await api<{ running: boolean }>('/runtime')
      kernelConnected.current = runtime.running
      setKernelReady(runtime.running)
    }).catch(failure => setError(`Local Python service unavailable: ${String(failure)}`))
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    if (!globeReady || requestedLayerOpened.current) return
    const target = requestedLayer ? layers.find(layer => layer.id === requestedLayer) : layers.find(layer => layer.focus_on_load)
    if (!target) return
    requestedLayerOpened.current = true
    removedIds.current.delete(target.id)
    localStorage.setItem('open-earth-removed', JSON.stringify([...removedIds.current]))
    setLayers(previous => [target, ...previous.filter(layer => layer.id !== target.id)].map(layer => ({ ...layer, visible: layer.id === target.id })))
    setSelectedId(target.id)
    if (!requestedLayer) setBasemap('google-satellite')
    globe.current?.fly(target.bbox)
    setNotice(target.name)
  }, [globeReady, layers, requestedLayer])
  const workspaceLayerKey = layers.map(layer => `${layer.id}:${layer.revision ?? ''}`).join(',')
  useEffect(() => { currentWorkspace.current = { layers: layers.map(layer => layer.id), view } }, [layers, view])
  useEffect(() => {
    const mobile = matchMedia('(max-width: 760px)')
    const closeDrawer = () => { if (mobile.matches && codeOpen) setPanel(null) }
    closeDrawer()
    mobile.addEventListener('change', closeDrawer)
    return () => mobile.removeEventListener('change', closeDrawer)
  }, [codeOpen])
  useEffect(() => {
    if (!kernelReady || pythonRunning) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const synchronize = () => {
      runtimeQueue.current = runtimeQueue.current.catch(() => {}).then(async () => {
        if (disposed || executingPython.current) return
        const context = currentWorkspace.current
        const result = await api<{ running?: boolean; errors?: Record<string, string>; changed?: string[]; displays?: typeof workspaceDisplays; objects?: NotebookObject[] }>('/runtime/sync', { ...context, view: { ...context.view, bbox: globe.current?.bounds() ?? context.view.bbox } })
        if (disposed) return
        if (result.running === false) { kernelConnected.current = false; setKernelReady(false); return }
        setWorkspaceErrors(result.errors ?? {})
        setWorkspaceDisplays(result.displays ?? {})
        setNotebookObjects(result.objects ?? [])
        if (Object.keys(result.errors ?? {}).length) timer = setTimeout(synchronize, 5000)
        if (result.changed?.length) await refresh()
      }).catch(failure => {
        if (disposed) return
        if (!String(failure).includes('cell is running')) setWorkspaceErrors({ workspace: String(failure) })
        timer = setTimeout(synchronize, 750)
      })
    }
    timer = setTimeout(synchronize, 200)
    return () => { disposed = true; clearTimeout(timer) }
  }, [workspaceLayerKey, view, kernelReady, pythonRunning])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(timer)
  }, [notice])
  async function importFiles(files: FileList | null) {
    if (!files?.length) return
    await perform('Importing data', async () => {
      const entries = Array.from(files)
      const sidecar = /\.(shx|dbf|prj|cpg|sbn|sbx|qix)$/i
      const stem = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase()
      for (const file of entries.filter(entry => sidecar.test(entry.name))) {
        if (!entries.some(entry => /\.shp$/i.test(entry.name) && stem(entry.name) === stem(file.name))) throw new Error('Select matching .shp, .shx, .dbf and .prj files together, or upload a ZIP.')
      }
      for (const file of entries.filter(entry => !sidecar.test(entry.name))) {
        const form = new FormData()
        form.append('file', file)
        if (/\.shp$/i.test(file.name)) for (const part of entries.filter(entry => sidecar.test(entry.name) && stem(entry.name) === stem(file.name))) form.append('companions', part)
        addLayer(await api<Layer>('/upload', form))
      }
    })
  }
  function operationCode() {
    const parameters: Record<string, string | number> = { ...params, ...(selected?.kind === 'stac' ? { asset: operationAsset } : {}), ...(basemapInput ? { zoom: basemapClipZoom } : {}) }
    if (parameters.distance) parameters.distance = Number(parameters.distance)
    if (parameters.resolution) parameters.resolution = Number(parameters.resolution)
    return `from server.sdk import earth\n\nresult = earth.run(\n    ${JSON.stringify(basemapInput ? `basemap:${basemap}` : selectedId)},\n    ${JSON.stringify(tool?.id)},\n    params=${JSON.stringify(parameters)},\n    other=${tool?.second && other ? JSON.stringify(other) : 'None'},\n)\nresult`
  }
  function chooseTool(entry: Tool) {
    if (tool) toolParameters.current[tool.id] = params
    const inputs = [...layers.filter(layer => supportsLayer(entry, layer)), ...(entry.id === 'clip' ? [currentBasemap] : [])]
    const input = inputs.find(layer => layer.id === selectedId) ?? inputs.find(layer => layer.visible !== false) ?? inputs[0]
    const boundaries = boundaryLayers(entry, layers, input?.id ?? '')
    setTool(entry)
    if (input) setSelectedId(input.id)
    setOther(entry.second ? defaultBoundary(boundaries) : '')
    const defaults = entry.id === 'buffer' ? { distance: '100' } : entry.id === 'calculator' ? { expression: 'b1' } : entry.id === 'reproject' ? { crs: 'EPSG:4326', method: 'nearest' } : entry.id === 'resample' ? { method: 'nearest' } : {}
    const remembered = { ...(toolParameters.current[entry.id] ?? defaults) }
    if (input?.kind === 'stac') remembered.asset = rasterAsset(input, remembered.asset)
    if (['filter', 'dissolve'].includes(entry.id) && !input?.fields?.includes(remembered.field)) remembered.field = entry.id === 'filter' ? input?.fields?.[0] ?? '' : ''
    setParams(remembered)
    setRecentTools(previous => [entry.id, ...previous.filter(id => id !== entry.id)].slice(0, 3))
    setDrawing(null); setPanel('tools')
  }
  async function runTool() {
    if (!tool || !selected || busy || operationIssue) return
    await perform(`Running ${tool.name.toLowerCase()}`, async () => {
      const result = await api<Layer>('/operations', { layer: basemapInput ? `basemap:${basemap}` : selectedId, operation: tool.id, params: { ...params, ...(selected.kind === 'stac' ? { asset: operationAsset } : {}), ...(basemapInput ? { zoom: basemapClipZoom } : {}) }, other: tool.second ? other || null : null })
      addLayer(result); setNotice('Result added to workspace')
    })
  }
  async function openRuntime() {
    setModal('runtime')
    await perform('Finding Python environments', async () => { const runtime = await api<{ environments: string[]; running: boolean }>('/runtime'); setEnvironments(runtime.environments); setKernelReady(runtime.running) })
  }
  async function runNotebookCell(source: string) {
    if (executingPython.current) throw new Error('Wait for the current Python operation to finish.')
    executingPython.current = true
    setPythonRunning(true)
    try {
      await runtimeQueue.current.catch(() => {})
      if (!kernelConnected.current) { await api('/runtime/start', { executable: pythonPath }); kernelConnected.current = true; setKernelReady(true) }
      const context = currentWorkspace.current
      const result = await api<CellResult>('/runtime/execute', { code: source, context: { ...context, view: { ...context.view, bbox: globe.current?.bounds() ?? context.view.bbox } } })
      if (result.objects) setNotebookObjects(result.objects)
      await refresh()
      return result
    } finally { executingPython.current = false; setPythonRunning(false) }
  }
  async function visualizeNotebook(object: NotebookObject) {
    if (executingPython.current) { setError('Wait for the current cell to finish.'); return }
    executingPython.current = true
    setPythonRunning(true)
    try {
      await runtimeQueue.current.catch(() => {})
      await perform('Creating map copy', async () => {
        const result = await api<{ layers: Layer[] }>('/notebook/visualize', { key: object.key, kind: object.kind })
        if (!result.layers.length) throw new Error('This dataset has no displayable data in the current view.')
        for (const layer of result.layers) addLayer(layer)
        setNotice('Independent copy added to map')
      })
    } finally { executingPython.current = false; setPythonRunning(false) }
  }
  async function restartNotebook() {
    await runtimeQueue.current.catch(() => {})
    await api('/runtime/start', { executable: pythonPath })
    kernelConnected.current = true
    setKernelReady(true)
    const result = await api<{ errors?: Record<string, string> }>('/runtime/sync', { layers: layers.map(layer => layer.id), view })
    setWorkspaceErrors(result.errors ?? {})
  }
  async function locate() {
    if (!query.trim()) return
    const coordinates = query.split(',').map(Number)
    if (coordinates.length === 2 && coordinates.every(Number.isFinite)) {
      if (Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) { setError('Coordinates must be longitude, latitude.'); return }
      globe.current?.locate(coordinates[0], coordinates[1]); return
    }
    await perform('Finding place', async () => {
      const places = await api<{ lon: string; lat: string; display_name: string }[]>(`/geocode?q=${encodeURIComponent(query)}`)
      if (!places.length) throw new Error('No matching place found.')
      globe.current?.locate(Number(places[0].lon), Number(places[0].lat)); setNotice(places[0].display_name)
    })
  }
  const showTable = () => perform('Loading attributes', async () => {
    if (!selected) return
    const data = await api<{ features: { properties: Record<string, unknown> }[] }>(`/layers/${selected.id}/geojson`)
    setRows(data.features.slice(0, 500).map(feature => feature.properties)); setModal('table')
  })
  const updateParam = (key: string, value: string) => {
    const next = { ...params, [key]: value }
    if (tool) toolParameters.current[tool.id] = next
    setParams(next)
  }
  function changeOperationInput(identifier: string) {
    setSelectedId(identifier)
    const input = layers.find(layer => layer.id === identifier)
    if (input?.kind === 'stac') updateParam('asset', rasterAsset(input, params.asset))
    const boundaries = boundaryLayers(tool, layers, identifier)
    if (!boundaries.some(layer => layer.id === other)) setOther(defaultBoundary(boundaries))
    if (tool && ['filter', 'dissolve'].includes(tool.id) && !input?.fields?.includes(params.field)) updateParam('field', tool.id === 'filter' ? input?.fields?.[0] ?? '' : '')
  }
  function insertBand(band: string) {
    const input = expressionInput.current
    if (!input) return
    const expression = params.expression ?? ''
    const start = input.selectionStart
    const end = input.selectionEnd
    updateParam('expression', expression.slice(0, start) + band + expression.slice(end))
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + band.length, start + band.length) })
  }
  const saveProject = () => { localStorage.setItem('open-earth-workspace', JSON.stringify({ version: 1, basemap, layers, code, bounds: globe.current?.bounds() })); setNotice('Workspace view saved on this browser') }
  const restoreProject = () => {
    const saved = localStorage.getItem('open-earth-workspace'); if (!saved) { setNotice('No saved workspace view'); return }
    try { const project = JSON.parse(saved); setBasemap(project.basemap); setCode(project.code); setLayers(project.layers); for (const layer of project.layers) removedIds.current.delete(layer.id); localStorage.setItem('open-earth-removed', JSON.stringify([...removedIds.current])); if (project.bounds) globe.current?.fly(project.bounds); setNotice('Workspace view restored') } catch { setError('Saved workspace could not be restored.') }
  }

  return <Tooltip.Provider delayDuration={180}><div className={`app-shell studio panel-${panel ?? 'none'} ${codeOpen ? 'with-code' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void importFiles(event.dataTransfer.files) }}>
    <header className="topbar"><a className="brand" href="/" aria-label="Open Earth home"><Earth size={27} strokeWidth={1.5} /><span>open<span className="brand-light">earth</span><span className="brand-dot">.</span></span></a><span className="header-divider" /><span className="project-title">Untitled workspace <span className="local-tag">LOCAL</span></span>
      <div className="header-actions"><IconButton icon={FolderOpen} label="Restore workspace view" onClick={restoreProject} /><IconButton icon={Save} label="Save workspace view" onClick={saveProject} /><button className="runtime-button" aria-label="Local Python runtime" onClick={() => void openRuntime()}><span className={`status-dot ${connected ? 'online' : ''}`} /><span>Local Python</span><ChevronDown size={13} /></button><button className="primary add-top" onClick={() => setModal('import')} disabled={!!busy || !connected}><Plus size={16} />Add data</button></div>
    </header><div className="workspace"><nav className="rail" aria-label="Workspace navigation">
      {([{ id: 'layers', label: 'Visualize', icon: Globe2 }, { id: 'catalog', label: 'Data', icon: Database }, { id: 'tools', label: 'Geoprocessing', icon: SlidersHorizontal }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={`rail-button ${panel === id ? 'selected' : ''}`} aria-label={label} aria-pressed={panel === id} onClick={() => setPanel(panel === id ? null : id)}><Icon size={18} strokeWidth={1.7} /><span>{label}</span></button>)}
      <button className={`rail-button ${codeOpen ? 'selected' : ''}`} aria-label="Python editor" aria-pressed={codeOpen} onClick={() => setCodeOpen(!codeOpen)}><FileCode2 size={18} strokeWidth={1.7} /><span>Python / AI</span></button>
    </nav>
    {panel && <aside className="sidebar"><div className="panel-heading"><div><span className="eyebrow">{panel === 'catalog' ? 'DATA EXPLORER' : panel === 'tools' ? 'GEOPROCESSING' : 'YOUR WORKSPACE'}</span><h1>{panel === 'layers' ? 'Layers' : panel === 'catalog' ? 'Catalog' : 'Analysis'}</h1></div><IconButton icon={X} label="Collapse panel" onClick={() => setPanel(null)} /></div><div className="panel-scroll">
      {panel === 'layers' && <><div className="section-heading"><span>Project layers</span><span className="count">{layers.length}</span><IconButton icon={Plus} label="Import a layer" onClick={() => setModal('import')} disabled={!!busy} /></div>
        {!layers.length && <div className="empty-layers"><Layers size={30} strokeWidth={1} /><h3>No layers yet</h3><button className="secondary" onClick={() => setModal('import')}><Plus size={15} />Add data</button><button className="text-button" disabled={!!busy} onClick={() => void perform('Adding study area', async () => { const sample = await fetch('/samples/kathmandu.geojson').then(response => response.json()); addLayer(await api<Layer>('/annotations', { name: 'Kathmandu study area', geojson: sample })) })}>Kathmandu study area <ArrowUpRight size={13} /></button></div>}
        {removedLayer && <div className="removal-notice"><span>Layer removed</span><button className="text-button" onClick={undoRemoval}><Undo2 size={14} />Undo</button></div>}
        <div className="layer-list">{layers.map(layer => <div key={layer.id} className={`layer-row ${selectedId === layer.id ? 'selected' : ''}`}><button className="layer-select" onClick={() => setSelectedId(layer.id)}><span className="layer-symbol" style={{ color: layer.color }}>{layer.kind === 'vector' ? <Pentagon size={18} /> : <Image size={18} />}</span><span><strong>{layer.name}</strong><small>{layer.kind === 'stac' ? 'MPC preview' : layer.kind === 'raster' ? `${layer.count} bands · ${layer.crs}` : `${layer.count} features · ${layer.crs}`}</small></span></button><IconButton icon={layer.visible === false ? EyeOff : Eye} label={`${layer.visible === false ? 'Show' : 'Hide'} ${layer.name}`} onClick={() => setLayers(previous => previous.map(entry => entry.id === layer.id ? { ...entry, visible: entry.visible === false } : entry))} /><IconButton icon={X} label={`Remove ${layer.name}`} onClick={() => removeLayer(layer)} /></div>)}</div>
        {selected && <section className="layer-detail"><div className="section-heading"><span>Layer properties</span><div className="spacer" /><IconButton icon={Crosshair} label="Zoom to layer" onClick={() => globe.current?.fly(selected.bbox)} /><IconButton icon={Trash2} label="Remove layer from view" onClick={() => removeLayer(selected)} /></div><h3 className="selected-name">{selected.name}</h3>
          <Field label="Name"><input value={selected.name} onChange={event => changeLayer({ name: event.target.value })} /></Field><Field label={`Opacity · ${Math.round((selected.opacity ?? 1) * 100)}%`}><input type="range" min="0" max="1" step="0.05" value={selected.opacity ?? 1} onChange={event => changeLayer({ opacity: Number(event.target.value) })} /></Field>
          {selected.kind === 'vector' && <><Field label="Color"><div className="swatches">{palette.map(color => <button key={color} className={selected.color === color ? 'chosen' : ''} style={{ background: color }} aria-label={`Layer color ${color}`} title={color} onClick={() => changeLayer({ color })} />)}</div></Field><button className="secondary full" onClick={() => void showTable()}><Table2 size={15} />Attribute table<ArrowUpRight size={14} /></button></>}
          {selected.kind !== 'vector' && <RasterDisplay key={selected.id} layer={selected} onChange={changeLayer} />}
          {selected.kind === 'stac' && <button className="secondary full" onClick={() => { setCode(`from server.sdk import earth\nimport rasterio\n\nassets = earth.assets(${JSON.stringify(selected.id)})\nprint(list(assets))\n\nwith rasterio.open(assets[${JSON.stringify(selected.band_names?.[0])}]) as source:\n    print(source.profile)\n`); setCodeOpen(true) }}><FileCode2 size={15} />Open dataset in Python</button>}
          {selected.kind !== 'stac' && <div className="button-row"><a className="secondary" href={`/api/layers/${selected.id}/download`}><Download size={15} />Export</a>{selected.kind === 'vector' && <a className="text-button" href={`/api/layers/${selected.id}/download?format=geojson`}>GeoJSON<ArrowUpRight size={14} /></a>}</div>}<button className="text-button" onClick={() => { setPanel('tools'); setToolKind(selected.kind === 'vector' ? 'vector' : 'raster'); setTool(null) }}>Analyze layer<ArrowRight size={15} /></button>
        </section>}
      </>}
      {panel === 'tools' && <>{tool ? <form className="operation-form" onSubmit={event => { event.preventDefault(); void runTool() }}><button type="button" className="text-button back" onClick={() => { toolParameters.current[tool.id] = params; setTool(null) }}><ArrowLeft size={14} />All operations</button><h2 className="tool-title"><tool.icon size={21} />{tool.name}</h2>
        <Field label={tool.id === 'rasterize' ? 'Reference raster grid' : 'Input layer'}><select value={selectedId} onChange={event => changeOperationInput(event.target.value)}><option value="">Select a layer</option>{operationInputs.map(layer => <option value={layer.id} key={layer.id} disabled={layer.id === currentBasemap.id && basemap === 'google'}>{layer.name}{layer.id === currentBasemap.id && basemap === 'google' ? ' (display only)' : ''}</option>)}</select></Field>
        {basemapInput && <Field label="Tile zoom"><input type="number" min="0" max={basemapMaximum} step="1" value={basemapClipZoom} onChange={event => updateParam('zoom', event.target.value)} /></Field>}
        {!operationInputs.length && <div className="operation-empty"><p>No compatible layers.</p><button type="button" className="secondary" onClick={() => setModal('import')}><Plus size={14} />Add data</button></div>}
        {selected?.kind === 'stac' && Object.keys(selected.assets ?? {}).length > 1 && <Field label="Raster asset"><select value={operationAsset} onChange={event => { setParams(previous => ({ ...previous, asset: event.target.value, band: '1', expression: 'b1' })) }}>{Object.entries(selected.assets ?? {}).map(([key, asset]) => <option key={key} value={key}>{asset.title ? `${key} · ${asset.title}` : key}</option>)}</select></Field>}
        {tool.second && <><Field label={tool.id === 'zonal' ? 'Zones' : tool.id === 'clip' ? 'Clip boundary' : tool.id === 'rasterize' ? 'Features to rasterize' : tool.id === 'difference' ? 'Erase layer' : 'Second vector layer'}><select value={other} onChange={event => setOther(event.target.value)}><option value="">{['clip', 'zonal'].includes(tool.id) ? 'Select polygons or raster extent' : 'Select a vector layer'}</option>{operationBoundaries.some(layer => layer.id === selectedId) && <option value={selectedId}>Entire input raster</option>}<optgroup label="Vector layers">{operationBoundaries.filter(layer => layer.kind === 'vector').map(layer => <option value={layer.id} key={layer.id}>{layer.name}</option>)}</optgroup>{operationBoundaries.some(layer => layer.kind !== 'vector' && layer.id !== selectedId) && <optgroup label="Raster extents">{operationBoundaries.filter(layer => layer.kind !== 'vector' && layer.id !== selectedId).map(layer => <option value={layer.id} key={layer.id}>{layer.name} extent</option>)}</optgroup>}</select></Field>{selected?.kind === 'vector' && <button type="button" className="text-button swap-inputs" disabled={!operationBoundaries.some(layer => layer.id === other && layer.kind === 'vector')} onClick={() => { setSelectedId(other); setOther(selectedId) }}><ArrowLeftRight size={14} />Swap inputs</button>}</>}
        {tool.id === 'buffer' && <Field label="Distance (meters)"><input type="number" step="any" min="0.000001" value={params.distance ?? '100'} onChange={event => updateParam('distance', event.target.value)} /></Field>}
        {tool.id === 'reproject' && <><Field label="Target CRS"><input list="operation-crs" value={params.crs ?? 'EPSG:4326'} onChange={event => updateParam('crs', event.target.value)} /></Field><datalist id="operation-crs"><option value="EPSG:4326">WGS 84</option><option value="EPSG:3857">Web Mercator</option>{selected && <option value={selected.crs}>Source CRS</option>}</datalist></>}
        {tool.id === 'resample' && <Field label="Pixel size (CRS units)"><input type="number" step="any" min="0.000001" value={params.resolution ?? ''} onChange={event => updateParam('resolution', event.target.value)} /></Field>}
        {['resample', 'reproject'].includes(tool.id) && selected && selected.kind !== 'vector' && <Field label="Resampling"><select value={params.method ?? 'nearest'} onChange={event => updateParam('method', event.target.value)}><option value="nearest">Nearest · categorical</option><option value="bilinear">Bilinear · continuous</option><option value="cubic">Cubic</option><option value="average">Average</option></select></Field>}
        {['filter', 'dissolve'].includes(tool.id) && <Field label={tool.id === 'dissolve' ? 'Group by' : 'Attribute'}><select value={params.field ?? ''} onChange={event => updateParam('field', event.target.value)}><option value="">{tool.id === 'dissolve' ? 'All features' : 'Select field'}</option>{selected?.fields?.map(field => <option key={field}>{field}</option>)}</select></Field>}
        {tool.id === 'filter' && <Field label="Equals"><input value={params.value ?? ''} onChange={event => updateParam('value', event.target.value)} /></Field>}
        {tool.id === 'calculator' && <><Field label="Expression"><textarea ref={expressionInput} rows={3} maxLength={500} className="expression" value={params.expression ?? 'b1'} onChange={event => updateParam('expression', event.target.value)} placeholder="(b2 - b1) / (b2 + b1)" /></Field><div className="calculator-bands">{Array.from({ length: selected && selected.kind !== 'vector' ? operationBandCount : 0 }, (_, index) => <button type="button" key={index} title={selected?.kind === 'stac' ? `${operationAsset} / Band ${index + 1}` : selected?.band_names?.[index] ?? `Band ${index + 1}`} aria-label={`Insert band ${index + 1}`} onClick={() => insertBand(`b${index + 1}`)}>b{index + 1}</button>)}</div></>}
        {tool.id === 'polygonize' && <Field label="Band"><input type="number" min="1" max={operationBandCount} value={params.band ?? '1'} onChange={event => updateParam('band', event.target.value)} /></Field>}
        <div className="operation-actions">{operationIssue && <p className="operation-validation" role="status">{operationIssue}</p>}<button type="submit" className="primary full" disabled={!!busy || !!operationIssue}>{busy ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}Run {tool.name.toLowerCase()}</button><details className="operation-code"><summary>Python</summary><button type="button" className="text-button" disabled={!!operationIssue} onClick={() => { setCode(operationCode()); setCodeOpen(true) }}><FileCode2 size={15} />Open Python</button></details></div>
      </form> : <><div className="input-icon tool-search"><Search size={15} /><input aria-label="Find an operation" placeholder="Find an operation" value={toolSearch} onChange={event => { setToolSearch(event.target.value); setToolKind('all') }} />{toolSearch && <IconButton icon={X} label="Clear operation search" onClick={() => setToolSearch('')} />}</div><div className="segmented operation-kinds">{['all', 'vector', 'raster'].map(kind => <button key={kind} aria-pressed={toolKind === kind} className={toolKind === kind ? 'active' : ''} onClick={() => setToolKind(kind)}>{kind === 'all' ? 'All' : kind === 'vector' ? 'Vector' : 'Raster'}</button>)}</div>{!toolSearch && recentTools.length > 0 && <div className="recent-tools"><span>Recent</span>{recentTools.map(id => { const entry = tools.find(candidate => candidate.id === id)!; return <IconButton key={id} icon={entry.icon} label={`Recent: ${entry.name}`} onClick={() => chooseTool(entry)} /> })}</div>}{toolGroups.map(group => { const entries = group.ids.flatMap(id => eligibleTools.filter(entry => entry.id === id)); return entries.length > 0 && <section className="operation-group" key={group.name}><h3>{group.name}</h3><div className="operation-list">{entries.map(entry => <button key={entry.id} aria-label={entry.name} onClick={() => chooseTool(entry)}><entry.icon size={18} strokeWidth={1.6} /><span>{entry.name}</span><small>{entry.kinds.length > 1 ? 'Both' : entry.kinds[0] === 'vector' ? 'Vector' : 'Raster'}</small><ArrowRight size={13} /></button>)}</div></section> })}{eligibleTools.length === 0 && <p className="operation-validation">No matching operations.</p>}</>}
      </>}
      {panel === 'catalog' && <><div className="data-sources"><button className="secondary" onClick={() => setModal('import')}><Upload size={16} />Local files</button><span><Database size={16} />STAC catalog</span></div><div className="provider-label"><span className="microsoft-mark"><i /><i /><i /><i /></span><div><strong>Planetary Computer</strong><small>Microsoft · STAC API</small></div><span className="status-dot online" /></div><Field label="Collection"><select value={collection} onChange={event => setCollection(event.target.value)}>{collections.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></Field><button className="text-button small" disabled={!!busy} onClick={() => void perform('Loading collections', async () => setCollections(await api('/stac/collections')))}>Browse all collections<ArrowUpRight size={12} /></button>
        <div className="date-fields"><Field label="From"><input type="date" value={start} onChange={event => setStart(event.target.value)} /></Field><Field label="To"><input type="date" value={end} onChange={event => setEnd(event.target.value)} /></Field></div><Field label="Bounds (west, south, east, north)"><input className="monospace" value={bbox} onChange={event => setBbox(event.target.value)} /></Field><div className="button-row"><button className="text-button small" onClick={() => setBbox((globe.current?.bounds() ?? []).map(value => value.toFixed(4)).join(','))}><Scan size={14} />Map extent</button><button className="text-button small" disabled={!selected} onClick={() => selected && setBbox(selected.bbox.map(value => value.toFixed(4)).join(','))}><Pentagon size={14} />Selected layer</button></div>
        {['sentinel-2-l2a', 'landsat-c2-l2'].includes(collection) && <Field label={`Cloud cover · below ${cloud}%`}><input type="range" min="1" max="100" value={cloud} onChange={event => setCloud(Number(event.target.value))} /></Field>}
        <button className="primary full" disabled={!!busy} onClick={() => void perform('Searching Planetary Computer', async () => { if (!start || !end || start > end) throw new Error('Choose a valid date range.'); const bounds = bbox.split(',').map(Number); if (bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new Error('Enter four geographic bounds.'); setResults(await api('/stac/search', { collection, bbox: bounds, start, end, cloud })); setSearched(true) })}><Search size={15} />Search imagery</button>
        {searched && <div className="section-heading spaced"><span>{results.length ? 'Scenes' : 'No matching scenes'}</span><span className="count">{results.length}</span></div>}
        {results.map(item => <CatalogResult key={item.id} item={item} busy={!!busy} onFootprint={() => void perform('Adding scene footprint', async () => addLayer(await api<Layer>('/annotations', { name: `${item.id} footprint`, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: item.geometry, properties: { id: item.id } }] } })))} onPreview={assets => void perform('Opening dataset', async () => { addLayer(await api<Layer>('/stac/load', { collection: item.collection, item: item.id, assets })) })} />)}
      </>}
    </div><button className="basemap-summary" onClick={() => setModal('basemap')}><span className={`basemap-mini ${basemap}`} /><span><small>BASEMAP</small><strong>{basemaps.find(entry => entry.id === basemap)?.name}</strong></span><Settings2 size={17} /></button></aside>}
    <main className="main-area"><div className="map-area"><Globe ref={globe} basemap={basemap} layers={layers} drawing={drawing} continuous={continuous} onDraft={(vertices, complete) => setDraft({ vertices, complete })} onError={setError} onPosition={setPosition} onViewChange={setView} onReady={() => setGlobeReady(true)} onMeasure={setMeasurement} onPolygon={savePolygon} onDeleteFeature={deleteFeature} />
      <div className="geo-toolbar" role="toolbar" aria-label="Geospatial tools"><div className="toolbar-tools"><span className="toolbar-label">Sketch</span><IconButton icon={Pentagon} label="Draw polygon" active={drawing === 'polygon'} onClick={() => { setDrawing(drawing === 'polygon' ? null : 'polygon'); if (window.innerWidth < 760) setPanel(null) }} /><IconButton icon={Ruler} label="Measure distance" active={drawing === 'measure'} onClick={() => { setDrawing(drawing === 'measure' ? null : 'measure'); if (window.innerWidth < 760) setPanel(null) }} /><span className="tool-divider" /><span className="toolbar-label">Process</span>{toolGroups[0].ids.map(id => { const entry = tools.find(candidate => candidate.id === id)!; return <IconButton key={entry.id} icon={entry.icon} label={entry.name} active={panel === 'tools' && tool?.id === entry.id} onClick={() => chooseTool(entry)} /> })}<span className="tool-divider" /><IconButton icon={Table2} label="Attribute table" disabled={selected?.kind !== 'vector' || !!busy} onClick={() => void showTable()} /></div><button className={`toolbar-all ${panel === 'tools' && !tool ? 'active' : ''}`} aria-label="All geospatial operations" onClick={() => { setPanel('tools'); setTool(null); setToolKind('all'); setToolSearch('') }}><SlidersHorizontal size={16} /><span>All tools</span></button></div>
      <form className="place-search" onSubmit={event => { event.preventDefault(); void locate() }}><Search size={18} /><input aria-label="Search places or coordinates" placeholder="Search places or coordinates" value={query} onChange={event => setQuery(event.target.value)} /><button aria-label="Find place" type="submit" disabled={!!busy}><ArrowRight size={17} /></button></form><div className="map-view-label"><span className="tiny-line" /><span>{flat ? 'MAP VIEW' : 'EARTH VIEW'}</span><span className="view-datum">WGS 84</span></div><div className="map-top-actions"><MapLayers layers={layers} selectedId={selectedId} onSelect={setSelectedId} onChange={(id, update) => setLayers(previous => previous.map(layer => layer.id === id ? { ...layer, ...update } : layer))} onZoom={layer => globe.current?.fly(layer.bbox)} /><IconButton icon={Map} label="Choose basemap" onClick={() => setModal('basemap')} /></div>
      {!globeReady && <div className="globe-loading"><LoaderCircle className="spin" size={25} />Opening Earth</div>}
      <RasterLegend layer={selected && selected.kind !== 'vector' && selected.visible !== false ? selected : layers.filter(layer => layer.kind !== 'vector' && layer.visible !== false && (layer.opacity ?? 1) > 0).at(-1)} />
      <NotebookDropTarget onDrop={object => void visualizeNotebook(object)} />
      {drawing && <div className="drawing-bar"><div className="drawing-actions"><span className="status-dot online" />{drawing === 'polygon' ? <select aria-label="Polygon layer" value={polygonLayerId === 'auto' ? (polygonLayer?.id ?? 'new') : polygonLayerId} onChange={event => { setPolygonLayerId(event.target.value); annotationTarget.current = null }}><option value="new">New annotation layer</option>{drawingLayers.map(layer => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select> : <strong>{`${(measurement / 1000).toFixed(2)} km`}</strong>}<IconButton icon={Undo2} label="Undo vertex" onClick={() => globe.current?.undo?.()} /><IconButton icon={Redo2} label="Redo vertex" onClick={() => globe.current?.redo?.()} />{drawing === 'polygon' && draft.complete && <IconButton icon={Save} label="Finish polygon" onClick={() => globe.current?.finish()} />}<IconButton icon={Trash2} label="Discard current draft" disabled={!draft.vertices} onClick={() => globe.current?.discardDraft?.()} /><button type="button" className="text-button drawing-done" aria-label={drawing === 'polygon' ? 'Done drawing' : 'Finish measurement'} title={drawing === 'polygon' && draft.vertices > 0 && !draft.complete ? 'Close or discard the current polygon first' : 'Return to map navigation'} disabled={drawing === 'polygon' && draft.vertices > 0 && !draft.complete} onClick={() => { if (drawing === 'polygon' && draft.complete) globe.current?.finish(); setDrawing(null) }}><Check size={15} />Done</button></div>{drawing === 'polygon' && <div className="drawing-status"><label title="Save each closed polygon and continue drawing"><input type="checkbox" checked={continuous} onChange={event => setContinuous(event.target.checked)} />Continuous</label><span role="status">{savingPolygons ? `${savingPolygons} saving` : draft.vertices ? `${draft.vertices} vertices${draft.complete ? ' · Closed' : ''}` : `${polygonLayer?.count ?? 0} saved`}</span></div>}</div>}
      <div className="map-controls"><div className="control-group"><IconButton icon={Pentagon} label="Draw polygon" active={drawing === 'polygon'} onClick={() => setDrawing(drawing === 'polygon' ? null : 'polygon')} /><IconButton icon={Ruler} label="Measure distance" active={drawing === 'measure'} onClick={() => { setMeasurement(0); setDrawing(drawing === 'measure' ? null : 'measure') }} /></div><div className="control-group"><IconButton icon={Plus} label="Zoom in" onClick={() => globe.current?.zoom(1)} /><IconButton icon={Minus} label="Zoom out" onClick={() => globe.current?.zoom(-1)} /></div><div className="control-group"><IconButton icon={Compass} label="Reset north" onClick={() => globe.current?.north()} /><IconButton icon={Globe2} label="Full Earth" onClick={() => globe.current?.home()} /></div></div>
      <div className="view-switch segmented"><button className={!flat ? 'active' : ''} onClick={() => { setFlat(false); globe.current?.mode(false) }}><Globe2 size={14} />Globe</button><button className={flat ? 'active' : ''} onClick={() => { setFlat(true); globe.current?.mode(true) }}><Map size={14} />Map</button></div>
      {(error || notice || busy || featureUndo) && <div className={`notification ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{busy ? <LoaderCircle className="spin" size={17} /> : error ? <CircleHelp size={17} /> : <Check size={17} />}<span>{error || busy || notice || 'Feature deleted'}</span>{featureUndo && !busy && <button className="text-button" onClick={() => void undoFeatureDeletion()}><Undo2 size={14} />Undo deletion</button>}{!busy && <IconButton icon={X} label="Dismiss notification" onClick={() => { setError(''); setNotice(''); setFeatureUndo(null) }} />}</div>}
    </div>
    {codeOpen && <WorkspaceDivider />}
    {connected && <Notebook open={codeOpen} snippet={code} ready={kernelReady} objects={notebookObjects} exporting={pythonRunning} onVisualize={object => void visualizeNotebook(object)} workspaceErrors={workspaceErrors} workspaceDisplays={workspaceDisplays} onRun={runNotebookCell} onRestart={restartNotebook} onClose={() => setCodeOpen(false)} />}
    <footer className="statusbar"><span className={`status-dot ${connected ? 'online' : ''}`} /><span>{connected ? 'Local workspace' : 'Connecting'}</span><span className="status-separator">/</span><span>{layers.length} layers</span><div className="spacer" /><span className="coordinates">{position}</span><span className="status-separator">/</span><span>EPSG:4326</span></footer></main></div>
    <input ref={uploadInput} hidden type="file" multiple onChange={event => { void importFiles(event.target.files); event.target.value = '' }} />
    {modal === 'import' && <Dialog title="Add data" onClose={() => setModal(null)}><button className="dropzone" disabled={!!busy} onClick={() => uploadInput.current?.click()}><Upload size={28} strokeWidth={1.4} /><strong>Choose files</strong><span>GeoParquet · Shapefile · GeoJSON · GeoPackage · GeoTIFF</span><small>Up to 256 MB per dataset, including sidecars</small></button><div className="or-divider"><span>or a local dataset</span></div><form onSubmit={event => { event.preventDefault(); void perform('Importing local file', async () => addLayer(await api<Layer>('/import', { path }))) }}><Field label="Absolute dataset path"><input autoComplete="off" placeholder="/path/to/data.parquet" value={path} onChange={event => setPath(event.target.value)} /></Field><button className="primary full" disabled={!path || !!busy}><FolderOpen size={16} />Import dataset</button></form><button className="text-button" onClick={() => { setModal(null); setPanel('catalog') }}><Database size={15} />Browse Planetary Computer<ArrowUpRight size={14} /></button>{busy && <p className="inline-status"><LoaderCircle size={15} className="spin" />{busy}</p>}{error && <p className="inline-error" role="alert">{error}</p>}</Dialog>}
    {modal === 'basemap' && <Dialog title="Basemap" onClose={() => setModal(null)}><div className="basemap-grid">{basemaps.map(entry => <button key={entry.id} className={`basemap-option ${basemap === entry.id ? 'selected' : ''}`} onClick={() => { if (entry.id === 'google' && !googleAvailable) { setError('Google imagery needs GOOGLE_MAPS_API_KEY in the local service environment.'); return } setBasemap(entry.id); setModal(null) }}><div className={`basemap-image ${entry.id}`} style={{ backgroundImage: `url(${entry.image})` }}>{basemap === entry.id && <span><Check size={14} /></span>}</div><strong>{entry.name}</strong><small>{entry.id === 'google' && googleAvailable ? 'Google Maps Platform' : entry.source}</small></button>)}</div>{error && <p className="inline-error">{error}</p>}</Dialog>}
    {modal === 'runtime' && <Dialog title="Local Python" onClose={() => setModal(null)}><div className="runtime-summary"><span className="runtime-icon"><Cpu size={24} /></span><div><strong>This computer</strong><small>Python {pythonVersion} · local execution</small></div><span className="status-dot online" /></div><Field label="Python environment"><input list="python-environments" value={pythonPath} onChange={event => setPythonPath(event.target.value)} /><datalist id="python-environments">{environments.map(environment => <option key={environment} value={environment} />)}</datalist></Field><div className="button-row"><button className="primary" disabled={!!busy || pythonRunning} onClick={() => void perform('Starting Python kernel', async () => { await restartNotebook(); setCodeOpen(true); setModal(null) })}><Play size={15} />{kernelReady ? 'Restart & connect' : 'Connect'}</button><button className="secondary" disabled={!!busy} onClick={() => { if (window.confirm('Create an isolated geospatial Python environment and download its packages on this computer?')) void perform('Creating Python environment', async () => { const result = await api<{ executable: string }>('/runtime/create', {}); setPythonPath(result.executable); setEnvironments(previous => [...previous, result.executable]) }) }}><Plus size={15} />New environment</button></div><div className="security-note"><strong>Trusted local code only</strong><p>Python can access your files and run programs with your user permissions.</p></div>{busy && <p className="inline-status"><LoaderCircle size={15} className="spin" />{busy}</p>}{error && <p className="inline-error">{error}</p>}</Dialog>}
    {modal === 'table' && <Dialog wide title={`Attributes · ${selected?.name ?? 'Layer'}`} onClose={() => setModal(null)}><div className="table-summary">{rows.length} displayed · first 500 features</div><div className="table-wrap"><table><thead><tr><th>#</th>{Object.keys(rows[0] ?? {}).map(key => <th key={key}>{key}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td>{index + 1}</td>{Object.keys(rows[0] ?? {}).map(key => <td key={key}>{String(row[key] ?? '')}</td>)}</tr>)}</tbody></table></div></Dialog>}
    {modal === 'about' && <Dialog title="Open Earth · Preview 0.1" onClose={() => setModal(null)}><div className="about-wordmark"><Earth size={32} />openearth.</div><dl className="about-details"><dt>Execution</dt><dd>Your computer</dd><dt>Catalog</dt><dd>Microsoft Planetary Computer</dd><dt>Map / drawing</dt><dd>MapLibre GL · Terra Draw</dd><dt>Processing</dt><dd>GeoPandas · Rasterio · NumPy</dd><dt>Formats</dt><dd>GeoTIFF, GeoParquet, Feather/Arrow, Shapefile, GeoJSON, GeoPackage, FlatGeobuf, KML, GPX, GML and installed GDAL vector drivers</dd></dl><p className="security-note">Preview limits: 24 million cells per in-memory operation, 100,000 vector features. NetCDF/Zarr, terrain elevation, model-training interfaces, and remote runtimes are not included in this build.</p></Dialog>}
  </div></Tooltip.Provider>
}