/** 2D debug map: plan (north up, east right) with elevation colours, corner labels, walls; plus elevation/curvature strips. */
import type { TrackRuntimeImpl } from '../../src/track';

export function drawMap(canvas: HTMLCanvasElement, rt: TrackRuntimeImpl): void {
  const W = (canvas.width = innerWidth);
  const H = (canvas.height = innerHeight);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#10151a';
  g.fillRect(0, 0, W, H);
  const b = rt.bounds;
  const stripH = 150;
  const pad = 40;
  const planH = H - stripH - pad * 2;
  const sx = (W - pad * 2) / (b.maxX - b.minX);
  const sz = planH / (b.maxZ - b.minZ);
  const sc = Math.min(sx, sz);
  const ox = W / 2 + ((b.minX + b.maxX) / 2) * sc; // screen x = ox - x*sc  (east = -x is right)
  const oy = pad + planH / 2 + ((b.minZ + b.maxZ) / 2) * sc; // screen y = oy - z*sc (north = +z is up)
  const px = (x: number) => ox - x * sc;
  const py = (z: number) => oy - z * sc;

  // terrain shading sampled from the baked field
  rt.ensureField();
  const cell = 14;
  const t = rt.terrain;
  for (let zz = b.minZ - 250; zz < b.maxZ + 250; zz += cell) {
    for (let xx = b.minX - 250; xx < b.maxX + 250; xx += cell) {
      const h = rt.fieldHeight(xx + cell / 2, zz + cell / 2);
      const lake = t.lakeLevel;
      if (lake !== null && h < lake) g.fillStyle = '#2a6d9c';
      else {
        const k = Math.max(0, Math.min(1, (h - b.minY + 10) / (b.maxY - b.minY + 40)));
        g.fillStyle = `hsl(${110 - k * 70},34%,${20 + k * 34}%)`;
      }
      g.fillRect(px(xx), py(zz) - cell * sc, cell * sc + 1, cell * sc + 1);
    }
  }
  // walls, asphalt edges
  const line = (pts: [number, number][], col: string, w: number) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.beginPath();
    pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), py(z)) : g.moveTo(px(x), py(z))));
    g.stroke();
  };
  const N = rt.count;
  const wl: [number, number][] = [];
  const wr: [number, number][] = [];
  const el: [number, number][] = [];
  const er: [number, number][] = [];
  for (let i = 0; i <= N; i += 2) {
    wl.push([rt.X[i] + rt.HLX[i] * rt.L.wall[i], rt.Z[i] + rt.HLZ[i] * rt.L.wall[i]]);
    wr.push([rt.X[i] - rt.HLX[i] * rt.R.wall[i], rt.Z[i] - rt.HLZ[i] * rt.R.wall[i]]);
    el.push([rt.X[i] + rt.HLX[i] * rt.L.W[i], rt.Z[i] + rt.HLZ[i] * rt.L.W[i]]);
    er.push([rt.X[i] - rt.HLX[i] * rt.R.W[i], rt.Z[i] - rt.HLZ[i] * rt.R.W[i]]);
  }
  line(wl, '#ffb74d', 1);
  line(wr, '#ffb74d', 1);
  line(el, '#e8e8e8', Math.max(1, rt.L.W[0] * sc * 0.4));
  line(er, '#e8e8e8', 1.5);
  g.font = '13px system-ui';
  for (const c of rt.corners) {
    const i = Math.round((c.sArcA + c.sArcB) / 2 / rt.spacing);
    g.fillStyle = '#fff';
    g.fillText(c.name, px(rt.X[i]) + 6, py(rt.Z[i]) - 6);
  }
  g.fillStyle = '#ff4040';
  g.beginPath();
  g.arc(px(rt.X[0]), py(rt.Z[0]), 6, 0, Math.PI * 2);
  g.fill();

  // strips: elevation (top) and curvature (bottom)
  const y0 = H - stripH + 10;
  const sw = W - pad * 2;
  const strip = (arr: ArrayLike<number>, min: number, max: number, top: number, h: number, col: string, label: string) => {
    g.strokeStyle = col;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i <= N; i += 3) {
      const x = pad + (i / N) * sw;
      const y = top + h - ((arr[i] - min) / (max - min)) * h;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = '#9ab';
    g.fillText(`${label}  ${min.toFixed(1)} .. ${max.toFixed(1)}`, pad, top - 2);
  };
  strip(rt.py, b.minY, b.maxY, y0, 55, '#6cf', 'elevation m');
  let kmax = 0;
  for (let i = 0; i < N; i++) kmax = Math.max(kmax, Math.abs(rt.curvature[i]));
  strip(rt.curvature, -kmax, kmax, y0 + 75, 55, '#fc6', 'curvature 1/m (+ = left)');
  g.fillStyle = '#9ab';
  g.fillText(`${rt.info.name}  ${(rt.length / 1000).toFixed(2)} km`, pad, 22);
}
