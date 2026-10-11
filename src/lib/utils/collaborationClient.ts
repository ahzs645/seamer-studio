import { base } from '$app/paths';
import type { Pattern } from '@seamer/pattern-model';
export type SharedRole = 'owner' | 'editor' | 'viewer';
export interface SharedAccount { id: string; email: string; name: string }
export interface SharedDocumentView {
  id: string; role: SharedRole; revision: number; changeToken: string; pattern: Pattern; author: string; savedAt: string;
  members: (SharedAccount & { role: SharedRole })[];
  versions: { revision: number; author: string; savedAt: string }[];
  messages: { id: string; author: string; text: string; sentAt: string; userId: string }[];
}
export class CollaborationClientError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function collaborationRequest<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetch(`${base}/api/collaboration/${path}`, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!result.headers.get('content-type')?.includes('application/json')) throw new CollaborationClientError(503, 'Sharing requires the Seamer Node server.');
  const value = await result.json();
  if (!result.ok) throw new CollaborationClientError(result.status, value.error ?? 'Collaboration request failed.');
  return value as T;
}
/** Geometry/document changes are dirty; transient save markers do not produce publish loops. */
export function sharedDocumentFingerprint(pattern: Pattern): string {
  return JSON.stringify({ ...pattern, hasChanged: undefined });
}
