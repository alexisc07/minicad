// Importación / exportación de mallas (STL, OBJ).
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

// Recorre los triángulos (en coordenadas del mundo) de una lista de {geometry, matrix}
function forEachTri(items, fn) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const { geometry, matrix } of items) {
    const pa = geometry.attributes.position;
    const idx = geometry.index;
    const count = idx ? idx.count : pa.count;
    const flip = matrix.determinant() < 0;
    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pa, i0).applyMatrix4(matrix);
      b.fromBufferAttribute(pa, i1).applyMatrix4(matrix);
      c.fromBufferAttribute(pa, i2).applyMatrix4(matrix);
      if (flip) fn(a, c, b);
      else fn(a, b, c);
    }
  }
}

function triCount(items) {
  let n = 0;
  for (const { geometry } of items) n += Math.floor((geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3);
  return n;
}

// STL binario. zUp: convierte Y-arriba a Z-arriba (lo que esperan la mayoría de laminadores 3D)
export function exportSTL(items, zUp = true) {
  const n = triCount(items);
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = 'MiniCAD STL (mm)';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const w = (v) => {
    if (zUp) {
      dv.setFloat32(o, v.x, true);
      dv.setFloat32(o + 4, -v.z, true);
      dv.setFloat32(o + 8, v.y, true);
    } else {
      dv.setFloat32(o, v.x, true);
      dv.setFloat32(o + 4, v.y, true);
      dv.setFloat32(o + 8, v.z, true);
    }
    o += 12;
  };
  let written = 0;
  forEachTri(items, (a, b, c) => {
    nrm.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize();
    w(nrm);
    w(a);
    w(b);
    w(c);
    dv.setUint16(o, 0, true);
    o += 2;
    written++;
  });
  dv.setUint32(80, written, true);
  return new Blob([buf.slice(0, 84 + written * 50)], { type: 'model/stl' });
}

export function exportOBJ(items, names) {
  const out = ['# MiniCAD OBJ (mm)'];
  let base = 1;
  items.forEach((it, k) => {
    out.push(`o ${(names?.[k] || 'cuerpo' + (k + 1)).replace(/\s+/g, '_')}`);
    const verts = [];
    forEachTri([it], (a, b, c) => {
      for (const v of [a, b, c]) verts.push(`v ${+v.x.toFixed(5)} ${+v.y.toFixed(5)} ${+v.z.toFixed(5)}`);
    });
    out.push(...verts);
    for (let i = 0; i < verts.length; i += 3) out.push(`f ${base + i} ${base + i + 1} ${base + i + 2}`);
    base += verts.length;
  });
  return new Blob([out.join('\n')], { type: 'text/plain' });
}

// Devuelve un Float32Array de posiciones (triángulos sueltos), en Y-arriba
export async function importMeshFile(file, zUp = true) {
  const name = file.name.toLowerCase();
  let geom;
  if (name.endsWith('.stl')) {
    geom = new STLLoader().parse(await file.arrayBuffer());
  } else if (name.endsWith('.obj')) {
    const obj = new OBJLoader().parse(await file.text());
    const parts = [];
    obj.updateMatrixWorld(true);
    obj.traverse((o) => {
      if (o.isMesh) {
        const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
        parts.push(g.attributes.position.clone().applyMatrix4(o.matrixWorld).array);
      }
    });
    const len = parts.reduce((s, p) => s + p.length, 0);
    const arr = new Float32Array(len);
    let off = 0;
    for (const p of parts) {
      arr.set(p, off);
      off += p.length;
    }
    geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    zUp = false; // OBJ suele estar en Y-arriba
  } else throw new Error('Formato no soportado (usa STL u OBJ)');
  if (geom.index) geom = geom.toNonIndexed();
  const arr = new Float32Array(geom.attributes.position.array);
  if (zUp) {
    for (let i = 0; i < arr.length; i += 3) {
      const y = arr[i + 1], z = arr[i + 2];
      arr[i + 1] = z;
      arr[i + 2] = -y;
    }
  }
  if (!arr.length) throw new Error('El archivo no contiene triángulos');
  return arr;
}
