import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DEFAULT_ENV } from '../../core/sim/env.ts';
import { Q_INIT, ikStep, tcpPosition } from '../../core/sim/kinematics.ts';
import type { Vec3 } from '../../core/math/vec.ts';
import { PandaModel } from './panda.ts';
import { buildWorld } from './world.ts';

export function SceneView() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    // three frame: (x, y, z) = robot (x, z, -y); view from the robot's right side, slightly behind
    camera.position.set(-0.35, 1.25, 1.75);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.42, 0.2, 0);
    // left button is reserved for moving the hand; right button orbits
    controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.enableZoom = false;
    controls.update();

    scene.add(new THREE.HemisphereLight(0xdde6f0, 0x1a2028, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);

    // robot frame (z up) -> three frame (y up)
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);

    const world = buildWorld(DEFAULT_ENV);
    root.add(world.group);

    const arm = new PandaModel('real');
    root.add(arm.group);

    // Stage-2 demo: the tool follows a slow figure-eight through IK.
    const q = [...Q_INIT];
    const home = tcpPosition(q);
    const t0 = performance.now();

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

    let raf = 0;
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      const target: Vec3 = [
        home[0] + 0.15 + 0.1 * Math.sin(0.6 * t),
        home[1] + 0.2 * Math.sin(0.3 * t),
        home[2] - 0.15 + 0.08 * Math.sin(0.9 * t),
      ];
      for (let k = 0; k < 16; k++) ikStep(q, target);
      arm.update(q);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div className="scene" ref={hostRef} />;
}
