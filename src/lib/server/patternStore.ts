import type { Pattern, PatternSummary } from '@seamer/pattern-model';

interface StoredPattern {
  pattern: Pattern;
  updatedAt: string;
}

// Single in-memory store shared by all /api/patterns* endpoints.
const store = new Map<string, StoredPattern>();

export function getPattern(id: string): Pattern | undefined {
  return store.get(id)?.pattern;
}

export function putPattern(pattern: Pattern): void {
  store.set(pattern.id, { pattern, updatedAt: new Date().toISOString() });
}

export function deletePattern(id: string): boolean {
  return store.delete(id);
}

export function listPatterns(filter?: (p: Pattern) => boolean): PatternSummary[] {
  return Array.from(store.values())
    .filter(({ pattern }) => (filter ? filter(pattern) : true))
    .map(({ pattern, updatedAt }) => toSummary(pattern, updatedAt));
}

function toSummary(p: Pattern, updatedAt: string): PatternSummary {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    is3d: p.enable3d,
    thumbnailUrl: null,
    updatedAt,
    ownerUserId: 'local',
    organizationId: null,
    organization: null,
    owner: {
      id: 'local',
      firstName: 'Local',
      lastName: null,
      email: '',
      image: null
    }
  };
}
