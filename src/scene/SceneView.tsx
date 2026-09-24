import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export function SceneView() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
    camera.position.set(1.4, 1.1, 1.2);
    camera.lookAt(0.35, 0.25, 0);

    scene.add(new THREE.HemisphereLight(0xdde6f0, 0x202830, 1.2));
    const grid = new THREE.GridHelper(2, 20, 0x3a4654, 0x232b35);
    scene.add(grid);

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
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div className="scene" ref={hostRef} />;
}
