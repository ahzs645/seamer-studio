import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const password = 'A-private-test-password-123';
async function openStudio(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600'); });
  await page.goto('/studio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('studio-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Pencil skirt - 3D');
}
async function share(page: Page, refreshList = false) {
  await page.getByRole('button', { name: 'Command palette', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  await dialog.getByRole('searchbox').fill('sharing');
  await dialog.getByRole('button', { name: 'Open sharing and collaboration', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Sharing and collaboration', exact: true });
  if (refreshList) await panel.getByRole('button', { name: 'Refresh shared documents', exact: true }).click();
  return panel;
}
async function register(request: APIRequestContext, baseURL: string, email: string, name: string) {
  const response = await request.post('/api/collaboration/register', { headers: { Origin: baseURL }, data: { email, name, password } });
  expect(response.status()).toBe(200); return response.json();
}
// These boundary cases deliberately hold network responses. Service-worker-owned
// requests bypass Playwright routing, so keep interception deterministic here.
test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });

test('server sharing persists accounts, enforces roles and detects competing document revisions', async ({ page, context, playwright, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await register(context.request, origin, `owner-${suffix}@example.com`, 'Owner');
  const viewer = await playwright.request.newContext({ baseURL });
  await register(viewer, origin, `viewer-${suffix}@example.com`, 'Viewer');
  await openStudio(page);
  const pattern = await page.evaluate(() => window.seamer!.getPattern());
  const created = await context.request.post('/api/collaboration/documents', { headers: { Origin: origin }, data: { pattern } });
  expect(created.status()).toBe(200); const document = await created.json();
  expect((await viewer.get(`/api/collaboration/documents/${document.id}`)).status()).toBe(404);
  expect((await context.request.post(`/api/collaboration/members/${document.id}`, { headers: { Origin: origin }, data: { email: `viewer-${suffix}@example.com`, role: 'viewer' } })).status()).toBe(200);
  expect((await viewer.post(`/api/collaboration/documents/${document.id}`, { headers: { Origin: origin }, data: { revision: 1, pattern: { ...pattern, name: 'Denied edit' } } })).status()).toBe(403);
  expect((await context.request.post(`/api/collaboration/documents/${document.id}`, { headers: { Origin: origin }, data: { revision: 1, pattern: { ...pattern, name: 'Shared revision' } } })).status()).toBe(200);
  expect((await context.request.post(`/api/collaboration/documents/${document.id}`, { headers: { Origin: origin }, data: { revision: 1, pattern } })).status()).toBe(409);
  expect((await context.request.post(`/api/collaboration/chat/${document.id}`, { headers: { Origin: 'https://untrusted.example' }, data: { text: 'Rejected' } })).status()).toBe(403);
  expect((await viewer.post(`/api/collaboration/chat/${document.id}`, { headers: { Origin: origin }, data: { text: 'Reviewed sample' } })).status()).toBe(200);
  expect((await (await context.request.get(`/api/collaboration/documents/${document.id}`)).json()).messages[0].text).toBe('Reviewed sample');
  const panel = await share(page, true); await panel.getByRole('button', { name: 'Shared revision · owner', exact: true }).click();
  await expect(panel.getByText('All changes shared', { exact: false })).toBeVisible();
  await expect(panel.locator('.messages')).toContainText('Reviewed sample');
  await context.request.post('/api/collaboration/logout', { headers: { Origin: origin }, data: {} });
  await page.goto(`/studio?shared=${document.id}`, { waitUntil: 'domcontentloaded' });
  const pendingPanel = page.getByRole('dialog', { name: 'Sharing and collaboration', exact: true });
  await expect(pendingPanel.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await pendingPanel.getByRole('button', { name: 'Close sharing', exact: true }).click();
  await page.getByTestId('pattern-name-input').fill('Draft before sign-in'); await page.getByTestId('pattern-name-input').press('Tab');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('shared')).toBe(document.id);
  await page.getByTestId('import-menu-trigger').click(); await page.getByTestId('import-sample-rect-piece.dxf').click();
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('rect-piece');
  expect(new URL(page.url()).searchParams.has('shared')).toBe(false);
  await viewer.dispose();
});

test('sharing UI creates an account, publishes a document, sends chat and keeps local edit publishing alive when closed', async ({ page }) => {
  await openStudio(page); const panel = await share(page);
  await panel.getByRole('button', { name: 'Create an account', exact: true }).click();
  await panel.getByLabel('Name', { exact: true }).fill('Designer');
  await panel.getByLabel('Email', { exact: true }).fill(`designer-${Date.now()}@example.com`);
  await panel.getByLabel('Password', { exact: true }).fill(password);
  await panel.getByRole('button', { name: 'Create account', exact: true }).click();
  await panel.getByRole('button', { name: 'Share current document', exact: true }).click();
  await expect(panel.getByText('All changes shared', { exact: false })).toBeVisible();
  await panel.getByLabel('Chat message').fill('Ready for review'); await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.locator('.messages')).toContainText('Ready for review');
  await panel.getByRole('button', { name: 'Close sharing', exact: true }).click();
  await page.getByTestId('pattern-name-input').fill('Shared live edit'); await page.getByTestId('pattern-name-input').press('Tab');
  await expect.poll(async () => { const list = await (await page.request.get('/api/collaboration/documents')).json(); return list[0]?.name; }).toBe('Shared live edit');
});

test('detached Specs edits synchronize to the canonical document and use parent undo; closed parent disables editing', async ({ page }) => {
  await openStudio(page);
  const more = page.getByRole('button', { name: 'More', exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByLabel('Detached pane').selectOption('specs');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /^Detach(?: \(\d+\))?$/ }).click();
  const popup = await popupPromise;
  await expect(popup.getByTestId('specs-workspace')).toBeVisible();
  await popup.getByRole('button', { name: 'Add measurement row', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().productionSpec?.measurements.length ?? 0)).toBe(1);
  await popup.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().productionSpec?.measurements.length ?? 0)).toBe(0);
  await popup.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().productionSpec?.measurements.length ?? 0)).toBe(1);
  await page.close();
  await expect(popup.getByRole('status')).toContainText(/closed|lost/);
  await expect(popup.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a viewer receives live owner revisions while all command, history and transaction writes stay locked', async ({ page, context, browser, playwright, baseURL }) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL!).origin, suffix = `${Date.now()}-live`;
  await register(context.request, origin, `owner-${suffix}@example.com`, 'Owner');
  await openStudio(page);
  const viewerContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  await viewerContext.addInitScript(() => { localStorage.setItem('seamer.welcomeSeen', '1'); localStorage.setItem('seamer.autosaveSeconds', '600'); });
  await register(viewerContext.request, origin, `viewer-${suffix}@example.com`, 'Viewer');
  const pattern = await page.evaluate(() => window.seamer!.getPattern());
  const created = await context.request.post('/api/collaboration/documents', { headers: { Origin: origin }, data: { pattern } });
  expect(created.status()).toBe(200); const document = await created.json();
  await context.request.post(`/api/collaboration/members/${document.id}`, { headers: { Origin: origin }, data: { email: `viewer-${suffix}@example.com`, role: 'viewer' } });
  const ownerPanel = await share(page, true); await ownerPanel.getByRole('button', { name: `${pattern.name} · owner`, exact: true }).click();
  await ownerPanel.getByRole('button', { name: 'Close sharing', exact: true }).click();
  const viewer = await viewerContext.newPage(); await viewer.goto(`/studio?shared=${document.id}`, { waitUntil: 'domcontentloaded' });
  const viewerPanel = viewer.getByRole('dialog', { name: 'Sharing and collaboration', exact: true });
  await expect(viewerPanel.getByText(/viewer · revision 1/)).toBeVisible();
  expect(new URL(viewer.url()).searchParams.get('shared')).toBe(document.id);
  await viewer.reload({ waitUntil: 'domcontentloaded' });
  await expect(viewerPanel.getByText(/viewer · revision 1/)).toBeVisible();
  expect(new URL(viewer.url()).searchParams.get('shared')).toBe(document.id);
  await viewerPanel.getByRole('button', { name: 'Close sharing', exact: true }).click();
  await expect(viewer.getByTestId('pattern-name-input')).toBeDisabled();
  const denied = await viewer.evaluate(() => {
    const api = window.seamer! as unknown as {
      getPattern: () => { layers: { id: string; name: string }[] };
      execute: (type: string, params: unknown) => { ok: boolean };
      undo: () => boolean;
      beginTransaction: (label: string) => { execute: (type: string, params: unknown) => { ok: boolean }; commit: () => unknown; rollback: () => void };
    };
    const before = JSON.stringify(api.getPattern());
    const params = { layerId: api.getPattern().layers[0].id, name: 'Unauthorized' };
    const execute = api.execute('layer.rename', params).ok, undo = api.undo();
    const transaction = api.beginTransaction('Unauthorized transaction');
    const transactionExecute = transaction.execute('layer.rename', params).ok;
    transaction.commit();
    return { execute, undo, transactionExecute, unchanged: JSON.stringify(api.getPattern()) === before };
  });
  expect(denied).toEqual({ execute: false, undo: false, transactionExecute: false, unchanged: true });
  await page.getByTestId('pattern-name-input').fill('Live owner revision'); await page.getByTestId('pattern-name-input').press('Tab');
  await expect(viewer.getByTestId('pattern-name-input')).toHaveValue('Live owner revision');
  await expect(viewer.getByTestId('pattern-name-input')).toBeDisabled();
  const viewerPattern = await viewer.evaluate(() => window.seamer!.getPattern());
  expect((await viewerContext.request.post(`/api/collaboration/documents/${document.id}`, { headers: { Origin: origin }, data: { revision: 2, pattern: { ...viewerPattern, name: 'Denied server write' } } })).status()).toBe(403);
  expect(await viewer.evaluate(() => (window.seamer as unknown as { undo: () => boolean }).undo())).toBe(false);
  await expect(viewer.getByTestId('pattern-name-input')).toHaveValue('Live owner revision');
  // A real editor account publishes a peer revision after the owner has a local undo entry.
  await page.evaluate(() => window.seamer!.execute('layer.rename', { layerId: window.seamer!.getPattern().layers[0].id, name: 'Owner layer edit' }));
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect.poll(async () => (await (await context.request.get(`/api/collaboration/documents/${document.id}`)).json()).pattern.layers[0].name).toBe('Owner layer edit');
  const editor = await playwright.request.newContext({ baseURL });
  const editorEmail = `editor-${suffix}@example.com`; await register(editor, origin, editorEmail, 'Peer editor');
  await context.request.post(`/api/collaboration/members/${document.id}`, { headers: { Origin: origin }, data: { email: editorEmail, role: 'editor' } });
  const current = await (await editor.get(`/api/collaboration/documents/${document.id}`)).json();
  expect((await editor.post(`/api/collaboration/documents/${document.id}`, { headers: { Origin: origin }, data: { revision: current.revision, pattern: { ...current.pattern, description: 'Peer contribution' } } })).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().description)).toBe('Peer contribution');
  await expect.poll(() => viewer.evaluate(() => window.seamer!.getPattern().description)).toBe('Peer contribution');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window.seamer as unknown as { undo: () => boolean }).undo())).toBe(false);
  expect(await page.evaluate(() => window.seamer!.getPattern().description)).toBe('Peer contribution');
  const localPanel = await share(viewer);
  await localPanel.getByRole('button', { name: 'Continue as local document', exact: true }).click();
  expect(new URL(viewer.url()).searchParams.has('shared')).toBe(false);
  await localPanel.getByRole('button', { name: 'Close sharing', exact: true }).click();
  await expect(viewer.getByTestId('pattern-name-input')).toBeEnabled();
  await editor.dispose();
  await viewerContext.close();
});

test('a delayed shared-document open preserves a newer draft with the same document identity', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await register(context.request, origin, `late-${Date.now()}@example.com`, 'Designer');
  await openStudio(page);
  const pattern = await page.evaluate(() => window.seamer!.getPattern());
  const created = await context.request.post('/api/collaboration/documents', { headers: { Origin: origin }, data: { pattern: { ...pattern, name: 'Older server snapshot' } } });
  expect(created.status()).toBe(200); const document = await created.json();
  const panel = await share(page, true);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/collaboration/documents/${document.id}`, async (route) => { await blocked; await route.continue(); });
  await panel.getByRole('button', { name: 'Older server snapshot · owner', exact: true }).click();
  await page.evaluate(() => window.seamer!.execute('layer.rename', { layerId: window.seamer!.getPattern().layers[0].id, name: 'New local draft' }));
  release();
  await expect(panel.getByRole('alert')).toContainText('Your draft was preserved');
  await expect.poll(() => page.evaluate(() => window.seamer!.getPattern().layers[0].name)).toBe('New local draft');
  await expect(page.getByTestId('pattern-name-input')).toHaveValue(pattern.name);
});

test('an in-flight peer revision waits for pending frozen diagnostic verification to thaw', async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL!).origin;
  await register(context.request, origin, `frozen-${Date.now()}@example.com`, 'Frozen observer');
  await openStudio(page);
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByTestId('pattern-scene-3d')).toBeVisible();
  await expect(page.getByTestId('pattern-scene-3d')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  const hasDiagnostic = await page.evaluate(() => !!(window as Window & { __seamerWebgpuDrape?: unknown }).__seamerWebgpuDrape);
  test.skip(!hasDiagnostic, 'Frozen diagnostic inspection is available only in the development runtime.');
  const pattern = await page.evaluate(() => window.seamer!.getPattern());
  const created = await context.request.post('/api/collaboration/documents', { headers: { Origin: origin }, data: { pattern } });
  expect(created.status()).toBe(200); const document = await created.json();
  const panel = await share(page, true); await panel.getByRole('button', { name: `${pattern.name} · owner`, exact: true }).click();
  await panel.getByRole('button', { name: 'Close sharing', exact: true }).click();
  let releasePoll!: () => void, observedPoll = false;
  const heldPoll = new Promise<void>((resolve) => { releasePoll = resolve; });
  await page.route((url) => url.pathname.endsWith(`/api/collaboration/documents/${document.id}`) && url.searchParams.has('since'), async (route) => { observedPoll = true; await heldPoll; await route.continue(); });
  await expect.poll(() => observedPoll, { timeout: 15_000, message: 'The authenticated shared workspace must issue a live poll before diagnostic inspection.' }).toBe(true);
  // Delay the real preparation called by the public diagnostic hook. The actual hook
  // establishes the frozen read-only state; no permission callback is synthesized.
  await page.evaluate(async () => {
    // Use the module URL actually loaded by this page, including any Vite HMR stamp,
    // so the prototype belongs to the live renderer rather than a second ESM instance.
    const path = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => new URL(name).pathname === '/src/lib/scene/scene3d.ts') ?? '/src/lib/scene/scene3d.ts';
    const { PatternRenderer } = await import(/* @vite-ignore */ path) as { PatternRenderer: { prototype: { setPattern: (...args: unknown[]) => Promise<boolean> } } };
    const original = PatternRenderer.prototype.setPattern;
    const target = window as Window & { __releaseFrozenPreparation?: () => void; __seamerWebgpuDrape?: { presentFrozenCheckpoint: (request: { snapshotJson: string; snapshotSha256: string }) => Promise<unknown> } };
    PatternRenderer.prototype.setPattern = function (...args: unknown[]) {
      PatternRenderer.prototype.setPattern = original;
      return new Promise<void>((resolve) => { target.__releaseFrozenPreparation = resolve; }).then(() => original.apply(this, args));
    };
    void target.__seamerWebgpuDrape!.presentFrozenCheckpoint({ snapshotJson: '{}', snapshotSha256: '0'.repeat(64) }).catch(() => {});
  });
  await expect(page.getByTestId('pattern-name-input')).toBeDisabled();
  const current = await (await context.request.get(`/api/collaboration/documents/${document.id}`)).json();
  expect((await context.request.post(`/api/collaboration/documents/${document.id}`, { headers: { Origin: origin }, data: { revision: current.revision, pattern: { ...current.pattern, name: 'Peer during frozen verification' } } })).status()).toBe(200);
  const delivered = page.waitForResponse((response) => response.url().includes(`/api/collaboration/documents/${document.id}?since=`), { timeout: 15_000 });
  releasePoll(); await delivered;
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('pattern-name-input')).toHaveValue(pattern.name);
  expect((await (await context.request.get(`/api/collaboration/documents/${document.id}`)).json()).revision).toBe(current.revision + 1);
  await page.getByRole('button', { name: 'Exit diagnostic', exact: true }).click();
  await page.evaluate(() => { const target = window as Window & { __releaseFrozenPreparation?: () => void }; target.__releaseFrozenPreparation?.(); delete target.__releaseFrozenPreparation; });
  await expect(page.getByTestId('pattern-name-input')).toHaveValue('Peer during frozen verification');
  await page.waitForTimeout(1200);
  const final = await (await context.request.get(`/api/collaboration/documents/${document.id}`)).json();
  expect(final.revision).toBe(current.revision + 1); expect(final.pattern.name).toBe('Peer during frozen verification');
});
