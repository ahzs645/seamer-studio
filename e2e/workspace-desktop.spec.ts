import { expect, test, type Page } from '@playwright/test';

async function openStudio(page: Page) {
	await page.goto('/studio', { waitUntil: 'domcontentloaded' });
	await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
	await page.getByRole('button', { name: '2D', exact: true }).click();
	await expect(page.locator('[data-tour-id="tour-drawing-tools"]')).toBeVisible();
}

for (const view of [
	{ width: 1024, height: 768, mode: '3D' },
	{ width: 390, height: 568, mode: '3D' },
	{ width: 667, height: 375, mode: 'Both' },
	{ width: 360, height: 800, mode: 'Both' }
]) {
	const viewport = { width: view.width, height: view.height };
	test.describe(`3D toolbar ${viewport.width}x${viewport.height} ${view.mode}`, () => {
		test.use({ viewport });
		test('scrolling and keyboard focus expose export and drawing controls in a short viewport', async ({ page }, testInfo) => {
			test.setTimeout(180_000);
			await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
			await page.goto('/studio', { waitUntil: 'domcontentloaded' });
			await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
			await page.getByRole('button', { name: view.mode, exact: true }).click();
			const expandControls = page.getByRole('button', { name: 'Expand 3D controls', exact: true });
			const narrowControls = await expandControls.isVisible();
			if (narrowControls) await expandControls.click();
			const rail = page.getByRole('group', { name: '3D controls', exact: true });
			await expect.poll(() => rail.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
			const lastExport = rail.getByRole('button', { name: 'Download as glTF', exact: true });
			await lastExport.focus();
			await expect(lastExport).toBeFocused();
			await expect.poll(() => lastExport.evaluate(el => {
				const bounds = el.getBoundingClientRect();
				const parent = el.closest('[role="group"]')!.getBoundingClientRect();
				return bounds.top >= parent.top && bounds.bottom <= parent.bottom + 1 && bounds.bottom <= innerHeight;
			})).toBe(true);
			await rail.evaluate(el => { el.scrollTop = 0; });
			await rail.hover();
			await page.mouse.wheel(0, 1600);
			await expect.poll(() => rail.evaluate(el => el.scrollTop > 0)).toBe(true);
			await lastExport.scrollIntoViewIfNeeded();
			await expect.poll(() => lastExport.evaluate(el => {
				const bounds = el.getBoundingClientRect();
				return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === el;
			})).toBe(true);
			const bounds = await lastExport.boundingBox();
			expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
			await page.screenshot({ path: testInfo.outputPath(`3d-rail-${viewport.width}.png`) });
			const image = page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Save Image', exact: true });
			await page.getByTestId('pattern-scene-3d').getByRole('button', { name: 'Sunset', exact: true }).focus();
			await page.keyboard.press('Tab');
			await expect(image).toBeFocused();
			await expect.poll(() => image.evaluate(el => {
				const bounds = el.getBoundingClientRect();
				const pane = el.closest('[data-testid="pattern-scene-3d"]')!.getBoundingClientRect();
				return bounds.left >= pane.left && bounds.right <= pane.right + 1 && bounds.bottom <= pane.bottom + 1 &&
					document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === el;
			})).toBe(true);
			await page.getByRole('button', { name: '2D', exact: true }).click();
			const measure = page.getByRole('button', { name: 'Measure (point to point)', exact: true });
			await measure.focus();
			await expect(measure).toBeFocused();
			await expect.poll(() => measure.evaluate(el => {
				const bounds = el.getBoundingClientRect();
				const parent = el.closest('[data-tour-id="tour-drawing-tools"]')!.getBoundingClientRect();
				return bounds.top >= parent.top && bounds.bottom <= parent.bottom + 1 && bounds.bottom <= innerHeight;
			})).toBe(true);
			await measure.click();
			await expect(page.getByText('tool: measure', { exact: true })).toBeVisible();
		});
	});
}

async function flags(page: Page) {
	return page.evaluate(() => {
		const pattern = window.seamer!.getPattern() as { showGrid: boolean; snapToGrid: boolean };
		return { grid: pattern.showGrid, snap: pattern.snapToGrid };
	});
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
	test.describe(`desktop workspace ${viewport.width}x${viewport.height}`, () => {
		test.use({ viewport });
		test.beforeEach(async ({ page }) => {
			test.setTimeout(180_000);
			await page.addInitScript(() => {
				localStorage.setItem('seamer.welcomeSeen', '1');
				localStorage.setItem('seamer.autosaveSeconds', '120');
			});
		});

		test('settings, toolbar and saved document agree on grid and snapping after reload', async ({ page }) => {
			await openStudio(page);
			const before = await flags(page);
			await page.getByRole('button', { name: 'Settings', exact: true }).click();
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			await settings.getByRole('checkbox', { name: 'Show grid', exact: true }).setChecked(!before.grid);
			await settings.getByRole('checkbox', { name: 'Snap to grid', exact: true }).setChecked(!before.snap);
			await expect.poll(() => flags(page)).toEqual({ grid: !before.grid, snap: !before.snap });
			await settings.getByRole('button', { name: 'Close', exact: true }).click();
			const grid = page.getByRole('button', { name: 'Grid', exact: true });
			if (!before.grid) await expect(grid).toHaveClass(/btn-active/);
			else await expect(grid).not.toHaveClass(/btn-active/);
			await grid.click();
			await expect.poll(() => flags(page)).toEqual({ grid: before.grid, snap: !before.snap });
			await page.getByRole('button', { name: 'Settings', exact: true }).click();
			await expect(settings.getByRole('checkbox', { name: 'Show grid', exact: true })).toBeChecked({ checked: before.grid });
			await settings.getByRole('button', { name: 'Close', exact: true }).click();
			await page.locator('[data-tour-id="tour-save"]').click();
			await expect(page.getByText('Pattern saved', { exact: true })).toBeVisible();
			await expect(page).toHaveURL(/\/studio\/.+/);
			await page.reload({ waitUntil: 'domcontentloaded' });
			await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D', { timeout: 60_000 });
			await expect.poll(() => flags(page)).toEqual({ grid: before.grid, snap: !before.snap });
			await page.getByRole('button', { name: 'Settings', exact: true }).click();
			await expect(settings.getByRole('checkbox', { name: 'Snap to grid', exact: true })).toBeChecked({ checked: !before.snap });
		});

		test('native Settings dialog traps focus, isolates drawing shortcuts and returns focus on Escape', async ({ page }) => {
			await openStudio(page);
			const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
			await pen.click();
			const trigger = page.getByRole('button', { name: 'Settings', exact: true });
			await trigger.click();
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			await expect(settings).toBeVisible();
			await expect.poll(() => settings.evaluate(el => el.contains(document.activeElement))).toBe(true);
			await settings.getByRole('button', { name: 'Close', exact: true }).focus();
			await page.keyboard.press('a');
			await expect(pen).toHaveAttribute('aria-pressed', 'true');
			const interaction = settings.getByRole('combobox');
			await interaction.focus();
			await page.keyboard.press('s');
			await expect(pen).toHaveAttribute('aria-pressed', 'true');
			for (let n = 0; n < 15; n++) {
				await page.keyboard.press('Tab');
				// Chromium can put Tab focus in browser chrome at the native dialog boundary.
				await expect.poll(() => settings.evaluate(el => !document.hasFocus() || el.contains(document.activeElement))).toBe(true);
			}
			await page.keyboard.press('Escape');
			await expect(settings).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await expect(pen).toHaveAttribute('aria-pressed', 'true');
		});

		test('repeated New and Save create distinct documents and preserve the earlier document', async ({ page }) => {
			await openStudio(page);
			await page.getByRole('button', { name: 'New', exact: true }).click();
			await page.getByRole('button', { name: 'Clear scene', exact: true }).click();
			await page.getByTestId('pattern-name-input').fill('Desktop first document');
			await page.locator('[data-tour-id="tour-save"]').click();
			await expect(page.locator('[data-tour-id="tour-save"]')).toHaveText('Saved');
			const firstUrl = page.url();
			const firstId = await page.evaluate(() => window.seamer!.getPattern().id);
			await page.getByRole('button', { name: 'New', exact: true }).click();
			await expect(page.getByTestId('pattern-name-input')).toHaveValue('New Pattern');
			await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().id)).not.toBe(firstId);
			await page.getByTestId('pattern-name-input').fill('Desktop second document');
			await page.locator('[data-tour-id="tour-save"]').click();
			await expect(page.locator('[data-tour-id="tour-save"]')).toHaveText('Saved');
			const secondUrl = page.url();
			expect(secondUrl).not.toBe(firstUrl);
			await page.goto(firstUrl, { waitUntil: 'domcontentloaded' });
			await expect(page.getByTestId('pattern-name-input')).toHaveValue('Desktop first document');
			await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().id)).toBe(firstId);
			await page.goto(secondUrl, { waitUntil: 'domcontentloaded' });
			await expect(page.getByTestId('pattern-name-input')).toHaveValue('Desktop second document');
		});

		test('dropdown and nested contenteditable own keys; flyouts support mouse and keyboard', async ({ page }) => {
			await openStudio(page);
			const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
			await pen.click();
			// Native controls outside a modal exercise the global shortcut guard independently.
			await page.evaluate(() => {
				const holder = document.createElement('div');
				holder.id = 'keyboard-fixture';
				holder.style.cssText = 'position:fixed;left:240px;top:110px;z-index:500;background:white;color:black';
				holder.innerHTML = '<select aria-label="QA dropdown"><option>Point</option><option>Pen</option></select><div contenteditable="true" role="textbox" aria-label="QA editable"><span>edit</span></div>';
				document.body.append(holder);
			});
			await page.getByRole('combobox', { name: 'QA dropdown' }).focus();
			await page.keyboard.press('n');
			await expect(pen).toHaveAttribute('aria-pressed', 'true');
			await page.getByRole('textbox', { name: 'QA editable' }).click();
			await page.keyboard.type('asq');
			await expect(pen).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByRole('textbox', { name: 'QA editable' })).toContainText('asq');
			await page.locator('#keyboard-fixture').evaluate(el => el.remove());
			const arcs = page.getByRole('button', { name: 'Arc/circle tools', exact: true });
			await arcs.click();
			await expect(arcs).toHaveAttribute('aria-expanded', 'true');
			const arc = page.getByRole('button', { name: 'New three-point-arc', exact: true });
			await arc.click();
			await expect(arcs).toHaveAttribute('aria-expanded', 'false');
			await expect(page.getByText('tool: arc-3pt', { exact: true })).toBeVisible();
			await arcs.focus();
			await page.keyboard.press('ArrowDown');
			await expect(page.getByRole('button', { name: 'New circle/ellipse', exact: true })).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(arcs).toBeFocused();
			await expect(arcs).toHaveAttribute('aria-expanded', 'false');
			const seams = page.getByRole('button', { name: 'Seam tools', exact: true });
			await seams.focus();
			await page.keyboard.press('Enter');
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: 'Create single seam', exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			await page.keyboard.press('Enter');
			await expect(seams).toHaveAttribute('aria-expanded', 'false');
			await expect(page.getByText('tool: seam-multi', { exact: true })).toBeVisible();
		});

		test('2D, Both and 3D preserve desktop panel choices and 3D owns hovered shortcuts', async ({ page }, testInfo) => {
			await openStudio(page);
			const left = page.getByRole('button', { name: 'Layers and body panel', exact: true });
			const right = page.getByRole('button', { name: 'Properties panel', exact: true });
			await expect(left).toHaveAttribute('aria-expanded', 'true');
			await expect(right).toHaveAttribute('aria-expanded', 'true');
			await left.click();
			await page.getByRole('button', { name: 'Both', exact: true }).click();
			const pen = page.getByRole('button', { name: 'Pen tool (lines and curves)', exact: true });
			await pen.click();
			const scene = page.getByTestId('pattern-scene-3d');
			await scene.hover({ position: { x: 20, y: 20 } });
			await page.keyboard.press('a');
			await expect(pen).toHaveAttribute('aria-pressed', 'true');
			await page.getByRole('button', { name: '3D', exact: true }).click();
			await expect(left).toHaveAttribute('aria-expanded', 'false');
			await expect(right).toHaveAttribute('aria-expanded', 'false');
			await page.getByRole('button', { name: '3D', exact: true }).click();
			await page.getByRole('button', { name: 'Both', exact: true }).click();
			await expect(left).toHaveAttribute('aria-expanded', 'false');
			await expect(right).toHaveAttribute('aria-expanded', 'true');
			await page.getByRole('button', { name: '2D', exact: true }).click();
			await left.click();
			await right.click();
			await page.getByRole('button', { name: '3D', exact: true }).click();
			await page.getByRole('button', { name: '2D', exact: true }).click();
			await expect(left).toHaveAttribute('aria-expanded', 'true');
			await expect(right).toHaveAttribute('aria-expanded', 'false');
			await expect(page.locator('body')).toHaveJSProperty('scrollWidth', viewport.width);
			await page.screenshot({ path: testInfo.outputPath(`desktop-${viewport.width}.png`) });
		});
	});
}
