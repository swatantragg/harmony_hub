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

export const registerTag = (name: string, force = false) =>
  api<TagSuggestion>('/tags', { method: 'POST', body: { name, force } }).catch(() => null);


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

export function isSameTag(a: string, b: string): boolean {
  return normaliseTag(a) === normaliseTag(b);
}

export function isNearTag(candidate: string, other: string): boolean {
  const x = normaliseTag(candidate);
  const y = normaliseTag(other);
  if (!x || !y || x === y) return false;
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

export function groupTypes(types: AssetTypeDef[]): [Family, AssetTypeDef[]][] {
  const families: Family[] = ['Audio', 'Video', 'Image', 'Document'];
  return families
    .map((f) => [f, types.filter((t) => t.family === f).sort((a, b) => Number(a.custom) - Number(b.custom))] as [Family, AssetTypeDef[]])
    .filter(([, list]) => list.length > 0);
}

export function useLanguages() {
  return useQuery({
    queryKey: ['vocabulary-languages'],
    queryFn: () => api<{ languages: string[]; moods: string[] }>('/tags'),
    staleTime: 300_000,
    select: (d) => d.languages ?? [],
  });
}
