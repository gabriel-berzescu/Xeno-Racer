/**
 * Tree lab: a flat meadow with rows of trees at increasing distance in front of the camera (view=treelab), built
 * from the same tree system the tracks use. Use x,y,z,tx,ty,tz to frame it. `rows=16,28,45,...` overrides the
 * row distances (m), `h=14` the tree height.
 */
import * as THREE from 'three';
import type { EnvironmentState, QualityLevel } from '../../src/core/contracts';
import type { TrackScene } from '../../src/core/systems';
import { instantiateTrees } from '../../src/track/scene/trees';
import type { Inst } from '../../src/track/scene/trees';
import type { SpeciesId } from '../../src/track/types';

export function buildTreeLab(quality: QualityLevel, env: EnvironmentState, q: URLSearchParams): TrackScene {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4d6a22, roughness: 1 }),
  );
  ground.receiveShadow = true;
  root.add(ground);
  const rows = (q.get('rows') ?? '16,28,45,70,105,150,220,330,480').split(',').map(Number);
  const h = parseFloat(q.get('h') ?? '14');
  const order: SpeciesId[] = ['oak', 'pine', 'poplar', 'oak', 'pine'];
  const inst: Record<SpeciesId, Inst[]> = { oak: [], poplar: [], pine: [], birch: [], palm: [] };
  let k = 0;
  rows.forEach((z, ri) => {
    order.forEach((sp, j) => {
      k++;
      const hh = h * (sp === 'poplar' ? 1.5 : sp === 'pine' ? 1.15 : 1) * (0.9 + 0.2 * ((k * 0.618) % 1));
      inst[sp].push({ x: ((j - 2) * 0.24 + ((ri % 3) - 1) * 0.075) * z + ((k * 7) % 5) - 2, y: 0, z, yaw: k * 2.4, s: hh, tint: 0.94 + 0.12 * ((k * 0.37) % 1), hue: ((k * 0.53) % 1) * 0.2 - 0.1, w: 0.9 + 0.2 * ((k * 0.29) % 1) });
    });
  });
  const tier = { low: 0, medium: 1, high: 2, ultra: 3 }[quality];
  const sys = instantiateTrees(inst, tier, 8, 100);
  root.add(sys.group);
  const scene: TrackScene = {
    root,
    update(_dt, camera) {
      sys.update(camera, performance.now() / 1000);
    },
    setStartLights() {},
    setEnvironment(e) {
      sys.setSun(e.sunDirection, e.sunIntensity, parseFloat(q.get('glow') ?? '1'));
    },
    tvCameras: [],
    dispose() {
      for (const d of sys.disposables) d.dispose();
    },
  };
  scene.setEnvironment(env);
  return scene;
}
