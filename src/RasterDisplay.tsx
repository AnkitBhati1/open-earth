import { useEffect, useRef, useState } from 'react'
import { Check, Plus, RotateCcw, WandSparkles, X } from 'lucide-react'
import { api } from './api'
import type { ClassStyle, Layer, Symbology } from './api'

const ramps = [
  { id: 'gray', name: 'Gray', colors: '#161616,#ffffff' },
  { id: 'viridis', name: 'Viridis', colors: '#440154,#31688e,#35b779,#fde725' },
  { id: 'terrain', name: 'Terrain', colors: '#333399,#00aa99,#e6e695,#885a54,#ffffff' },
  { id: 'magma', name: 'Magma', colors: '#000004,#721f81,#f1605d,#fcfdbf' },
  { id: 'blues', name: 'Blues', colors: '#f7fbff,#6baed6,#08306b' },
] as const
const softColors = ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5']
const contrastColors = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9', '#746b29', '#454545']
interface StyleAnalysis {
  defaults: Symbology
  recommendation?: Symbology
  distribution?: { histogram: number[]; valid: number; sampled: boolean; range: number[] | null } | null
}

function evidence(style: Symbology) {
  if (style.source === 'Sampled values') return 'Sampled classes'
  if (style.source === 'Unique values') return 'Unique values'
  if (style.source === 'Embedded color table') return 'Embedded palette'
  if (style.mode === 'classes') return 'Class metadata'
  if (style.source === 'RGB metadata') return 'RGB metadata'
  if (style.source === 'Band statistics') return 'Band statistics'
  return style.mode === 'rgb' ? 'Band composite' : 'Continuous values'
}

export default function RasterDisplay({ layer, onChange }: { layer: Layer; onChange: (update: Partial<Layer>) => void }) {
  const names = layer.band_names ?? Array.from({ length: layer.count }, (_, index) => String(index + 1))
  const initial: Symbology = layer.symbology ?? { mode: layer.count >= 3 ? 'rgb' : 'continuous', palette: 'gray', classes: [], source: 'Band display' }
  const [style, setStyle] = useState(initial)
  const [defaults, setDefaults] = useState(initial)
  const [bands, setBands] = useState((layer.bands || initial.bands?.join(',') || names.slice(0, initial.mode === 'rgb' ? 3 : 1).join(',')).split(','))
  const [analysis, setAnalysis] = useState<{ band: string; result: StyleAnalysis } | null>(null)
  const autoBand = useRef('')
  const [pendingBand, setPendingBand] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const firstBand = bands[0]
  useEffect(() => {
    let cancelled = false
    void api<StyleAnalysis>(`/layers/${layer.id}/symbology?band=${encodeURIComponent(firstBand)}`).then(result => {
      if (cancelled) return
      setDefaults(result.defaults)
      setAnalysis({ band: firstBand, result })
      if (autoBand.current === firstBand) {
        if (result.recommendation) { setStyle(result.recommendation); setDirty(true) }
        autoBand.current = ''; setPendingBand('')
      }
    }).catch(failure => { if (!cancelled) { autoBand.current = ''; setPendingBand(''); setError(String(failure)) } })
    return () => { cancelled = true }
  }, [layer.id, firstBand])
  function edit(update: Partial<Symbology>) { autoBand.current = ''; setPendingBand(''); setStyle(previous => ({ ...previous, ...update })); setDirty(true); setMessage(''); setError('') }
  function editClass(index: number, update: Partial<ClassStyle>) {
    edit({ classes: style.classes.map((entry, offset) => offset === index ? { ...entry, ...update } : entry) })
  }
  function mode(value: Symbology['mode']) {
    edit({ mode: value, classes: value === 'classes' && !style.classes.length ? (recommendation.classes.length ? recommendation.classes : [{ value: 1, label: 'Class 1', color: softColors[0], visible: true }]) : style.classes })
    setBands(value === 'rgb' ? (bands.length === 3 ? bands : defaults.mode === 'rgb' && defaults.bands ? defaults.bands : names.slice(0, 3)) : [bands[0]])
  }
  function changeBand(value: string, index: number) {
    setBands(previous => { const next = [...previous]; next[index] = value; return next })
    setFilter('')
    if (style.mode !== 'rgb') {
      edit({ mode: 'continuous', classes: [], minimum: null, maximum: null, source: 'Band display' })
      autoBand.current = value
      setPendingBand(value)
    } else edit({})
  }
  const ready = analysis?.band === firstBand
  const recommendation = (style.mode === 'rgb' ? defaults : ready && analysis.result.recommendation) || defaults
  const distribution = ready ? analysis.result.distribution : null
  const schemes = [
    { id: 'dataset', name: 'Dataset colors', colors: recommendation.classes.map(entry => entry.color) },
    { id: 'soft', name: 'Soft categorical', colors: softColors },
    { id: 'contrast', name: 'High contrast', colors: contrastColors },
  ]
  const range = layer.kind === 'stac' ? (layer.rescale ?? '0,3000').split(',').map(Number) : layer.ranges?.[Number(bands[0]) - 1] ?? [0, 255]
  async function apply(nextStyle = style, nextBands = bands) {
    setSaving(true); setError(''); setMessage('')
    try {
      const selectedBands = nextStyle.mode === 'rgb' ? (nextBands.length === 3 ? nextBands : names.slice(0, 3)) : [nextBands[0]]
      const result = await api<Symbology>(`/layers/${layer.id}/symbology`, { ...nextStyle, bands: selectedBands })
      onChange({ symbology: result, bands: selectedBands.join(',') })
      setStyle(result); setBands(selectedBands); setDirty(false); setMessage('Style saved')
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setSaving(false) }
  }
  return <form className="raster-display symbology" onSubmit={event => { event.preventDefault(); void apply() }}>
    <div className="section-heading"><span>Symbology</span><span className="count">{layer.count} bands</span></div>
    <div className="style-detection"><div><span title={recommendation.source === 'Sampled values' ? 'Estimated from a bounded sample; rare classes may be absent.' : undefined}>{ready ? evidence(recommendation) : 'Reading metadata...'}</span><small>{dirty ? 'Unsaved changes' : style.mode === 'classes' ? `${style.classes.length} classes` : style.mode === 'rgb' ? 'Three-channel color' : 'Value ramp'}</small></div><button type="button" className="text-button" disabled={saving || !ready} title="Apply the recommended style" onClick={() => { autoBand.current = ''; void apply(recommendation, recommendation.bands ?? bands) }}><WandSparkles size={14} />Auto</button></div>
    <div className="segmented" aria-label="Rendering mode">{(['rgb', 'continuous', 'classes'] as const).map(value => <button type="button" key={value} aria-pressed={style.mode === value} className={style.mode === value ? 'active' : ''} disabled={saving || (value === 'rgb' && names.length < 3)} onClick={() => mode(value)}>{value === 'rgb' ? 'RGB' : value === 'continuous' ? 'Ramp' : 'Classes'}</button>)}</div>
    <fieldset disabled={saving} className="style-fields">
      <div className={`rgb-fields ${style.mode === 'rgb' ? 'is-rgb' : 'single-band'}`}>{(style.mode === 'rgb' ? (bands.length === 3 ? bands : names.slice(0, 3)) : [bands[0]]).map((band, index) => <label className="field" key={index}><span>{style.mode === 'rgb' ? ['Red', 'Green', 'Blue'][index] : 'Band'}</span><select value={band} onChange={event => changeBand(event.target.value, index)}>{names.map(name => <option key={name} value={name}>{layer.band_names ? name : `Band ${name}`}</option>)}</select></label>)}</div>
      {style.mode === 'classes' ? <>
        <div className="legend-heading"><span>Colors</span><span>Discrete</span></div>
        <div className="categorical-options" aria-label="Class palettes">{schemes.filter(scheme => scheme.colors.length).map(scheme => {
          const colorFor = (entry: ClassStyle, index: number) => scheme.id === 'dataset' ? recommendation.classes.find(candidate => candidate.value === entry.value)?.color ?? entry.color : scheme.colors[index % scheme.colors.length]
          const datasetColors = style.classes.every(entry => recommendation.classes.find(candidate => candidate.value === entry.value)?.color === entry.color)
          const selected = style.classes.every((entry, index) => entry.color === colorFor(entry, index)) && (scheme.id === 'dataset' || !datasetColors)
          return <button type="button" key={scheme.id} title={scheme.name} aria-label={scheme.name} aria-pressed={selected} className={selected ? 'selected' : ''} onClick={() => edit({ source: 'Custom colors', classes: style.classes.map((entry, index) => ({ ...entry, color: colorFor(entry, index) })) })}><span>{scheme.colors.slice(0, 8).map((color, index) => <i key={index} style={{ background: color }} />)}</span></button>
        })}</div>
        <div className="legend-heading"><span>Legend</span><span>{style.classes.length} classes</span></div>
        {style.classes.length > 12 && <input className="class-filter" aria-label="Find class" placeholder="Find class" value={filter} onChange={event => setFilter(event.target.value)} />}
        <div className="class-list">{style.classes.map((entry, index) => (!filter || `${entry.value} ${entry.label}`.toLowerCase().includes(filter.toLowerCase())) && <div className="class-row" key={index}>
          <input type="checkbox" aria-label={`Show class ${entry.value}`} checked={entry.visible} onChange={event => editClass(index, { visible: event.target.checked })} />
          <input type="color" aria-label={`Color for class ${entry.value}`} value={entry.color} onChange={event => editClass(index, { color: event.target.value })} />
          <input className="class-label" aria-label={`Label for class ${entry.value}`} value={entry.label} onChange={event => editClass(index, { label: event.target.value })} />
          <input className="class-value" type="number" step="1" aria-label={`Value for ${entry.label}`} value={entry.value} onChange={event => editClass(index, { value: Number(event.target.value) })} />
          <button type="button" className="icon-button" aria-label={`Delete class ${entry.value}`} title="Delete class" onClick={() => edit({ classes: style.classes.filter((_, offset) => index !== offset) })}><X size={12} /></button>
        </div>)}</div>
        <button type="button" className="text-button small" disabled={style.classes.length >= 256} onClick={() => { const value = Math.max(0, ...style.classes.map(entry => entry.value)) + 1; edit({ classes: [...style.classes, { value, label: `Class ${value}`, color: softColors[style.classes.length % softColors.length], visible: true }] }) }}><Plus size={13} />Add class</button>
      </> : <>
        {style.mode === 'continuous' && distribution && <div className="value-distribution"><div className="legend-heading"><span>{distribution.sampled ? 'Sample distribution' : 'Value distribution'}</span><span>{distribution.valid ? `${distribution.valid.toLocaleString()} px` : 'No valid pixels'}</span></div><div className="histogram" role="img" aria-label="Raster value distribution">{distribution.histogram.map((count, index) => <i key={index} style={{ height: `${Math.max(0, count / Math.max(1, ...distribution.histogram) * 100)}%` }} />)}</div></div>}
        {style.mode === 'continuous' && <><div className="legend-heading"><span>Color ramp</span><span>{ramps.find(entry => entry.id === style.palette)?.name}</span></div><div className="ramp-options">{ramps.map(entry => <button type="button" key={entry.id} title={entry.name} aria-label={`${entry.name} palette`} aria-pressed={style.palette === entry.id} className={style.palette === entry.id ? 'selected' : ''} onClick={() => edit({ palette: entry.id })}><span style={{ background: `linear-gradient(90deg,${entry.colors})` }} /></button>)}</div></>}
        <label className="checkbox"><input type="checkbox" checked={style.minimum == null} onChange={event => edit(event.target.checked ? { minimum: null, maximum: null } : { minimum: range[0], maximum: range[1] })} />{layer.kind === 'stac' ? 'Dataset range' : 'Automatic range'}</label>
        <div className="range-fields">{(['minimum', 'maximum'] as const).map((key, index) => <label key={key} className="field"><span>{key === 'minimum' ? 'Min' : 'Max'}</span><input type="number" step="any" disabled={style.minimum == null} aria-label={`Display ${key}`} value={style[key] ?? range[index]} onChange={event => edit({ [key]: Number(event.target.value) })} /></label>)}</div>
      </>}
    </fieldset>
    <div className="style-actions"><button className="primary" type="submit" disabled={saving || !dirty || !!pendingBand}><Check size={14} />{saving ? 'Applying...' : 'Apply style'}</button><button type="button" className="icon-button" aria-label="Reset to dataset style" title="Reset to dataset style" disabled={saving || !ready} onClick={() => { edit({ minimum: null, maximum: null, ...defaults }); setBands(defaults.bands ?? names.slice(0, defaults.mode === 'rgb' ? 3 : 1)); setFilter('') }}><RotateCcw size={14} /></button></div>
    {message && <div className="style-status" role="status">{message}</div>}{error && <div className="inline-error" role="alert">{error}</div>}
  </form>
}

export function RasterScale({ layer }: { layer: Layer }) {
  const style = layer.symbology
  if (style?.mode !== 'continuous') return null
  const band = layer.bands?.split(',')[0] ?? style.bands?.[0] ?? layer.band_names?.[0] ?? '1'
  const automatic = layer.kind === 'stac' ? (layer.rescale ?? '0,3000').split(',').map(Number) : layer.stretch === false ? [0, 255] : layer.ranges?.[Number(band) - 1]
  const minimum = style.minimum ?? automatic?.[0]
  const maximum = style.maximum ?? automatic?.[1]
  return <div className="raster-scale" aria-label="Continuous value scale"><div className="scale-caption"><span title={layer.name}>{layer.name}</span><span>{layer.band_names ? band : `Band ${band}`}</span></div><div className="scale-ramp" style={{ background: `linear-gradient(90deg,${ramps.find(entry => entry.id === style.palette)?.colors ?? ramps[0].colors})` }} /><div className="scale-ticks"><span title={String(minimum)}>{minimum == null ? 'Unknown' : Number(minimum.toPrecision(6))}</span><span title={String(maximum)}>{maximum == null ? 'Unknown' : Number(maximum.toPrecision(6))}</span></div></div>
}

export function RasterLegend({ layer }: { layer?: Layer }) {
  if (!layer?.symbology || layer.visible === false || (layer.opacity ?? 1) === 0 || layer.symbology.mode === 'rgb') return null
  if (layer.symbology.mode === 'continuous') return <div className="map-legend continuous-legend"><RasterScale layer={layer} /></div>
  return <details className="map-legend"><summary>Legend <span>{layer.symbology.classes.filter(entry => entry.visible).length}</span></summary><div className="map-legend-items">{layer.symbology.classes.filter(entry => entry.visible).map(entry => <div key={entry.value}><i style={{ background: entry.color }} /><span>{entry.label}</span><small>{entry.value}</small></div>)}</div></details>
}