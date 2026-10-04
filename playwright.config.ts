import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173';
const executablePath = process.env.CHROMIUM_PATH || undefined;
const webgpuLaunchArgs = [
	'--enable-unsafe-webgpu',
	...(process.platform === 'darwin'
		? ['--use-angle=metal']
		: process.platform === 'linux'
			? ['--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader']
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
			testIgnore: ['**/webgpu-drape.spec.ts', '**/garmentcode-drape.spec.ts', '**/self-collision-webgpu.spec.ts', '**/cloth-contact-webgpu.spec.ts', '**/cloth-surface-webgpu.spec.ts', '**/cloth-self-surface-webgpu.spec.ts', '**/cloth-diagnostic-copy-webgpu.spec.ts', '**/source-worker-webgpu.spec.ts', '**/workspace-mobile.spec.ts'],
			use: {
				...devices['Desktop Chrome'],
				launchOptions: { executablePath, args: ['--enable-unsafe-swiftshader'] }
			}
		},
		{
			name: 'mobile-chromium',
			testMatch: '**/workspace-mobile.spec.ts',
			use: {
				...devices['Pixel 7'],
				launchOptions: { executablePath, args: ['--enable-unsafe-swiftshader'] }
			}
		},
		{
			name: 'webgpu',
			testMatch: ['**/webgpu-drape.spec.ts', '**/garmentcode-drape.spec.ts', '**/self-collision-webgpu.spec.ts', '**/cloth-contact-webgpu.spec.ts', '**/cloth-surface-webgpu.spec.ts', '**/cloth-self-surface-webgpu.spec.ts', '**/cloth-diagnostic-copy-webgpu.spec.ts', '**/source-worker-webgpu.spec.ts'],
			use: {
				...devices['Desktop Chrome'],
				launchOptions: { executablePath, args: webgpuLaunchArgs }
			}
		}
	],
	webServer: {
		command: 'node node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port 4173 --strictPort',
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
