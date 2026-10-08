import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:8766', viewport: { width: 1440, height: 960 }, screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-webgl'] } },
  webServer: {
    command: 'uv run uvicorn server.main:app --host 127.0.0.1 --port 8766',
    env: { OPEN_EARTH_DATA: '.earth-e2e' },
    url: 'http://127.0.0.1:8766/api/session',
    reuseExistingServer: false,
  },
})