import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';
const webgpuLaunchArgs = [
	'--enable-unsafe-webgpu',
	...(process.platform === 'darwin'
		? ['--use-angle=metal']
		: process.platform === 'linux'
			? ['--enable-features=Vulkan']
			: [])
];

export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.spec.ts',
	globalSetup: './e2e/global-setup.ts',
	timeout: 90_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	forbidOnly: !!process.env.CI,
	reporter: [['list']],
	use: {
		baseURL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			testIgnore: '**/webgpu-drape.spec.ts',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: { args: ['--enable-unsafe-swiftshader'] }
			}
		},
		{
			name: 'webgpu',
			testMatch: '**/webgpu-drape.spec.ts',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: { args: webgpuLaunchArgs }
			}
		}
	],
	webServer: {
		command: 'pnpm dev --host 127.0.0.1 --port 4173 --strictPort',
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000
	}
});
