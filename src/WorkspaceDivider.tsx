import { useEffect, useRef, useState } from 'react'
import { GripVertical } from 'lucide-react'

function savedSize(stacked: boolean) {
  try { const value = Number(localStorage.getItem(stacked ? 'open-earth-notebook-height' : 'open-earth-notebook-width')); if (value >= 20 && value <= 80) return value } catch {}
  return stacked ? 58 : 48
}

export default function WorkspaceDivider() {
  const handle = useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = useState(() => matchMedia('(max-width: 960px)').matches)
  const [size, setSize] = useState(() => savedSize(stacked))
  const dragging = useRef(false)
  const currentSize = useRef(size)

  useEffect(() => {
    const media = matchMedia('(max-width: 960px)')
    const changed = () => { setStacked(media.matches); const value = savedSize(media.matches); currentSize.current = value; setSize(value) }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    handle.current?.parentElement?.style.setProperty(stacked ? '--notebook-height' : '--notebook-width', `${currentSize.current}%`)
  }, [stacked])

  function resize(value: number) {
    const parent = handle.current?.parentElement
    if (!parent) return
    const bounds = parent.getBoundingClientRect()
    const minimum = stacked ? 25 : Math.min(45, 280 / bounds.width * 100)
    const maximum = stacked ? 78 : Math.min(80, (bounds.width - 180) / bounds.width * 100)
    const next = Math.max(minimum, Math.min(maximum, value))
    currentSize.current = next
    setSize(next)
    parent.style.setProperty(stacked ? '--notebook-height' : '--notebook-width', `${next}%`)
  }
  function finish() {
    dragging.current = false
    handle.current?.parentElement?.classList.remove('resizing-workspace')
    try { localStorage.setItem(stacked ? 'open-earth-notebook-height' : 'open-earth-notebook-width', String(currentSize.current)) } catch {}
  }
  return <div ref={handle} className="workspace-divider" role="separator" aria-label="Resize map and notebook" aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(size)} tabIndex={0} title="Drag to resize map and notebook" onDoubleClick={() => { resize(stacked ? 58 : 48); finish() }} onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.parentElement?.classList.add('resizing-workspace'); event.preventDefault() }} onPointerMove={event => { if (!dragging.current) return; const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); resize(stacked ? (bounds.bottom - event.clientY - 27) / bounds.height * 100 : (bounds.right - event.clientX) / bounds.width * 100) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); finish() }} onPointerCancel={finish} onKeyDown={event => { if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); resize(currentSize.current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 3 : -3)); finish() } }}><GripVertical size={14} /></div>
}