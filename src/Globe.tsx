import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import {
  Viewer, Cartesian2, Cartesian3, Cartographic, Color, Math as CesiumMath, Rectangle,
  TileMapServiceImageryProvider, UrlTemplateImageryProvider, OpenStreetMapImageryProvider,
  GeoJsonDataSource, ImageryLayer, Credit, ScreenSpaceEventType, ScreenSpaceEventHandler,
  EllipsoidGeodesic, Entity, WebMercatorTilingScheme, ColorMaterialProperty, ConstantProperty, PolygonHierarchy,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import { api } from './api'
import type { Layer } from './api'

export type Basemap = 'earth' | 'satellite' | 'osm' | 'google' | 'google-satellite'
export type Drawing = 'polygon' | 'measure' | null
export interface GlobeHandle {
  home: () => void
  zoom: (direction: number) => void
  fly: (bounds: number[]) => void
  locate: (longitude: number, latitude: number) => void
  bounds: () => number[]
  mode: (flat: boolean) => void
  finish: () => void
  north: () => void
  undo?: () => void
  redo?: () => void
  discardDraft?: () => void
}
interface Props {
  ref: Ref<GlobeHandle>
  basemap: Basemap
  layers: Layer[]
  drawing: Drawing
  onError: (message: string) => void
  onPosition: (position: string) => void
  onReady: () => void
  onPolygon: (coordinates: number[][]) => void
  onMeasure: (meters: number) => void
}

export default function Globe({ ref, basemap, layers, drawing, onError, onPosition, onReady, onPolygon, onMeasure }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const viewer = useRef<Viewer | null>(null)
  const overlays = useRef(new Map<string, { object: ImageryLayer | GeoJsonDataSource; key: string }>())
  const vertices = useRef<number[][]>([])
  const sketch = useRef<Entity[]>([])
  const [ready, setReady] = useState(false)
  const [copyright, setCopyright] = useState('')
  const [loadError, setLoadError] = useState('')
  const errorEvent = useEffectEvent(onError)
  const positionEvent = useEffectEvent(onPosition)
  const readyEvent = useEffectEvent(onReady)
  const measureEvent = useEffectEvent(onMeasure)

  function clearSketch() {
    sketch.current.forEach(entity => viewer.current?.entities.remove(entity))
    sketch.current = []
    vertices.current = []
  }

  useImperativeHandle(ref, () => ({
    home() { viewer.current?.camera.flyTo({ destination: Cartesian3.fromDegrees(65, 20, 21_000_000), duration: 1.2 }) },
    zoom(direction) {
      const camera = viewer.current?.camera
      if (camera) {
        if (direction > 0) camera.zoomIn(camera.positionCartographic.height * .4)
        else camera.zoomOut(camera.positionCartographic.height * .6)
      }
      viewer.current?.scene.requestRender()
    },
    fly(bounds) {
      const [west, south, east, north] = bounds
      viewer.current?.camera.flyTo({ destination: Rectangle.fromDegrees(west - .005, south - .005, east + .005, north + .005), duration: 1.1 })
    },
    locate(longitude, latitude) { viewer.current?.camera.flyTo({ destination: Cartesian3.fromDegrees(longitude, latitude, 80_000), duration: 1.4 }) },
    bounds() {
      const rectangle = viewer.current?.camera.computeViewRectangle()
      return rectangle ? [rectangle.west, rectangle.south, rectangle.east, rectangle.north].map(value => CesiumMath.toDegrees(value)) : [-180, -85, 180, 85]
    },
    mode(flat) {
      if (flat) viewer.current?.scene.morphTo2D(.35)
      else viewer.current?.scene.morphTo3D(.35)
    },
    north() {
      const current = viewer.current
      if (current) current.camera.flyTo({ destination: current.camera.positionWC, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }, duration: .5 })
    },
    finish() {
      if (drawing === 'polygon') {
        if (vertices.current.length < 3) { onError('A polygon needs at least three vertices.'); return }
        onPolygon([...vertices.current, vertices.current[0]])
      }
      clearSketch()
    },
  }))

  useEffect(() => {
    if (!container.current) return
    let current: Viewer
    try {
      current = new Viewer(container.current, {
        baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false,
        sceneModePicker: false, navigationHelpButton: false, animation: false, timeline: false,
        fullscreenButton: false, infoBox: false, selectionIndicator: false,
        skyBox: false, requestRenderMode: true, maximumRenderTimeChange: Infinity,
        msaaSamples: 1,
        contextOptions: { webgl: { preserveDrawingBuffer: false } },
      })
    } catch (error) { setLoadError(`WebGL could not start: ${String(error)}`); return }
    viewer.current = current
    current.scene.backgroundColor = Color.fromCssColorString('#101619')
    current.scene.globe.baseColor = Color.fromCssColorString('#354b50')
    current.scene.globe.enableLighting = false
    current.scene.globe.maximumScreenSpaceError = 2
    current.scene.globe.showGroundAtmosphere = true
    if (current.scene.sun) current.scene.sun.show = false
    if (current.scene.moon) current.scene.moon.show = false
    current.resolutionScale = 1
    current.scene.postProcessStages.fxaa.enabled = false
    const overlayMap = overlays.current
    current.camera.setView({ destination: Cartesian3.fromDegrees(65, 20, 21_000_000) })
    current.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    const moved = () => {
      const position = current.camera.positionCartographic
      const latitude = CesiumMath.toDegrees(position.latitude), longitude = CesiumMath.toDegrees(position.longitude)
      positionEvent(`${Math.abs(latitude).toFixed(3)}° ${latitude >= 0 ? 'N' : 'S'}   ${Math.abs(longitude).toFixed(3)}° ${longitude >= 0 ? 'E' : 'W'}`)
    }
    current.camera.moveEnd.addEventListener(moved)
    moved()
    setReady(true)
    readyEvent()
    return () => { overlayMap.clear(); current.destroy(); viewer.current = null }
  }, [])

  useEffect(() => {
    const current = viewer.current
    if (!ready || !current) return
    let cancelled = false
    let active: ImageryLayer | undefined
    let removeMove: (() => void) | undefined
    setCopyright('')
    async function load() {
      try {
        let provider
        if (basemap === 'earth') {
          provider = await TileMapServiceImageryProvider.fromUrl('/cesium/Assets/Textures/NaturalEarthII', { credit: new Credit('Natural Earth II', true) })
        } else if (basemap === 'osm') {
          provider = new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19,
            credit: new Credit('<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>', true) })
        } else if (basemap === 'satellite') {
          provider = new UrlTemplateImageryProvider({ url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', maximumLevel: 14,
            credit: new Credit('<a href="https://cloudless.eox.at/" target="_blank">Sentinel-2 cloudless 2016 by EOX • CC BY 4.0 • Copernicus Sentinel data</a>', true) })
        } else {
          const session = await api<{ key: string; session: string; tileWidth: number; tileHeight: number }>('/google/session')
          provider = new UrlTemplateImageryProvider({
            url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(session.key)}`,
            maximumLevel: 19, tileWidth: session.tileWidth, tileHeight: session.tileHeight,
          })
          const attribution = async () => {
            const extent = current!.camera.computeViewRectangle() ?? Rectangle.MAX_VALUE
            const [west, south, east, north] = [extent.west, extent.south, extent.east, extent.north].map(CesiumMath.toDegrees)
            const zoom = Math.max(0, Math.min(19, Math.round(Math.log2(40_000_000 / Math.max(1, current!.camera.positionCartographic.height)))))
            try {
              const result = await api<{ copyright: string }>(`/google/viewport?${new URLSearchParams({ north: String(Math.min(89.99, north)), south: String(Math.max(-89.99, south)), east: String(east), west: String(west), zoom: String(zoom) })}`)
              if (!cancelled) { setCopyright(result.copyright); if (active) active.show = true }
              return true
            } catch (error) {
              if (!cancelled) { if (active) active.show = false; errorEvent(String(error)) }
              return false
            }
          }
          if (!await attribution()) return
          removeMove = current!.camera.moveEnd.addEventListener(attribution)
        }
        if (cancelled || current!.isDestroyed()) return
        active = current!.imageryLayers.addImageryProvider(provider, 0)
        let reported = false
        provider.errorEvent.addEventListener(() => {
          if (!reported && !cancelled) { reported = true; errorEvent('Some basemap tiles could not load. Check your connection or choose another basemap.') }
        })
        current!.scene.requestRender()
      } catch (error) { if (!cancelled) errorEvent(String(error)) }
    }
    void load()
    return () => { cancelled = true; removeMove?.(); if (active && !current.isDestroyed()) current.imageryLayers.remove(active) }
  }, [basemap, ready])

  useEffect(() => {
    const current = viewer.current
    if (!ready || !current) return
    let cancelled = false
    const ids = new Set(layers.map(layer => layer.id))
    const remove = (object: ImageryLayer | GeoJsonDataSource) => object instanceof ImageryLayer ? current.imageryLayers.remove(object) : current.dataSources.remove(object, true)
    for (const [id, entry] of overlays.current) {
      if (!ids.has(id)) { remove(entry.object); overlays.current.delete(id) }
    }
    async function synchronize() {
      for (const layer of layers) {
        if (cancelled || current!.isDestroyed()) return
        const key = `${layer.bands ?? ''}:${layer.stretch ?? true}:${layer.color ?? ''}:${layer.rescale ?? ''}`
        let entry = overlays.current.get(layer.id)
        if (entry && entry.key !== key) { remove(entry.object); overlays.current.delete(layer.id); entry = undefined }
        if (!entry) {
          try {
            let object: ImageryLayer | GeoJsonDataSource
            if (layer.kind === 'vector') {
              const data = await api<object>(`/layers/${layer.id}/geojson`)
              const source = await GeoJsonDataSource.load(data, { stroke: Color.fromCssColorString(layer.color ?? '#44d9b5'), markerColor: Color.fromCssColorString(layer.color ?? '#44d9b5'), strokeWidth: 2,
                fill: Color.fromCssColorString(layer.color ?? '#44d9b5').withAlpha(.2), clampToGround: false })
              if (cancelled || current!.isDestroyed()) return
              await current!.dataSources.add(source)
              object = source
            } else {
              const bounds = layer.bbox
              const remote = layer.kind === 'stac' ? await api<{ tiles: string[] }>(`/layers/${layer.id}/render`, { bands: layer.bands, rescale: layer.rescale }) : null
              if (cancelled || current!.isDestroyed()) return
              const provider = new UrlTemplateImageryProvider({
                url: remote?.tiles[0] ?? `/api/layers/${layer.id}/tiles/{z}/{x}/{y}.png?bands=${encodeURIComponent(layer.bands ?? '')}&stretch=${layer.stretch ?? true}`,
                rectangle: Rectangle.fromDegrees(bounds[0], Math.max(-85, bounds[1]), bounds[2], Math.min(85, bounds[3])),
                tilingScheme: new WebMercatorTilingScheme(), maximumLevel: 20,
                minimumLevel: layer.kind === 'stac' ? Math.max(0, Math.min(7, Math.floor(Math.log2(60 / Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]))))) : 0,
                credit: layer.attribution ? new Credit(layer.attribution, true) : undefined,
              })
              let reported = false
              provider.errorEvent.addEventListener(() => {
                if (!reported) { reported = true; errorEvent(`Some tiles for ${layer.name} could not load.`) }
              })
              object = current!.imageryLayers.addImageryProvider(provider)
            }
            entry = { object, key }
            overlays.current.set(layer.id, entry)
          } catch (error) { if (!cancelled) errorEvent(`Could not display ${layer.name}: ${String(error)}`); continue }
        }
        entry.object.show = layer.visible !== false
        if (entry.object instanceof ImageryLayer) entry.object.alpha = layer.opacity ?? 1
        else {
          const color = Color.fromCssColorString(layer.color ?? '#44d9b5')
          for (const entity of entry.object.entities.values) {
            if (entity.polygon) {
              entity.polygon.material = new ColorMaterialProperty(color.withAlpha(.22 * (layer.opacity ?? 1)))
              entity.polygon.outlineColor = new ConstantProperty(color.withAlpha(layer.opacity ?? 1))
            }
            if (entity.polyline) entity.polyline.material = new ColorMaterialProperty(color.withAlpha(layer.opacity ?? 1))
            if (entity.billboard) entity.billboard.color = new ConstantProperty(Color.WHITE.withAlpha(layer.opacity ?? 1))
          }
        }
      }
      current!.scene.requestRender()
    }
    void synchronize()
    return () => { cancelled = true }
  }, [layers, ready])

  useEffect(() => {
    const current = viewer.current
    if (!ready || !current || !drawing) return
    clearSketch()
    const handler = new ScreenSpaceEventHandler(current.canvas)
    const positions = new ConstantProperty([])
    const hierarchy = new ConstantProperty(new PolygonHierarchy([]))
    const outline = current.entities.add({ polyline: { positions, width: 2, material: Color.fromCssColorString('#79e8fa'), arcType: 1 } })
    sketch.current.push(outline)
    if (drawing === 'polygon') sketch.current.push(current.entities.add({ polygon: { hierarchy, material: Color.fromCssColorString('#79e8fa').withAlpha(.16) } }))
    const updatePreview = (cursor?: Cartesian3) => {
      const points = vertices.current.map(vertex => Cartesian3.fromDegrees(vertex[0], vertex[1]))
      if (cursor && points.length) points.push(cursor)
      hierarchy.setValue(new PolygonHierarchy(points))
      positions.setValue(drawing === 'polygon' && points.length > 2 ? [...points, points[0]] : points)
      current.canvas.dataset.sketchPoints = String(points.length)
      if (drawing === 'measure' && points.length > 1) {
        let distance = 0
        for (let index = 1; index < points.length; index++) distance += new EllipsoidGeodesic(Cartographic.fromCartesian(points[index - 1]), Cartographic.fromCartesian(points[index])).surfaceDistance
        measureEvent(distance)
      }
      current.scene.requestRender()
    }
    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      const position = current.camera.pickEllipsoid(event.endPosition, current.scene.globe.ellipsoid)
      if (position) updatePreview(position)
    }, ScreenSpaceEventType.MOUSE_MOVE)
    handler.setInputAction((event: { position: Cartesian2 }) => {
      const position = current.camera.pickEllipsoid(event.position, current.scene.globe.ellipsoid)
      if (!position) return
      const geographic = Cartographic.fromCartesian(position)
      vertices.current.push([CesiumMath.toDegrees(geographic.longitude), CesiumMath.toDegrees(geographic.latitude)])
      sketch.current.push(current.entities.add({ position, point: { pixelSize: 7, color: Color.fromCssColorString('#f2bb60'), outlineColor: Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Infinity } }))
      updatePreview()
    }, ScreenSpaceEventType.LEFT_CLICK)
    return () => { handler.destroy(); clearSketch(); delete current.canvas.dataset.sketchPoints; if (!current.isDestroyed()) current.scene.requestRender() }
  }, [drawing, ready])

  return <div className={`globe ${drawing ? 'is-drawing' : ''}`} ref={container} data-testid="globe">
    {loadError && <div className="globe-error" role="alert">{loadError}</div>}
    {basemap === 'google' && copyright && <div className="google-credit"><strong>Google Maps</strong><span>{copyright}</span></div>}
  </div>
}