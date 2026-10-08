import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawLineStringMode, TerraDrawSelectMode, TerraDrawModeUndoRedo, TerraDrawSessionUndoRedo, ValidateNotSelfIntersecting } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import length from '@turf/length'
import pointOnFeature from '@turf/point-on-feature'
import 'maplibre-gl/dist/maplibre-gl.css'
import { api } from './api'
import type { Layer } from './api'
import type { Basemap, Drawing, GlobeHandle } from './Globe'
import MapInspector from './MapInspector'
import type { Inspection, InspectCandidate } from './MapInspector'

maplibregl.setWorkerUrl(workerUrl)

const featureToken = '__open_earth_feature_token__'
const overviewGeometry = '__open_earth_overview_geometry__'
const renderSuffixes = ['fill', 'line', 'point', 'overview', 'raster'] as const

function polygonOverview(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: data.features.flatMap(feature => {
    if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) return []
    if (!feature.geometry.coordinates.flat(Infinity).length) return []
    const point = pointOnFeature(feature)
    return [{ ...point, id: feature.id, properties: { ...feature.properties, [overviewGeometry]: feature.geometry.type } }]
  }) }
}

function renderFeatures(data: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return { ...data, features: data.features.map((feature, index) => ({ ...feature, id: index, properties: { ...feature.properties, [featureToken]: feature.id } })) }
}

interface Props {
  ref: Ref<GlobeHandle>
  basemap: Basemap
  layers: Layer[]
  drawing: Drawing
  continuous: boolean
  onError: (message: string) => void
  onPosition: (position: string) => void
  onReady: () => void
  onPolygon: (coordinates: number[][]) => Promise<void>
  onDeleteFeature: (layer: Layer, featureId: string | number) => Promise<void>
  onDraft: (vertices: number, complete: boolean) => void
  onMeasure: (meters: number) => void
  onViewChange: (view: { bbox: number[]; zoom: number }) => void
}

export default function MapWorkspace({ ref, basemap, layers, drawing, continuous, onError, onPosition, onReady, onPolygon, onDeleteFeature, onDraft, onMeasure, onViewChange }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const editor = useRef<TerraDraw | null>(null)
  const registered = useRef(new Map<string, string>())
  const pending = useRef(new Set<string | number>())
  const failed = useRef(new Set<string | number>())
  const marker = useRef<maplibregl.Marker | null>(null)
  const inspectionSequence = useRef(0)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [ready, setReady] = useState(false)
  const [credit, setCredit] = useState('')
  const report = useEffectEvent(onError)
  const positionChanged = useEffectEvent(onPosition)
  const readyEvent = useEffectEvent(onReady)
  const measure = useEffectEvent(onMeasure)
  const viewChanged = useEffectEvent(onViewChange)
  const draftChanged = useEffectEvent(onDraft)
  function closeInspection() { setInspection(null); marker.current?.remove(); marker.current = null }
  const dismissInspection = useEffectEvent(closeInspection)
  const inspect = useEffectEvent((event: maplibregl.MapMouseEvent) => {
    const current = map.current
    if (!current || drawing || event.originalEvent.defaultPrevented) return
    const longitude = ((event.lngLat.lng + 180) % 360 + 360) % 360 - 180
    const latitude = event.lngLat.lat
    const candidates: InspectCandidate[] = []
    for (const layer of [...layers].reverse()) {
      if (layer.visible === false || (layer.opacity ?? 1) === 0) continue
      if (layer.kind === 'vector') {
        const identifiers = ['fill', 'line', 'point', 'overview'].map(suffix => `${layer.id}-${suffix}`).filter(identifier => current.getLayer(identifier))
        if (!identifiers.length) continue
        const seen = new Set<string>()
        for (const feature of current.queryRenderedFeatures([[event.point.x - 3, event.point.y - 3], [event.point.x + 3, event.point.y + 3]], { layers: identifiers })) {
          const { [featureToken]: token, [overviewGeometry]: originalGeometry, ...properties } = feature.properties ?? {}
          const featureId = typeof token === 'string' ? token : undefined
          const key = featureId ?? (feature.id == null ? JSON.stringify(properties) : String(feature.id))
          if (seen.has(key)) continue
          seen.add(key)
          candidates.push({ layerId: layer.id, label: `${layer.name} / ${properties.name ?? feature.id ?? 'Feature'}`, properties, geometryType: originalGeometry ?? feature.geometry.type, featureId })
        }
      } else {
        const [west, south, east, north] = layer.bbox
        if (latitude >= south && latitude <= north && (west <= east ? longitude >= west && longitude <= east : longitude >= west || longitude <= east)) candidates.push({ layerId: layer.id, label: layer.name })
      }
    }
    closeInspection()
    if (!candidates.length) return
    const element = document.createElement('div')
    element.className = 'inspect-pin'
    marker.current = new maplibregl.Marker({ element }).setLngLat(event.lngLat).addTo(current)
    setInspection({ sequence: ++inspectionSequence.current, longitude, latitude, candidates })
  })
  function submitPolygon(identifier: string | number) {
    const draw = editor.current
    const polygon = draw?.getSnapshot().find(feature => feature.id === identifier)
    if (!draw || !polygon || polygon.geometry.type !== 'Polygon' || pending.current.has(identifier)) return
    pending.current.add(identifier)
    failed.current.delete(identifier)
    draw.setMode(drawing === 'polygon' ? 'polygon' : 'static')
    onDraft(0, false)
    void onPolygon(polygon.geometry.coordinates[0]).then(() => {
      if (editor.current === draw && draw.getSnapshot().some(feature => feature.id === identifier)) draw.removeFeatures([identifier])
    }).catch(error => {
      pending.current.delete(identifier)
      failed.current.add(identifier)
      onDraft(Math.max(0, polygon.geometry.type === 'Polygon' ? polygon.geometry.coordinates[0].length - 1 : 0), true)
      onError(`Polygon not saved: ${String(error)}. The draft remains on the map.`)
    }).finally(() => { pending.current.delete(identifier) })
  }
  const finished = useEffectEvent((identifier: string | number) => {
    if (continuous) submitPolygon(identifier)
    else { editor.current?.setMode('select'); editor.current?.selectFeature(identifier) }
  })
  const homeZoom = () => Math.min(2, Math.log2(Math.max(180, Math.min(container.current?.clientWidth ?? 800, container.current?.clientHeight ?? 800)) * .72 / 147))

  useImperativeHandle(ref, () => ({
    home: () => map.current?.flyTo({ center: [65, 20], zoom: homeZoom(), duration: 500 }),
    zoom: direction => map.current?.zoomTo((map.current?.getZoom() ?? 2) + direction, { duration: 180 }),
    fly: bounds => map.current?.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 70, duration: 500, maxZoom: 17 }),
    locate: (longitude, latitude) => map.current?.flyTo({ center: [longitude, latitude], zoom: 11, duration: 500 }),
    bounds: () => { const bounds = map.current?.getBounds(); return bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] : [-180, -80, 180, 80] },
    mode: flat => map.current?.setProjection({ type: flat ? 'mercator' : 'globe' }),
    north: () => map.current?.easeTo({ bearing: 0, pitch: 0, duration: 200 }),
    undo: () => { editor.current?.undo() },
    redo: () => { editor.current?.redo() },
    discardDraft: () => {
      const draw = editor.current
      if (!draw) return
      draw.setMode('static')
      const identifiers = draw.getSnapshot().flatMap(feature => feature.id !== undefined && !pending.current.has(feature.id) ? [feature.id] : [])
      if (identifiers.length) draw.removeFeatures(identifiers)
      identifiers.forEach(identifier => failed.current.delete(identifier))
      draw.setMode(drawing === 'polygon' ? 'polygon' : 'linestring')
      onDraft(0, false)
    },
    finish: () => {
      const polygon = editor.current?.getSnapshot().find(feature => feature.geometry.type === 'Polygon' && !feature.properties.currentlyDrawing && feature.id !== undefined && !pending.current.has(feature.id))
      if (!polygon || polygon.geometry.type !== 'Polygon') { onError('Close the polygon by clicking its first vertex before saving.'); return }
      if (polygon.id !== undefined) submitPolygon(polygon.id)
    },
  }))

  useEffect(() => {
    if (!container.current) return
    const registry = registered.current
    const current = new maplibregl.Map({
      container: container.current, center: [65, 20], zoom: homeZoom(),
      canvasContextAttributes: { antialias: false, preserveDrawingBuffer: false },
      style: { version: 8, projection: { type: 'globe' }, sky: { 'sky-color': '#e9f1f3', 'horizon-color': '#d4e5e8', 'sky-horizon-blend': .3, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, .22, 5, 0] }, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9f1f3', 'background-opacity': 0 } }] },
      attributionControl: { compact: true }, maxTileCacheSize: 256, maxTileCacheZoomLevels: 8,
    })
    map.current = current
    current.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left')
    const resize = new ResizeObserver(() => current.resize())
    resize.observe(container.current)
    current.on('load', () => {
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: current, coordinatePrecision: 9 }),
        modes: [
          new TerraDrawPolygonMode({ pointerDistance: 12, showCoordinatePoints: true, snapping: { toCoordinate: true }, validation: (feature, context) => context.updateType === 'finish' ? ValidateNotSelfIntersecting(feature) : { valid: true }, styles: { fillColor: '#d5ef78', fillOpacity: .16, outlineColor: '#d5ef78', outlineWidth: 2, closingPointColor: '#d5ef78' } }),
          new TerraDrawLineStringMode({ pointerDistance: 12, showCoordinatePoints: true, styles: { lineStringColor: '#d5ef78', lineStringWidth: 2 } }),
          new TerraDrawSelectMode({ flags: { polygon: { feature: { draggable: true, coordinates: { draggable: true, deletable: true, midpoints: { draggable: true } } } } } }),
        ],
        undoRedo: { modeLevel: new TerraDrawModeUndoRedo(), sessionLevel: new TerraDrawSessionUndoRedo() },
      })
      draw.start()
      editor.current = draw
      draw.on('finish', (identifier, context) => {
        if (context.action === 'draw' && context.mode === 'polygon') queueMicrotask(() => finished(identifier))
      })
      draw.on('change', () => {
        const polygon = draw.getSnapshot().find(feature => feature.geometry.type === 'Polygon' && feature.id !== undefined && !pending.current.has(feature.id))
        current.getCanvas().dataset.draftGeometry = polygon ? JSON.stringify(polygon.geometry.coordinates) : ''
        current.getCanvas().dataset.draftComplete = String(!!polygon && !polygon.properties.currentlyDrawing)
        draftChanged(polygon?.geometry.type === 'Polygon' ? Math.max(0, polygon.geometry.coordinates[0].length - (polygon.properties.currentlyDrawing ? 2 : 1)) : 0, !!polygon && !polygon.properties.currentlyDrawing)
        const line = draw.getSnapshot().find(feature => feature.geometry.type === 'LineString' && feature.properties.mode === 'linestring')
        if (line?.geometry.type === 'LineString') measure(length(line, { units: 'meters' }))
      })
      setReady(true)
      readyEvent()
    })
    const updateView = () => { const center = current.getCenter(); current.getCanvas().dataset.camera = JSON.stringify([center.lng, center.lat, current.getZoom(), current.getBearing(), current.getPitch()]); positionChanged(`${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`); const bounds = current.getBounds(); viewChanged({ bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], zoom: current.getZoom() }) }
    current.on('moveend', updateView)
    current.on('load', updateView)
    current.on('resize', updateView)
    current.on('click', inspect)
    current.on('movestart', dismissInspection)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismissInspection() }
    document.addEventListener('keydown', escape)
    let reported = false
    current.on('error', event => { if (!reported) { reported = true; report(event.error.message) } })
    return () => { document.removeEventListener('keydown', escape); marker.current?.remove(); resize.disconnect(); editor.current?.stop(); editor.current = null; current.remove(); map.current = null; registry.clear() }
  }, [])

  useEffect(() => {
    const current = map.current
    if (!ready || !current) return
    let cancelled = false
    let removeMove: (() => void) | undefined
    const googleImagery = basemap === 'google-satellite' || basemap === 'google'
    current.cancelPendingTileRequestsWhileZooming = !googleImagery
    async function load() {
      let tiles = ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg']
      let attribution = '<a href="https://cloudless.eox.at/">EOX Sentinel-2 cloudless 2016 / CC BY 4.0</a>'
      let maximum = 14
      if (basemap === 'osm') { tiles = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png']; attribution = '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'; maximum = 19 }
      if (basemap === 'earth') { tiles = ['https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/{z}/{y}/{x}.jpg']; attribution = '<a href="https://maps.eox.at/">NASA Blue Marble / EOX</a>'; maximum = 8 }
      if (basemap === 'google-satellite') {
        tiles = [0, 1, 2, 3].map(server => `https://mt${server}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}`)
        attribution = '<a href="https://www.google.com/maps">Google Maps</a>'
        maximum = 20
      }
      if (basemap === 'google') {
        const session = await api<{ session: string; key: string }>('/google/session')
        tiles = [`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(session.key)}`]
        maximum = 19; attribution = 'Google Maps'
        const update = async () => {
          const bounds = current!.getBounds()
          const params = new URLSearchParams({ north: String(Math.min(85, bounds.getNorth())), south: String(Math.max(-85, bounds.getSouth())), east: String(Math.min(180, bounds.getEast())), west: String(Math.max(-180, bounds.getWest())), zoom: String(Math.max(0, Math.round(current!.getZoom()))) })
          try {
            const result = await api<{ copyright: string }>(`/google/viewport?${params}`)
            if (!result.copyright) throw new Error('Google Maps attribution is unavailable.')
            if (!cancelled) { setCredit(result.copyright); if (current!.getLayer('basemap')) current!.setLayoutProperty('basemap', 'visibility', 'visible') }
            return true
          } catch (error) {
            if (!cancelled) { report(String(error)); if (current!.getLayer('basemap')) current!.setLayoutProperty('basemap', 'visibility', 'none') }
            return false
          }
        }
        if (!await update() || cancelled) return
        current!.on('moveend', update); removeMove = () => { current!.off('moveend', update) }
      } else setCredit('')
      if (cancelled) return
      if (current!.getLayer('basemap')) current!.removeLayer('basemap')
      if (current!.getSource('basemap')) current!.removeSource('basemap')
      current!.addSource('basemap', { type: 'raster', tiles, tileSize: 256, maxzoom: maximum, attribution })
      const next = current!.getStyle().layers.find(layer => layer.id !== 'background')?.id
      current!.addLayer({ id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-fade-duration': googleImagery ? 250 : 100 } }, next)
    }
    void load().catch(error => { if (!cancelled) report(String(error)) })
    return () => { cancelled = true; removeMove?.() }
  }, [ready, basemap])

  useEffect(() => {
    const current = map.current
    if (!ready || !current) return
    let cancelled = false
    const remove = (id: string) => { for (const suffix of renderSuffixes) if (current.getLayer(`${id}-${suffix}`)) current.removeLayer(`${id}-${suffix}`); for (const source of [id, `${id}-overview-source`]) if (current.getSource(source)) current.removeSource(source); registered.current.delete(id) }
    for (const id of registered.current.keys()) if (!layers.some(layer => layer.id === id)) remove(id)
    async function sync() {
      for (const layer of layers) {
        if (cancelled) return
        try {
        const style = layer.symbology
        const displayBands = style && style.mode !== 'rgb' ? (layer.bands?.split(',')[0] ?? (layer.band_names?.[0] ?? '1')) : layer.bands
        const key = `${displayBands}:${layer.stretch}:${layer.rescale}:${JSON.stringify(style)}:${layer.revision}`
        if (registered.current.has(layer.id) && registered.current.get(layer.id) !== key) {
          if (layer.kind === 'vector') {
            const data = await api<GeoJSON.FeatureCollection>(`/layers/${layer.id}/geojson`)
            if (cancelled) return
            const rendered = renderFeatures(data)
            ;(current!.getSource(layer.id) as maplibregl.GeoJSONSource).setData(rendered)
            ;(current!.getSource(`${layer.id}-overview-source`) as maplibregl.GeoJSONSource).setData(polygonOverview(rendered))
            registered.current.set(layer.id, key)
          } else remove(layer.id)
        }
        if (!registered.current.has(layer.id)) {
          if (layer.visible === false) continue
          const before = current!.getStyle().layers.find(entry => entry.id.includes('td-') || entry.id.includes('terra-draw'))?.id
          if (layer.kind === 'vector') {
            const data = await api<GeoJSON.FeatureCollection>(`/layers/${layer.id}/geojson`)
            if (cancelled) return
            const rendered = renderFeatures(data)
            current!.addSource(layer.id, { type: 'geojson', data: rendered, tolerance: 0, maxzoom: 20 })
            current!.addSource(`${layer.id}-overview-source`, { type: 'geojson', data: polygonOverview(rendered) })
            current!.addLayer({ id: `${layer.id}-fill`, type: 'fill', source: layer.id, filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': layer.color ?? '#d5ef78', 'fill-opacity': .28 } }, before)
            current!.addLayer({ id: `${layer.id}-line`, type: 'line', source: layer.id, paint: { 'line-color': layer.color ?? '#d5ef78', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.25, 12, 2, 17, 2.5] } }, before)
            current!.addLayer({ id: `${layer.id}-point`, type: 'circle', source: layer.id, filter: ['==', '$type', 'Point'], paint: { 'circle-color': layer.color ?? '#d5ef78', 'circle-radius': 5 } }, before)
            current!.addLayer({ id: `${layer.id}-overview`, type: 'circle', source: `${layer.id}-overview-source`, maxzoom: 13,
              paint: { 'circle-color': layer.color ?? '#d5ef78', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 2.5, 8, 3.5, 13, 3], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } }, before)
          } else {
            const remote = layer.kind === 'stac' ? await api<{ tiles: string[] }>(`/layers/${layer.id}/render`, { bands: displayBands, rescale: layer.rescale, symbology: style }) : null
            if (cancelled) return
            const tile = remote?.tiles[0] ?? `/api/layers/${layer.id}/tiles/{z}/{x}/{y}.png?bands=${encodeURIComponent(displayBands ?? '')}&stretch=${layer.stretch ?? true}&style=${encodeURIComponent(style ? JSON.stringify(style) : '')}&revision=${layer.revision ?? ''}`
            current!.addSource(layer.id, { type: 'raster', tiles: [tile.startsWith('/') ? location.origin + tile : tile], tileSize: 256, bounds: layer.bbox as [number, number, number, number], maxzoom: 20, attribution: layer.attribution })
            current!.addLayer({ id: `${layer.id}-raster`, type: 'raster', source: layer.id, paint: { 'raster-fade-duration': 0, 'raster-resampling': style?.mode === 'classes' ? 'nearest' : 'linear' } }, before)
          }
          registered.current.set(layer.id, key)
        }
        for (const suffix of renderSuffixes) {
          const id = `${layer.id}-${suffix}`
          if (!current!.getLayer(id)) continue
          current!.setLayoutProperty(id, 'visibility', layer.visible === false ? 'none' : 'visible')
          const type = suffix === 'point' || suffix === 'overview' ? 'circle' : suffix
          const opacity = layer.opacity ?? 1
          const alpha: number | maplibregl.ExpressionSpecification = suffix === 'overview' ? ['interpolate', ['linear'], ['zoom'], 10, opacity, 13, 0] : opacity * (suffix === 'fill' ? .28 : 1)
          current!.setPaintProperty(id, `${type}-opacity`, alpha)
          if (suffix === 'overview') current!.setPaintProperty(id, 'circle-stroke-opacity', alpha)
          if (type !== 'raster') current!.setPaintProperty(id, `${type}-color`, layer.color_property ? ['to-color', ['get', layer.color_property], layer.color ?? '#d5ef78'] : layer.color ?? '#d5ef78')
        }
        } catch (error) {
          if (cancelled) return
          remove(layer.id)
          report(`${layer.name}: ${String(error)}`)
        }
      }
      const before = current!.getStyle().layers.find(entry => entry.id.includes('td-') || entry.id.includes('terra-draw'))?.id
      const displayOrder = [...layers.filter(layer => layer.kind !== 'vector'), ...layers.filter(layer => layer.kind === 'vector')]
      for (const layer of displayOrder) for (const suffix of renderSuffixes) {
        const identifier = `${layer.id}-${suffix}`
        if (current!.getLayer(identifier)) current!.moveLayer(identifier, before)
      }
    }
    void sync().catch(error => { if (!cancelled) report(String(error)) })
    return () => { cancelled = true }
  }, [ready, layers])

  useEffect(() => {
    if (!ready || !editor.current) return
    dismissInspection()
    const retained = editor.current.getSnapshot().filter(feature => feature.id !== undefined && (pending.current.has(feature.id) || failed.current.has(feature.id)))
    editor.current.clear()
    if (retained.length) editor.current.addFeatures(retained)
    editor.current.setMode(drawing === 'polygon' ? 'polygon' : drawing === 'measure' ? 'linestring' : 'static')
  }, [ready, drawing])

  return <div className="globe" ref={container} data-testid="globe">{inspection && !drawing && <MapInspector key={inspection.sequence} inspection={inspection} layers={layers} onClose={closeInspection} onDeleteFeature={onDeleteFeature} />}{basemap === 'google' && credit && <div className="google-credit"><strong>Google Maps</strong>{credit}</div>}</div>
}