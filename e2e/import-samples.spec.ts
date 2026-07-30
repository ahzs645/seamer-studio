import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
});

async function openStudio(page: Page) {
	await page.goto('/studio', { waitUntil: 'domcontentloaded' });
	const patternName = page.getByTestId('pattern-name-input');
	await expect(patternName).toBeVisible();
	await expect(patternName).toHaveValue('Pencil Skirt (3D)');
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
		const scene = page.getByTestId('pattern-scene-3d');
		await expect(scene).toBeVisible();
		await expect(scene.locator('canvas')).toBeVisible();
		await expect(scene).toHaveAttribute('data-status', 'ready');
		expect(seamWarnings).toEqual([]);
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
});
