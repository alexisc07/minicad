// Operaciones booleanas. Usa Manifold (WASM, rápido y robusto) y, si una malla
// no es cerrada o Manifold no está disponible, recurre a three-bvh-csg.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import Module from 'manifold-3d';

export { ADDITION, SUBTRACTION, INTERSECTION };

let wasm = null;

export async function initManifold(wasmBinary) {
  try {
    const opts = wasmBinary ? { wasmBinary, locateFile: () => 'manifold.wasm' } : undefined;
    wasm = await Module(opts);
    wasm.setup();
  } catch (err) {
    console.warn('Manifold no disponible, se usa el motor alternativo', err);
    wasm = null;
  }
  return !!wasm;
}

export function manifoldReady() {
  return !!wasm;
}

// ---------------------------------------------------------------- Manifold
function toManifold(geom) {
  const pa = geom.attributes.position;
  const idx = geom.index;
  const count = idx ? idx.count : pa.count;
  const map = new Map();
  const verts = [];
  const tris = [];
  const q = 1e5;
  const vid = (i) => {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(x, y, z);
    }
    return id;
  };
  for (let i = 0; i + 2 < count; i += 3) {
    const a = vid(idx ? idx.getX(i) : i), b = vid(idx ? idx.getX(i + 1) : i + 1), c = vid(idx ? idx.getX(i + 2) : i + 2);
    if (a === b || b === c || a === c) continue;
    tris.push(a, b, c);
  }
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
  mesh.merge();
  const man = new wasm.Manifold(mesh);
  const st = man.status();
  if (st !== 'NoError') {
    man.delete();
    throw new Error('Malla no cerrada (' + st + ')');
  }
  return man;
}

function fromManifold(man) {
  const m = man.getMesh();
  const g = new THREE.BufferGeometry();
  const np = m.numProp;
  let pos = m.vertProperties;
  if (np !== 3) {
    const n = pos.length / np;
    const p3 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p3[i * 3] = pos[i * np];
      p3[i * 3 + 1] = pos[i * np + 1];
      p3[i * 3 + 2] = pos[i * np + 2];
    }
    pos = p3;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(m.triVerts, 1));
  return toCreasedNormals(g, (30 * Math.PI) / 180);
}

function manifoldCombine(geoms, op) {
  const parts = [];
  try {
    for (const g of geoms) parts.push(toManifold(g));
    let res;
    if (op === ADDITION) res = wasm.Manifold.union(parts);
    else if (op === SUBTRACTION) {
      const [base, ...tools] = parts;
      if (!tools.length) res = base.translate([0, 0, 0]);
      else {
        const t = tools.length === 1 ? tools[0] : wasm.Manifold.union(tools);
        res = base.subtract(t);
        if (t !== tools[0]) t.delete();
      }
    } else {
      res = parts[0];
      for (let i = 1; i < parts.length; i++) {
        const next = res.intersect(parts[i]);
        if (res !== parts[0]) res.delete();
        res = next;
      }
    }
    const out = fromManifold(res);
    if (!parts.includes(res)) res.delete();
    return out;
  } finally {
    for (const p of parts) p.delete();
  }
}

// ---------------------------------------------------------------- three-bvh-csg
const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];
evaluator.useGroups = false;

function bvhCombine(geoms, op) {
  let res = null;
  for (const g of geoms) {
    const b = new Brush(g);
    b.updateMatrixWorld();
    res = res ? evaluator.evaluate(res, b, op) : b;
  }
  const out = res.geometry;
  delete out.halfEdges;
  delete out.boundsTree;
  return out;
}

export function combine(geoms, op) {
  if (wasm) {
    try {
      return manifoldCombine(geoms, op);
    } catch (err) {
      console.warn('Manifold falló, se usa el motor alternativo:', err.message || err);
    }
  }
  return bvhCombine(geoms, op);
}
