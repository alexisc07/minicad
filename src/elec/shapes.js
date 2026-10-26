// Utilidades para construir modelos 3D de componentes con primitivas.
import * as THREE from 'three';

export const P = 2.54; // paso estándar entre pines

// ---------------------------------------------------------------- utilidades 3D
const geoCache = new Map();
export function cached(key, make) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    g.computeBoundingBox();
    geoCache.set(key, g);
  }
  return g;
}

export function mat(color, opts = {}) {
  return new THREE.MeshPhongMaterial({ color, shininess: 40, specular: 0x333333, ...opts });
}

export function box(g, w, h, d, m, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), m);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}

export function cyl(g, r, h, m, x = 0, y = 0, z = 0, axis = 'y', seg = 24, r2 = r) {
  const mesh = new THREE.Mesh(cached(`c${r},${r2},${h},${seg}`, () => new THREE.CylinderGeometry(r2, r, h, seg)), m);
  mesh.position.set(x, y, z);
  if (axis === 'x') mesh.rotation.z = -Math.PI / 2;
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  g.add(mesh);
  return mesh;
}

export function sphere(g, r, m, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(cached(`s${r}`, () => new THREE.SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2)), m);
  mesh.position.set(x, y, z);
  g.add(mesh);
  return mesh;
}

// Patita vertical de un componente (desde y0 hasta y1)
export function leg(g, x, z, y0, y1, m, r = 0.3) {
  return cyl(g, r, y1 - y0, m, x, (y0 + y1) / 2, z, 'y', 6);
}

export function label(g, text, w, h, x, y, z, opts = {}) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  const s = 8;
  cv.width = Math.round(w * s * 4);
  cv.height = Math.round(h * s * 4);
  const c = cv.getContext('2d');
  c.fillStyle = opts.color || '#ffffff';
  c.font = `${opts.weight || 'bold'} ${Math.round(cv.height * 0.72)}px "Segoe UI", Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, cv.width / 2, cv.height / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  mesh.position.set(x, y, z);
  mesh.rotation.x = opts.vertical ? 0 : -Math.PI / 2;
  if (opts.rotZ) mesh.rotation.z = opts.rotZ;
  mesh.userData.noPick = true;
  g.add(mesh);
  return mesh;
}

export const METAL = () => mat(0xc9ced6, { shininess: 90, specular: 0x888888 });
export const LEAD = () => mat(0xb9bec6, { shininess: 80 });
export const BLACK = () => mat(0x1d1f23, { shininess: 25 });

