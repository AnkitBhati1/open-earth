import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Braces, GripVertical, MapPlus, Search } from 'lucide-react'

export type NotebookObject = { key: string; name: string; kind: 'ds' | 'dfs'; variables: string[] }
export const notebookMime = 'application/x-open-earth-notebook'

export function NotebookData({ objects, disabled, onInsert, onVisualize }: { objects: NotebookObject[]; disabled: boolean; onInsert: (source: string) => void; onVisualize: (object: NotebookObject) => void }) {
  const [query, setQuery] = useState('')
  return <details className="notebook-data" open>
    <summary><Braces size={15} /><strong>Session data</strong><span>{objects.length}</span></summary>
    <div className="notebook-data-content">
      {objects.length > 4 && <label className="notebook-data-search"><Search size={13} /><input aria-label="Filter notebook data" placeholder="Filter data" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      <div className="notebook-data-items">{objects.filter(object => object.name.toLowerCase().includes(query.toLowerCase())).map(object => <div className="notebook-data-row" key={`${object.kind}:${object.key}`} draggable={!disabled} onDragStart={event => { event.dataTransfer.setData(notebookMime, JSON.stringify({ key: object.key, kind: object.kind })); event.dataTransfer.effectAllowed = 'copy' }} title={`Drag ${object.name} to map as a copy`}>
        <GripVertical size={14} className="data-grip" /><code>{object.kind}</code>
        <button className="data-reference" title={`Insert ${object.kind} reference`} onClick={() => onInsert(`${object.kind}[${JSON.stringify(object.key)}]`)}><span>{object.name}</span><small>{object.variables.join(', ') || 'GeoDataFrame'}</small></button>
        <button className="notebook-tool" aria-label={`Add ${object.name} copy to map`} title="Add copy to map" disabled={disabled} onClick={() => onVisualize(object)}><MapPlus size={16} /></button>
      </div>)}</div>
      {!objects.length && <div className="notebook-data-empty">No session datasets</div>}
    </div>
  </details>
}

export function NotebookDropTarget({ onDrop }: { onDrop: (object: NotebookObject) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const dropped = useEffectEvent(onDrop)
  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(notebookMime)) return
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setActive(true)
    }
    const leave = (event: DragEvent) => { if (!parent.contains(event.relatedTarget as Node | null)) setActive(false) }
    const end = () => setActive(false)
    const drop = (event: DragEvent) => {
      const payload = event.dataTransfer?.getData(notebookMime)
      if (!payload) return
      event.preventDefault(); setActive(false)
      try { const object = JSON.parse(payload); if (typeof object.key === 'string' && ['ds', 'dfs'].includes(object.kind)) dropped(object) } catch { return }
    }
    parent.addEventListener('dragover', over); parent.addEventListener('dragleave', leave); parent.addEventListener('drop', drop)
    window.addEventListener('dragend', end)
    return () => { parent.removeEventListener('dragover', over); parent.removeEventListener('dragleave', leave); parent.removeEventListener('drop', drop); window.removeEventListener('dragend', end) }
  }, [])
  return <div ref={ref} className={`notebook-map-drop ${active ? 'active' : ''}`} aria-hidden={!active}><MapPlus size={30} /><strong>Add a copy to map</strong></div>
}