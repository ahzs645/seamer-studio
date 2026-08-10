import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
});

async function openStudio(page: Page) {
	await page.goto('/studio', { waitUntil: 'domcontentloaded' });
	const patternName = page.getByTestId('pattern-name-input');
	await expect(patternName).toBeVisible();
	await expect(patternName).toHaveValue('Pencil skirt - 3D');
}

async function importSample(page: Page, file: string) {
	await page.getByTestId('import-menu-trigger').click();
	await page.getByTestId(`import-sample-${file}`).click();
}

test.describe('Import samples', () => {
	test('studio loads and pattern name input is present', async ({ page }) => {
		const seamWarnings: string[] = [];
		page.on('console', (message) => {
			if (/Seam (?:particle count|length) mismatch/.test(message.text())) {
				seamWarnings.push(message.text());
			}
		});
		await openStudio(page);
		await expect(page.getByTestId('pattern-name-input')).toBeVisible();
		await expect(page.getByText('P:35 · Paths:36 · Pieces:4 · Seams:12')).toBeVisible();
		const scene = page.getByTestId('pattern-scene-3d');
		await expect(scene).toBeVisible();
		await expect(scene.locator('canvas')).toBeVisible();
		await expect(scene).toHaveAttribute('data-status', 'ready');
		// The canonical skirt's two composite waistband seams intentionally use proportional
		// particle sampling (33 vs 35) when the cloth is rebuilt. A saved default drape may not need
		// that rebuild, so allow zero warnings but reject anything beyond the known fallbacks.
		const allowedSeamWarnings = [
			'Seam particle count mismatch (Seam_uzave2eyv): 33 vs 35 — fallback proportional sampling applied',
			'Seam particle count mismatch (Seam_sibuwpf53): 33 vs 35 — fallback proportional sampling applied'
		];
		expect(seamWarnings.filter((warning) => !allowedSeamWarnings.includes(warning))).toEqual([]);
	});

	test('full 2D mode refits the canonical draft to the expanded canvas', async ({ page }) => {
		await openStudio(page);
		const splitZoom = Number.parseInt(await page.getByTestId('zoom-percent').innerText(), 10);
		await page.getByRole('button', { name: '2D', exact: true }).click();
		await expect.poll(async () => Number.parseInt(await page.getByTestId('zoom-percent').innerText(), 10))
			.toBeGreaterThan(splitZoom + 20);
	});

	const samples = [
		{ file: 'pocket-curved.svg', label: 'Pocket (curved, SVG)', name: 'pocket-curved' },
		{ file: 'two-pieces.svg', label: 'Two pieces (SVG)', name: 'two-pieces' },
		{ file: 'rect-piece.dxf', label: 'Rectangle (DXF)', name: 'rect-piece' },
		{ file: 'curved-hem.dxf', label: 'Curved hem (DXF bulge)', name: 'curved-hem' }
	];

	for (const sample of samples) {
		test(`imports ${sample.label}`, async ({ page }) => {
			await openStudio(page);
			await importSample(page, sample.file);

			await expect(page.getByText(`Imported "${sample.name}"`)).toBeVisible();
			await expect(page.getByTestId('pattern-name-input')).toHaveValue(sample.name);
			const canvas = page.getByTestId('pattern-canvas-2d');
			await expect(canvas).toBeVisible();
			const box = await canvas.boundingBox();
			expect(box?.width).toBeGreaterThan(0);
			expect(box?.height).toBeGreaterThan(0);
		});
	}

	test('an import becomes the active unsaved document and survives save/reload', async ({ page }) => {
		await page.goto('/studio', { waitUntil: 'domcontentloaded' });
		const patternName = page.getByRole('textbox', { name: 'Pattern name...' });
		await expect(patternName).toHaveValue('Pencil skirt - 3D');
		await page.getByRole('button', { name: 'Import', exact: true }).click();
		await page.getByRole('button', { name: 'Two pieces (SVG)', exact: true }).click();

		await expect(page.getByText('Imported "two-pieces"')).toBeVisible();
		await expect(patternName).toHaveValue('two-pieces');
		expect(new URL(page.url()).pathname).toMatch(/\/studio\/[^/]+$/);
		const importedUrl = page.url();

		// The old bug left the stale "Saved" state in place even though no imported record existed.
		// Observing the dirty state before saving makes that lifecycle regression deterministic.
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
		await page.reload({ waitUntil: 'domcontentloaded' });
		expect(page.url()).toBe(importedUrl);
		await expect(page.getByRole('textbox', { name: 'Pattern name...' })).toHaveValue('two-pieces');
		await expect(page.getByText('P:8 · Paths:8 · Pieces:2 · Seams:0')).toBeVisible();
	});

	test('object browser lists imported pieces', async ({ page }) => {
		await openStudio(page);
		await importSample(page, 'two-pieces.svg');
		await expect(page.getByText('Imported "two-pieces"')).toBeVisible();

		await page.getByTestId('object-browser-toggle').click();
		const browser = page.getByTestId('object-browser');
		await expect(browser).toBeVisible();
		await expect(browser.getByTestId('object-browser-pieces-count')).toHaveText('Pieces (2)');
		await expect(browser.getByTestId('object-browser-piece')).toHaveCount(2);
		await expect(browser.getByTestId('object-browser-piece').nth(0)).toContainText('Piece 1');
		await expect(browser.getByTestId('object-browser-piece').nth(1)).toContainText('Piece 2');
	});

	test('rejects an invalid 3D import without replacing the active document', async ({ page }) => {
		await openStudio(page);
		const scene = page.getByTestId('pattern-scene-3d');
		await expect(scene).toHaveAttribute('data-status', 'ready');

		const invalidLegacy = {
			name: 'Broken bow-tie',
			pieces: [{
				name: 'Crossed piece',
				origin: [0, 0],
				grain: [0, 1],
				materialId: 'Material',
				boundary: [
					[[0, 0], [100, 100]],
					[[100, 100], [0, 100]],
					[[0, 100], [100, 0]],
					[[100, 0], [0, 0]]
				],
				sewLines: [
					[[0, 0], [100, 100]],
					[[100, 100], [0, 100]],
					[[0, 100], [100, 0]],
					[[100, 0], [0, 0]]
				]
			}]
		};

		const chooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-menu-trigger').click();
		await page.getByRole('button', { name: /From file/ }).click();
		const chooser = await chooserPromise;
		await chooser.setFiles({
			name: 'broken.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(invalidLegacy))
		});

		await expect(page.getByText(/Cannot import "Broken bow-tie"/)).toBeVisible();
		await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
		await expect(scene).toHaveAttribute('data-status', 'ready');
		await expect(scene.getByRole('button', { name: 'Start simulation' })).toBeEnabled();
	});
});
