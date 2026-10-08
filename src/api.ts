export interface ClassStyle { value: number; label: string; color: string; visible: boolean }
export interface Symbology {
  mode: 'rgb' | 'continuous' | 'classes'
  palette: 'gray' | 'viridis' | 'terrain' | 'magma' | 'blues'
  classes: ClassStyle[]
  source: string
  minimum?: number | null
  maximum?: number | null
  bands?: string[] | null
}

export interface Layer {
  id: string
  name: string
  kind: 'vector' | 'raster' | 'stac'
  crs: string
  count: number
  bbox: number[]
  fields?: string[]
  width?: number
  height?: number
  dtype?: string
  visible?: boolean
  focus_on_load?: boolean
  opacity?: number
  color?: string
  color_property?: string
  bands?: string
  stretch?: boolean
  tiles?: string
  attribution?: string
  band_names?: string[]
  assets?: Record<string, { href: string; title?: string; 'raster:bands'?: unknown[]; 'eo:bands'?: unknown[] }>
  rescale?: string
  collection?: string
  item?: string
  symbology?: Symbology
  ranges?: number[][]
  editable?: boolean
  revision?: string
  notebook_key?: string
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    method: body === undefined ? 'GET' : 'POST',
    headers: body instanceof FormData ? { 'X-Open-Earth': '1' } : { 'Content-Type': 'application/json', 'X-Open-Earth': '1' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({ detail: `Request failed (${response.status})` }))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail))
  return data as T
}

export const palette = ['#44d9b5', '#f2bb60', '#75baff', '#ed8ca6', '#bacd70']