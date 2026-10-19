import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  reporter: 'list',
  outputDir: 'qa-artifacts/playwright',
  use: { baseURL: 'http://127.0.0.1:4317', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/helpers/e2e-server.js',
    url: 'http://127.0.0.1:4317/api/health',
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
