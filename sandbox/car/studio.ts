import * as THREE from 'three';

/**
 * A photo-studio environment for judging paint: graded dark cyclorama, long overhead strip
 * lights (crisp parallel highlights down the hood, roof and flanks), tall side strips, low
 * front/rear fills and a warm/teal accent pair so metallic paint shows its colour travel.
 */
export function createStudioScene(): THREE.Scene {
  const scene = new THREE.Scene();

  // vertical gradient dome
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#5d626b'); // zenith
  grd.addColorStop(0.35, '#3a3d44');
  grd.addColorStop(0.5, '#25272c'); // horizon
  grd.addColorStop(0.52, '#101114');
  grd.addColorStop(1, '#040405');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
  scene.add(dome);

  const lamp = (w: number, h: number, c: THREE.ColorRepresentation, k: number, pos: [number, number, number], look: [number, number, number], roll = 0): void => {
    const col = new THREE.Color(c).multiplyScalar(k);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(...look);
    m.rotateZ(roll);
    scene.add(m);
  };
  // overhead strips running along the car (z), three of them
  lamp(0.7, 11, 0xfff7ee, 9, [0, 8.5, 0], [0, 0, 0], Math.PI / 2 * 0);
  lamp(0.5, 11, 0xffffff, 7, [2.6, 8.2, 0], [0, 0, 0]);
  lamp(0.5, 11, 0xffffff, 7, [-2.6, 8.2, 0], [0, 0, 0]);
  // a wide soft fill above, dimmer
  lamp(9, 6, 0xdde6ff, 1.2, [0, 9.5, 0], [0, 0, 0]);
  // tall strips either side (long highlight down the flank)
  lamp(7.5, 1.1, 0xeaf3ff, 18, [-9, 3.0, 0], [0, 1, 0], Math.PI / 2);
  lamp(7.5, 1.1, 0xfff1e3, 18, [9, 3.0, 0], [0, 1, 0], Math.PI / 2);
  // lower side strips for the sills / arches
  lamp(9, 0.5, 0xffffff, 6, [-8, 0.9, 0], [0, 0.7, 0], Math.PI / 2);
  lamp(9, 0.5, 0xffffff, 6, [8, 0.9, 0], [0, 0.7, 0], Math.PI / 2);
  // front / rear low fills
  lamp(8, 1.2, 0xffffff, 5, [0, 1.6, 13], [0, 1, 0]);
  lamp(8, 1.2, 0xffffff, 5, [0, 1.6, -13], [0, 1, 0]);
  // accents
  lamp(1.6, 3.2, 0xffa860, 9, [-10, 1.2, -7], [0, 1, 0]);
  lamp(1.6, 3.2, 0x2fe0c0, 5, [10, 1.2, 7], [0, 1, 0]);
  return scene;
}
