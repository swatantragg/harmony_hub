// Shared hooks for the two vocabularies a person can extend: asset types and tags.
// Both go through the server's similarity check before anything new is created, so the
// library never quietly ends up with "Press Kit", "Presskit" and "press-kit".
import { useQuery } from '@tanstack/react-query';
import { api, qs } from './api';
import type { AssetTypeDef, Family, FolderOption, TagSuggestion } from './types';

export function useAssetTypes() {
  return useQuery({
    queryKey: ['asset-types'],
    queryFn: () => api<{ data: AssetTypeDef[]; families: Family[]; builtinCount: number; customCount: number }>('/asset-types'),
    staleTime: 60_000,
  });
}

export function useFolderOptions() {
  return useQuery({
    queryKey: ['folder-options'],
    queryFn: () => api<FolderOption[]>('/folders/lookup/options'),
    staleTime: 30_000,
  });
}

export const fetchSimilarTags = (name: string) =>
  api<{ exact: TagSuggestion | null; suggestions: TagSuggestion[] }>(`/tags/similar${qs({ name })}`);

// Registers a custom tag in the shared vocabulary the moment it is added, rather than
// waiting for the upload to finish. Without this, a tag typed on one file is invisible to
// the duplicate check on the next one — which is exactly how "aloo wada" and "Aloo Wada"
// end up as two tags in the same session.
export const registerTag = (name: string, force = false) =>
  api<TagSuggestion>('/tags', { method: 'POST', body: { name, force } }).catch(() => null);

// ── Duplicate detection, mirrored from the server ───────────────────────────
// The same normalisation and edit distance run here so tags that exist only in the
// current session — typed a minute ago, not yet uploaded — are caught too.

export const normaliseTag = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export interface TagMatch {
  name: string;
  usageCount: number | null;
  source: 'library' | 'session';
  applied: boolean;
  confidence: number;
}

/** True when two tag names are the same idea spelled differently. */
export function isSameTag(a: string, b: string): boolean {
  return normaliseTag(a) === normaliseTag(b);
}

/** True when `other` is close enough to `candidate` to be worth offering instead. */
export function isNearTag(candidate: string, other: string): boolean {
  const x = normaliseTag(candidate);
  const y = normaliseTag(other);
  if (!x || !y || x === y) return false;
  // One name containing the other is the common real-world case: "aloo" vs "aloo wada".
  if (y.includes(x) || x.includes(y)) return true;
  const longest = Math.max(x.length, y.length);
  return levenshtein(x, y) <= Math.max(1, Math.round(longest * 0.28));
}

export function nearTagConfidence(candidate: string, other: string): number {
  const x = normaliseTag(candidate);
  const y = normaliseTag(other);
  const longest = Math.max(x.length, y.length) || 1;
  return Math.max(0, 1 - levenshtein(x, y) / longest);
}

export const fetchSimilarTypes = (type: string) =>
  api<{ exact: AssetTypeDef | null; suggestions: AssetTypeDef[] }>(`/asset-types/similar${qs({ type })}`);

// Groups a flat type list by family, custom types last inside each group so the
// familiar catalogue stays where people expect it.
export function groupTypes(types: AssetTypeDef[]): [Family, AssetTypeDef[]][] {
  const families: Family[] = ['Audio', 'Video', 'Image', 'Document'];
  return families
    .map((f) => [f, types.filter((t) => t.family === f).sort((a, b) => Number(a.custom) - Number(b.custom))] as [Family, AssetTypeDef[]])
    .filter(([, list]) => list.length > 0);
}
