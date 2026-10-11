import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDocumentExtensions, type Pattern } from '@seamer/pattern-model';

const scrypt = promisify(scryptCallback);
export type SharedRole = 'owner' | 'editor' | 'viewer';
export interface Account { id: string; email: string; name: string }
interface User extends Account { salt: string; hash: string }
interface Session { userId: string; expiresAt: number }
export interface SharedVersion { revision: number; author: string; savedAt: string; pattern: Pattern }
export interface ChatMessage { id: string; author: string; userId: string; text: string; sentAt: string }
interface SharedDocument { id: string; ownerId: string; members: Record<string, SharedRole>; versions: SharedVersion[]; messages: ChatMessage[] }
interface Database { users: User[]; sessions: Record<string, Session>; documents: SharedDocument[] }
export class CollaborationError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new CollaborationError(status, message); };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const cleanAccount = ({ id, email, name }: Account): Account => ({ id, email, name });
export function validateSharedPattern(value: unknown): asserts value is Pattern {
  if (!value || typeof value !== 'object') fail(400, 'A pattern is required.');
  const pattern = value as Pattern;
  if (typeof pattern.id !== 'string' || !pattern.id || typeof pattern.name !== 'string' || !Array.isArray(pattern.pieces) || !Array.isArray(pattern.points) || !Array.isArray(pattern.paths)) fail(400, 'Invalid pattern document.');
  if (!['inch', 'cm', 'mm'].includes(pattern.lengthUnit) || !['degrees', 'radians'].includes(pattern.angleUnit) || !pattern.body || typeof pattern.body !== 'object' || !pattern.settings3d || typeof pattern.settings3d !== 'object') fail(400, 'Invalid pattern units or settings.');
  for (const key of ['variables', 'seams', 'materials', 'layers', 'images', 'texts'] as const) if (!Array.isArray(pattern[key])) fail(400, `Invalid ${key} collection.`);
  for (const collection of [pattern.points, pattern.paths, pattern.pieces, pattern.seams, pattern.materials]) {
    const ids = new Set<string>();
    for (const item of collection) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail(400, 'Document elements need unique identifiers.');
      ids.add(item.id);
    }
  }
  for (const point of pattern.points) if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) fail(400, 'Point coordinates must be finite.');
  for (const path of pattern.paths) if (!Array.isArray(path.pathPoints)) fail(400, 'Invalid path points.');
  for (const piece of pattern.pieces) if (!Array.isArray(piece.mainPaths) || !Array.isArray(piece.internalPaths) || !piece.settings3d || typeof piece.settings3d !== 'object') fail(400, 'Invalid piece geometry.');
  for (const seam of pattern.seams) if (!Array.isArray(seam.fromPaths) || !Array.isArray(seam.toPaths)) fail(400, 'Invalid seam references.');
  const numbers = (value: object, keys: string[], label: string) => { for (const key of keys) if (!Number.isFinite((value as Record<string, unknown>)[key])) fail(400, `Invalid ${label} ${key}.`); };
  const booleans = (value: object, keys: string[], label: string) => { for (const key of keys) if (typeof (value as Record<string, unknown>)[key] !== 'boolean') fail(400, `Invalid ${label} ${key}.`); };
  const vector = (value: unknown, size: number, label: string) => { if (!Array.isArray(value) || value.length !== size || !value.every(Number.isFinite)) fail(400, `Invalid ${label}.`); };
  numbers(pattern, ['seamAllowance', 'defaultNotchSize', 'graphicsScale', 'versionNumber'], 'pattern');
  if (!pattern.graphicsOffset || typeof pattern.graphicsOffset !== 'object') fail(400, 'Missing graphics offset.');
  numbers(pattern.graphicsOffset, ['x', 'y'], 'graphics offset');
  if (!pattern.body.fields || typeof pattern.body.fields !== 'object' || typeof pattern.body.gender !== 'string' || !['imperial', 'metric'].includes(pattern.body.unitType)) fail(400, 'Invalid body settings.');
  for (const value of Object.values(pattern.body.fields)) if (typeof value !== 'number' || !Number.isFinite(value)) fail(400, 'Body dimensions must be finite.');
  for (const key of ['cameraPosition', 'controlsTarget', 'gravity'] as const) vector(pattern.settings3d[key], 3, key);
  numbers(pattern.settings3d, ['cameraFov', 'bokehFStop', 'n8aoRadius', 'n8aoDistanceFalloff', 'n8aoIntensity', 'smaaScale'], 'scene');
  booleans(pattern.settings3d, ['avatarEnabled', 'showAvatar', 'showArrangementPoints', 'showTriangles', 'showSeams', 'n8aoEnabled', 'forceLowEndHardware', 'handleSelfCollisions', 'debugFocusPoint'], 'scene');
  for (const material of pattern.materials) {
    if (typeof material.name !== 'string') fail(400, 'Material name is required.');
    numbers(material, ['stretchWarpValue', 'stretchWeftValue', 'bendValue', 'thickness', 'weight', 'roughness', 'metalness', 'specularIntensity', 'opacity', 'normalScale', 'alphaCutoff'], 'material');
    booleans(material, ['useSeparateBackSide'], 'material');
    for (const slot of [material.frontTexture, material.backTexture]) {
      if (slot === null) continue;
      if (!slot || typeof slot !== 'object') fail(400, 'Invalid material texture.');
      for (const key of ['url', 'color', 'normalUrl', 'opacityUrl'] as const) if (typeof slot[key] !== 'string') fail(400, 'Invalid material texture source.');
      numbers(slot, ['scale', 'normalMapScale', 'opacityMapScale'], 'texture');
    }
  }
  for (const piece of pattern.pieces) {
    if (typeof piece.name !== 'string' || typeof piece.type !== 'string' || typeof piece.materialId !== 'string' || !piece.origin || !piece.position || !piece.grainVector) fail(400, 'Missing piece placement.');
    numbers(piece, ['rotation', 'rightPieces', 'leftPieces'], 'piece');
    for (const value of [piece.origin, piece.position, piece.grainVector]) numbers(value, ['x', 'y'], 'piece placement');
    booleans(piece, ['mirrorX', 'mirrorY', 'seamAllowanceInside'], 'piece');
    const settings = piece.settings3d, arrangement = settings.arrangement;
    if (!arrangement || typeof arrangement !== 'object' || typeof arrangement.mode !== 'string' || typeof arrangement.cylinderName !== 'string') fail(400, 'Missing piece arrangement.');
    booleans(settings, ['enable3d', 'frozen', 'flipNormals', 'filterExternalCollisionsByClothNormal'], 'piece settings');
    numbers(settings, ['collisionLayer'], 'piece settings');
    numbers(arrangement, ['uDegrees', 'v', 'uOffsetMm', 'vOffsetMm', 'radialOffsetMm'], 'arrangement');
    booleans(arrangement, ['use2DPosition', 'positionChanged'], 'arrangement');
    vector(arrangement.matrixWorld, 16, 'arrangement matrix'); vector(arrangement.position, 3, 'arrangement position');
    if (!Array.isArray(settings.savedPositions) || settings.savedPositions.length % 5 !== 0 || !settings.savedPositions.every(Number.isFinite)) fail(400, 'Invalid drape checkpoint.');
    for (const edge of [...piece.mainPaths, ...piece.internalPaths]) if (!edge || typeof edge.id !== 'string' || typeof edge.from !== 'string' || typeof edge.to !== 'string') fail(400, 'Invalid piece edge.');
  }
  if (JSON.stringify(pattern).length > 12_000_000) fail(413, 'Document exceeds the 12 MB collaboration limit.');
  try { validateDocumentExtensions(pattern); } catch { fail(400, 'Invalid document extension.'); }
}
/** Atomic persistence for a single Node server process. The directory must be private to that process. */
export class CollaborationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private database: Database | null = null;
  private documentSignatures = new Map<string, string>();
  private persistedVersions = new Map<string, Set<number>>();
  constructor(private directory: string) {}
  private transaction<T>(operation: (db: Database) => Promise<T> | T, persist = true): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, 'collaboration.json');
      if (((await stat(this.directory)).mode & 0o077) !== 0) fail(503, 'The collaboration data directory must be private (mode 0700).');
      if (!this.database) {
        try {
          const stored = JSON.parse(await readFile(file, 'utf8')) as Database & { documentIds?: string[] };
          if (stored.documentIds) stored.documents = await Promise.all(stored.documentIds.map(async (id) => {
            const document = JSON.parse(await readFile(join(this.directory, `document-${id}.json`), 'utf8')) as SharedDocument;
            this.persistedVersions.set(id, new Set(document.versions.filter((version) => !version.pattern).map((version) => version.revision)));
            document.versions = await Promise.all(document.versions.map(async (version) => version.pattern ? version : { ...version, pattern: JSON.parse(await readFile(this.versionFile(id, version.revision), 'utf8')) as Pattern }));
            return document;
          }));
          this.database = stored;
          for (const document of stored.documents) { if (stored.documentIds) this.documentSignatures.set(document.id, this.documentSignature(document)); else this.persistedVersions.set(document.id, new Set()); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (error as NodeJS.ErrnoException).path !== file) throw error; this.database = { users: [], sessions: {}, documents: [] }; }
      }
      const db = this.database;
      const result = await operation(db);
      if (persist) {
        try {
        for (const [key, session] of Object.entries(db.sessions)) if (session.expiresAt < Date.now()) delete db.sessions[key];
        // Accounts/sessions are small. Read polling never rewrites documents, and a save only
        // rewrites the changed document's own retained history rather than every shared project.
        for (const document of db.documents) {
          const signature = this.documentSignature(document);
          if (this.documentSignatures.get(document.id) === signature) continue;
          const previousVersions = this.persistedVersions.get(document.id) ?? new Set<number>();
          for (const version of document.versions) if (!previousVersions.has(version.revision)) await this.atomicWrite(this.versionFile(document.id, version.revision), version.pattern);
          await this.atomicWrite(join(this.directory, `document-${document.id}.json`), { ...document, versions: document.versions.map(({ revision, author, savedAt }) => ({ revision, author, savedAt })) });
          const retained = new Set(document.versions.map((version) => version.revision));
          for (const revision of previousVersions) if (!retained.has(revision)) await rm(this.versionFile(document.id, revision), { force: true });
          this.persistedVersions.set(document.id, retained);
          this.documentSignatures.set(document.id, signature);
        }
        await this.atomicWrite(file, { users: db.users, sessions: db.sessions, documentIds: db.documents.map((document) => document.id) });
        } catch (error) {
          // Discard speculative in-memory mutations. The next operation reloads the last atomic
          // files; a completed document save stays an accepted revision even if a later index write failed.
          this.database = null; this.documentSignatures.clear(); this.persistedVersions.clear();
          throw error;
        }
      }
      return result;
    });
    this.queue = next;
    return next;
  }
  private versionFile(id: string, revision: number) { return join(this.directory, `version-${id}-${revision}.json`); }
  private documentSignature(document: SharedDocument): string {
    return `${document.versions.at(-1)?.revision}/${document.messages.at(-1)?.id ?? ''}/${JSON.stringify(document.members)}`;
  }
  private async atomicWrite(file: string, value: unknown) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); }
    catch (error) { await rm(temp, { force: true }); throw error; }
  }
  register(email: string, password: string, name: string) {
    email = email.trim().toLowerCase(); name = name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !name || name.length > 80 || password.length < 12 || password.length > 256) fail(400, 'Use a valid email, a name, and a password of 12–256 characters.');
    return this.transaction(async (db) => {
      if (db.users.some((user) => user.email === email)) fail(409, 'This account already exists.');
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64) as Buffer).toString('hex');
      const user: User = { id: randomUUID(), email, name, salt, hash };
      db.users.push(user);
      return this.createSession(db, user);
    });
  }
  login(email: string, password: string) {
    if (typeof password !== 'string' || password.length > 256) fail(401, 'Email or password is incorrect.');
    return this.transaction(async (db) => {
      const user = db.users.find((u) => u.email === email.trim().toLowerCase());
      const candidate = await scrypt(password, user?.salt ?? 'unknown-account-salt', 64) as Buffer;
      if (!user || !timingSafeEqual(candidate, Buffer.from(user.hash, 'hex'))) fail(401, 'Email or password is incorrect.');
      return this.createSession(db, user!);
    });
  }
  private createSession(db: Database, user: User) {
    const token = randomBytes(32).toString('hex');
    db.sessions[digest(token)] = { userId: user.id, expiresAt: Date.now() + 7 * 86400_000 };
    return { token, account: cleanAccount(user) };
  }
  private user(db: Database, token: string): User {
    const session = db.sessions[digest(token)];
    const user = session && session.expiresAt > Date.now() && db.users.find((u) => u.id === session.userId);
    return user || fail(401, 'Sign in to the collaboration server.');
  }
  account(token: string) { return this.transaction((db) => cleanAccount(this.user(db, token)), false); }
  logout(token: string) { return this.transaction((db) => { delete db.sessions[digest(token)]; }); }
  list(token: string) { return this.transaction((db) => { const user = this.user(db, token); return db.documents.filter((d) => d.members[user.id]).map((d) => ({ id: d.id, name: d.versions.at(-1)!.pattern.name, role: d.members[user.id], revision: d.versions.at(-1)!.revision })); }, false); }
  create(token: string, pattern: Pattern) {
    validateSharedPattern(pattern);
    return this.transaction((db) => {
      const user = this.user(db, token);
      const document: SharedDocument = { id: randomUUID(), ownerId: user.id, members: { [user.id]: 'owner' }, versions: [{ revision: 1, author: user.name, savedAt: new Date().toISOString(), pattern }], messages: [] };
      db.documents.push(document); return this.view(db, document, user);
    });
  }
  private member(db: Database, token: string, id: string) {
    const user = this.user(db, token);
    const document = db.documents.find((d) => d.id === id);
    if (!document || !document.members[user.id]) fail(404, 'Shared document is unavailable.');
    return { user, document: document! };
  }
  private view(db: Database, document: SharedDocument, user: User) {
    return { id: document.id, changeToken: digest(this.documentSignature(document)), role: document.members[user.id], ...document.versions.at(-1)!, members: Object.entries(document.members).map(([id, role]) => ({ ...cleanAccount(db.users.find((u) => u.id === id)!), role })), versions: document.versions.map(({ revision, author, savedAt }) => ({ revision, author, savedAt })), messages: document.messages };
  }
  get(token: string, id: string) { return this.transaction((db) => { const { user, document } = this.member(db, token, id); return this.view(db, document, user); }, false); }
  save(token: string, id: string, revision: number, pattern: Pattern) {
    validateSharedPattern(pattern);
    return this.transaction((db) => {
      const { user, document } = this.member(db, token, id);
      if (document.members[user.id] === 'viewer') fail(403, 'Viewers cannot edit shared documents.');
      if (document.versions.at(-1)!.revision !== revision) fail(409, 'The shared document changed. Load the server version or save your draft separately.');
      if (pattern.id !== document.versions.at(-1)!.pattern.id) fail(400, 'Pattern identity cannot change.');
      document.versions.push({ revision: revision + 1, author: user.name, savedAt: new Date().toISOString(), pattern });
      if (document.versions.length > 50) document.versions.shift();
      return this.view(db, document, user);
    });
  }
  version(token: string, id: string, revision: number) { return this.transaction((db) => { const { document } = this.member(db, token, id); return document.versions.find((v) => v.revision === revision) ?? fail(404, 'Version unavailable.'); }, false); }
  grant(token: string, id: string, email: string, role: 'editor' | 'viewer' | 'remove') {
    if (!['editor', 'viewer', 'remove'].includes(role)) fail(400, 'Invalid member role.');
    return this.transaction((db) => {
      const { user, document } = this.member(db, token, id);
      if (document.ownerId !== user.id) fail(403, 'Only the owner can manage access.');
      const member = db.users.find((u) => u.email === email.trim().toLowerCase());
      if (!member) fail(404, 'Ask this collaborator to register an account first.');
      if (member!.id === document.ownerId) fail(400, 'Owner access cannot be removed.');
      if (role === 'remove') delete document.members[member!.id]; else document.members[member!.id] = role;
      return this.view(db, document, user);
    });
  }
  chat(token: string, id: string, text: string) {
    text = text.trim(); if (!text || text.length > 2000) fail(400, 'Messages must contain 1–2000 characters.');
    return this.transaction((db) => {
      const { user, document } = this.member(db, token, id);
      document.messages.push({ id: randomUUID(), author: user.name, userId: user.id, text, sentAt: new Date().toISOString() });
      if (document.messages.length > 200) document.messages.shift();
      return this.view(db, document, user);
    });
  }
}
export const collaborationStore = new CollaborationStore(process.env.SEAMER_DATA_DIR ?? join(process.cwd(), '.seamer-data'));
