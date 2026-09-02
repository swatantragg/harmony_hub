import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * The library is served from the catalogue, not from Drive. This asks the server
 * to pull in anything that was added to the Drive folder from outside the app —
 * dropped in from drive.google.com, the desktop client, a phone — so it shows up
 * here without waiting for the background timer.
 */
export interface SyncSummary {
  mode: 'full' | 'incremental' | 'skipped';
  changed: number;
  adopted: number;
  durationMs: number;
  counts: {
    foldersAdopted: number;
    filesAdopted: number;
    renamed: number;
    refiled: number;
    foldersRenamed: number;
    foldersRefiled: number;
    trashed: number;
    missing: number;
    restored: number;
    contentChanged: number;
  };
}

export const syncNow = (full = false) =>
  api<SyncSummary>('/admin/storage/sync', { method: 'POST', body: { full } });

export function describeSync(s: SyncSummary): string {
  const c = s.counts;
  const bits: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (c.filesAdopted) bits.push(`${plural(c.filesAdopted, 'new file')} added`);
  if (c.foldersAdopted) bits.push(`${plural(c.foldersAdopted, 'new folder')} added`);
  if (c.renamed + c.foldersRenamed) bits.push(`${plural(c.renamed + c.foldersRenamed, 'rename')} followed`);
  if (c.refiled + c.foldersRefiled) bits.push(`${plural(c.refiled + c.foldersRefiled, 'move')} followed`);
  if (c.restored) bits.push(`${plural(c.restored, 'file')} back from the trash`);
  if (c.trashed) bits.push(`${plural(c.trashed, 'file')} now in the Drive trash`);
  if (c.missing) bits.push(`${plural(c.missing, 'file')} no longer in Drive`);
  if (c.contentChanged) bits.push(`${plural(c.contentChanged, 'file')} replaced in Drive`);
  return bits.length ? `${bits.join(', ')}.` : 'Everything here already matches Google Drive.';
}

/** `4s`, then `1m 04s`. Short enough to sit inside a button. */
export function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Seconds since `active` last became true, ticking once a second.
 *
 * A sync over a large Drive takes a while, and a spinner alone does not say
 * whether it is working or wedged — a number that keeps climbing does.
 */
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) { setSeconds(0); return; }
    const startedAt = Date.now();
    setSeconds(0);
    const id = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, [active]);

  return seconds;
}

export function useDriveSync(opts: { onDone?: (s: SyncSummary) => void } = {}) {
  const qc = useQueryClient();
  const done = useRef(opts.onDone);
  done.current = opts.onDone;
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (full?: boolean) => syncNow(full === true),
    onSuccess: (summary) => {
      setLastSyncedAt(new Date().toISOString());
      if (summary.changed > 0) qc.invalidateQueries();
      done.current?.(summary);
    },
  });

  const elapsedSec = useElapsed(mutation.isPending);

  return {
    mutate: mutation.mutate,
    isPending: mutation.isPending,
    error: mutation.error,
    /** How long the run in flight has been going. 0 when nothing is running. */
    elapsedSec,
    elapsed: elapsedLabel(elapsedSec),
    /** When this tab last finished a sync it asked for itself. */
    lastSyncedAt,
  };
}

/**
 * Syncs when the tab comes back to the foreground. Someone who uploads in the
 * Drive tab and switches back here expects to see the file, and a plain reload
 * is not the only way people return to the app.
 */
export function useSyncOnFocus(run: () => void, { minGapMs = 30_000 } = {}) {
  const last = useRef(0);
  const fire = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - last.current < minGapMs) return;
    last.current = Date.now();
    run();
  }, [run, minGapMs]);

  useEffect(() => {
    window.addEventListener('focus', fire);
    document.addEventListener('visibilitychange', fire);
    return () => {
      window.removeEventListener('focus', fire);
      document.removeEventListener('visibilitychange', fire);
    };
  }, [fire]);
}
