// Extracción de aristas "reales" de un sólido. A diferencia de EdgesGeometry,
// ignora las aristas falsas que dejan las operaciones booleanas (uniones en T
// dentro de una misma cara plana).
import * as THREE from 'three';

export function featureEdges(geom, angleDeg = 28) {
  const pa = geom.attributes.position;
  const idx = geom.index;
  const triCount = Math.floor((idx ? idx.count : pa.count) / 3);
  const cosT = Math.cos((angleDeg * Math.PI) / 180);

  // Fusiona vértices coincidentes
  const q = 1e4;
  const vmap = new Map();
  const vx = [];
  const vid = new Int32Array(idx ? pa.count : pa.count);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = vmap.get(key);
    if (id === undefined) {
      id = vx.length / 3;
      vmap.set(key, id);
      vx.push(x, y, z);
    }
    vid[i] = id;
  }

  const normals = new Float32Array(triCount * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edges = new Map();
  const tv = (t, k) => vid[idx ? idx.getX(t * 3 + k) : t * 3 + k];
  for (let t = 0; t < triCount; t++) {
    const i0 = tv(t, 0), i1 = tv(t, 1), i2 = tv(t, 2);
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    a.fromArray(vx, i0 * 3);
    b.fromArray(vx, i1 * 3);
    c.fromArray(vx, i2 * 3);
    const n = c.sub(b).cross(a.sub(b));
    const len = n.length();
    if (len < 1e-12) continue;
    n.divideScalar(len);
    normals[t * 3] = n.x;
    normals[t * 3 + 1] = n.y;
    normals[t * 3 + 2] = n.z;
    for (const [u, v] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const key = u < v ? u * 4294967 + v : v * 4294967 + u;
      let e = edges.get(key);
      if (!e) edges.set(key, (e = { u, v, tris: [] }));
      e.tris.push(t);
    }
  }

  const out = [];
  const dot = (t1, t2) => normals[t1 * 3] * normals[t2 * 3] + normals[t1 * 3 + 1] * normals[t2 * 3 + 1] + normals[t1 * 3 + 2] * normals[t2 * 3 + 2];
  const push = (u, v) => out.push(vx[u * 3], vx[u * 3 + 1], vx[u * 3 + 2], vx[v * 3], vx[v * 3 + 1], vx[v * 3 + 2]);
  const loose = [];
  for (const e of edges.values()) {
    if (e.tris.length === 2) {
      if (dot(e.tris[0], e.tris[1]) < cosT) push(e.u, e.v);
    } else if (e.tris.length === 1) loose.push(e);
    else push(e.u, e.v);
  }

  // Aristas sueltas: se agrupan por recta y se descartan las que tienen al
  // otro lado una cara coplanar (uniones en T)
  if (loose.length) {
    const buckets = new Map();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), d = new THREE.Vector3(), p0 = new THREE.Vector3();
    for (const e of loose) {
      A.fromArray(vx, e.u * 3);
      B.fromArray(vx, e.v * 3);
      d.subVectors(B, A).normalize();
      // Sentido canónico: primera componente claramente no nula, positiva
      const lead = Math.abs(d.x) > 1e-4 ? d.x : Math.abs(d.y) > 1e-4 ? d.y : d.z;
      if (lead < 0) d.negate();
      p0.copy(A).addScaledVector(d, -A.dot(d));
      const key = [d.x, d.y, d.z].map((v) => Math.round(v * 100)).join(',') + '|' + [p0.x, p0.y, p0.z].map((v) => Math.round(v * 5)).join(',');
      e.d = d.clone();
      e.p0 = p0.clone();
      e.t0 = A.dot(d);
      e.t1 = B.dot(d);
      if (e.t0 > e.t1) [e.t0, e.t1] = [e.t1, e.t0];
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(e);
    }
    for (const list of buckets.values()) {
      for (const e of list) {
        let coplanar = false;
        for (const f of list) {
          if (f === e) continue;
          const overlap = Math.min(e.t1, f.t1) - Math.max(e.t0, f.t0);
          if (overlap > 1e-6 && f.p0.distanceTo(e.p0) < 2e-3 && f.d.dot(e.d) > 0.99999 && dot(e.tris[0], f.tris[0]) >= cosT) {
            coplanar = true;
            break;
          }
        }
        if (!coplanar) push(e.u, e.v);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}
