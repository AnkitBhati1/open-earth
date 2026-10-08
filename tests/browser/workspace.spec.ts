import { expect, test } from '@playwright/test'
import { PNG } from 'pngjs'

test.beforeEach(async ({ request, page }) => {
  await request.get('/api/session')
  const notebook = await (await request.get('/api/notebook')).json()
  notebook.cells = [notebook.cells.find((cell: { metadata: { earth_bootstrap?: boolean } }) => cell.metadata.earth_bootstrap), { id: 'analysis', cell_type: 'code', metadata: { language: 'python', id: 'analysis' }, source: 'ds', outputs: [], execution_count: null }]
  await request.post('/api/notebook', { data: notebook, headers: { 'X-Open-Earth': '1' } })
  const previous = await (await request.get('/api/layers')).json()
  await page.addInitScript(ids => { if (!sessionStorage.getItem('isolated-test')) { localStorage.setItem('open-earth-removed', JSON.stringify(ids)); sessionStorage.setItem('isolated-test', '1') } }, previous.map((layer: { id: string }) => layer.id))
})

test('textured globe responds to zoom and stays within mobile viewport', async ({ page }, testInfo) => {
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.basemap-summary')).toContainText('OpenStreetMap')
  const toolbarBox = (await page.getByRole('toolbar', { name: 'Geospatial tools' }).boundingBox())!
  const mapBox = (await page.locator('canvas').boundingBox())!
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(mapBox.y + 1)
  await expect(page.locator('.map-area')).toHaveCSS('background-color', 'rgb(233, 241, 243)')
  expect(await page.locator('.globe').evaluate(element => getComputedStyle(element).backgroundImage)).not.toContain('url(')
  expect(await page.locator('.globe').evaluate(element => getComputedStyle(element, '::before').content)).toBe('none')
  const backdrop = async () => {
    const bounds = (await page.locator('canvas').boundingBox())!
    const { data } = PNG.sync.read(await page.screenshot({ clip: { x: bounds.x + 4, y: bounds.y + 4, width: 16, height: 16 } }))
    return Array.from(data).filter((_, index) => index % 4 !== 3).reduce((sum, value) => sum + value, 0) / (16 * 16 * 3)
  }
  await expect.poll(backdrop).toBeGreaterThan(210)
  const pixels = async () => {
    const { data } = PNG.sync.read(await page.locator('canvas').screenshot())
    let colored = 0, hash = 0
    for (let offset = 0; offset < data.length; offset += 4) {
      const channels = [data[offset], data[offset + 1], data[offset + 2]]
      if (Math.max(...channels) - Math.min(...channels) > 25 && channels.reduce((sum, value) => sum + value, 0) > 150) colored++
      hash = (hash + data[offset] * (offset + 1)) % 1000000007
    }
    return { colored, hash }
  }
  await expect.poll(async () => (await pixels()).colored, { timeout: 20000 }).toBeGreaterThan(20000)
  await page.screenshot({ path: testInfo.outputPath('desktop-earth.png') })
  const before = await pixels()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(async () => (await pixels()).hash).not.toBe(before.hash)
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Draw polygon', exact: true }).click()
  await page.getByLabel('Continuous', { exact: true }).uncheck()
  const canvas = page.locator('canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40)
  await expect(canvas).toHaveAttribute('data-draft-geometry', /\[\[/)
  await expect.poll(async () => {
    const { data } = PNG.sync.read(await page.screenshot({ clip: { x: box.x + box.width / 2 - 10, y: box.y + box.height / 2 - 10, width: 85, height: 65 } }))
    let lime = 0
    for (let offset = 0; offset < data.length; offset += 4) {
      if (Math.abs(data[offset] - 213) < 8 && Math.abs(data[offset + 1] - 239) < 8 && Math.abs(data[offset + 2] - 120) < 8) lime++
    }
    return lime
  }).toBeGreaterThan(60)
  await page.screenshot({ path: testInfo.outputPath('drawing-hover.png') })
  await page.mouse.click(box.x + box.width / 2 + 100, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2 + 100, box.y + box.height / 2 + 100)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(canvas).toHaveAttribute('data-draft-complete', 'true')
  const geometry = await canvas.getAttribute('data-draft-geometry')
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 130, box.y + box.height / 2 + 130, { steps: 8 })
  await page.mouse.up()
  await expect(canvas).not.toHaveAttribute('data-draft-geometry', geometry!)
  const editedGeometry = await canvas.getAttribute('data-draft-geometry')
  await page.getByRole('button', { name: 'Undo vertex', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-draft-geometry', geometry!)
  await page.getByRole('button', { name: 'Redo vertex', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-draft-geometry', editedGeometry!)
  await page.screenshot({ path: testInfo.outputPath('polygon-edited.png') })
  const cameraBeforeSave = await canvas.getAttribute('data-camera')
  const savedPolygon = page.waitForResponse(response => response.url().endsWith('/api/annotations') && response.ok())
  await page.getByRole('button', { name: 'Finish polygon', exact: true }).click()
  await expect(page.locator('.selected-name')).toContainText('Annotations')
  await expect(canvas).toHaveAttribute('data-camera', cameraBeforeSave!)
  const name = (await page.locator('.selected-name').textContent())!
  const initialLayers = await (await page.request.get('/api/layers')).json()
  const drawingLayer = await (await savedPolygon).json()
  await page.reload()
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Draw polygon', exact: true }).click()
  await page.getByLabel('Continuous', { exact: true }).uncheck()
  await expect(page.getByLabel('Polygon layer')).toHaveValue(drawingLayer.id)
  const secondBox = (await canvas.boundingBox())!
  const centerX = secondBox.x + secondBox.width / 2
  const centerY = secondBox.y + secondBox.height / 2
  await page.mouse.click(centerX, centerY)
  await page.mouse.click(centerX + 80, centerY)
  await page.mouse.click(centerX + 80, centerY + 80)
  await page.mouse.click(centerX, centerY)
  await expect(canvas).toHaveAttribute('data-draft-complete', 'true')
  const updatedVector = page.waitForResponse(response => response.url().endsWith(`/api/layers/${drawingLayer.id}/geojson`) && response.ok())
  await page.getByRole('button', { name: 'Done drawing', exact: true }).click()
  await expect(page.locator('.drawing-bar')).toHaveCount(0)
  await expect(page.locator('.selected-name')).toHaveText(name)
  expect((await (await updatedVector).json()).features).toHaveLength(drawingLayer.count + 1)
  const afterDrawing = await (await page.request.get('/api/layers')).json()
  expect(afterDrawing).toHaveLength(initialLayers.length)
  expect(afterDrawing.find((layer: { id: string }) => layer.id === drawingLayer.id).count).toBe(drawingLayer.count + 1)
  const exportPolygons = await page.request.get(`/api/layers/${drawingLayer.id}/download?format=geojson`)
  expect((await exportPolygons.json()).features).toHaveLength(drawingLayer.count + 1)
  await page.screenshot({ path: testInfo.outputPath('single-polygon-layer.png') })
  const removedRow = page.locator('.layer-row').filter({ has: page.getByRole('button', { name: `Remove ${name}`, exact: true }) })
  await removedRow.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
  await expect(removedRow).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(removedRow).toHaveCount(1)
  await removedRow.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
  await page.reload()
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await expect(removedRow).toHaveCount(0)
  const stored = await page.request.get('/api/layers')
  expect((await stored.json()).some((layer: { name: string }) => layer.name === name)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Add data', exact: true })).toBeVisible()
  await expect.poll(async () => (await pixels()).colored, { timeout: 20000 }).toBeGreaterThan(20000)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect.poll(backdrop).toBeGreaterThan(210)
  await page.screenshot({ path: testInfo.outputPath('mobile-earth.png') })
  await page.getByRole('button', { name: 'Geoprocessing', exact: true }).click()
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Buffer', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('mobile-tools.png') })
  expect(failures).toEqual([])
})

test('continuous annotation queues saves without moving the map and map layers work without the sidebar', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse panel' }).click()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Draw polygon', exact: true }).click()
  await page.getByLabel('Continuous', { exact: true }).check()
  const canvas = page.locator('canvas')
  await expect(canvas).toHaveAttribute('data-camera', /\[/)
  const camera = await canvas.getAttribute('data-camera')
  const box = (await canvas.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2)
  await expect(page.getByRole('button', { name: 'Done drawing', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Discard current draft', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Done drawing', exact: true })).toBeEnabled()
  const draw = async (offset: number) => {
    const startX = box.x + box.width / 2 + offset
    const startY = box.y + box.height / 2
    await page.mouse.click(startX, startY)
    await page.mouse.click(startX + 35, startY)
    await page.mouse.click(startX + 35, startY + 40)
    await page.mouse.click(startX, startY)
  }
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  await page.route('**/api/annotations', async route => { requests++; if (requests === 1) await blocked; await route.continue() })
  await draw(-120)
  await draw(-30)
  await draw(60)
  await expect(page.locator('.drawing-status')).toContainText('3 saving')
  expect(requests).toBe(1)
  release()
  await expect(page.locator('.drawing-status')).toContainText('3 saved')
  await expect(page.getByRole('button', { name: 'Finish polygon', exact: true })).toHaveCount(0)
  expect(requests).toBe(3)
  const identifier = await page.getByLabel('Polygon layer').inputValue()
  const features = (await (await page.request.get(`/api/layers/${identifier}/geojson`)).json()).features
  expect(features.map((feature: { properties: { name: string } }) => feature.properties.name)).toEqual(['Polygon 1', 'Polygon 2', 'Polygon 3'])
  expect(new Set(features.map((feature: { properties: { annotation_id: string } }) => feature.properties.annotation_id)).size).toBe(3)
  await expect(canvas).toHaveAttribute('data-camera', camera!)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('continuous-desktop.png') })
  await page.unroute('**/api/annotations')
  let failSave!: () => void
  const waitingFailure = new Promise<void>(resolve => { failSave = resolve })
  await page.route('**/api/annotations', async route => { await waitingFailure; await route.fulfill({ status: 503, json: { detail: 'Test save failure' } }) }, { times: 1 })
  await draw(150)
  await expect(page.locator('.drawing-status')).toContainText('1 saving')
  await page.getByRole('button', { name: 'Done drawing', exact: true }).click()
  failSave()
  await expect(page.getByRole('alert')).toContainText('draft remains')
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Draw polygon', exact: true }).click()
  await page.getByRole('button', { name: 'Finish polygon', exact: true }).click()
  await expect(page.locator('.drawing-status')).toContainText('4 saved')
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.drawing-bar')).toHaveCount(0)
  await page.getByLabel('Map layers', { exact: true }).click()
  const controls = page.getByRole('region', { name: 'Map layer controls' })
  await expect(controls).toContainText('4 features')
  const polygonPixels = async () => {
    const { data } = PNG.sync.read(await page.screenshot({ clip: { x: box.x + box.width / 2 - 125, y: box.y + box.height / 2 - 5, width: 325, height: 50 } }))
    let count = 0
    for (let offset = 0; offset < data.length; offset += 4) if (Math.abs(data[offset] - 68) < 5 && Math.abs(data[offset + 1] - 217) < 5 && Math.abs(data[offset + 2] - 181) < 5) count++
    return count
  }
  await expect.poll(polygonPixels).toBeGreaterThan(150)
  await controls.getByRole('button', { name: /^Hide Annotations/ }).click()
  await expect(page.locator('.map-layers summary')).toHaveText('0/1')
  await expect.poll(polygonPixels).toBeLessThan(5)
  await controls.getByRole('button', { name: /^Show Annotations/ }).click()
  await expect(page.locator('.map-layers summary')).toHaveText('1/1')
  await expect.poll(polygonPixels).toBeGreaterThan(150)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(canvas).toHaveAttribute('data-camera', camera!)
  await page.screenshot({ path: testInfo.outputPath('map-layers-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(controls).not.toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Map layers', { exact: true }).click()
  await expect(controls).toBeVisible()
  const search = (await page.getByRole('textbox', { name: 'Search places or coordinates' }).boundingBox())!
  const actions = (await page.locator('.map-top-actions').boundingBox())!
  expect(search.x + search.width).toBeLessThan(actions.x)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('map-layers-mobile.png') })
  await page.keyboard.press('Escape')
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Draw polygon', exact: true }).click()
  const drawBar = (await page.locator('.drawing-bar').boundingBox())!
  expect(drawBar.x).toBeGreaterThanOrEqual(0)
  expect(drawBar.x + drawBar.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('continuous-mobile.png') })
  expect(errors).toEqual([])
})

test('continuous annotation appends to a thousand-feature layer without changing the camera', async ({ page }) => {
  await page.request.get('/api/session')
  const features = Array.from({ length: 1000 }, (_, index) => {
    const longitude = 64 + (index % 40) * .025
    const latitude = 19 + Math.floor(index / 40) * .025
    return { type: 'Feature', properties: { annotation_id: `seed-${index}`, name: `Polygon ${index + 1}`, source: 'user drawn' }, geometry: { type: 'Polygon', coordinates: [[[longitude, latitude], [longitude + .015, latitude], [longitude + .015, latitude + .015], [longitude, latitude]]] } }
  })
  const response = await page.request.post('/api/annotations', { headers: { 'X-Open-Earth': '1' }, data: { name: 'Annotation workload', editable: true, geojson: { type: 'FeatureCollection', features } } })
  expect(response.ok(), await response.text()).toBe(true)
  const layer = await response.json()
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse panel' }).click()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Draw polygon', exact: true }).click()
  await expect(page.getByLabel('Polygon layer')).toHaveValue(layer.id)
  await expect(page.locator('.drawing-status')).toContainText('1000 saved')
  const canvas = page.locator('canvas')
  const camera = await canvas.getAttribute('data-camera')
  const box = (await canvas.boundingBox())!
  for (let index = 0; index < 5; index++) {
    const startX = box.x + box.width / 2 - 180 + index * 80
    const startY = box.y + box.height / 2
    await page.mouse.click(startX, startY)
    await page.mouse.click(startX + 30, startY)
    await page.mouse.click(startX + 30, startY + 30)
    await page.mouse.click(startX, startY)
  }
  await expect(page.locator('.drawing-status')).toContainText('1005 saved')
  await expect(canvas).toHaveAttribute('data-camera', camera!)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  const exported = await (await page.request.get(`/api/layers/${layer.id}/download?format=geojson`)).json()
  expect(exported.features).toHaveLength(1005)
  expect(exported.features.slice(-5).map((feature: { properties: { name: string } }) => feature.properties.name)).toEqual(['Polygon 1001', 'Polygon 1002', 'Polygon 1003', 'Polygon 1004', 'Polygon 1005'])
})

test('direct map inspection shows polygon attributes and every raster band in a compact panel', async ({ page }, testInfo) => {
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.request.get('/api/session')
  const headers = { 'X-Open-Earth': '1' }
  const session = await (await page.request.get('/api/session')).json()
  const previousIds = new Set((await (await page.request.get('/api/layers')).json()).map((layer: { id: string }) => layer.id))
  await page.request.post('/api/runtime/start', { headers, data: { executable: session.executable } })
  const execution = await page.request.post('/api/runtime/execute', { headers, data: { code: `from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin
from server.sdk import earth
path = Path('.earth-e2e/inspect-grid.tif').resolve()
with rasterio.open(path, 'w', driver='GTiff', width=64, height=64, count=4, dtype='float32', crs='EPSG:4326', transform=from_origin(64, 21, .03125, .03125), nodata=-9999) as target:
    target.write(np.stack([np.full((64,64), value, dtype='float32') for value in [0, 1234, -9999, 7.25]]))
    target.descriptions = ('Zero band', 'NIR', 'Masked band', 'Thermal')
earth.add(path, 'Inspector raster')` } })
  expect((await execution.json()).status).toBe('ok')
  const stored = await (await page.request.get('/api/layers')).json()
  const raster = stored.find((layer: { id: string; name: string }) => layer.name === 'Inspector raster' && !previousIds.has(layer.id))
  const style = await page.request.post(`/api/layers/${raster.id}/symbology`, { headers, data: { mode: 'continuous', palette: 'viridis', minimum: -10, maximum: 50, bands: ['4'], classes: [], source: 'Test range' } })
  expect(style.ok()).toBe(true)
  await page.request.post('/api/annotations', { headers, data: { name: 'Inspector polygon', geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'River parcel', category: 'Survey area', note: '<script>not executable</script>', ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`survey_${index}`, `Attribute ${index}`])) }, geometry: { type: 'Polygon', coordinates: [[[64.7, 19.7], [65.3, 19.7], [65.3, 20.3], [64.7, 20.3], [64.7, 19.7]]] } }] } } })
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse panel' }).click()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  const canvas = page.locator('canvas')
  await expect(canvas).toHaveAttribute('data-camera', /\[/)
  const box = (await canvas.boundingBox())!
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const camera = await canvas.getAttribute('data-camera')
  const inspector = page.getByRole('region', { name: 'Map inspection' })
  await expect(async () => {
    await page.mouse.click(center.x, center.y)
    await expect(inspector).toContainText('River parcel')
  }).toPass()
  await page.getByLabel('Inspect result').selectOption({ label: 'Inspector polygon / River parcel' })
  await expect(inspector).toContainText('Survey area')
  await expect(inspector).toContainText('<script>not executable</script>')
  expect((await inspector.boundingBox())!.height).toBeLessThan(370)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(canvas).toHaveAttribute('data-camera', camera!)
  await page.screenshot({ path: testInfo.outputPath('inspect-polygon-desktop.png') })
  await page.getByLabel('Inspect result').selectOption({ label: 'Inspector raster' })
  await expect(inspector).toContainText('4 bands')
  for (const [name, value] of [['Zero band', '0'], ['NIR', '1234'], ['Masked band', 'NoData'], ['Thermal', '7.25']]) {
    const row = inspector.locator('.inspect-values>div').filter({ has: page.getByText(name, { exact: true }) })
    await expect(row.locator('dd')).toHaveText(value)
  }
  await expect(inspector.getByLabel('Continuous value scale')).toContainText('-10')
  await expect(inspector.getByLabel('Continuous value scale')).toContainText('50')
  await page.screenshot({ path: testInfo.outputPath('inspect-raster-desktop.png') })
  await page.getByRole('button', { name: 'Collapse inspection' }).click()
  expect((await inspector.boundingBox())!.height).toBeLessThan(50)
  await page.getByRole('button', { name: 'Expand inspection' }).click()
  await expect(inspector).toContainText('1234')
  await page.keyboard.press('Escape')
  await expect(inspector).toHaveCount(0)
  await expect(page.locator('.continuous-legend')).toBeVisible()
  await expect(page.locator('.continuous-legend')).toContainText('-10')
  let releaseOld!: () => void
  const oldRequest = new Promise<void>(resolve => { releaseOld = resolve })
  let requests = 0
  let oldFinished = false
  await page.route(`**/api/layers/${raster.id}/inspect`, async route => {
    const number = ++requests
    if (number === 1) await oldRequest
    try { await route.fulfill({ json: { bands: [{ name: 'Freshness', value: number === 1 ? 111 : 222, status: 'value' }] } }) } catch { /* The older fetch is intentionally cancelled. */ }
    if (number === 1) oldFinished = true
  })
  await page.mouse.click(center.x, center.y)
  await page.getByLabel('Inspect result').selectOption({ label: 'Inspector raster' })
  await expect(inspector).toContainText('Reading pixel')
  await expect.poll(() => requests).toBe(1)
  await page.getByRole('button', { name: 'Close inspection' }).click()
  await page.mouse.click(center.x + 1, center.y)
  await page.getByLabel('Inspect result').selectOption({ label: 'Inspector raster' })
  await expect(inspector).toContainText('222')
  releaseOld()
  await expect.poll(() => oldFinished).toBe(true)
  await expect(inspector).not.toContainText('111')
  await page.unroute(`**/api/layers/${raster.id}/inspect`)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(async () => {
    const mobileBox = (await canvas.boundingBox())!
    await page.mouse.click(mobileBox.x + mobileBox.width / 2, mobileBox.y + mobileBox.height / 2)
    await expect(inspector).toContainText('River parcel')
  }).toPass()
  await page.getByLabel('Inspect result').selectOption({ label: 'Inspector polygon / River parcel' })
  await expect(inspector).toContainText('Survey area')
  await page.getByLabel('Inspect result').selectOption({ label: 'Inspector raster' })
  await expect(inspector).toContainText('1234')
  const panelBox = (await inspector.boundingBox())!
  expect(panelBox.x).toBeGreaterThanOrEqual(0)
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390)
  expect(panelBox.height).toBeLessThan(300)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('inspect-raster-mobile.png') })
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(inspector).toHaveCount(0)
  expect(failures).toEqual([])
})

test('notebook cells isolate edits and drag independent copies to the map', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  const divider = page.getByRole('separator', { name: 'Resize map and notebook' })
  const originalWidth = (await page.locator('.notebook-panel').boundingBox())!.width
  const split = (await divider.boundingBox())!
  await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2)
  await page.mouse.down()
  await page.mouse.move(split.x - 90, split.y + split.height / 2, { steps: 5 })
  await page.mouse.up()
  expect((await page.locator('.notebook-panel').boundingBox())!.width).toBeGreaterThan(originalWidth + 70)
  const resizedWidth = (await page.locator('.notebook-panel').boundingBox())!.width
  const cells = page.locator('.notebook-cell')
  const first = cells.first()
  await first.locator('.cm-content').fill(`import rasterio
from rasterio.transform import from_origin
from pathlib import Path
path = Path('.earth-e2e/notebook-raster.tif').resolve()
with rasterio.open(path, 'w', driver='GTiff', width=64, height=64, count=1, dtype='uint8', crs=4326, transform=from_origin(85.2, 27.85, .005, .005), nodata=0) as target:
    target.write(np.tile(np.repeat(np.array([1, 7], dtype='uint8'), 32), (64, 1)), 1)
layer = earth.add(path, 'Notebook raster')
print('published')`)
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(first.locator('.cell-outputs')).toContainText('published', { timeout: 25000 })
  await page.getByRole('button', { name: 'Close Python editor', exact: true }).click()
  await page.getByRole('button', { name: 'Notebook raster 1 bands · EPSG:4326', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom to layer', exact: true }).click()
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  const second = cells.nth(1)
  const originalLayers = await (await page.request.get('/api/layers')).json()
  const original = originalLayers.find((entry: { name: string }) => entry.name === 'Notebook raster')
  await second.locator('.cm-content').fill(`key = next(name for name in ds.children if ds[name].attrs['layer_id'] == layer['id'])
assert isinstance(ds, xr.DataTree)
assert ds[key]['data'].chunks is not None
assert isinstance(dfs, dict) and len(view['bbox']) == 4
assert gpod.__name__ == 'geopandas'
ds[key]['data'] = ds[key]['data'] * 0 + 7
display(pd.DataFrame({'layer': [layer_names[key]], 'lazy': [True]}))
print('map updated')`)
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(second.locator('.cell-outputs')).toContainText('map updated', { timeout: 20000 })
  await expect(second.locator('iframe')).toHaveAttribute('sandbox', '')
  expect((await second.locator('iframe').boundingBox())!.height).toBeLessThan(150)
  const unchanged = await (await page.request.get('/api/layers')).json()
  expect(unchanged.find((entry: { id: string }) => entry.id === original.id)).toEqual(original)
  expect(unchanged).toHaveLength(originalLayers.length)
  const dataset = page.locator('.notebook-data-row').filter({ hasText: 'Notebook raster' }).first()
  await expect(dataset).toBeVisible()
  const copied = page.waitForResponse(response => response.url().endsWith('/api/notebook/visualize') && response.request().method() === 'POST')
  await dataset.dragTo(page.locator('.map-area'), { targetPosition: { x: 100, y: 220 } })
  expect((await copied).ok()).toBe(true)
  const afterCopy = await (await page.request.get('/api/layers')).json()
  expect(afterCopy).toHaveLength(originalLayers.length + 1)
  expect(afterCopy.find((entry: { id: string }) => entry.id === original.id)).toEqual(original)
  await expect.poll(async () => {
    const { data } = PNG.sync.read(await page.locator('canvas').screenshot())
    let colored = 0
    for (let offset = 0; offset < data.length; offset += 4) if (data[offset] === 252 && data[offset + 1] === 141 && data[offset + 2] === 98) colored++
    return colored
  }, { timeout: 20000 }).toBeGreaterThan(1000)
  await page.getByRole('button', { name: 'Markdown', exact: true }).click()
  await cells.nth(2).locator('.cm-content').fill('## Land-cover analysis\n\nLazy layers, computed previews.')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(cells.nth(2).getByRole('heading', { name: 'Land-cover analysis' })).toBeVisible()
  await page.getByRole('button', { name: 'Save notebook', exact: true }).click()
  await expect(page.locator('.notebook-footer')).toContainText('Saved')
  await page.screenshot({ path: testInfo.outputPath('notebook-desktop.png') })
  await page.getByRole('button', { name: 'Focus notebook', exact: true }).click()
  await expect(page.locator('.notebook-panel')).toHaveClass(/notebook-expanded/)
  await page.screenshot({ path: testInfo.outputPath('notebook-focus.png') })
  await page.getByRole('button', { name: 'Exit notebook focus', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByLabel('Notebook menu', { exact: true }).click()
  await page.getByRole('button', { name: 'Download notebook', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('workspace.ipynb')
  await page.reload()
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  await expect(cells).toHaveCount(3)
  expect(Math.abs((await page.locator('.notebook-panel').boundingBox())!.width - resizedWidth)).toBeLessThan(3)
  await expect(second.locator('.cell-outputs')).toContainText('map updated')
  await page.getByRole('button', { name: 'Code', exact: true }).click()
  const resumed = cells.nth(1)
  await resumed.locator('.cm-content').fill('assert ds[key].attrs["layer_id"] == layer["id"]\nprint("kernel survived reload")')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(resumed.locator('.cell-outputs')).toContainText('kernel survived reload')
  await resumed.locator('.cm-content').fill('view')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(resumed.locator('.cell-outputs')).toContainText('bbox')
  async function bindings() {
    const response = await page.request.post('/api/runtime/execute', { headers: { 'X-Open-Earth': '1' }, data: { code: "print(__import__('json').dumps({'view': view, 'rasters': list(ds.children), 'vectors': list(dfs), 'sizes': {name: dict(ds[name].sizes) for name in ds.children}}))" } })
    if (!response.ok()) return null
    const result = await response.json()
    return result.status === 'ok' ? JSON.parse(result.output) : null
  }
  let beforePan = await bindings()
  await expect.poll(async () => { beforePan = await bindings(); return beforePan }).not.toBeNull()
  let syncAttempts = 0
  let requestedBounds: number[] = []
  await page.route('**/api/runtime/sync', async route => {
    syncAttempts++
    requestedBounds = route.request().postDataJSON().view.bbox
    if (syncAttempts === 1) await route.fulfill({ status: 409, json: { detail: 'A Python cell is running; workspace sync will resume afterward.' } })
    else await route.continue()
  })
  const canvas = (await page.locator('canvas').boundingBox())!
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvas.x + canvas.width / 2 + 65, canvas.y + canvas.height / 2 + 30, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => syncAttempts).toBeGreaterThan(1)
  await expect.poll(async () => (await bindings())?.view.bbox).toEqual(requestedBounds)
  expect(requestedBounds).not.toEqual(beforePan.view.bbox)
  await expect(resumed.locator('.cell-outputs')).toContainText(String(requestedBounds[0]))
  await page.locator('input[type=file][multiple]').setInputFiles('public/samples/kathmandu.geojson')
  await expect.poll(async () => (await bindings())?.vectors.some((name: string) => name.includes('kathmandu'))).toBe(true)
  await page.getByRole('button', { name: 'Remove kathmandu', exact: true }).click()
  await expect.poll(async () => (await bindings())?.vectors).toEqual([])
  await page.unroute('**/api/runtime/sync')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(divider).toHaveAttribute('aria-orientation', 'horizontal')
  const originalHeight = (await page.locator('.notebook-panel').boundingBox())!.height
  const mobileSplit = (await divider.boundingBox())!
  await page.mouse.move(mobileSplit.x + mobileSplit.width / 2, mobileSplit.y + 4)
  await page.mouse.down()
  await page.mouse.move(mobileSplit.x + mobileSplit.width / 2, mobileSplit.y - 45, { steps: 5 })
  await page.mouse.up()
  expect((await page.locator('.notebook-panel').boundingBox())!.height).toBeGreaterThan(originalHeight + 25)
  await expect(page.getByRole('button', { name: 'Run all', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('notebook-mobile.png') })
})

test('notebook import run-all errors and interruption', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  await expect(page.locator('.notebook-footer')).toContainText('Saved')
  const imported = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { id: 'first', cell_type: 'code', metadata: { id: 'first', language: 'python' }, source: 'shared_number = 41\nprint("first cell")', execution_count: null, outputs: [] },
    { id: 'second', cell_type: 'code', metadata: { id: 'second', language: 'python' }, source: 'print(shared_number + 1)', execution_count: null, outputs: [] },
  ] }
  await page.locator('input[accept=".ipynb"]').setInputFiles({ name: 'analysis.ipynb', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) })
  const cells = page.locator('.notebook-cell')
  await expect(cells).toHaveCount(2)
  await page.getByRole('button', { name: 'Run all', exact: true }).click()
  await expect(cells.nth(1).locator('.cell-outputs')).toContainText('42', { timeout: 20000 })
  await expect(page.getByRole('button', { name: 'Run all', exact: true })).toBeEnabled()
  await cells.nth(1).locator('.cm-content').fill('1 / 0')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(cells.nth(1).locator('.cell-error')).toContainText('ZeroDivisionError')
  await cells.nth(1).locator('.cm-content').fill('while True:\n    pass')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get('/api/runtime')).json()).busy).toBe(true)
  await page.getByRole('button', { name: 'Interrupt Python', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run all', exact: true })).toBeEnabled({ timeout: 15000 })
  await cells.nth(1).locator('.cm-content').fill('print(shared_number)')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(cells.nth(1).locator('.cell-outputs')).toContainText('41')
  await page.getByRole('button', { name: 'Duplicate cell 3', exact: true }).click()
  await expect(cells).toHaveCount(3)
  await page.getByRole('button', { name: 'Move cell 4 up', exact: true }).click()
  await page.getByRole('button', { name: 'Delete cell 3', exact: true }).click()
  await expect(cells).toHaveCount(2)
  await page.locator('.notebook-undo').getByRole('button', { name: 'Undo' }).click()
  await expect(cells).toHaveCount(3)
  await page.getByLabel('Notebook menu', { exact: true }).click()
  await page.getByRole('button', { name: 'Clear all outputs', exact: true }).click()
  await expect(page.locator('.cell-outputs')).toHaveCount(0)
})

test('catalog loading opens the full item without the search clipping extent', async ({ page }) => {
  const bounds = [85.2, 27.6, 85.5, 27.85]
  const symbology = { mode: 'classes', palette: 'gray', source: 'Esri 9-class', classes: [{ value: 1, label: 'Water', color: '#1a5bab', visible: true }] }
  const scene = { id: 'extent-scene', collection: 'io-lulc-annual-v02', bbox: [80, 20, 90, 30], geometry: null, properties: { datetime: '2024-01-01' }, assets: { data: { type: 'image/tiff', href: 'https://example.test/data.tif' } } }
  await page.route('**/api/layers', route => route.fulfill({ json: [] }))
  await page.route('**/api/stac/search', route => route.fulfill({ json: [scene] }))
  await page.route('**/api/stac/load', route => route.fulfill({ json: { ...scene, kind: 'stac', name: 'Clipped Esri land cover', crs: 'EPSG:3857', count: 1, bbox: bounds, band_names: ['data'], bands: 'data', symbology } }))
  await page.route('**/api/layers/extent-scene/symbology*', route => route.fulfill({ json: { style: symbology, defaults: symbology, presets: {} } }))
  await page.route('**/api/layers/extent-scene/render', route => route.fulfill({ json: { tiles: ['/clip-test/{z}/{x}/{y}.png'] } }))
  const blank = PNG.sync.write(new PNG({ width: 256, height: 256 }))
  await page.route('**/clip-test/**', route => route.fulfill({ body: blank, contentType: 'image/png' }))
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Data', exact: true }).click()
  await page.getByRole('combobox', { name: 'Collection', exact: true }).selectOption('io-lulc-annual-v02')
  await page.getByLabel('Bounds (west, south, east, north)').fill(bounds.join(','))
  await page.getByRole('button', { name: 'Search imagery', exact: true }).click()
  await expect(page.getByText('extent-scene', { exact: true })).toBeVisible()
  await page.getByLabel('Bounds (west, south, east, north)').fill('0,0,1,1')
  const loading = page.waitForRequest('**/api/stac/load')
  await page.getByRole('button', { name: 'Load dataset', exact: true }).click()
  expect((await loading).postDataJSON().bbox).toBeUndefined()
  await expect(page.locator('.selected-name')).toHaveText('Clipped Esri land cover')
})

test('upload vector, buffer, attributes, export, and persistent local Python', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.locator('input[type=file][multiple]').setInputFiles('public/samples/kathmandu.geojson')
  await page.getByRole('button', { name: 'Analyze layer', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Buffer', exact: true }).click()
  await page.getByLabel('Distance (meters)').fill('250')
  await page.getByRole('button', { name: 'Run buffer', exact: true }).click()
  await expect(page.locator('.selected-name')).toHaveText('kathmandu / buffer')
  await page.getByRole('toolbar', { name: 'Geospatial tools' }).getByRole('button', { name: 'Attribute table', exact: true }).click()
  await expect(page.locator('table')).toContainText('Kathmandu study area')
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const pendingDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'GeoJSON', exact: true }).click()
  expect((await pendingDownload).suggestedFilename()).toBe('layer.geojson')
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  const editor = page.locator('.cm-content')
  await editor.fill('remember = 21\nprint(remember)')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(page.locator('.output pre')).toContainText('21', { timeout: 20000 })
  await editor.fill('print(remember * 2)')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(page.locator('.output pre')).toContainText('42')
  await page.screenshot({ path: testInfo.outputPath('python-workflow.png') })
  await page.getByRole('button', { name: 'Close Python editor', exact: true }).click()
  await page.getByRole('button', { name: 'All geospatial operations', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Convex hull', exact: true }).click()
  await page.getByRole('button', { name: 'Run convex hull', exact: true }).click()
  await expect(page.locator('.selected-name')).toHaveText('kathmandu / buffer / convex_hull')
  await page.screenshot({ path: testInfo.outputPath('convex-hull-workflow.png') })
  const hullRemoval = page.getByRole('button', { name: 'Remove kathmandu / buffer / convex_hull', exact: true })
  const hullCount = await hullRemoval.count()
  await hullRemoval.last().click()
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  await editor.fill('print(remember)')
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(page.locator('.output pre')).toContainText('21')
  await expect(hullRemoval).toHaveCount(hullCount - 1)
})

test('common tools prefill inputs, remember parameters and search across operations', async ({ page }, testInfo) => {
  await page.request.get('/api/session')
  const headers = { 'x-open-earth': '1' }
  const makeLayer = async (name: string, inset: number) => {
    const response = await page.request.post('/api/annotations', { headers, data: { name, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [[[85.2 + inset, 27.6 + inset], [85.5 - inset, 27.6 + inset], [85.5 - inset, 27.9 - inset], [85.2 + inset, 27.9 - inset], [85.2 + inset, 27.6 + inset]]] } }] } } })
    expect(response.ok()).toBe(true)
    return response.json()
  }
  const source = await makeLayer('Tool input', 0)
  const boundary = await makeLayer('Tool boundary', .05)
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Tool input 1 features · EPSG:4326', exact: true }).click()
  const toolbar = page.getByRole('toolbar', { name: 'Geospatial tools' })
  await toolbar.getByRole('button', { name: 'Clip', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Input layer', exact: true })).toHaveValue(source.id)
  await expect(page.getByRole('combobox', { name: 'Clip boundary', exact: true })).toHaveValue(boundary.id)
  await expect(page.getByRole('button', { name: 'Run clip', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Swap inputs' }).click()
  await expect(page.getByRole('combobox', { name: 'Input layer', exact: true })).toHaveValue(boundary.id)
  await expect(page.getByRole('combobox', { name: 'Clip boundary', exact: true })).toHaveValue(source.id)
  await page.getByRole('button', { name: 'Swap inputs' }).click()
  const operation = page.waitForRequest('**/api/operations')
  await page.getByRole('button', { name: 'Run clip', exact: true }).click()
  expect((await operation).postDataJSON()).toMatchObject({ layer: source.id, other: boundary.id, operation: 'clip' })
  await expect(page.locator('.selected-name')).toHaveText('Tool input / clip')
  await toolbar.getByRole('button', { name: 'Buffer', exact: true }).click()
  await page.getByLabel('Distance (meters)').fill('250')
  await toolbar.getByRole('button', { name: 'Dissolve', exact: true }).click()
  await toolbar.getByRole('button', { name: 'Buffer', exact: true }).click()
  await expect(page.getByLabel('Distance (meters)')).toHaveValue('250')
  await page.getByLabel('Distance (meters)').fill('-1')
  await expect(page.getByRole('button', { name: 'Run buffer', exact: true })).toBeDisabled()
  await page.getByLabel('Distance (meters)').fill('250')
  await page.screenshot({ path: testInfo.outputPath('operation-buffer-desktop.png') })
  await page.getByLabel('Distance (meters)').press('Enter')
  await expect(page.locator('.selected-name')).toHaveText('Tool input / clip / buffer')
  await toolbar.getByRole('button', { name: 'All geospatial operations' }).click()
  await page.getByRole('button', { name: 'Vector', exact: true }).click()
  await page.getByLabel('Find an operation').fill('ndvi')
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Raster calculator', exact: true })).toBeVisible()
  await page.getByRole('complementary').getByRole('button', { name: 'Raster calculator', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run raster calculator', exact: true })).toBeDisabled()
  await expect(page.getByText('No compatible layers.', { exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: 'All geospatial operations' }).click()
  await page.getByLabel('Find an operation').fill('erase')
  await expect(page.locator('.operation-list button')).toHaveCount(1)
  await expect(page.locator('.operation-list button')).toHaveAttribute('aria-label', 'Difference')
  await page.getByRole('button', { name: 'Clear operation search' }).click()
  await page.screenshot({ path: testInfo.outputPath('operations-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Collapse panel', exact: true }).click()
  await toolbar.getByRole('button', { name: 'All geospatial operations' }).click()
  await expect(page.getByLabel('Find an operation')).toBeVisible()
  await page.getByLabel('Find an operation').fill('crop')
  await page.getByRole('complementary').getByRole('button', { name: 'Clip', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Clip boundary', exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Run clip', exact: true })).toBeDisabled()
  await page.getByRole('combobox', { name: 'Clip boundary', exact: true }).selectOption(boundary.id)
  await expect(page.getByRole('button', { name: 'Run clip', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('operation-clip-mobile.png') })
})

test('catalog rasters stay selected in every raster tool and clip native classes', async ({ page }, testInfo) => {
  await page.request.get('/api/session')
  const headers = { 'x-open-earth': '1' }
  const previous = new Set((await (await page.request.get('/api/layers')).json()).map((layer: { id: string }) => layer.id))
  expect((await page.request.post('/api/runtime/start', { headers, data: {} })).ok()).toBe(true)
  const created = await page.request.post('/api/runtime/execute', { headers, data: { code: `import json
import numpy as np
import rasterio
from pathlib import Path
from rasterio.transform import from_origin
from server.sdk import earth
path = Path('.earth-e2e/catalog-operations.tif').resolve()
with rasterio.open(path, 'w', driver='GTiff', width=16, height=16, count=1, dtype='uint8', crs=4326, transform=from_origin(85,28,.01,.01), nodata=0) as target:
    target.write(np.full((1,16,16),7,dtype='uint8'))
item = earth.store.register(path, 'Esri operation fixture')
item.update(kind='stac', collection='io-lulc-annual-v02', band_names=['data'], bands='data', assets={'data':{'href':str(path)}})
item.pop('filename')
(earth.store.path(item['id'])/'metadata.json').write_text(json.dumps(item))
print('ready')` } })
  expect((await created.json()).status).toBe('ok')
  const catalog = (await (await page.request.get('/api/layers')).json()).find((layer: { id: string; name: string }) => !previous.has(layer.id) && layer.name === 'Esri operation fixture')
  const boundary = await page.request.post('/api/annotations', { headers, data: { name: 'Catalog clip boundary', geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[85.02,27.90],[85.1,27.90],[85.1,27.98],[85.02,27.98],[85.02,27.90]]] } }] } } })
  expect(boundary.ok()).toBe(true)
  const boundaryId = (await boundary.json()).id
  const blank = PNG.sync.write(new PNG({ width: 256, height: 256 }))
  await page.route(`**/api/layers/${catalog.id}/render`, route => route.fulfill({ json: { tiles: ['/catalog-fixture/{z}/{x}/{y}.png'] } }))
  await page.route('**/catalog-fixture/**', route => route.fulfill({ body: blank, contentType: 'image/png' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Esri operation fixture MPC preview', exact: true }).click()
  await page.getByRole('button', { name: 'Analyze layer', exact: true }).click()
  for (const name of ['Raster calculator', 'Zonal statistics', 'Polygonize', 'Rasterize', 'Resample', 'Reproject', 'Clip']) {
    await page.getByRole('complementary').getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('combobox', { name: name === 'Rasterize' ? 'Reference raster grid' : 'Input layer', exact: true })).toHaveValue(catalog.id)
    await expect(page.getByLabel('Raster asset', { exact: true })).toHaveCount(0)
    if (name !== 'Clip') await page.getByRole('button', { name: 'All operations', exact: true }).click()
  }
  await expect(page.getByRole('combobox', { name: 'Clip boundary', exact: true })).toHaveValue(boundaryId)
  await page.getByRole('combobox', { name: 'Clip boundary', exact: true }).selectOption(catalog.id)
  const wholeResponse = page.waitForResponse('**/api/operations')
  await page.getByRole('button', { name: 'Run clip', exact: true }).click()
  const whole = await (await wholeResponse).json()
  expect(whole.width).toBe(16)
  expect(whole.height).toBe(16)
  await expect(page.locator('.selected-name')).toHaveText('Esri operation fixture / clip')
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Zonal statistics', exact: true }).click()
  await page.getByRole('combobox', { name: 'Zones', exact: true }).selectOption(whole.id)
  const statsResponse = page.waitForResponse('**/api/operations')
  await page.getByRole('button', { name: 'Run zonal statistics', exact: true }).click()
  const stats = await (await statsResponse).json()
  const statsFeatures = (await (await page.request.get(`/api/layers/${stats.id}/geojson`)).json()).features
  expect(statsFeatures[0].properties).toMatchObject({ mean: 7, pixels: 256 })
  await page.getByRole('button', { name: 'Esri operation fixture MPC preview', exact: true }).click()
  await page.locator('.geo-toolbar').getByRole('button', { name: 'Clip', exact: true }).click()
  await page.getByRole('combobox', { name: 'Clip boundary', exact: true }).selectOption(boundaryId)
  const requested = page.waitForRequest('**/api/operations')
  const finished = page.waitForResponse('**/api/operations')
  await page.getByRole('button', { name: 'Run clip', exact: true }).click()
  expect((await requested).postDataJSON()).toMatchObject({ layer: catalog.id, operation: 'clip', params: { asset: 'data' }, other: boundaryId })
  const output = await (await finished).json()
  expect(output.kind).toBe('raster')
  expect(output.width).toBeLessThan(16)
  await expect(page.locator('.selected-name')).toHaveText('Esri operation fixture / clip')
  const pixel = await page.request.post(`/api/layers/${output.id}/inspect`, { headers, data: { longitude: 85.05, latitude: 27.95 } })
  expect((await pixel.json()).bands[0].value).toBe(7)
  await page.screenshot({ path: testInfo.outputPath('catalog-raster-clip.png') })
})

test('adaptive catalog styling follows bands and ignores stale recommendations', async ({ page }, testInfo) => {
  const categories = { mode: 'classes', palette: 'gray', source: 'Esri 9-class', bands: ['cover'], classes: [
    { value: 0, label: 'Open ground', color: '#baaea0', visible: true },
    { value: 7, label: 'Wetland', color: '#419d94', visible: true },
  ] }
  const continuous = { mode: 'continuous', palette: 'viridis', source: 'Band statistics', bands: ['height'], classes: [], minimum: -50, maximum: 400 }
  const layer = { id: 'adaptive-scene', name: 'Mixed catalog raster', kind: 'stac', count: 2, crs: 'EPSG:4326', bbox: [85,27,86,28], bands: 'cover', band_names: ['cover', 'height'], symbology: categories }
  await page.route('**/api/layers', route => route.fulfill({ json: [layer] }))
  const blank = PNG.sync.write(new PNG({ width: 256, height: 256 }))
  await page.route('**/api/layers/adaptive-scene/render', route => route.fulfill({ json: { tiles: ['/adaptive-fixture/{z}/{x}/{y}.png'] } }))
  await page.route('**/adaptive-fixture/**', route => route.fulfill({ body: blank, contentType: 'image/png' }))
  let delayCover = false
  let releaseCover: (() => void) | undefined
  await page.route('**/api/layers/adaptive-scene/symbology**', async route => {
    if (route.request().method() === 'POST') { await route.fulfill({ json: route.request().postDataJSON() }); return }
    const band = new URL(route.request().url()).searchParams.get('band')
    if (delayCover && band === 'cover') await new Promise<void>(resolve => { releaseCover = resolve })
    await route.fulfill({ json: { defaults: categories, recommendation: band === 'height' ? continuous : categories } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Mixed catalog raster MPC preview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toBeEnabled()
  await expect(page.locator('.symbology')).not.toContainText(/Esri|9-class|10-class/)
  await expect(page.getByLabel('Label for class 7', { exact: true })).toHaveValue('Wetland')
  await page.getByRole('combobox', { name: 'Band', exact: true }).selectOption('height')
  await expect(page.getByLabel('Display minimum')).toHaveValue('-50')
  await page.getByRole('button', { name: 'Apply style', exact: true }).click()
  await expect(page.getByText('Style saved', { exact: true })).toBeVisible()
  await expect(page.locator('.scale-ticks')).toContainText('-50')
  delayCover = true
  await page.getByRole('combobox', { name: 'Band', exact: true }).selectOption('cover')
  await expect.poll(() => !!releaseCover).toBe(true)
  await expect(page.getByRole('button', { name: 'Apply style', exact: true })).toBeDisabled()
  await page.getByRole('combobox', { name: 'Band', exact: true }).selectOption('height')
  await expect(page.getByLabel('Display maximum')).toHaveValue('400')
  const stale = page.waitForResponse(response => response.url().endsWith('symbology?band=cover'))
  releaseCover!()
  await stale
  await page.getByRole('button', { name: 'Auto', exact: true }).click()
  await expect(page.getByText('Style saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Band', exact: true })).toHaveValue('height')
  await expect(page.getByRole('button', { name: 'Ramp', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Display maximum')).toHaveValue('400')
  await page.screenshot({ path: testInfo.outputPath('adaptive-catalog.png') })
})

test('Python-created GeoTIFF imports, displays, calculates and exports', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByText('Local workspace', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Python editor', exact: true }).click()
  await page.locator('.cm-content').fill(`from server.sdk import earth
import numpy as np
import rasterio
from rasterio.transform import from_origin
from pathlib import Path
path = Path('.earth-e2e/test-grid.tif').resolve()
with rasterio.open(path, 'w', driver='GTiff', width=64, height=64, count=1, dtype='float32', crs='EPSG:4326', transform=from_origin(85.2, 27.85, .005, .005), nodata=-9999) as target:
    target.write(np.arange(4096, dtype='float32').reshape(1,64,64))
earth.add(path, 'Synthetic test raster')
classes_path = Path('.earth-e2e/test-landcover.tif').resolve()
with rasterio.open(classes_path, 'w', driver='GTiff', width=64, height=64, count=1, dtype='uint8', crs='EPSG:4326', transform=from_origin(85.2, 27.85, .005, .005), nodata=0) as target:
  target.write(np.tile(np.repeat(np.array([1, 2, 7, 0], dtype='uint8'), 16), (64, 1)), 1)
earth.add(classes_path, 'Test land cover')
print('raster published')`)
  await page.getByRole('button', { name: 'Run Python cell', exact: true }).click()
  await expect(page.locator('.output pre')).toContainText('raster published')
  await page.getByRole('button', { name: 'Close Python editor', exact: true }).click()
  await page.getByRole('button', { name: 'Synthetic test raster 1 bands · EPSG:4326', exact: true }).last().click()
  await expect(page.getByRole('img', { name: 'Raster value distribution' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('adaptive-continuous.png') })
  await page.getByRole('button', { name: 'Zoom to layer', exact: true }).click()
  await page.getByRole('button', { name: 'Analyze layer', exact: true }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'Raster calculator', exact: true }).click()
  await page.getByLabel('Expression').fill('replace * 2')
  await page.getByLabel('Expression').evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 7))
  await page.getByRole('button', { name: 'Insert band 1', exact: true }).click()
  await expect(page.getByLabel('Expression')).toHaveValue('b1 * 2')
  await page.getByRole('button', { name: 'Run raster calculator', exact: true }).click()
  await expect(page.locator('.selected-name')).toHaveText('Synthetic test raster / calculator')
  const href = await page.getByRole('link', { name: 'Export', exact: true }).getAttribute('href')
  const identifier = href!.split('/')[3]
  const tile = await page.request.get(`/api/layers/${identifier}/tiles/8/188/107.png`)
  expect(tile.status()).toBe(200)
  expect(tile.headers()['content-type']).toContain('image/png')
  const toolbar = await page.getByRole('toolbar', { name: 'Geospatial tools' }).boundingBox()
  expect(toolbar).not.toBeNull()
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.screenshot({ path: testInfo.outputPath('raster-workflow.png') })
  await page.getByRole('button', { name: 'Hide Synthetic test raster / calculator', exact: true }).click()
  await page.getByRole('button', { name: 'Hide Synthetic test raster', exact: true }).click()
  await page.getByRole('button', { name: 'Test land cover 1 bands · EPSG:4326', exact: true }).last().click()
  await expect(page.getByRole('button', { name: 'Classes', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.symbology')).not.toContainText(/Esri|WorldCover|9-class|10-class/)
  await expect(page.locator('.class-row')).toHaveCount(3)
  const datasetColor = await page.getByLabel('Color for class 1', { exact: true }).inputValue()
  await page.getByRole('button', { name: 'Soft categorical', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Soft categorical', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Color for class 1', { exact: true })).not.toHaveValue(datasetColor)
  await page.getByRole('button', { name: 'High contrast', exact: true }).click()
  await page.getByRole('button', { name: 'Apply style', exact: true }).click()
  await expect(page.locator('.map-legend')).toContainText('Class 1')
  await page.getByLabel('Label for class 1', { exact: true }).fill('Open water')
  await page.getByLabel('Color for class 1', { exact: true }).evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#547eaa')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.getByLabel('Show class 2', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Apply style', exact: true }).click()
  await expect(page.locator('.map-legend')).toContainText('Open water')
  await expect(page.locator('.map-legend')).not.toContainText('Class 2')
  await expect(page.getByText('Style saved', { exact: true })).toBeVisible()
  await expect.poll(async () => {
    const { data } = PNG.sync.read(await page.locator('canvas').screenshot())
    let matching = 0
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset] === 84 && data[offset + 1] === 126 && data[offset + 2] === 170) matching++
    }
    return matching
  }, { timeout: 20000 }).toBeGreaterThan(1000)
  await page.screenshot({ path: testInfo.outputPath('landcover-symbology.png') })
  await page.reload()
  await page.getByRole('button', { name: 'Test land cover 1 bands · EPSG:4326', exact: true }).last().click()
  await expect(page.getByLabel('Label for class 1', { exact: true })).toHaveValue('Open water')
  await expect(page.getByLabel('Color for class 1', { exact: true })).toHaveValue('#547eaa')
  await expect(page.getByLabel('Show class 2', { exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: 'Soft categorical', exact: true }).click()
  await expect(page.getByLabel('Label for class 1', { exact: true })).toHaveValue('Open water')
  await expect(page.getByLabel('Show class 2', { exact: true })).not.toBeChecked()
  await page.getByRole('button', { name: 'Dataset colors', exact: true }).click()
  await expect(page.getByLabel('Label for class 1', { exact: true })).toHaveValue('Open water')
  await expect(page.locator('.class-row')).toHaveCount(3)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Label for class 1', { exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const classesBox = (await page.locator('.class-list').boundingBox())!
  expect(classesBox.x).toBeGreaterThanOrEqual(0)
  expect(classesBox.x + classesBox.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('landcover-mobile.png') })
  await page.getByRole('button', { name: 'Auto', exact: true }).click()
  await expect(page.getByText('Style saved', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Label for class 1', { exact: true })).toHaveValue('Class 1')
  await expect(page.getByLabel('Show class 2', { exact: true })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Apply style', exact: true })).toBeDisabled()
})