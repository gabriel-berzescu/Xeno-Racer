/** Runs the report groups (shared by the ?test=1 page and the interactive bench). */
import { type Check, Checks } from './report-util';
import { allEngines } from './report-engines';
import { impactChecks, roadChecks, spatialChecks, tireChecks } from './report-chassis';
import { cpuChecks, masterChecks, musicChecks, realtimeChecks, uiChecks } from './report-misc';

export const GROUPS = ['engines', 'tires', 'road', 'impacts', 'spatial', 'ui', 'music', 'master', 'cpu', 'realtime'] as const;
export type Group = (typeof GROUPS)[number];

export interface Saved {
  results: Record<string, unknown>;
  checks: Record<string, Check[]>;
  timings: Record<string, number>;
}

const RUNNERS: Record<Group, (c: Checks) => Promise<unknown>> = {
  engines: allEngines,
  tires: tireChecks,
  road: roadChecks,
  impacts: impactChecks,
  spatial: spatialChecks,
  ui: uiChecks,
  music: musicChecks,
  master: masterChecks,
  cpu: cpuChecks,
  realtime: realtimeChecks,
};

export interface FinalReport {
  ok: boolean;
  checks: number;
  passed: number;
  ms: number;
  timings: Record<string, number>;
  failed: Check[];
  [group: string]: unknown;
}

/** Run the selected groups (skipping any already present in `saved`), persisting after each group. */
export async function runGroups(
  only: string[] | null,
  saved: Saved,
  hooks: { onStart?: (g: Group) => void; onDone?: (g: Group, ms: number) => void; persist?: (s: Saved) => void } = {},
): Promise<FinalReport> {
  const t0 = performance.now();
  for (const g of GROUPS) {
    if (only && !only.includes(g)) continue;
    if (saved.results[g] !== undefined) continue;
    hooks.onStart?.(g);
    const c = new Checks();
    const s = performance.now();
    saved.results[g] = await RUNNERS[g](c);
    saved.checks[g] = c.list;
    saved.timings[g] = Math.round(performance.now() - s);
    hooks.persist?.(saved);
    hooks.onDone?.(g, saved.timings[g]);
  }
  const all: Check[] = GROUPS.flatMap((g) => saved.checks[g] ?? []);
  const failed = all.filter((c) => !c.pass);
  return {
    ok: failed.length === 0,
    checks: all.length,
    passed: all.length - failed.length,
    ms: Math.round(performance.now() - t0),
    timings: saved.timings,
    failed,
    ...saved.results,
  };
}
