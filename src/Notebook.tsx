import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { python } from '@codemirror/lang-python'
import { EditorView } from '@codemirror/view'
import Markdown from 'react-markdown'
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, Download, Eraser, FileCode2, LoaderCircle, Maximize2, Minimize2, MoreHorizontal, Play, Plus, RotateCcw, Save, Square, Trash2, Upload, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from './api'
import { NotebookData } from './NotebookData'
import type { NotebookObject } from './NotebookData'

const Editor = lazy(() => import('@uiw/react-codemirror'))
type Output = { output_type: string; name?: string; text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string; traceback?: string[] }
type Cell = { id: string; cell_type: 'code' | 'markdown'; metadata: Record<string, unknown>; source: string; execution_count?: number | null; outputs?: Output[] }
type Document = { nbformat: number; nbformat_minor: number; metadata: Record<string, unknown>; cells: Cell[] }
export type CellResult = { output: string; outputs: Output[]; execution_count: number | null; status: string; binding_errors?: Record<string, string>; objects?: NotebookObject[] }
type Props = { open: boolean; snippet: string; ready: boolean; objects: NotebookObject[]; exporting: boolean; onVisualize: (object: NotebookObject) => void; workspaceErrors: Record<string, string>; workspaceDisplays: Record<string, Record<string, string | string[]>>; onRun: (code: string) => Promise<CellResult>; onRestart: () => Promise<void>; onClose: () => void }

const text = (value?: string | string[]) => Array.isArray(value) ? value.join('') : value ?? ''
const newCell = (kind: 'code' | 'markdown' = 'code', source = ''): Cell => ({ id: crypto.randomUUID(), cell_type: kind, source, metadata: { language: kind === 'code' ? 'python' : 'markdown' }, ...(kind === 'code' ? { execution_count: null, outputs: [] } : {}) })
function normalize(document: Document): Document {
  return { ...document, cells: document.cells.map(cell => ({ ...cell, id: cell.id || crypto.randomUUID(), source: text(cell.source), metadata: { ...cell.metadata, language: cell.cell_type === 'markdown' ? 'markdown' : 'python' } })) }
}
function Tool({ icon: Icon, label, onClick, disabled = false }: { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="notebook-tool" aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon size={15} /></button>
}
function CellOutput({ output }: { output: Output }) {
  if (output.output_type === 'error') return <pre className="cell-error">{output.ename}: {output.evalue}{output.traceback?.length ? '\n' + output.traceback.join('\n').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '') : ''}</pre>
  if (output.output_type === 'stream') return <pre className={output.name === 'stderr' ? 'cell-stderr' : ''}>{text(output.text)}</pre>
  if (output.data?.['image/png'] || output.data?.['image/jpeg']) {
    const mime = output.data['image/png'] ? 'image/png' : 'image/jpeg'
    return <img alt="Cell output" src={`data:${mime};base64,${text(output.data[mime])}`} />
  }
  if (output.data?.['text/html']) {
    const html = text(output.data['text/html'])
    const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table.dataframe')
    const height = table ? Math.min(400, Math.max(80, table.querySelectorAll('tr').length * 30 + 24)) : 250
    return <iframe title="Cell HTML output" sandbox="" style={{ height }} srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;"><style>body{font:12px sans-serif;color:#253b35;margin:8px}table{border-collapse:collapse}td,th{padding:5px 9px;border-bottom:1px solid #dde5e2}pre{white-space:pre-wrap}</style>${html}`} />
  }
  if (output.data?.['text/markdown']) return <Markdown>{text(output.data['text/markdown'])}</Markdown>
  return <pre>{text(output.data?.['text/plain']) || JSON.stringify(output.data, null, 2)}</pre>
}

export default function Notebook({ open, snippet, ready, objects, exporting, onVisualize, workspaceErrors, workspaceDisplays, onRun, onRestart, onClose }: Props) {
  const [document, setDocument] = useState<Document | null>(null)
  const [active, setActive] = useState('')
  const [running, setRunning] = useState('')
  const [saved, setSaved] = useState('Loading')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [bindingErrors, setBindingErrors] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Set<string>>(new Set())
  const [deleted, setDeleted] = useState<{ cell: Cell; index: number } | null>(null)
  const upload = useRef<HTMLInputElement>(null)
  const stop = useRef(false)
  const executing = useRef(false)
  const latest = useRef<Document | null>(null)
  const saveQueue = useRef(Promise.resolve())
  const priorSnippet = useRef('')
  useEffect(() => { latest.current = document }, [document])

  useEffect(() => {
    let cancelled = false
    void api<Document>('/notebook').then(result => { if (!cancelled) { const loaded = normalize(result); setDocument(loaded); setActive(loaded.cells.find(cell => !cell.metadata.earth_bootstrap)?.id ?? ''); setSaved('Saved') } }).catch(failure => setError(String(failure)))
    return () => { cancelled = true }
  }, [])

  async function save(value = latest.current) {
    if (!value) return
    setSaved('Saving')
    const snapshot = { ...value, cells: value.cells.map(cell => ({ ...cell, metadata: { ...cell.metadata, id: cell.id } })) }
    const pending = saveQueue.current.catch(() => {}).then(async () => { await api('/notebook', snapshot) })
    saveQueue.current = pending
    try { await pending; if (latest.current === value) setSaved('Saved') } catch (failure) { setSaved('Not saved'); setError(String(failure)) }
  }
  useEffect(() => {
    if (!document) return
    const timer = setTimeout(() => { void save(document) }, 700)
    return () => clearTimeout(timer)
  }, [document])
  useEffect(() => {
    if (!document || !snippet || priorSnippet.current === snippet) return
    priorSnippet.current = snippet
    const cell = newCell('code', snippet)
    setDocument(previous => previous && { ...previous, cells: [...previous.cells, cell] })
    setActive(cell.id)
  }, [snippet, document])

  function update(id: string, changes: Partial<Cell>) {
    setSaved('Unsaved')
    setDocument(previous => previous && { ...previous, cells: previous.cells.map(cell => cell.id === id ? { ...cell, ...changes } : cell) })
  }
  function insert(kind: 'code' | 'markdown') {
    const cell = newCell(kind)
    setDocument(previous => {
      if (!previous) return previous
      const cells = [...previous.cells]
      const index = cells.findIndex(entry => entry.id === active)
      cells.splice(index < 0 ? cells.length : index + 1, 0, cell)
      return { ...previous, cells }
    })
    setActive(cell.id)
  }
  function move(index: number, direction: number) {
    if (!document) return
    const cells = [...document.cells]
    if (index + direction < 0 || index + direction >= cells.length || cells[index + direction].metadata.earth_bootstrap) return
    ;[cells[index], cells[index + direction]] = [cells[index + direction], cells[index]]
    setDocument({ ...document, cells })
  }
  async function run(cells: Cell[], advance = false) {
    if (executing.current || exporting) return
    executing.current = true
    stop.current = false
    setError('')
    try {
      for (const cell of cells) {
        if (stop.current) break
        if (cell.metadata.earth_bootstrap) continue
        setActive(cell.id)
        if (cell.cell_type === 'markdown') { setPreview(previous => new Set([...previous, cell.id])); continue }
        setRunning(cell.id)
        const started = performance.now()
        const result = await onRun(cell.source)
        update(cell.id, { outputs: result.outputs ?? [{ output_type: 'stream', name: 'stdout', text: result.output }], execution_count: result.execution_count, metadata: { ...cell.metadata, duration: ((performance.now() - started) / 1000).toFixed(2), result_status: result.status } })
        setBindingErrors(result.binding_errors ?? {})
        if (result.status === 'error') break
      }
      if (advance && !stop.current) {
        const list = latest.current?.cells ?? []
        const index = list.findIndex(cell => cell.id === cells.at(-1)?.id)
        if (index >= 0 && index < list.length - 1) setActive(list[index + 1].id)
        else insert('code')
      }
    } catch (failure) { setError(String(failure)) }
    finally { setRunning(''); executing.current = false }
  }
  async function interrupt() {
    stop.current = true
    try { await api('/runtime/interrupt', {}) } catch (failure) { setError(String(failure)) }
  }
  async function importNotebook(file?: File) {
    if (!file) return
    try {
      if (file.size > 20_000_000) throw new Error('Notebook exceeds 20 MB.')
      const imported = normalize(JSON.parse(await file.text()))
      if (!Array.isArray(imported.cells) || imported.cells.some(cell => !['code', 'markdown'].includes(cell.cell_type))) throw new Error('Import a code/Markdown notebook.')
      const bootstrap = document?.cells.find(cell => cell.metadata.earth_bootstrap)
      if (bootstrap && !imported.cells.some(cell => cell.metadata.earth_bootstrap)) imported.cells.unshift(bootstrap)
      await api('/notebook', imported)
      setDocument(imported); setActive(imported.cells.find(cell => !cell.metadata.earth_bootstrap)?.id ?? ''); setError('')
    } catch (failure) { setError(String(failure)) }
  }
  function download() {
    if (!document) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/x-ipynb+json' }))
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'workspace.ipynb'; anchor.click(); URL.revokeObjectURL(url)
  }
  const errors = { ...workspaceErrors, ...bindingErrors }
  return <section className={`code-panel notebook-panel ${expanded ? 'notebook-expanded' : ''}`} style={open ? undefined : { display: 'none' }} aria-label="Python notebook">
    <header className="notebook-heading"><span className="notebook-document-icon"><FileCode2 size={21} /></span><div className="notebook-title"><strong>workspace.ipynb</strong><span>Open Earth / Notebooks</span></div><span className="spacer" /><span className="notebook-runtime"><span className={`notebook-kernel ${ready ? 'ready' : ''}`} />{running ? 'Running' : ready ? 'Connected' : 'Offline'}</span><Tool icon={expanded ? Minimize2 : Maximize2} label={expanded ? 'Exit notebook focus' : 'Focus notebook'} onClick={() => setExpanded(!expanded)} /><Tool icon={X} label="Close Python editor" onClick={onClose} /></header>
    <div className="notebook-toolbar" role="toolbar" aria-label="Notebook tools">
      <Tool icon={Play} label="Run Python cell" disabled={!!running || exporting || !document} onClick={() => { const cell = document?.cells.find(entry => entry.id === active); if (cell) void run([cell]) }} />
      <button className="notebook-command" disabled={!!running || exporting || !document} onClick={() => { if (document) void run(document.cells) }}><Play size={13} />Run all</button>
      <Tool icon={Square} label="Interrupt Python" onClick={() => void interrupt()} /><span className="tool-divider" />
      <button className="notebook-command" disabled={!!running} onClick={() => insert('code')}><Plus size={13} />Code</button>
      <button className="notebook-command" disabled={!!running} onClick={() => insert('markdown')}><Plus size={13} />Markdown</button><span className="spacer" />
      <Tool icon={Save} label="Save notebook" onClick={() => void save()} />
      <details className="notebook-menu"><summary aria-label="Notebook menu" title="Notebook menu"><MoreHorizontal size={18} /></summary><div>
        <button onClick={() => upload.current?.click()} disabled={!!running}><Upload size={15} />Import notebook</button>
        <button onClick={download}><Download size={15} />Download notebook</button>
        <button disabled={!!running} onClick={() => setDocument(previous => previous && { ...previous, cells: previous.cells.map(cell => cell.cell_type === 'code' ? { ...cell, outputs: [], execution_count: null } : cell) })}><Eraser size={15} />Clear all outputs</button>
        <button disabled={!!running || exporting} onClick={() => { void onRestart().then(() => { setDocument(previous => previous && { ...previous, cells: previous.cells.map(cell => cell.cell_type === 'code' ? { ...cell, execution_count: null } : cell) }) }).catch(failure => setError(String(failure))) }}><RotateCcw size={15} />Restart Python kernel</button>
      </div></details>
      <input hidden ref={upload} type="file" accept=".ipynb" onChange={event => { void importNotebook(event.target.files?.[0]); event.target.value = '' }} />
    </div>
    <NotebookData objects={objects} disabled={!!running || exporting} onInsert={source => { const cell = newCell('code', source); setDocument(previous => previous && { ...previous, cells: [...previous.cells, cell] }); setActive(cell.id) }} onVisualize={object => { setExpanded(false); onVisualize(object) }} />
    <div className="notebook-cells">
      {error && <div className="notebook-error" role="alert">{error}</div>}
      {Object.keys(errors).length > 0 && <details className="notebook-error"><summary>{Object.keys(errors).length} workspace binding issues</summary>{Object.entries(errors).map(([key, value]) => <p key={key}>{key}: {value}</p>)}</details>}
      {!document && <div className="editor-loading"><LoaderCircle className="spin" size={18} />Loading notebook</div>}
      {document?.cells.map((cell, index) => cell.metadata.earth_bootstrap ? <details className="notebook-bootstrap" key={cell.id}><summary><Check size={13} />Workspace imports <span>Python</span></summary><pre>{cell.source}</pre></details> : <article key={cell.id} className={`notebook-cell ${active === cell.id ? 'active' : ''} ${running === cell.id ? 'running' : ''}`} onFocus={() => setActive(cell.id)} onClick={() => setActive(cell.id)} onKeyDown={event => { if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) { event.preventDefault(); void run([cell], event.shiftKey) } }}>
        <div className="cell-heading"><Tool icon={running === cell.id ? LoaderCircle : Play} label={`Run cell ${index + 1}`} disabled={!!running || exporting} onClick={() => void run([cell])} /><span className="cell-number">{`[${cell.execution_count ?? ' '}]`}</span><select aria-label={`Cell ${index + 1} type`} value={cell.cell_type} disabled={!!running} onChange={event => { const kind = event.target.value as 'code' | 'markdown'; const replacement = newCell(kind, cell.source); setDocument(previous => previous && { ...previous, cells: previous.cells.map(entry => entry.id === cell.id ? { ...replacement, id: cell.id } : entry) }) }}><option value="code">Python</option><option value="markdown">Markdown</option></select><span className="spacer" />
          {!!cell.metadata.duration && <span className={`cell-duration ${cell.metadata.result_status === 'error' ? 'failed' : ''}`}>{String(cell.metadata.duration)}s</span>}
          <div className="cell-actions"><Tool icon={cell.metadata.collapsed ? ChevronRight : ChevronDown} label={`${cell.metadata.collapsed ? 'Expand' : 'Collapse'} cell ${index + 1}`} onClick={() => update(cell.id, { metadata: { ...cell.metadata, collapsed: !cell.metadata.collapsed } })} /><Tool icon={ArrowUp} label={`Move cell ${index + 1} up`} disabled={!!running || index <= 1} onClick={() => move(index, -1)} /><Tool icon={ArrowDown} label={`Move cell ${index + 1} down`} disabled={!!running || index === document.cells.length - 1} onClick={() => move(index, 1)} /><Tool icon={Copy} label={`Duplicate cell ${index + 1}`} disabled={!!running} onClick={() => { const copy = newCell(cell.cell_type, cell.source); const cells = [...document.cells]; cells.splice(index + 1, 0, copy); setDocument({ ...document, cells }); setActive(copy.id) }} /><Tool icon={Trash2} label={`Delete cell ${index + 1}`} disabled={!!running} onClick={() => { setDeleted({ cell, index }); setDocument({ ...document, cells: document.cells.filter(entry => entry.id !== cell.id) }) }} /></div>
        </div>
        {!cell.metadata.collapsed && (cell.cell_type === 'markdown' && preview.has(cell.id) ? <div className="markdown-cell" tabIndex={0} onDoubleClick={() => setPreview(previous => { const next = new Set(previous); next.delete(cell.id); return next })}><Markdown>{cell.source}</Markdown><button className="text-button" onClick={() => setPreview(previous => { const next = new Set(previous); next.delete(cell.id); return next })}>Edit</button></div> : <Suspense fallback={<pre>{cell.source}</pre>}><Editor value={cell.source} minHeight="80px" maxHeight="560px" extensions={[EditorView.lineWrapping, ...(cell.cell_type === 'code' ? [python()] : [])]} onChange={value => update(cell.id, { source: value })} editable={!running} basicSetup={{ foldGutter: true, highlightActiveLine: true, lineNumbers: true }} /></Suspense>)}
        {!!cell.outputs?.length && <div className="output cell-outputs">{(workspaceDisplays[cell.source.trim()] ? [{ output_type: 'display_data', data: workspaceDisplays[cell.source.trim()] }] : cell.outputs).map((output, position) => <CellOutput key={position} output={output} />)}<Tool icon={Eraser} label={`Clear cell ${index + 1} output`} disabled={!!running} onClick={() => update(cell.id, { outputs: [], execution_count: null })} /></div>}
      </article>)}
      {deleted && <div className="notebook-undo">Cell deleted<button onClick={() => { setDocument(previous => { if (!previous) return previous; const cells = [...previous.cells]; cells.splice(Math.min(deleted.index, cells.length), 0, deleted.cell); return { ...previous, cells } }); setDeleted(null) }}>Undo</button></div>}
      <button className="notebook-add" disabled={!!running} onClick={() => insert('code')}><Plus size={15} />Code cell</button>
    </div>
    <footer className="notebook-footer"><span>{running ? 'Executing' : ready ? 'Python ready' : 'Python disconnected'}</span><span>{document?.cells.length ?? 0} cells</span><span className="spacer" /><span role="status">{saved}</span></footer>
  </section>
}