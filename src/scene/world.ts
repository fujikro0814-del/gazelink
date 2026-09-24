// Static task environment meshes (table, wall, target box, rings) in robot coordinates.
import * as THREE from 'three';
import type { Box, Environment, Ring } from '../../core/sim/env.ts';

function boxMesh(b: Box, material: THREE.Material): THREE.Mesh {
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  return mesh;
}

function ringMesh(r: Ring, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(r.radius, 0.006, 12, 48), material);
  mesh.position.set(...r.center);
  // torus axis is local z; align it with the ring axis
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...r.axis));
  return mesh;
}

export interface WorldMeshes {
  group: THREE.Group;
  floor: THREE.Mesh;
  rings: Map<string, THREE.Mesh>;
  wall: THREE.Mesh;
  target: THREE.Mesh;
}

export function buildWorld(env: Environment): WorldMeshes {
  const group = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x1a2129, roughness: 0.95 }),
  );
  floor.position.set(0.35, 0, env.floorZ - 0.0005);
  group.add(floor);

  const grid = new THREE.GridHelper(1.8, 36, 0x33404d, 0x252e38);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(0.35, 0, env.floorZ);
  group.add(grid);

  const wall = boxMesh(
    env.wall,
    new THREE.MeshStandardMaterial({ color: 0x8793a0, roughness: 0.7, transparent: true, opacity: 0.55 }),
  );
  const wallEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(wall.geometry),
    new THREE.LineBasicMaterial({ color: 0xb8c4d0 }),
  );
  wall.add(wallEdges);
  group.add(wall);

  const target = boxMesh(env.target, new THREE.MeshStandardMaterial({ color: 0x3fb27f, roughness: 0.5 }));
  group.add(target);

  const rings = new Map<string, THREE.Mesh>();
  for (const r of env.rings) {
    const m = ringMesh(r, new THREE.MeshStandardMaterial({ color: 0xffc857, emissive: 0x6b4a00, roughness: 0.4 }));
    rings.set(r.id, m);
    group.add(m);
  }

  return { group, floor, rings, wall, target };
}
