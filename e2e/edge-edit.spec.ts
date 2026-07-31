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

async function importRectangle(page: Page) {
	await page.getByTestId('import-menu-trigger').click();
	await page.getByTestId('import-sample-rect-piece.dxf').click();
	await expect(page.getByText('Imported "rect-piece"')).toBeVisible();
	await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
}

async function selectFirstRectangleEdge(page: Page) {
	await page.getByTestId('object-browser-toggle').click();
	const browser = page.getByTestId('object-browser');
	await expect(browser).toBeVisible();
	await browser.getByTestId('object-browser-piece').filter({ hasText: 'Piece 1' }).click();
	await page.getByTestId('object-browser-toggle').click();

	await expect(page.getByTestId('property-panel-heading')).toHaveText('Properties for Piece');
	await page.getByTestId('piece-edge-select').first().click();
	await expect(page.getByTestId('property-panel-heading')).toHaveText('Properties for Edge');
}

test('selecting a piece then an edge lets you edit the edge angle', async ({ page }) => {
	await openStudio(page);
	await importRectangle(page);
	await selectFirstRectangleEdge(page);

	const angle = page.getByTestId('edge-angle-input');
	await expect(angle).toBeVisible();
	const before = await angle.inputValue();

	await page.getByTestId('edge-rotate-plus-one').click();
	await expect.poll(() => angle.inputValue()).not.toBe(before);
});

test('edge pivot toggle lets you rotate around either endpoint', async ({ page }) => {
	await openStudio(page);
	await importRectangle(page);
	await selectFirstRectangleEdge(page);

	const pivotButtons = page.getByTestId('edge-pivot').getByRole('button');
	await expect(pivotButtons).toHaveCount(2);
	await expect(pivotButtons.nth(0)).toHaveClass(/btn-active/);

	await pivotButtons.nth(1).click();
	await expect(pivotButtons.nth(1)).toHaveClass(/btn-active/);
	await expect(pivotButtons.nth(0)).not.toHaveClass(/btn-active/);

	const angle = page.getByTestId('edge-angle-input');
	const before = await angle.inputValue();
	await page.getByTestId('edge-rotate-plus-one').click();
	await expect.poll(() => angle.inputValue()).not.toBe(before);
});
