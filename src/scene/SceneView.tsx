import { useEffect, useRef, useState } from 'react';
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
import { HandJog, JOG_CODES, noKeys, type JogKeys } from './jog.ts';

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
  const [focused, setFocused] = useState(false);
  const [viewDrag, setViewDrag] = useState(false);
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
    // left button: nothing (the mouse is the gaze); right orbits, middle pans, wheel zooms
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enableZoom = true;
    controls.minDistance = 0.5;
    controls.maxDistance = 5;
    controls.update();
    // debugging / e2e helper: distance of the camera from its orbit target
    (window as unknown as { __gazeViewDistance: () => number }).__gazeViewDistance = () => camera.position.distanceTo(controls.target);

    scene.add(new THREE.HemisphereLight(0xdde6f0, 0x1a2028, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);

    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    root.updateMatrixWorld(true);

    // debugging / e2e helper: normalized screen position of a robot-frame point
    (window as unknown as { __gazeProject: (p: Vec3) => [number, number] }).__gazeProject = (p) => {
      const v = root.localToWorld(new THREE.Vector3(p[0], p[1], p[2])).project(camera);
      return [(v.x + 1) / 2, (1 - v.y) / 2];
    };

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
    // Mouse = gaze only (hover); right drag orbits, middle drag pans, wheel zooms.
    // The hand is driven by the keyboard (W/A/S/D horizontal relative to the view, Q/E vertical,
    // Shift = slow) with smoothly ramped velocity (see jog.ts).
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const keys: JogKeys = noKeys();
    const jog = new HandJog();
    let viewDrag = false;

    const toRobot = (p: THREE.Vector3): Vec3 => {
      const v = root.worldToLocal(p.clone());
      return [v.x, v.y, v.z];
    };

    const setRay = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as [number, number];
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
      canvas.focus(); // any click gives the canvas the keyboard
      if (e.button === 1 || e.button === 2) {
        // viewpoint manipulation: freeze the gaze until the button is released
        viewDrag = true;
        setViewDrag(true);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!interactiveRef.current || viewDrag) return;
      // the cursor stands in for the operator's gaze
      updateGazeFromPointer(setRay(e));
    };
    const endViewDrag = (e: PointerEvent) => {
      if (!viewDrag || (e.buttons & 6) !== 0) return; // still holding right/middle
      viewDrag = false;
      setViewDrag(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const k = JOG_CODES[e.code];
      if (!k || !interactiveRef.current) return;
      e.preventDefault();
      keys[k] = e.type === 'keydown';
    };
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      setFocused(false);
      // keys released while unfocused would otherwise stay "pressed"
      Object.assign(keys, noKeys());
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endViewDrag);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('keyup', onKey);
    canvas.addEventListener('focus', onFocus);
    canvas.addEventListener('blur', onBlur);
    setFocused(document.activeElement === canvas);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      // portrait screens (phones): widen the vertical field of view so the whole arm fits
      camera.fov = camera.aspect < 1 ? Math.min(85, 40 / camera.aspect) : 40;
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

      // keyboard jogging with smoothly ramped velocity
      if (isOp && interactiveRef.current) {
        // view-relative horizontal direction: camera forward projected onto the table
        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        const f = toRobot(fwd.add(root.localToWorld(new THREE.Vector3())));
        const fl = Math.hypot(f[0], f[1]) || 1;
        const d = jog.step(dt, keys, [f[0] / fl, f[1] / fl]);
        if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-7) {
          const h = session.master.handTarget;
          const want: Vec3 = [h[0] + d[0], h[1] + d[1], h[2] + d[2]];
          const c = clampHand(want);
          for (let i = 0; i < 3; i++) if (c[i] !== want[i]) jog.stopAxis(i);
          session.setHand(c);
        }
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
      window.removeEventListener('pointerup', endViewDrag);
      renderer.dispose();
      host.removeChild(canvas);
    };
  }, [session]);

  return (
    <div className="scene" ref={hostRef}>
      {interactive && !focused && <div className="scene-overlay focus">画面をクリックしてから操作（W・A・S・D・Q・E）</div>}
      {viewDrag && <div className="scene-overlay view">視点操作中（視線の更新を停止）</div>}
    </div>
  );
}
