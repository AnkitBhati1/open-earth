import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Check, LoaderCircle, RotateCcw, Trash2, X } from 'lucide-react'
import type { Layer } from './api'
import { RasterScale } from './RasterDisplay'

export interface InspectCandidate {
  layerId: string
  label: string
  properties?: Record<string, unknown>
  geometryType?: string
  featureId?: string | number
}
export interface Inspection {
  sequence: number
  longitude: number
  latitude: number
  candidates: InspectCandidate[]
}
interface PixelBand {
  name: string
  value: number | string | null
  status: 'value' | 'nodata' | 'outside' | 'error'
  unit?: string | null
  scale?: number
  offset?: number
  row?: number | null
  column?: number | null
  error?: string
}
interface PixelResult { bands: PixelBand[] }
const formatValue = (value: unknown): string => value == null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)

function PixelValues({ layer, inspection }: { layer: Layer; inspection: Inspection }) {
  const [result, setResult] = useState<PixelResult | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort('timeout'), 60000)
    void fetch(`/api/layers/${layer.id}/inspect`, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Open-Earth': '1' }, body: JSON.stringify({ longitude: inspection.longitude, latitude: inspection.latitude }) }).then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Pixel could not be read.')
      if (!controller.signal.aborted) setResult(data)
    }).catch(failure => { if (!controller.signal.aborted || controller.signal.reason === 'timeout') setError(controller.signal.reason === 'timeout' ? 'Pixel request timed out.' : String(failure)) }).finally(() => window.clearTimeout(timeout))
    return () => { window.clearTimeout(timeout); controller.abort() }
  }, [layer.id, inspection.longitude, inspection.latitude, attempt])
  const retry = () => { setResult(null); setError(''); setAttempt(value => value + 1) }
  if (error) return <div className="inspect-message" role="alert"><span>{error}</span><button className="icon-button" title="Retry pixel inspection" aria-label="Retry pixel inspection" onClick={retry}><RotateCcw size={14} /></button></div>
  if (!result) return <div className="inspect-message" role="status"><LoaderCircle size={14} className="spin" />Reading pixel</div>
  return <><div className="inspect-caption"><span>Raw pixel values</span><span>{result.bands.length} bands</span>{result.bands.some(band => band.status === 'error') && <button className="icon-button" title="Retry unavailable bands" aria-label="Retry unavailable bands" onClick={retry}><RotateCcw size={13} /></button>}</div><RasterScale layer={layer} /><dl className="inspect-values">{result.bands.map((band, index) => <div key={index}><dt title={band.name}>{band.name}</dt><dd title={band.error ?? (band.row != null ? `Row ${band.row}, column ${band.column} (zero-based)` : undefined)}>{band.status === 'value' ? formatValue(band.value) : band.status === 'nodata' ? 'NoData' : band.status === 'outside' ? 'Outside raster' : 'Unavailable'}{band.status === 'value' && band.unit && (band.scale ?? 1) === 1 && (band.offset ?? 0) === 0 && <small>{band.unit}</small>}{band.status === 'value' && typeof band.value === 'number' && ((band.scale ?? 1) !== 1 || (band.offset ?? 0) !== 0) && <small title={`Raw * ${band.scale ?? 1} + ${band.offset ?? 0}`}>Scaled: {Number((band.value * (band.scale ?? 1) + (band.offset ?? 0)).toPrecision(9))} {band.unit}</small>}</dd></div>)}</dl></>
}

export default function MapInspector({ inspection, layers, onClose, onDeleteFeature }: { inspection: Inspection; layers: Layer[]; onClose: () => void; onDeleteFeature: (layer: Layer, featureId: string | number) => Promise<void> }) {
  const [index, setIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const candidates = inspection.candidates.filter(candidate => layers.some(layer => layer.id === candidate.layerId && layer.visible !== false && (layer.opacity ?? 1) > 0))
  const candidate = candidates[index] ?? candidates[0]
  const layer = layers.find(entry => entry.id === candidate?.layerId)
  if (!candidate || !layer) return null
  async function deleteFeature() {
    if (!candidate || !layer || candidate.featureId == null || deleting) return
    setDeleting(true); setDeleteError('')
    try { await onDeleteFeature(layer, candidate.featureId); onClose() }
    catch (failure) { setDeleteError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setDeleting(false) }
  }
  return <section className="map-inspector" aria-label="Map inspection" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <header><strong title={layer.name}>{layer.name}</strong><button className="icon-button" title={collapsed ? 'Expand inspection' : 'Collapse inspection'} aria-label={collapsed ? 'Expand inspection' : 'Collapse inspection'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button><button className="icon-button" title="Close inspection" aria-label="Close inspection" onClick={onClose}><X size={15} /></button></header>
    {!collapsed && <>
      <div className="inspect-location"><span>{inspection.latitude.toFixed(6)}, {inspection.longitude.toFixed(6)}</span><button className="icon-button" title={copyError ? 'Copy failed; coordinates can be selected' : 'Copy coordinates'} aria-label="Copy coordinates" onClick={() => { void navigator.clipboard.writeText(`${inspection.latitude.toFixed(6)}, ${inspection.longitude.toFixed(6)}`).then(() => { setCopied(true); setCopyError(false) }).catch(() => setCopyError(true)) }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></div>
      {candidates.length > 1 && <select aria-label="Inspect result" disabled={deleting} value={Math.min(index, candidates.length - 1)} onChange={event => { setIndex(Number(event.target.value)); setDeleteError(''); setConfirmDelete(false) }}>{candidates.map((entry, offset) => <option key={offset} value={offset}>{entry.label}</option>)}</select>}
      <div className="inspect-scroll">{candidate.properties ? <>
        <div className="inspect-caption"><span>{candidate.geometryType}</span><span>{layer.crs}</span>{candidate.featureId != null && !confirmDelete && <button className="icon-button" title="Delete selected feature" aria-label="Delete selected feature" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /></button>}</div>
        {confirmDelete && <div className="inspect-delete" role="group" aria-label="Confirm feature deletion"><span>{candidate.geometryType?.startsWith('Multi') ? 'Delete this entire multipart feature?' : 'Delete this feature?'}{layer.count === 1 ? ' The layer will be empty.' : ''}</span><div><button className="text-button" disabled={deleting} onClick={() => setConfirmDelete(false)}>Cancel</button><button className="text-button inspect-delete-action" disabled={deleting} onClick={() => void deleteFeature()}>{deleting ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}{deleting ? 'Deleting' : 'Delete'}</button></div></div>}
        {deleteError && <p className="inspect-message" role="alert">{deleteError}</p>}
        <dl className="inspect-values">{Object.entries(candidate.properties).map(([name, value]) => <div key={name}><dt title={name}>{name}</dt><dd>{formatValue(value)}</dd></div>)}{candidate.featureId != null && <div><dt>Feature ID</dt><dd>{candidate.featureId}</dd></div>}</dl>{!Object.keys(candidate.properties).length && <p className="inspect-message">No attributes</p>}
      </> : <PixelValues key={`${layer.id}:${layer.revision ?? ''}`} layer={layer} inspection={inspection} />}</div>
    </>}
  </section>
}