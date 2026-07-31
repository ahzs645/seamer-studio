import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

interface DrapeDebugBounds {
	min: [number, number, number];
	max: [number, number, number];
	centroid: [number, number, number];
}

interface DrapeDebugState {
	deviceAcquired: boolean;
	deviceLostReason: string | null;
	running: boolean;
	frameCount: number;
	particleCount: number;
	positionHash: string | null;
	positionsFinite: boolean;
	particleBounds: DrapeDebugBounds | null;
	avatarBounds: DrapeDebugBounds | null;
	maxSeamPairDistanceMm: number | null;
	waistbandMaxSeamPairDistanceMm: number | null;
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
	expect(
		finalState.waistbandMaxSeamPairDistanceMm,
		'waistband attachment seam distances were not exposed'
	).not.toBeNull();
	expect(
		finalState.waistbandMaxSeamPairDistanceMm!,
		'waistband remained detached from the skirt after five seconds'
	).toBeLessThan(30);
	expect(finalState.particleBounds, 'live particle bounds were not exposed').not.toBeNull();
	expect(finalState.avatarBounds, 'avatar bounds were not exposed').not.toBeNull();
	if (!finalState.particleBounds || !finalState.avatarBounds) {
		throw new Error('live cloth/avatar bounds were not exposed');
	}
	// The pencil skirt hem settles above the knees. A garment that missed body collision falls
	// rapidly toward/below the avatar's feet, so keep both its hem and centre in the body-height band.
	expect(
		finalState.particleBounds.min[1] - finalState.avatarBounds.min[1],
		'skirt hem fell below the avatar knee band'
	).toBeGreaterThan(0.25);
	expect(
		finalState.particleBounds.centroid[1] - finalState.avatarBounds.min[1],
		'skirt centroid fell through the avatar'
	).toBeGreaterThan(0.55);
	expect(finalState.particleBounds.max[1]).toBeLessThan(finalState.avatarBounds.max[1]);
	await expect(scene).toHaveAttribute('data-status', 'simulating');
	expect(pageErrors).toEqual([]);
	expect(deviceLostConsoleErrors).toEqual([]);
});

test('imports, drapes, pauses, and resets the legacy pencil skirt', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));

	await page.goto('/studio', { waitUntil: 'domcontentloaded' });
	await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil Skirt (3D)');

	const chooserPromise = page.waitForEvent('filechooser');
	await page.getByTestId('import-menu-trigger').click();
	await page.getByRole('button', { name: /From file/ }).click();
	const chooser = await chooserPromise;
	await chooser.setFiles(fileURLToPath(new URL('./fixtures/pencil-skirt-legacy.json', import.meta.url)));

	await expect(page.getByText('Imported "Pencil skirt - 3D"')).toBeVisible();
	await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
	await page.getByRole('button', { name: '3D', exact: true }).click();

	const scene = page.getByTestId('pattern-scene-3d');
	await expect(scene).toBeVisible();
	await expect(scene).toHaveAttribute('data-status', 'ready');
	await expect(scene.getByText(/Invalid shape/)).toHaveCount(0);

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
		}, { message: 'the imported legacy skirt did not produce finite WebGPU frames' })
		.toBe(true);

	await page.waitForTimeout(3_000);
	const running = await readDrapeState(page);
	expect(running?.maxSeamPairDistanceMm, 'legacy explicit seams were not built').not.toBeNull();
	expect(running?.maxSeamPairDistanceMm ?? Infinity, 'legacy pieces did not remain sewn together').toBeLessThan(35);
	expect(running?.waistbandMaxSeamPairDistanceMm, 'legacy waistband attachment was not built').not.toBeNull();
	expect(running?.waistbandMaxSeamPairDistanceMm ?? Infinity).toBeLessThan(35);

	await scene.getByRole('button', { name: 'Pause simulation' }).click();
	await expect(scene).toHaveAttribute('data-status', 'ready');
	const paused = await readDrapeState(page);
	expect(paused?.running).toBe(false);
	expect(paused?.positionHash).not.toBeNull();
	await page.waitForTimeout(1_200);
	expect((await readDrapeState(page))?.positionHash, 'Pause changed particle positions').toBe(paused?.positionHash);

	await scene.getByRole('button', { name: 'Reset simulation' }).click();
	const resetDialog = page.getByRole('dialog');
	await expect(resetDialog).toContainText('Reset all simulations?');
	await expect(resetDialog).toContainText('discard all simulated positions');
	await resetDialog.getByRole('button', { name: 'Reset' }).click();
	await expect(scene).toHaveAttribute('data-status', 'ready');
	expect((await readDrapeState(page))?.positionHash, 'Reset did not restore the initial arrangement')
		.not.toBe(paused?.positionHash);
	expect(pageErrors).toEqual([]);
});
