import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

interface DrapeDebugState {
	deviceAcquired: boolean;
	deviceLostReason: string | null;
	running: boolean;
	frameCount: number;
	particleCount: number;
	positionHash: string | null;
	positionsFinite: boolean;
}

interface DrapeDebugApi {
	getState: () => DrapeDebugState | null;
}

async function readDrapeState(page: Page): Promise<DrapeDebugState | null> {
	return page.evaluate(() => {
		const target = window as Window & { __seamerWebgpuDrape?: DrapeDebugApi };
		return target.__seamerWebgpuDrape?.getState() ?? null;
	});
}

function isDeviceLostMessage(message: ConsoleMessage): boolean {
	return /\bdevice\b.*\blost\b|\blost\b.*\bdevice\b/i.test(message.text());
}

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
});

test('runs the default cloth drape on WebGPU and updates particle positions', async ({ page }) => {
	const pageErrors: string[] = [];
	const deviceLostConsoleErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	page.on('console', (message) => {
		if (isDeviceLostMessage(message)) {
			deviceLostConsoleErrors.push(`[${message.type()}] ${message.text()}`);
		}
	});

	await page.goto('/studio', { waitUntil: 'domcontentloaded' });
	await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil Skirt (3D)');

	const gpuProbe = await page.evaluate(async () => {
		if (!('gpu' in navigator) || !navigator.gpu) {
			return { available: false, reason: 'navigator.gpu is missing' };
		}
		try {
			const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
			return adapter
				? { available: true, reason: '' }
				: { available: false, reason: 'navigator.gpu.requestAdapter() returned null' };
		} catch (error: unknown) {
			return {
				available: false,
				reason: `navigator.gpu.requestAdapter() failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	});
	test.skip(!gpuProbe.available, `WebGPU drape verification skipped: ${gpuProbe.reason}`);
	expect(gpuProbe.available, 'navigator.gpu adapter probe').toBe(true);

	// The studio starts in split view. Switch to the full 3D view, wait for GPU-free preparation,
	// then use the real right-rail control that lazily requests the device and starts ClothSimulation.
	await page.getByRole('button', { name: '3D', exact: true }).click();
	const scene = page.getByTestId('pattern-scene-3d');
	await expect(scene).toBeVisible();
	await expect(scene).toHaveAttribute('data-status', 'ready');
	await expect
		.poll(async () => (await readDrapeState(page)) !== null, {
			message: 'DEV drape probe was not installed'
		})
		.toBe(true);

	await scene.getByRole('button', { name: 'Start simulation' }).click();
	await expect(scene).toHaveAttribute('data-status', 'simulating');
	await expect
		.poll(async () => {
			const state = await readDrapeState(page);
			return !!state
				&& state.deviceAcquired
				&& state.running
				&& state.frameCount >= 2
				&& state.particleCount > 0
				&& state.positionHash !== null
				&& state.positionsFinite;
		}, { message: 'WebGPU solver did not acquire a device and produce finite particle frames' })
		.toBe(true);

	const baseline = await readDrapeState(page);
	expect(baseline, 'drape debug state disappeared after simulation startup').not.toBeNull();
	if (!baseline) throw new Error('drape debug state disappeared after simulation startup');

	// Keep the live solver under observation long enough to catch asynchronous device loss or a
	// runner that silently stops after its first dispatch.
	await page.waitForTimeout(5_000);

	const finalState = await readDrapeState(page);
	expect(finalState, 'drape debug state disappeared while simulation was running').not.toBeNull();
	if (!finalState) throw new Error('drape debug state disappeared while simulation was running');
	expect(finalState.running).toBe(true);
	expect(finalState.frameCount).toBeGreaterThan(baseline.frameCount);
	expect(finalState.positionHash, 'GPU-read particle positions did not change over five seconds')
		.not.toBe(baseline.positionHash);
	expect(finalState.positionsFinite).toBe(true);
	expect(finalState.deviceLostReason).toBeNull();
	await expect(scene).toHaveAttribute('data-status', 'simulating');
	expect(pageErrors).toEqual([]);
	expect(deviceLostConsoleErrors).toEqual([]);
});
