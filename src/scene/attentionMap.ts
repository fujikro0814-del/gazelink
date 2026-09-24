// Attention field projected on the table as a heat map texture.
import * as THREE from 'three';
import { attentionGrid, type GazeHistory } from '../../core/gaze/attention.ts';

const NX = 56;
const NY = 64;
const BOUNDS = { xMin: 0.1, xMax: 0.8, yMin: -0.4, yMax: 0.4 };

/** Dark-to-magenta ramp, transparent where attention is ~0. */
function ramp(v: number, out: Uint8Array, i: number) {
  const x = Math.min(1, Math.max(0, v));
  out[i] = Math.round(80 + 175 * x);
  out[i + 1] = Math.round(40 + 60 * x * x);
  out[i + 2] = Math.round(120 + 96 * x);
  out[i + 3] = Math.round(200 * Math.pow(x, 0.8));
}

export class AttentionMap {
  readonly mesh: THREE.Mesh;
  private readonly data = new Uint8Array(NX * NY * 4);
  private readonly tex: THREE.DataTexture;

  constructor() {
    this.tex = new THREE.DataTexture(this.data, NX, NY, THREE.RGBAFormat);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    const w = BOUNDS.xMax - BOUNDS.xMin;
    const h = BOUNDS.yMax - BOUNDS.yMin;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false }),
    );
    this.mesh.position.set((BOUNDS.xMin + BOUNDS.xMax) / 2, (BOUNDS.yMin + BOUNDS.yMax) / 2, 0.001);
    this.mesh.renderOrder = 1;
  }

  update(history: GazeHistory, now: number, sigma: number): void {
    const grid = attentionGrid(history, now, sigma, BOUNDS, NX, NY);
    for (let k = 0; k < grid.length; k++) ramp(grid[k], this.data, k * 4);
    this.tex.needsUpdate = true;
  }
}
