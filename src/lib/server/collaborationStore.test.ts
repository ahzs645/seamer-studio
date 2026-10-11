import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, mkdir, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEmptyPattern } from '@seamer/pattern-model';
import { CollaborationStore, validateSharedPattern } from './collaborationStore';
const createPattern = (name: string) => ({ ...createEmptyPattern(), name });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function setup() { const directory = await mkdtemp(join(tmpdir(), 'seamer-sharing-')); directories.push(directory); return { directory, store: new CollaborationStore(directory) }; }
const credentials = ['owner@example.com', 'a-long-secret-password', 'Owner'] as const;
describe('persistent collaboration', () => {
  it('stores password hashes and hashed sessions, persists across restart, and revokes sign-out', async () => {
    const { directory, store } = await setup();
    const owner = await store.register(...credentials);
    expect(await new CollaborationStore(directory).account(owner.token)).toEqual(owner.account);
    const persisted = await readFile(join(directory, 'collaboration.json'), 'utf8');
    expect(persisted).not.toContain(credentials[1]); expect(persisted).not.toContain(owner.token);
    expect((await stat(join(directory, 'collaboration.json'))).mode & 0o777).toBe(0o600);
    await expect(store.login(credentials[0], 'incorrect-password')).rejects.toMatchObject({ status: 401 });
    await store.logout(owner.token);
    await expect(store.account(owner.token)).rejects.toMatchObject({ status: 401 });
    expect((await store.login(credentials[0], credentials[1])).account).toEqual(owner.account);
  });
  it('enforces account uniqueness and credentials', async () => {
    const { store } = await setup(); await store.register(...credentials);
    await expect(store.register('OWNER@example.com', credentials[1], 'Duplicate')).rejects.toMatchObject({ status: 409 });
    expect(() => store.register('invalid', 'short', 'Name')).toThrow();
  });
  it('requires membership, restricts edits and access management, revokes member access', async () => {
    const { store } = await setup(); const owner = await store.register(...credentials);
    const viewer = await store.register('viewer@example.com', credentials[1], 'Viewer');
    const other = await store.register('other@example.com', credentials[1], 'Other');
    const document = await store.create(owner.token, createPattern('Shared'));
    await expect(store.get(viewer.token, document.id)).rejects.toMatchObject({ status: 404 });
    await store.grant(owner.token, document.id, viewer.account.email, 'viewer');
    expect((await store.get(viewer.token, document.id)).role).toBe('viewer');
    await expect(store.save(viewer.token, document.id, 1, document.pattern)).rejects.toMatchObject({ status: 403 });
    await expect(store.grant(viewer.token, document.id, other.account.email, 'editor')).rejects.toMatchObject({ status: 403 });
    await store.grant(owner.token, document.id, viewer.account.email, 'editor');
    expect((await store.save(viewer.token, document.id, 1, { ...document.pattern, name: 'Edited' })).revision).toBe(2);
    await store.grant(owner.token, document.id, viewer.account.email, 'remove');
    await expect(store.get(viewer.token, document.id)).rejects.toMatchObject({ status: 404 });
  });
  it('serializes competing edits without overwriting, and retains restorable server versions', async () => {
    const { store, directory } = await setup(); const owner = await store.register(...credentials);
    const document = await store.create(owner.token, createPattern('Initial'));
    const result = await Promise.allSettled([
      store.save(owner.token, document.id, 1, { ...document.pattern, name: 'First' }),
      store.save(owner.token, document.id, 1, { ...document.pattern, name: 'Second' })
    ]);
    expect(result[0].status).toBe('fulfilled'); expect(result[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    const restarted = new CollaborationStore(directory);
    expect((await restarted.get(owner.token, document.id)).pattern.name).toBe('First');
    expect((await restarted.version(owner.token, document.id, 1)).pattern.name).toBe('Initial');
  });
  it('never rewrites stored histories during live reads and refuses partial renderer structs', async () => {
    const { store, directory } = await setup(); const owner = await store.register(...credentials);
    const pattern = createPattern('Validate'); const document = await store.create(owner.token, pattern);
    const metadataPath = join(directory, `document-${document.id}.json`), versionPath = join(directory, `version-${document.id}-1.json`);
    const before = await Promise.all([stat(metadataPath), stat(versionPath), stat(join(directory, 'collaboration.json'))]);
    await store.account(owner.token); await store.get(owner.token, document.id); await store.list(owner.token); await store.version(owner.token, document.id, 1);
    const after = await Promise.all([stat(metadataPath), stat(versionPath), stat(join(directory, 'collaboration.json'))]);
    expect(after.map((value) => value.ino)).toEqual(before.map((value) => value.ino));
    expect(() => validateSharedPattern({ ...pattern, materials: [{ id: 'partial' }] })).toThrow();
    expect(() => validateSharedPattern({ ...pattern, pieces: [{ id: 'partial', mainPaths: [], internalPaths: [], settings3d: {} }] })).toThrow();
    expect(() => validateSharedPattern({ ...pattern, settings3d: {} })).toThrow();
    const token = (await store.get(owner.token, document.id)).changeToken;
    await store.chat(owner.token, document.id, 'Live event');
    expect((await store.get(owner.token, document.id)).changeToken).not.toBe(token);
    expect((await stat(versionPath)).ino).toBe(before[1].ino);
  });
  it('reloads disk state after a failed revision or account write, with no phantom memory mutations', async () => {
    const { store, directory } = await setup(); const owner = await store.register(...credentials);
    const document = await store.create(owner.token, createPattern('Durable'));
    const blocked = join(directory, `version-${document.id}-2.json`);
    await mkdir(blocked);
    await expect(store.save(owner.token, document.id, 1, { ...document.pattern, name: 'Not persisted' })).rejects.toBeDefined();
    await rm(blocked, { recursive: true });
    expect((await store.get(owner.token, document.id)).pattern.name).toBe('Durable');
    expect((await store.get(owner.token, document.id)).revision).toBe(1);
    const index = join(directory, 'collaboration.json'), backup = join(directory, 'backup.json');
    await rename(index, backup); await mkdir(index);
    await expect(store.register('phantom@example.com', credentials[1], 'Phantom')).rejects.toBeDefined();
    await rm(index, { recursive: true }); await rename(backup, index);
    await expect(store.login('phantom@example.com', credentials[1])).rejects.toMatchObject({ status: 401 });
    expect((await store.account(owner.token)).name).toBe('Owner');
  });
  it('requires a private data directory', async () => {
    const { store, directory } = await setup(); await chmod(directory, 0o755);
    await expect(store.register(...credentials)).rejects.toMatchObject({ status: 503 });
  });
  it('shares persisted chat only with members and validates imported extensions', async () => {
    const { store, directory } = await setup(); const owner = await store.register(...credentials);
    const viewer = await store.register('viewer@example.com', credentials[1], 'Viewer');
    const document = await store.create(owner.token, createPattern('Chat'));
    await store.grant(owner.token, document.id, viewer.account.email, 'viewer');
    await store.chat(viewer.token, document.id, 'Sample approval discussion');
    expect((await new CollaborationStore(directory).get(owner.token, document.id)).messages[0]).toMatchObject({ author: 'Viewer', text: 'Sample approval discussion' });
    expect(() => store.chat(owner.token, document.id, ' '.repeat(10))).toThrow();
    expect(() => store.create(owner.token, { ...document.pattern, artwork: [{ id: 'broken' }] } as never)).toThrow();
    await expect(store.save(owner.token, document.id, 1, { ...document.pattern, id: 'wrong-id' })).rejects.toMatchObject({ status: 400 });
  });
});
