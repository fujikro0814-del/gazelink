// Procedural Panda-like arm made of cylinders and boxes (no external meshes).
// Lives in robot coordinates (z up); the caller parents it under a z-up root group.
import * as THREE from 'three';
import { forwardFrames, translation, zAxis } from '../../core/sim/kinematics.ts';

export type ArmStyle = 'real' | 'ghost' | 'predicted';

const Y_UP = new THREE.Vector3(0, 1, 0);

function materials(style: ArmStyle) {
  if (style === 'real') {
    return {
      shell: new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: 0.45, metalness: 0.05 }),
      joint: new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.6 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4, metalness: 0.3 }),
    };
  }
  const color = style === 'ghost' ? 0x4fc3f7 : 0xffa94d;
  const mk = (opacity: number) =>
    new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      roughness: 0.6,
      emissive: color,
      emissiveIntensity: 0.45,
    });
  return { shell: mk(0.3), joint: mk(0.45), accent: mk(0.35) };
}

export class PandaModel {
  readonly group = new THREE.Group();
  private readonly links: THREE.Mesh[] = [];
  private readonly housings: THREE.Mesh[] = [];
  private readonly caps: THREE.Mesh[] = [];
  private readonly hand = new THREE.Group();
  private readonly flangeMatrix = new THREE.Matrix4();

  constructor(style: ArmStyle) {
    const m = materials(style);
    const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 28);

    // base plinth
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.06, 32), m.shell);
    base.rotation.x = Math.PI / 2;
    base.position.z = 0.03;
    this.group.add(base);

    // 9 points (base, 7 joint origins, flange) -> up to 8 link segments
    for (let i = 0; i < 8; i++) {
      const link = new THREE.Mesh(unitCyl, m.shell);
      link.scale.set(0.055, 1, 0.055);
      this.links.push(link);
      this.group.add(link);
    }
    // joint housings (white) with black caps showing the axis
    for (let i = 0; i < 7; i++) {
      const r = i < 4 ? 0.065 : 0.055;
      const housing = new THREE.Mesh(unitCyl, m.shell);
      housing.scale.set(r, 0.13, r);
      const cap = new THREE.Mesh(unitCyl, m.joint);
      cap.scale.set(r * 0.92, 0.136, r * 0.92);
      this.housings.push(housing);
      this.caps.push(cap);
      this.group.add(housing, cap);
    }

    // Franka-Hand-like gripper in the flange frame (flange z axis points out of the flange)
    const flangeDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.012, 24), m.joint);
    flangeDisc.rotation.x = Math.PI / 2;
    flangeDisc.position.z = 0.006;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.065), m.shell);
    body.position.z = 0.045;
    const fingerGeo = new THREE.BoxGeometry(0.018, 0.012, 0.05);
    const f1 = new THREE.Mesh(fingerGeo, m.accent);
    const f2 = new THREE.Mesh(fingerGeo, m.accent);
    f1.position.set(0, 0.02, 0.1);
    f2.position.set(0, -0.02, 0.1);
    this.hand.add(flangeDisc, body, f1, f2);
    this.hand.matrixAutoUpdate = false;
    this.group.add(this.hand);
  }

  update(q: ArrayLike<number>): void {
    const frames = forwardFrames(q);
    const pts: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
    for (const F of frames) pts.push(new THREE.Vector3(...translation(F)));

    const dir = new THREE.Vector3();
    for (let i = 0; i < this.links.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      dir.subVectors(b, a);
      const len = dir.length();
      const link = this.links[i];
      link.visible = len > 0.01;
      if (!link.visible) continue;
      link.position.addVectors(a, b).multiplyScalar(0.5);
      link.quaternion.setFromUnitVectors(Y_UP, dir.normalize());
      link.scale.y = len;
    }
    for (let i = 0; i < 7; i++) {
      const o = new THREE.Vector3(...translation(frames[i]));
      const z = new THREE.Vector3(...zAxis(frames[i]));
      const qt = new THREE.Quaternion().setFromUnitVectors(Y_UP, z);
      this.housings[i].position.copy(o);
      this.housings[i].quaternion.copy(qt);
      this.caps[i].position.copy(o);
      this.caps[i].quaternion.copy(qt);
    }
    const F = frames[7];
    // three's Matrix4.set takes row-major arguments, matching our layout
    this.flangeMatrix.set(F[0], F[1], F[2], F[3], F[4], F[5], F[6], F[7], F[8], F[9], F[10], F[11], 0, 0, 0, 1);
    this.hand.matrix.copy(this.flangeMatrix);
    this.hand.matrixWorldNeedsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
