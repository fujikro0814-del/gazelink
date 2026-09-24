// Task environment: a stiff wall, the table, a target box, and waypoint rings.
// All coordinates are in the robot base frame (z up, x forward).
import { ENV } from '../config.ts';
import type { Vec3 } from '../math/vec.ts';

export interface Box {
  id: string;
  min: Vec3;
  max: Vec3;
}

export interface Ring {
  id: string;
  center: Vec3;
  /** Unit axis of the ring (direction of passage). */
  axis: Vec3;
  radius: number;
}

export interface Environment {
  wall: Box;
  target: Box;
  rings: Ring[];
  floorZ: number;
}

export const DEFAULT_ENV: Environment = {
  wall: { id: 'wall', min: [0.62, -0.3, 0.0], max: [0.66, 0.3, 0.42] },
  target: { id: 'target', min: [0.49, 0.17, 0.0], max: [0.57, 0.25, 0.06] },
  rings: [
    { id: 'ring1', center: [0.46, -0.16, 0.3], axis: [1, 0, 0], radius: 0.06 },
    { id: 'ring2', center: [0.5, 0.1, 0.2], axis: [1, 0, 0], radius: 0.06 },
  ],
  floorZ: 0,
};

/** Penetration of point p into an axis-aligned box: depth > 0 inside, with outward normal. */
export function boxPenetration(p: Vec3, b: Box): { depth: number; normal: Vec3 } {
  const faces: Array<[number, Vec3]> = [
    [p[0] - b.min[0], [-1, 0, 0]],
    [b.max[0] - p[0], [1, 0, 0]],
    [p[1] - b.min[1], [0, -1, 0]],
    [b.max[1] - p[1], [0, 1, 0]],
    [p[2] - b.min[2], [0, 0, -1]],
    [b.max[2] - p[2], [0, 0, 1]],
  ];
  let best = faces[0];
  for (const f of faces) if (f[0] < best[0]) best = f;
  return { depth: best[0], normal: best[1] };
}

/** Euclidean distance from p to the box surface (0 inside). */
export function boxDistance(p: Vec3, b: Box): number {
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]);
  const dy = Math.max(b.min[1] - p[1], 0, p[1] - b.max[1]);
  const dz = Math.max(b.min[2] - p[2], 0, p[2] - b.max[2]);
  return Math.hypot(dx, dy, dz);
}

export const CONTACT_WALL = 1;
export const CONTACT_FLOOR = 2;
export const CONTACT_TARGET = 4;

export interface Contact {
  force: Vec3;
  /** Bit set of CONTACT_* flags. */
  flags: number;
  /** Largest penetration depth [m]. */
  depth: number;
}

function penalty(depth: number, normal: Vec3, v: Vec3, k: number, b: number, out: Vec3): number {
  // Unilateral spring-damper along the normal; never pulls the tool into the surface.
  const vn = v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2];
  const fn = Math.max(0, k * depth - b * vn);
  out[0] += fn * normal[0];
  out[1] += fn * normal[1];
  out[2] += fn * normal[2];
  return fn;
}

/** Contact force on the tool point at position p moving with velocity v. */
export function contactForce(p: Vec3, v: Vec3, env: Environment = DEFAULT_ENV): Contact {
  const force: Vec3 = [0, 0, 0];
  let flags = 0;
  let depth = 0;
  const w = boxPenetration(p, env.wall);
  if (w.depth > 0) {
    penalty(w.depth, w.normal, v, ENV.wallK, ENV.wallB, force);
    flags |= CONTACT_WALL;
    depth = Math.max(depth, w.depth);
  }
  const t = boxPenetration(p, env.target);
  if (t.depth > 0) {
    penalty(t.depth, t.normal, v, ENV.wallK, ENV.wallB, force);
    flags |= CONTACT_TARGET;
    depth = Math.max(depth, t.depth);
  }
  const fz = env.floorZ - p[2];
  if (fz > 0) {
    penalty(fz, [0, 0, 1], v, ENV.floorK, ENV.floorB, force);
    flags |= CONTACT_FLOOR;
    depth = Math.max(depth, fz);
  }
  return { force, flags, depth };
}

/**
 * Distance from p to the nearest obstacle for the damping law. Only the wall counts: the target
 * sits on the table, so treating the table as an obstacle would make the target area heavy.
 */
export function obstacleDistance(p: Vec3, env: Environment = DEFAULT_ENV): number {
  return boxDistance(p, env.wall);
}

/** True if the segment prev -> cur passes through the ring disk (in either direction). */
export function ringCrossed(prev: Vec3, cur: Vec3, ring: Ring): boolean {
  const a = ring.axis;
  const sp = (prev[0] - ring.center[0]) * a[0] + (prev[1] - ring.center[1]) * a[1] + (prev[2] - ring.center[2]) * a[2];
  const sc = (cur[0] - ring.center[0]) * a[0] + (cur[1] - ring.center[1]) * a[1] + (cur[2] - ring.center[2]) * a[2];
  if (sp === sc || Math.sign(sp) === Math.sign(sc)) return false;
  const t = sp / (sp - sc);
  const x: Vec3 = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1]), prev[2] + t * (cur[2] - prev[2])];
  return Math.hypot(x[0] - ring.center[0], x[1] - ring.center[1], x[2] - ring.center[2]) < ring.radius;
}

/** Target reached: tool within 1.5 cm above the top face of the target box, inside its footprint. */
export function targetReached(p: Vec3, env: Environment = DEFAULT_ENV): boolean {
  const b = env.target;
  return (
    p[0] > b.min[0] && p[0] < b.max[0] && p[1] > b.min[1] && p[1] < b.max[1] && p[2] < b.max[2] + 0.015 && p[2] > b.max[2] - 0.01
  );
}
