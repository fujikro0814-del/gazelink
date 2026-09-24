import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ENV } from '../../core/config.ts';
import { DEFAULT_ENV } from '../../core/sim/env.ts';
import { Q_INIT, ikStep } from '../../core/sim/kinematics.ts';
import { HIT_FLOOR, HIT_NONE, HIT_RING, HIT_TARGET, HIT_WALL } from '../../core/protocol/messages.ts';
import type { Vec3 } from '../../core/math/vec.ts';
import type { Session } from '../session/Session.ts';
import { PandaModel } from './panda.ts';
import { buildWorld } from './world.ts';
import { AttentionMap } from './attentionMap.ts';
import { predictSlave } from './predict.ts';

export interface SceneOptions {
  showGhost: boolean;
  showPrediction: boolean;
  showHeatmap: boolean;
}

interface Props {
  session: Session;
  options: SceneOptions;
  interactive: boolean;
}

const clampV = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function SceneView({ session, options, interactive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const optsRef = useRef(options);
  optsRef.current = options;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    // three frame: (x, y, z) = robot (x, z, -y)
    camera.position.set(-0.35, 1.25, 1.75);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0.42, 0.2, 0);
    // left button moves the hand; right button orbits; middle pans
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enableZoom = false;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xdde6f0, 0x1a2028, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);

    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    root.updateMatrixWorld(true);

    const world = buildWorld(DEFAULT_ENV);
    root.add(world.group);
    const heat = new AttentionMap();
    root.add(heat.mesh);

    const real = new PandaModel('real');
    const ghost = new PandaModel('ghost');
    const predicted = new PandaModel('predicted');
    root.add(real.group, ghost.group, predicted.group);
    const qGhost = [...Q_INIT];
    const qPred = [...Q_INIT];

    // gaze point marker
    const gazeMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0xff4fd8 }),
    );
    const gazeHalo = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0xff4fd8, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    gazeMarker.add(gazeHalo);
    root.add(gazeMarker);

    // hand marker (mouse target) and work-plane ring
    const handMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.018, 0.024, 32),
      new THREE.MeshBasicMaterial({ color: 0x4fc3f7, side: THREE.DoubleSide }),
    );
    root.add(handMarker);
    const handStem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0x4fc3f7, dashSize: 0.01, gapSize: 0.008 }),
    );
    root.add(handStem);

    // contact force arrow
    const forceArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, 0xff6b6b, 0.03, 0.018);
    root.add(forceArrow);

    // ---------------------------------------------------------------- input
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let handZ = session.master.home[2];
    let dragging = false;
    const keys = new Set<string>();

    const toRobot = (p: THREE.Vector3): Vec3 => {
      const v = root.worldToLocal(p.clone());
      return [v.x, v.y, v.z];
    };

    const setRay = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as [number, number];
    };

    /** intersect the horizontal work plane z = handZ (robot frame) */
    const planeHit = (): Vec3 | null => {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handZ); // three y == robot z
      const p = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, p)) return null;
      return toRobot(p);
    };

    const clampHand = (x: Vec3): Vec3 => [
      clampV(x[0], ENV.workspaceMin[0], ENV.workspaceMax[0]),
      clampV(x[1], ENV.workspaceMin[1], ENV.workspaceMax[1]),
      clampV(x[2], ENV.workspaceMin[2], ENV.workspaceMax[2]),
    ];

    const gazeTargets: Array<[THREE.Object3D, number]> = [
      [world.wall, HIT_WALL],
      [world.target, HIT_TARGET],
      ...[...world.rings.values()].map((m) => [m, HIT_RING] as [THREE.Object3D, number]),
      [world.floor, HIT_FLOOR],
    ];

    const updateGazeFromPointer = (uv: [number, number]) => {
      const hits = raycaster.intersectObjects(gazeTargets.map((g) => g[0]), false);
      if (hits.length) {
        const h = hits[0];
        const kind = gazeTargets.find((g) => g[0] === h.object)?.[1] ?? HIT_NONE;
        session.setGaze({ uv, p: toRobot(h.point), conf: 1, hit: kind, src: 1 });
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!interactiveRef.current || e.button !== 0) return;
      canvas.focus();
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      setRay(e);
      const p = planeHit();
      if (p) session.setHand(clampHand(p));
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!interactiveRef.current) return;
      const uv = setRay(e);
      if (dragging) {
        const p = planeHit();
        if (p) session.setHand(clampHand(p));
      } else {
        // not dragging: the cursor stands in for the operator's gaze
        updateGazeFromPointer(uv);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!interactiveRef.current) return;
      e.preventDefault();
      handZ = clampV(handZ - Math.sign(e.deltaY) * 0.01, ENV.workspaceMin[2] + 0.005, ENV.workspaceMax[2]);
      const h = session.master.handTarget;
      session.setHand([h[0], h[1], handZ]);
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!['w', 'a', 's', 'd', 'q', 'e'].includes(k)) return;
      if (e.type === 'keydown') keys.add(k);
      else keys.delete(k);
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // ---------------------------------------------------------------- frame loop
    let raf = 0;
    let lastFrame = performance.now();
    let lastHeat = 0;
    let lastPred = 0;
    const loop = () => {
      const tNow = performance.now();
      const dt = Math.min(0.1, (tNow - lastFrame) / 1000);
      lastFrame = tNow;
      const opts = optsRef.current;
      const isOp = session.role === 'operator';

      // keyboard hand motion (0.25 m/s)
      if (isOp && interactiveRef.current && keys.size) {
        const h = [...session.master.handTarget] as Vec3;
        const v = 0.25 * dt;
        // screen-relative: w/s along camera forward projected on the table, a/d sideways
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        const f = toRobot(fwd.add(root.localToWorld(new THREE.Vector3())));
        const fl = Math.hypot(f[0], f[1]) || 1;
        const fx = f[0] / fl;
        const fy = f[1] / fl;
        if (keys.has('w')) (h[0] += fx * v), (h[1] += fy * v);
        if (keys.has('s')) (h[0] -= fx * v), (h[1] -= fy * v);
        if (keys.has('d')) (h[0] += fy * v), (h[1] -= fx * v);
        if (keys.has('a')) (h[0] -= fy * v), (h[1] += fx * v);
        if (keys.has('q')) h[2] += v;
        if (keys.has('e')) h[2] -= v;
        const c = clampHand(h);
        handZ = c[2];
        session.setHand(c);
      }

      const st = session.state;
      if (st) real.update(st.q);
      else real.update(Q_INIT);

      // ghost = the command shadow: local master for the operator, the slave's command point for spectators
      const ghostTarget: Vec3 = isOp ? session.master.xm : st ? st.xd : session.master.home;
      for (let k = 0; k < 8; k++) ikStep(qGhost, ghostTarget);
      ghost.update(qGhost);
      ghost.setVisible(opts.showGhost);

      if (opts.showPrediction && isOp && st && tNow - lastPred > 33) {
        lastPred = tNow;
        const p = predictSlave(session);
        if (p) for (let k = 0; k < 8; k++) ikStep(qPred, p);
        predicted.update(qPred);
      }
      predicted.setVisible(opts.showPrediction && isOp && !!st);

      // hand marker
      const hand = session.master.handTarget;
      handMarker.visible = isOp;
      handStem.visible = isOp;
      handMarker.position.set(hand[0], hand[1], hand[2]);
      const stem = handStem.geometry as THREE.BufferGeometry;
      stem.setFromPoints([new THREE.Vector3(hand[0], hand[1], hand[2]), new THREE.Vector3(hand[0], hand[1], 0)]);
      handStem.computeLineDistances();

      // gaze marker
      const g = isOp ? session.gaze : session.remoteGaze;
      gazeMarker.visible = !!g;
      if (g) {
        gazeMarker.position.set(g.p[0], g.p[1], g.p[2]);
        const s = 1 + 0.15 * Math.sin(tNow / 150);
        gazeHalo.scale.setScalar(s);
      }

      // force arrow
      if (st) {
        const f = Math.hypot(st.fe[0], st.fe[1], st.fe[2]);
        forceArrow.visible = f > 0.2;
        if (forceArrow.visible) {
          forceArrow.position.set(st.xs[0], st.xs[1], st.xs[2]);
          forceArrow.setDirection(new THREE.Vector3(st.fe[0] / f, st.fe[1] / f, st.fe[2] / f));
          forceArrow.setLength(Math.min(0.3, 0.05 + f * 0.006), 0.03, 0.018);
        }
      } else forceArrow.visible = false;

      // attention heat map (the client keeps its own copy of the gaze history)
      heat.mesh.visible = opts.showHeatmap;
      if (opts.showHeatmap && tNow - lastHeat > 100) {
        lastHeat = tNow;
        heat.update(session.gazeHistory, session.gazeTime(), session.ctrlcfg.gaze.sigma);
      }

      // ring highlight when passed
      for (const [id, mesh] of world.rings) {
        const passed = session.ringsPassed.has(id);
        (mesh.material as THREE.MeshStandardMaterial).color.set(passed ? 0x7bd88f : 0xffc857);
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      renderer.dispose();
      host.removeChild(canvas);
    };
  }, [session]);

  return <div className="scene" ref={hostRef} />;
}
