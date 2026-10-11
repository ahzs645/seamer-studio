import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ actionTimeout: 15_000 });

const viewports = [
	{ width: 360, height: 800 },
	{ width: 390, height: 844 },
	{ width: 768, height: 1024 },
	{ width: 667, height: 375 }
];

async function openStudio(page: Page) {
	await page.addInitScript(() => localStorage.setItem('seamer.welcomeSeen', '1'));
	await page.goto('/studio', { waitUntil: 'domcontentloaded' });
	await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
	await page.waitForFunction(() => {
		const pattern = window.seamer?.getPattern();
		return pattern?.name === 'Pencil skirt - 3D' && pattern.pieces.length === 4;
	});
}

async function noPageOverflow(page: Page) {
	await expect.poll(() => page.evaluate(() => ({
		width: document.documentElement.scrollWidth - window.innerWidth,
		height: document.documentElement.scrollHeight - window.innerHeight
	}))).toEqual({ width: 0, height: 0 });
}

async function withinViewport(page: Page, locator: Locator) {
	await expect(locator).toBeVisible();
	const viewport = page.viewportSize()!;
	let box = { x: 0, y: 0, width: 0, height: 0 };
	// The 3D renderer can replace its startup canvas while initialization finishes.
	await expect.poll(async () => {
		const measured = await locator.boundingBox();
		if (!measured) return false;
		box = measured;
		return box.x >= -1 && box.y >= -1 &&
			box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1;
	}).toBe(true);
	return box;
}

async function canvasesUsable(page: Page, expectedCount: number) {
	const canvases = page.locator('.studio-canvases canvas');
	await expect(canvases).toHaveCount(expectedCount);
	for (const canvas of await canvases.all()) {
		const box = await withinViewport(page, canvas);
		expect(box.width).toBeGreaterThan(150);
		expect(box.height).toBeGreaterThan(90);
	}
}

async function sceneControlReachable(page: Page, button: Locator) {
	await button.scrollIntoViewIfNeeded();
	await withinViewport(page, button);
	await expect.poll(() => button.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const pane = element.closest('[data-testid="pattern-scene-3d"]')!.getBoundingClientRect();
		return bounds.left >= pane.left && bounds.right <= pane.right + 1 &&
			bounds.top >= pane.top && bounds.bottom <= pane.bottom + 1 &&
			document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element;
	})).toBe(true);
}

async function revealSceneControls(scene: Locator) {
	const expand = scene.getByRole('button', { name: 'Expand 3D controls', exact: true });
	if (await expand.isVisible()) await expand.tap();
}

for (const viewport of viewports) {
		test(`touch workspace remains usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
			test.setTimeout(180_000);
		await page.setViewportSize(viewport);
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await openStudio(page);
		await noPageOverflow(page);
		const views = page.getByRole('group', { name: 'Workspace view', exact: true });
		await views.getByRole('button', { name: '2D', exact: true }).tap();
		await canvasesUsable(page, 1);

		// Every primary header action and every disclosed secondary action is reachable.
		const header = page.locator('.studio-topbar');
		for (const locator of [
			page.getByTestId('pattern-name-input'), page.getByTestId('import-menu-trigger'),
			header.locator('[data-tour-id="tour-save"]'),
			page.getByTestId('templates-menu-trigger')
		]) await withinViewport(page, locator);
		const more = header.getByRole('button', { name: 'More', exact: true });
		await more.tap();
		await expect(more).toHaveAttribute('aria-expanded', 'true');
		// Short landscape moves these actions into More; portrait keeps their direct entry.
		for (const name of ['Layers and body panel', 'Fabric']) await withinViewport(page, header.getByRole('button', { name, exact: true }));
		for (const label of ['Export', 'New', 'Undo', 'Redo', 'Properties panel']) {
			const action = header.getByRole('button', { name: label, exact: true });
			await action.scrollIntoViewIfNeeded();
			await withinViewport(page, action);
		}
		for (const label of ['Object browser', 'Pattern errors & warnings', 'Edit history', 'Version history', 'Settings', 'Command palette', 'Take tour', 'Send feedback', 'Keyboard shortcuts']) {
			const action = header.getByRole('button', { name: label, exact: true });
			await action.scrollIntoViewIfNeeded();
			await withinViewport(page, action);
		}
		const theme = header.getByRole('button', { name: /Switch to .* mode/ });
		await theme.scrollIntoViewIfNeeded();
		await withinViewport(page, theme);

		// Native settings dialog contains focus, persists pattern choices, and supports all dismissals.
		const settingsTrigger = header.getByRole('button', { name: 'Settings', exact: true });
		await settingsTrigger.tap();
		const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
		await withinViewport(page, settings);
		await expect.poll(() => settings.evaluate((el) => el.contains(document.activeElement))).toBe(true);
		await settings.getByRole('checkbox', { name: 'Show grid', exact: true }).tap();
		const grid = await page.evaluate(() => window.seamer!.getPattern().showGrid);
		await page.keyboard.press('Escape');
		await expect(settings).not.toBeVisible();
		await expect(settingsTrigger).toBeFocused();
		await settingsTrigger.tap();
		await expect(settings.getByRole('checkbox', { name: 'Show grid', exact: true })).toBeChecked({ checked: grid });
		await page.touchscreen.tap(1, 1);
		await expect(settings).not.toBeVisible();
		await settingsTrigger.tap();
		await settings.getByRole('button', { name: 'Close', exact: true }).tap();
		await expect(settings).not.toBeVisible();
		await more.tap();
		await expect(more).toHaveAttribute('aria-expanded', 'false');

		// Fixed menus stay in the viewport; long lists scroll to their last item.
		for (const trigger of [page.getByTestId('templates-menu-trigger'), page.getByTestId('import-menu-trigger'), header.getByRole('button', { name: 'Export', exact: true })]) {
			if (!await trigger.isVisible()) await more.tap();
			await trigger.tap();
			const menu = trigger.locator('..').locator('.dropdown-content');
			await withinViewport(page, menu);
			const last = menu.getByRole('button').last();
			await last.scrollIntoViewIfNeeded();
			await withinViewport(page, last);
			await views.getByRole('button', { name: '2D', exact: true }).tap();
		}

		// Drawers trap focus and restore it on Escape, dismiss button, and backdrop.
		for (const [triggerName, dialogName, closeName] of [
			['Layers and body panel', 'Layers, body, fabric and seams', 'Close pattern panels'],
			['Properties panel', 'Properties', 'Close properties']
		]) {
			const trigger = header.getByRole('button', { name: triggerName, exact: true });
			const drawer = page.getByRole('dialog', { name: dialogName, exact: true });
			if (!await trigger.isVisible()) await more.tap();
			await trigger.tap();
			await withinViewport(page, drawer);
			await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			await page.keyboard.press('Shift+Tab');
			await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			await page.keyboard.press('Tab');
			await expect.poll(() => drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			await page.keyboard.press('Escape');
			await expect(drawer).not.toBeVisible();
			await expect(await trigger.isVisible() ? trigger : more).toBeFocused();
			if (!await trigger.isVisible()) await more.tap();
			await trigger.tap();
			await drawer.getByRole('button', { name: closeName, exact: true }).tap();
			await expect(drawer).not.toBeVisible();
			if (!await trigger.isVisible()) await more.tap();
			await trigger.tap();
			const backdrop = page.getByRole('button', { name: 'Close panel', exact: true });
			const bounds = (await backdrop.boundingBox())!;
			await page.touchscreen.tap(triggerName.startsWith('Layers') ? viewport.width - 8 : 8, bounds.y + bounds.height / 2);
			await expect(drawer).not.toBeVisible();
		}

		// Grouped drawing tools work by touch, including the lower seam group on short screens.
		const drawing = page.locator('[data-tour-id="tour-drawing-tools"]');
		for (const [groupName, toolName] of [['Arc/circle tools', 'New three-point-arc'], ['Seam tools', 'Create multi seam']]) {
			const groupTrigger = drawing.getByRole('button', { name: groupName, exact: true });
			await groupTrigger.tap();
			const flyout = drawing.getByRole('group', { name: groupName, exact: true });
			await withinViewport(page, flyout);
			await flyout.getByRole('button', { name: toolName, exact: true }).tap();
			await expect(flyout).not.toBeVisible();
			await expect(groupTrigger).toHaveAttribute('aria-expanded', 'false');
		}

		await views.getByRole('button', { name: 'Both', exact: true }).tap();
		await canvasesUsable(page, 2);
		const bothDrawing = page.locator('[data-tour-id="tour-drawing-tools"]');
		await bothDrawing.getByRole('button', { name: 'Seam tools', exact: true }).tap();
		const bothSeams = bothDrawing.getByRole('group', { name: 'Seam tools', exact: true });
		await withinViewport(page, bothSeams);
			await bothSeams.getByRole('button', { name: 'Create single seam', exact: true }).tap();
			await expect(bothSeams).not.toBeVisible();

			// Even a 334x154 landscape pane exposes its presets, export, and scrollable controls.
			const scene = page.getByTestId('pattern-scene-3d');
			await revealSceneControls(scene);
			const resetCamera = scene.getByRole('button', { name: 'Reset view', exact: true });
			await sceneControlReachable(page, resetCamera);
			await resetCamera.tap();
			await revealSceneControls(scene);
			const sunset = scene.getByRole('button', { name: 'Sunset', exact: true });
			await sceneControlReachable(page, sunset);
			await sunset.tap();
			await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().settings3d.lightingMode)).toBe('sunset');
			await revealSceneControls(scene);
			const image = scene.getByRole('button', { name: 'Save Image', exact: true });
			await sceneControlReachable(page, image);
			const imageDownload = page.waitForEvent('download');
			await image.tap();
			expect((await imageDownload).suggestedFilename()).toMatch(/\.png$/);
			await revealSceneControls(scene);
			const rail = scene.getByRole('group', { name: '3D controls', exact: true });
			const wires = rail.getByRole('button', { name: 'Hide wires', exact: true });
			await sceneControlReachable(page, wires);
			await wires.tap();
			await revealSceneControls(scene);
			await expect(rail.getByRole('button', { name: 'Show wires', exact: true })).toBeVisible();
			await sceneControlReachable(page, rail.getByRole('button', { name: 'Download as glTF', exact: true }));
			await views.getByRole('button', { name: '3D', exact: true }).tap();
		await canvasesUsable(page, 1);
		await expect(page.getByRole('dialog', { name: 'Properties', exact: true })).not.toBeVisible();
		await views.getByRole('button', { name: 'Both', exact: true }).tap();
		await page.setViewportSize({ width: viewport.height, height: viewport.width });
		await canvasesUsable(page, 2);
		await noPageOverflow(page);
		await page.setViewportSize(viewport);
		await canvasesUsable(page, 2);
		await noPageOverflow(page);
		expect(errors).toEqual([]);
	});
}

test('390px 3D controls collapse to preserve the garment and disclose every secondary action', async ({ page }, testInfo) => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 390, height: 844 });
	await openStudio(page);
	await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).tap();
	const scene = page.getByTestId('pattern-scene-3d');
	await expect(scene).toHaveAttribute('data-status', 'ready');
	const primary = scene.getByRole('group', { name: 'Primary 3D controls', exact: true });
	const expand = scene.getByRole('button', { name: 'Expand 3D controls', exact: true });
	await expect(expand).toHaveAttribute('aria-expanded', 'false');
	await expect(primary.getByRole('button')).toHaveCount(3);
	await expect(scene.getByRole('group', { name: '3D controls', exact: true })).not.toBeVisible();
	const paneBounds = (await scene.boundingBox())!;
	const primaryBounds = await withinViewport(page, primary);
	expect(primaryBounds.height).toBeLessThan(64);
	expect(primaryBounds.width * primaryBounds.height / (paneBounds.width * paneBounds.height)).toBeLessThan(0.12);
	console.log(JSON.stringify({ paneBounds, primaryBounds, controlCoverage: primaryBounds.width * primaryBounds.height / (paneBounds.width * paneBounds.height) }));
	await page.screenshot({ path: testInfo.outputPath('mobile-controls-collapsed.png') });
	for (const button of await primary.getByRole('button').all()) {
		const bounds = await withinViewport(page, button);
		expect(bounds.height).toBeGreaterThanOrEqual(44);
	}

	await expand.tap();
	const drawer = scene.getByRole('group', { name: '3D controls', exact: true });
	const close = drawer.getByRole('button', { name: 'Close 3D controls', exact: true });
	await withinViewport(page, drawer);
	expect(await drawer.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
	await expect(close).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('mobile-controls-expanded.png') });
	// Scroll to exports near the end, then close without scrolling back to the heading.
	await sceneControlReachable(page, drawer.getByRole('button', { name: 'Save Image', exact: true }));
	await sceneControlReachable(page, close);
	await close.tap();
	await expect(drawer).not.toBeVisible();
	await expect(expand).toBeFocused();
	await expand.tap();
	await drawer.getByRole('button', { name: 'Simulation controls', exact: true }).tap();
	await expect(drawer).not.toBeVisible();
	const settings = scene.locator('.scene-sim-panel');
	await withinViewport(page, settings);
	await settings.locator('input[type="range"]').last().scrollIntoViewIfNeeded();
	const closeSettings = settings.getByRole('button', { name: 'Close', exact: true });
	await sceneControlReachable(page, closeSettings);
	await closeSettings.tap();
	await expect(settings).not.toBeVisible();
	await expect(expand).toBeFocused();
	await expand.tap();
	await page.keyboard.press('Escape');
	await expect(drawer).not.toBeVisible();
	await expect(expand).toBeFocused();

	await expand.tap();
	await drawer.getByRole('button', { name: 'Show triangles', exact: true }).tap();
	await expect(drawer).not.toBeVisible();
	await expect(primary).toBeVisible();
	await expand.tap();
	await expect(drawer.getByRole('button', { name: 'Show triangles', exact: true })).toHaveClass(/btn-accent/);
	await close.tap();
	await noPageOverflow(page);

	// A wider pane resumes the original desktop controls without leaving a hidden drawer open.
	await expand.tap();
	await page.setViewportSize({ width: 1100, height: 844 });
	await expect(expand).not.toBeVisible();
	await expect(scene.getByRole('group', { name: '3D controls', exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(expand).toHaveAttribute('aria-expanded', 'false');
	await expect(drawer).not.toBeVisible();
	await noPageOverflow(page);
});

for (const width of [390, 360]) {
	test(`mobile library, search, generator and fabrics are discoverable at ${width}px`, async ({ page }, testInfo) => {
		test.setTimeout(150_000);
		await page.setViewportSize({ width, height: 844 });
		await page.addInitScript(() => {
			localStorage.setItem('seamer.welcomeSeen', '1');
			localStorage.setItem('seamer.autosaveSeconds', '600');
		});
		await page.goto('/studio', { waitUntil: 'domcontentloaded' });
		const trigger = page.getByTestId('templates-menu-trigger');
		await expect(trigger).toHaveText(/Library/);
		await trigger.tap();
		const library = page.getByRole('dialog', { name: 'Pattern library', exact: true });
		const close = library.getByRole('button', { name: 'Close pattern library', exact: true });
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(close).toBeFocused(); // Opening the library does not summon a phone keyboard.
		await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');
		await expect(library).toBeVisible();
		await withinViewport(page, library);
		await page.getByTestId('pattern-scene-3d').evaluate((element) => element.focus());
		await expect.poll(() => library.evaluate((element) => element.contains(document.activeElement))).toBe(true);
		await close.focus();
		await page.keyboard.press('Shift+Tab');
		await expect.poll(() => library.evaluate((element) => element.contains(document.activeElement))).toBe(true);
		await close.tap();
		await expect(trigger).toBeFocused();
		await expect.poll(() => page.locator('.studio-topbar').evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(150);
		await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).tap();
		const sceneBounds = await withinViewport(page, page.getByTestId('pattern-scene-3d'));
		const taskbarBounds = await withinViewport(page, page.getByRole('navigation', { name: 'Studio tasks', exact: true }));
		expect(taskbarBounds.height).toBeGreaterThanOrEqual(44);
		expect(taskbarBounds.height).toBeLessThanOrEqual(56);
		// Preserve the original available-space budget while accounting for the visible task row.
		expect(sceneBounds.height + taskbarBounds.height).toBeGreaterThan(660);
		await page.screenshot({ path: testInfo.outputPath(`mobile-compact-${width}.png`) });

		await trigger.tap();
		await library.getByRole('button', { name: 'GarmentCode', exact: true }).tap();
		const search = library.getByRole('searchbox', { name: 'Search pattern library', exact: true });
		await search.fill('hoodie');
		await expect(library.getByTestId('library-garmentcode-hoody_mean_specification.json')).toBeVisible();
		await expect(library.getByTestId('library-garmentcode-shirt_mean_specification.json')).toHaveCount(0);
		await page.setViewportSize({ width, height: 440 }); // Reduced visible area, as when a keyboard opens.
		await withinViewport(page, library);
		const hoodie = library.getByTestId('library-garmentcode-hoody_mean_specification.json');
		await hoodie.scrollIntoViewIfNeeded();
		await withinViewport(page, hoodie);
		await withinViewport(page, close);
		await hoodie.tap();
		await expect(library).not.toBeVisible();
		await expect(page.getByTestId('pattern-name-input')).toHaveValue('GarmentCode Hoodie');
		await page.setViewportSize({ width, height: 844 });
		await noPageOverflow(page);

		await trigger.tap();
		await search.fill('');
		await library.getByRole('button', { name: 'Generators', exact: true }).tap();
		await library.getByTestId('template-garmentcode').tap();
		const generator = page.getByRole('dialog', { name: 'GarmentCode garment', exact: true });
		await withinViewport(page, generator);
		await generator.getByRole('button', { name: 'Cancel', exact: true }).tap();
		await expect(trigger).toBeFocused();
		await trigger.tap();
		await library.getByRole('button', { name: '3D samples', exact: true }).tap();
		await search.fill('simple pants');
		const pants = library.getByTestId('template-simple-pants');
		await pants.scrollIntoViewIfNeeded();
		await pants.tap();
		await expect(page.getByTestId('pattern-name-input')).toHaveValue(/^Simple Pants/);
		await expect.poll(() => page.evaluate(() => ({ pieces: window.seamer!.getPattern().pieces.length, seams: window.seamer!.getPattern().seams.length }))).toEqual({ pieces: 6, seams: 14 });
		await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready');

		await page.locator('.studio-topbar').getByRole('button', { name: 'Fabric', exact: true }).tap();
		const panel = page.getByRole('dialog', { name: 'Layers, body, fabric and seams', exact: true });
		await expect(panel.getByRole('tab', { name: 'Fabric', exact: true })).toHaveAttribute('aria-selected', 'true');
		if (width === 390) {
			const materialCount = await page.evaluate(() => window.seamer!.getPattern().materials.length);
			const remove = panel.getByRole('button', { name: /^Remove fabric / }).first();
			await remove.focus();
			await page.keyboard.press('Space');
			await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(materialCount - 1);
			await expect(panel.getByRole('textbox', { name: 'Fabric name', exact: true })).toHaveCount(0);
			await panel.getByRole('button', { name: 'Close pattern panels', exact: true }).tap();
			await page.getByRole('button', { name: 'More', exact: true }).tap();
			await page.getByRole('button', { name: 'Undo', exact: true }).tap();
			await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().materials.length)).toBe(materialCount);
			await page.getByRole('button', { name: 'Close studio actions', exact: true }).tap();
			await page.locator('.studio-topbar').getByRole('button', { name: 'Fabric', exact: true }).tap();
		}
		const edit = panel.getByRole('button', { name: /^Edit fabric / }).first();
		await expect.poll(async () => (await edit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
		const editBounds = await withinViewport(page, edit);
		expect(editBounds.height).toBeGreaterThanOrEqual(44);
		await edit.focus();
		await page.keyboard.press('Enter');
		await expect(panel.getByRole('textbox', { name: 'Fabric name', exact: true })).toBeVisible();
		await panel.getByRole('button', { name: 'Close pattern panels', exact: true }).tap();
		await expect(page.locator('.studio-topbar').getByRole('button', { name: 'Fabric', exact: true })).toBeFocused();

		await trigger.tap();
		await page.keyboard.press('Escape');
		await expect(library).not.toBeVisible();
		await expect(trigger).toBeFocused();
		await trigger.tap();
		await page.touchscreen.tap(2, 300);
		await expect(library).not.toBeVisible();
		await noPageOverflow(page);
	});
}
