/**
 * Bit-identity guard for the cars' geometry: what a change to code the cars' bodies, wheels, cockpits and mirrors share does to the cars
 * it is not meant for. The Dieci's body, its 2004 wheel and its cockpit (formulaCockpit in layouts.ts, which the Volta's eye, cameras and
 * mirrors now read too) went into that code; this probe is what shows that the six other cars are built bit for bit as before.
 *
 * For each car in GEOMHASH_IDS (default: the six cars before the Dieci), at every quality (low, medium, high, ultra), it builds the car's
 * whole CarData (buildCarData: the three body LODs with their parts, the wheels and calipers at two qualities, the interior, the driver and
 * the steering wheel) and hashes everything in it with SHA-256: typed arrays by their bytes, numbers by their float64 bits, keys in their
 * order, the `ms` timings skipped, an absent field absent (so a field new to these cars shows). It also hashes, per car, the numbers the
 * main thread reads beside the meshes (computeLayout, eyePoint, wheelLook, styleForBody, cellScale, mirrorLayout, the door-mirror parts,
 * the blueprint's bounds and info) and, on the high quality's LOD0, the lamps and three surface points of the damage model. It does not
 * hash effects.ts or the shaders' text.
 *
 *   GEOMHASH=record  GEOMHASH_FILE=.cache/geom-hash-before.json  npx vitest run tests/probes/geom-hash.test.ts --reporter=verbose
 *   GEOMHASH=compare GEOMHASH_FILE=.cache/geom-hash-before.json  npx vitest run tests/probes/geom-hash.test.ts --reporter=verbose
 *
 * (`record` writes the file, `compare` builds everything again and prints `geomhash: N entries: ALL IDENTICAL` or the entries that differ,
 * and fails on any. Without GEOMHASH the probe is skipped: it takes under a minute and it is a guard for a change, not a property of the
 * game. GEOMHASH_TREE=<a tree's root> builds the cars of that tree instead of this one's, so that a file can be recorded on a commit from
 * before this probe; that tree needs its own node_modules.)
 *
 * Recorded on main 42fe7ca (before the Dieci) with the same hashing, the six cars of the branch that brought the Dieci compare as
 * `geomhash: 190 entries: ALL IDENTICAL`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODE = process.env.GEOMHASH ?? '';
const FILE = process.env.GEOMHASH_FILE ?? '.cache/geom-hash.json';
const IDS = (process.env.GEOMHASH_IDS ?? 'vanta-gt,kestrel-r,ronin-86,lmp-x,mammoth,volta').split(',');
const TREE = (process.env.GEOMHASH_TREE ?? fileURLToPath(new URL('../..', import.meta.url))).replace(/\\/g, '/').replace(/\/$/, '');
const QUALITIES = ['low', 'medium', 'high', 'ultra'] as const;

/** A module of the tree being hashed (this one, or GEOMHASH_TREE's). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = async (rel: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(`${TREE}/${rel}`).href);

function feed(h: ReturnType<typeof createHash>, v: unknown, path: string): void {
  if (v === undefined) return;
  if (v === null) {
    h.update(`${path}=null;`);
    return;
  }
  if (ArrayBuffer.isView(v)) {
    const a = v as unknown as { constructor: { name: string }; length: number; buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    h.update(`${path}:${a.constructor.name}[${a.length}]`);
    h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return;
  }
  if (typeof v === 'number') {
    h.update(`${path}#`);
    h.update(new Uint8Array(new Float64Array([v]).buffer));
    return;
  }
  if (typeof v === 'string' || typeof v === 'boolean') {
    h.update(`${path}=${String(v)};`);
    return;
  }
  if (typeof v === 'function') return;
  if (Array.isArray(v)) {
    h.update(`${path}[${v.length}]`);
    v.forEach((x, i) => feed(h, x, `${path}.${i}`));
    return;
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      if (k === 'ms') continue;
      feed(h, (v as Record<string, unknown>)[k], `${path}.${k}`);
    }
  }
}

function hashOf(v: unknown): string {
  const h = createHash('sha256');
  feed(h, v, '');
  return h.digest('hex');
}

/** Every car's geometry and the numbers read beside it, one hash per entry. */
async function hashAll(): Promise<Record<string, string>> {
  const { CARS } = await mod('src/cars/index.ts');
  const build = await mod('src/carvis/build.ts');
  const layouts = await mod('src/carvis/layouts.ts');
  const wheels = await mod('src/carvis/wheels.ts');
  const ml = await mod('src/carvis/mirrorLayout.ts');
  const mp = await mod('src/carvis/mirrorParts.ts');
  const parts = await mod('src/carvis/parts.ts');
  const bodies = await mod('src/carvis/bodies/index.ts');
  const dg = await mod('src/carvis/damageGeometry.ts');
  const out: Record<string, string> = {};
  for (const id of IDS) {
    const def = CARS.find((c: { id: string }) => c.id === id);
    expect(def, id).toBeDefined();
    const spec = def.visual;
    const mb = new parts.PartBuilder();
    mp.addDoorMirrors(mb, spec);
    const bp = bodies.BLUEPRINTS[spec.style](spec);
    out[`${id}/layout`] = hashOf({
      layout: layouts.computeLayout(spec),
      eye: layouts.eyePoint(spec),
      // (the era as car.ts and build.ts pass it: absent for every car but the Dieci, as it was before there was one)
      look: layouts.wheelLook(spec.style, spec.formulaEra),
      wheelStyle: wheels.styleForBody(spec.style, spec.formulaEra),
      cell: build.cellScale(spec.style),
      mirrors: ml.mirrorLayout(spec),
      mirrorParts: [mb.pos, mb.nor, mb.zon, mb.idx],
      bounds: bp.bounds,
      info: bp.info,
    });
    for (const q of QUALITIES) {
      const data = await build.buildCarData(spec, q);
      for (const k of Object.keys(data)) out[`${id}/${q}/${k}`] = hashOf(data[k]);
      out[`${id}/${q}/*`] = hashOf(data);
      if (q === 'high') {
        const geo = dg.makeDamageGeometry(data.lod0, spec);
        out[`${id}/lamps`] = hashOf(geo.lamps);
        out[`${id}/surface`] = hashOf([geo.surfacePoint([0.9, 0.6, 2.4], [0, 0, -1]), geo.surfacePoint([-0.9, 0.6, -2.3], [0, 0, 1]), geo.surfacePoint([0.9, 0.5, 0], [-1, 0, 0])]);
      }
    }
  }
  return out;
}

describe('the cars\' geometry', () => {
  it.skipIf(!MODE)(
    `${MODE || 'record or compare'} its hash at every quality (GEOMHASH=record|compare, GEOMHASH_FILE, GEOMHASH_IDS, GEOMHASH_TREE)`,
    async () => {
      const now = await hashAll();
      console.log(`geomhash: ${Object.keys(now).length} entries of ${IDS.join(', ')} in ${TREE}, all: ${hashOf(now)}`);
      if (MODE === 'record') {
        mkdirSync(dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify(now, null, 1));
        console.log(`geomhash: recorded -> ${FILE}`);
        return;
      }
      const before = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
      const keys = new Set([...Object.keys(before), ...Object.keys(now)]);
      const diff = [...keys].filter((k) => before[k] !== now[k]);
      console.log(`geomhash: ${keys.size} entries: ${diff.length === 0 ? 'ALL IDENTICAL' : `${diff.length} differ:\n  ${diff.slice(0, 40).join('\n  ')}`}`);
      expect(diff).toEqual([]);
    },
    900000,
  );
});
