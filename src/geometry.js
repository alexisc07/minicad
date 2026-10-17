// Núcleo geométrico: primitivas, perfiles de croquis, extrusión, revolución,
// operaciones booleanas (CSG) y propiedades físicas.
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { combine, ADDITION, SUBTRACTION, INTERSECTION } from './csg.js';
import { DEG, hashStr } from './util.js';

// ---------------------------------------------------------------------------
// Catálogo de tipos
// ---------------------------------------------------------------------------
export const TYPES = {
  box: { label: 'Caja', icon: 'box', params: [['w', 'Ancho (X)', 40], ['h', 'Alto (Y)', 40], ['d', 'Fondo (Z)', 40]] },
  cylinder: { label: 'Cilindro', icon: 'cylinder', params: [['r', 'Radio', 20], ['h', 'Altura', 40]] },
  cone: { label: 'Cono', icon: 'cone', params: [['r1', 'Radio base', 20], ['r2', 'Radio superior', 0], ['h', 'Altura', 40]] },
  sphere: { label: 'Esfera', icon: 'sphere', params: [['r', 'Radio', 20]] },
  torus: { label: 'Toroide', icon: 'torus', params: [['R', 'Radio mayor', 25], ['r', 'Radio del tubo', 7]] },
  tube: { label: 'Tubo', icon: 'tube', params: [['ro', 'Radio exterior', 20], ['ri', 'Radio interior', 15], ['h', 'Altura', 40]] },
  prism: { label: 'Prisma', icon: 'prism', params: [['r', 'Radio', 20], ['n', 'Lados', 6, 'int'], ['h', 'Altura', 40]] },
  wedge: { label: 'Cuña', icon: 'wedge', params: [['w', 'Ancho (X)', 40], ['h', 'Alto (Y)', 30], ['d', 'Fondo (Z)', 40]] },
  extrude: { label: 'Extrusión', icon: 'extrude', params: [] },
  revolve: { label: 'Revolución', icon: 'revolve', params: [] },
  boolean: { label: 'Operación', icon: 'union', params: [] },
  mesh: { label: 'Malla importada', icon: 'mesh', params: [] },
};

export const OPS = {
  union: { label: 'Unión', icon: 'union', csg: ADDITION },
  subtract: { label: 'Corte', icon: 'subtract', csg: SUBTRACTION },
  intersect: { label: 'Intersección', icon: 'intersect', csg: INTERSECTION },
};

export function defaultParams(type) {
  const p = {};
  for (const [k, , v] of TYPES[type].params) p[k] = v;
  return p;
}

// ---------------------------------------------------------------------------
// Polígonos 2D
// ---------------------------------------------------------------------------
export function polyArea(l) {
  let a = 0;
  for (let i = 0, n = l.length; i < n; i++) {
    const p = l[i], q = l[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPoly(pt, l) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const xi = l[i][0], yi = l[i][1], xj = l[j][0], yj = l[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segIntersect(a, b, c, d) {
  const d1 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
  const d2 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
  const d3 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d4 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

export function polySelfIntersects(l) {
  const n = l.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segIntersect(l[i], l[(i + 1) % n], l[j], l[(j + 1) % n])) return true;
    }
  }
  return false;
}

function cleanLoop(l) {
  const out = [];
  for (const p of l) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push([p[0], p[1]]);
  }
  while (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-7) out.pop();
    else break;
  }
  return out;
}

// Contorno (lista de puntos) de una entidad de croquis
export function entityContour(e, seg = 48) {
  switch (e.t) {
    case 'rect': {
      const x0 = Math.min(e.x, e.x + e.w), x1 = Math.max(e.x, e.x + e.w);
      const y0 = Math.min(e.y, e.y + e.h), y1 = Math.max(e.y, e.y + e.h);
      const r = Math.min(e.rr || 0, (x1 - x0) / 2, (y1 - y0) / 2);
      if (r <= 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      // Rectángulo con esquinas redondeadas
      const n = Math.max(3, Math.round(seg / 4));
      const pts = [];
      const corners = [[x0 + r, y0 + r, Math.PI], [x1 - r, y0 + r, Math.PI * 1.5], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2]];
      for (const [cx, cy, a0] of corners) {
        for (let i = 0; i <= n; i++) {
          const a = a0 + (i / n) * (Math.PI / 2);
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
      }
      return pts;
    }
    case 'circle': {
      const pts = [];
      const n = Math.max(8, seg);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push([e.x + e.r * Math.cos(a), e.y + e.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'ngon': {
      const pts = [];
      const n = Math.max(3, Math.round(e.n));
      const a0 = (e.a ?? 90) * DEG;
      for (let i = 0; i < n; i++) {
        const a = a0 + (i / n) * Math.PI * 2;
        pts.push([e.x + e.r * Math.cos(a), e.y + e.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'slot': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      if (Math.hypot(dx, dy) < 1e-9) return entityContour({ t: 'circle', x: e.x1, y: e.y1, r: e.r }, seg);
      const ang = Math.atan2(dy, dx);
      const half = Math.max(4, Math.round(seg / 2));
      const pts = [];
      for (let i = 0; i <= half; i++) {
        const a = ang - Math.PI / 2 + (i / half) * Math.PI;
        pts.push([e.x2 + e.r * Math.cos(a), e.y2 + e.r * Math.sin(a)]);
      }
      for (let i = 0; i <= half; i++) {
        const a = ang + Math.PI / 2 + (i / half) * Math.PI;
        pts.push([e.x1 + e.r * Math.cos(a), e.y1 + e.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'poly':
      return e.pts.map((p) => [p[0], p[1]]);
  }
  return [];
}

// Agrupa los contornos en regiones (contorno exterior + agujeros).
export function buildRegions(entities, seg = 48) {
  const loops = [];
  for (const e of entities) {
    const l = cleanLoop(entityContour(e, seg));
    if (l.length < 3 || Math.abs(polyArea(l)) < 1e-9) continue;
    if (polyArea(l) < 0) l.reverse();
    loops.push(l);
  }
  const info = loops.map((l) => ({ l, a: Math.abs(polyArea(l)), depth: 0, parent: -1 }));
  for (let i = 0; i < info.length; i++) {
    const l = info[i].l;
    // Punto ligeramente interior junto a la primera arista
    const p = l[0], q = l[1];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(len * 1e-3, 1e-3);
    const test = [(p[0] + q[0]) / 2 - (dy / len) * k, (p[1] + q[1]) / 2 + (dx / len) * k];
    for (let j = 0; j < info.length; j++) {
      if (j === i || info[j].a <= info[i].a) continue;
      if (pointInPoly(test, info[j].l)) {
        info[i].depth++;
        if (info[i].parent === -1 || info[j].a < info[info[i].parent].a) info[i].parent = j;
      }
    }
  }
  const regions = [];
  const regionOf = new Map();
  info.forEach((it, i) => {
    if (it.depth % 2 === 0) {
      regionOf.set(i, regions.length);
      regions.push({ outer: it.l, holes: [] });
    }
  });
  info.forEach((it) => {
    if (it.depth % 2 === 1 && regionOf.has(it.parent)) {
      regions[regionOf.get(it.parent)].holes.push(it.l.slice().reverse());
    }
  });
  return regions;
}

function regionBBox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r.outer) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}

// Triangula una región; devuelve {verts:[[x,y]...], tris:[[a,b,c]...]}
function triangulateRegion(region) {
  const contour = region.outer.map((p) => new THREE.Vector2(p[0], p[1]));
  const holes = region.holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const verts = [...region.outer, ...region.holes.flat()];
  return { verts, tris };
}

const SMOOTH_COS = Math.cos(36 * DEG);

// Normales de arista y normales suavizadas por vértice de un lazo 2D
function loopNormals(l) {
  const n = l.length;
  const en = [];
  for (let i = 0; i < n; i++) {
    const a = l[i], b = l[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    en.push([dy / len, -dx / len]);
  }
  const smooth = [], avg = [];
  for (let i = 0; i < n; i++) {
    const p = en[(i - 1 + n) % n], q = en[i];
    const d = p[0] * q[0] + p[1] * q[1];
    smooth.push(d > SMOOTH_COS);
    const sx = p[0] + q[0], sy = p[1] + q[1];
    const sl = Math.hypot(sx, sy) || 1;
    avg.push([sx / sl, sy / sl]);
  }
  return { en, smooth, avg };
}

class TriBuilder {
  constructor() {
    this.P = [];
    this.N = [];
  }
  // Añade un triángulo; corrige el orden según la normal deseada
  tri(a, b, c, na, nb, nc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const glen = Math.hypot(gx, gy, gz);
    if (glen < 1e-10) return;
    const sx = na[0] + nb[0] + nc[0], sy = na[1] + nb[1] + nc[1], sz = na[2] + nb[2] + nc[2];
    if (gx * sx + gy * sy + gz * sz < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
    }
    this.P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.N.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    return g;
  }
}

// Extruye una región entre z0 y z1 (geometría en coordenadas del croquis)
export function extrudeRegion(region, z0, z1) {
  const tb = new TriBuilder();
  const { verts, tris } = triangulateRegion(region);
  const up = [0, 0, 1], dn = [0, 0, -1];
  for (const [i, j, k] of tris) {
    const a = verts[i], b = verts[j], c = verts[k];
    tb.tri([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1], up, up, up);
    tb.tri([a[0], a[1], z0], [b[0], b[1], z0], [c[0], c[1], z0], dn, dn, dn);
  }
  for (const l of [region.outer, ...region.holes]) {
    const { en, smooth, avg } = loopNormals(l);
    const n = l.length;
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const a = l[i], b = l[i2];
      const na2 = smooth[i] ? avg[i] : en[i];
      const nb2 = smooth[i2] ? avg[i2] : en[i];
      const na = [na2[0], na2[1], 0], nb = [nb2[0], nb2[1], 0];
      const a0 = [a[0], a[1], z0], b0 = [b[0], b[1], z0], b1 = [b[0], b[1], z1], a1 = [a[0], a[1], z1];
      tb.tri(a0, b0, b1, na, nb, nb);
      tb.tri(a0, b1, a1, na, nb, na);
    }
  }
  return tb.geometry();
}

// Revoluciona una región (x = radio, y = altura) alrededor del eje Y
export function revolveRegion(region, angleDeg, th0, seg = 48) {
  const full = angleDeg >= 359.999;
  const ang = full ? Math.PI * 2 : Math.max(0.1, angleDeg) * DEG;
  const steps = Math.max(3, Math.ceil((seg * ang) / (Math.PI * 2)));
  const tb = new TriBuilder();
  const P = (p, t) => [p[0] * Math.cos(t), p[1], -p[0] * Math.sin(t)];
  const N = (n, t) => [n[0] * Math.cos(t), n[1], -n[0] * Math.sin(t)];
  const angAt = (k) => th0 + (ang * (full ? k % steps : k)) / steps;
  for (const l of [region.outer, ...region.holes]) {
    const { en, smooth, avg } = loopNormals(l);
    const n = l.length;
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const a = l[i], b = l[i2];
      const na = smooth[i] ? avg[i] : en[i];
      const nb = smooth[i2] ? avg[i2] : en[i];
      for (let k = 0; k < steps; k++) {
        const t0 = angAt(k), t1 = angAt(k + 1);
        const A = P(a, t0), B = P(b, t0), C = P(b, t1), D = P(a, t1);
        const nA = N(na, t0), nB = N(nb, t0), nC = N(nb, t1), nD = N(na, t1);
        tb.tri(A, B, C, nA, nB, nC);
        tb.tri(A, C, D, nA, nC, nD);
      }
    }
  }
  if (!full) {
    const { verts, tris } = triangulateRegion(region);
    const t1 = th0 + ang;
    const ns = [Math.sin(th0), 0, Math.cos(th0)];
    const ne = [-Math.sin(t1), 0, -Math.cos(t1)];
    for (const [i, j, k] of tris) {
      tb.tri(P(verts[i], th0), P(verts[j], th0), P(verts[k], th0), ns, ns, ns);
      tb.tri(P(verts[i], t1), P(verts[j], t1), P(verts[k], t1), ne, ne, ne);
    }
  }
  return tb.geometry();
}

function orientRegion(r) {
  const outer = polyArea(r.outer) < 0 ? r.outer.slice().reverse() : r.outer;
  const holes = r.holes.map((h) => (polyArea(h) > 0 ? h.slice().reverse() : h));
  return { outer, holes };
}

// ---------------------------------------------------------------------------
// CSG
// ---------------------------------------------------------------------------
function cleanAttrs(g) {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  return g;
}

function flipWinding(g) {
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    g.index.needsUpdate = true;
  } else {
    for (const attr of Object.values(g.attributes)) {
      const a = attr.array, s = attr.itemSize;
      for (let i = 0; i < attr.count; i += 3) {
        for (let c = 0; c < s; c++) {
          const t = a[(i + 1) * s + c];
          a[(i + 1) * s + c] = a[(i + 2) * s + c];
          a[(i + 2) * s + c] = t;
        }
      }
      attr.needsUpdate = true;
    }
  }
}

// Copia la geometría aplicando la matriz (y corrige simetrías)
export function bakeGeometry(geom, matrix) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geom.attributes.position.clone());
  if (geom.attributes.normal) g.setAttribute('normal', geom.attributes.normal.clone());
  if (geom.index) g.setIndex(geom.index.clone());
  g.applyMatrix4(matrix);
  if (matrix.determinant() < 0) flipWinding(g);
  return cleanAttrs(g);
}

export function csgCombine(geoms, op) {
  return cleanAttrs(combine(geoms, op));
}

function combineRegionSolids(geoms, regions) {
  if (geoms.length === 1) return geoms[0];
  const boxes = regions.map(regionBBox);
  let overlap = false;
  for (let i = 0; i < boxes.length && !overlap; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) {
        overlap = true;
        break;
      }
    }
  }
  return overlap ? csgCombine(geoms, ADDITION) : mergeGeometries(geoms);
}

// ---------------------------------------------------------------------------
// Construcción por tipo de nodo
// ---------------------------------------------------------------------------
const pos = (v, min = 0.001) => Math.max(min, Number(v) || 0);

export function extrudeRange(p) {
  const d = pos(p.depth, 0.001);
  const extra = p.extra || 0;
  if (p.dir === 0) return [-d / 2, d / 2];
  if (p.dir === -1) return [-d, extra];
  return [-extra, d];
}

export function revolveRegions(profiles, axis, seg) {
  const regions = buildRegions(profiles, seg);
  if (!regions.length) throw new Error('El croquis no tiene perfiles cerrados');
  const all = regions.flatMap((r) => r.outer);
  const ci = axis === 'x' ? 1 : 0;
  const mn = Math.min(...all.map((p) => p[ci])), mx = Math.max(...all.map((p) => p[ci]));
  if (mn < -1e-6 && mx > 1e-6) throw new Error('El perfil cruza el eje de revolución');
  const neg = mx <= 1e-6;
  const map = (p) => (axis === 'x' ? [Math.abs(p[1]), p[0]] : [Math.abs(p[0]), p[1]]);
  const mapped = regions.map((r) => orientRegion({ outer: r.outer.map(map), holes: r.holes.map((h) => h.map(map)) }));
  // Ángulo inicial para que el perfil quede en su posición original
  const th0 = axis === 'x' ? (neg ? 0 : Math.PI) : neg ? Math.PI : 0;
  return { regions: mapped, th0 };
}

function buildRevolve(p, seg) {
  const axis = p.axis === 'x' ? 'x' : 'y';
  const { regions, th0 } = revolveRegions(p.profiles || [], axis, seg);
  const geoms = regions.map((r) => revolveRegion(r, p.angle ?? 360, th0, seg));
  const g = combineRegionSolids(geoms, regions);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  return g;
}

function buildLocal(node, ctx) {
  const p = node.params || {};
  const seg = ctx.seg;
  switch (node.type) {
    case 'box':
      return new THREE.BoxGeometry(pos(p.w), pos(p.h), pos(p.d));
    case 'cylinder':
      return new THREE.CylinderGeometry(pos(p.r), pos(p.r), pos(p.h), seg);
    case 'cone':
      return new THREE.CylinderGeometry(pos(p.r2, 0), pos(p.r1, 0), pos(p.h), seg);
    case 'sphere':
      return new THREE.SphereGeometry(pos(p.r), seg, Math.max(8, Math.round(seg / 2)));
    case 'torus': {
      const R = pos(p.R), r = Math.min(pos(p.r), R * 0.999);
      return new THREE.TorusGeometry(R, r, Math.max(8, Math.round(seg / 2)), seg).rotateX(Math.PI / 2);
    }
    case 'tube': {
      const ro = pos(p.ro), ri = Math.min(pos(p.ri), ro * 0.999), hh = pos(p.h) / 2;
      const region = { outer: [[ri, -hh], [ro, -hh], [ro, hh], [ri, hh]], holes: [] };
      return revolveRegion(region, 360, 0, seg);
    }
    case 'prism': {
      const hh = pos(p.h) / 2;
      const [region] = buildRegions([{ t: 'ngon', x: 0, y: 0, r: pos(p.r), n: Math.max(3, Math.round(p.n || 6)), a: 90 }], seg);
      return extrudeRegion(region, -hh, hh).rotateX(-Math.PI / 2);
    }
    case 'wedge': {
      const w = pos(p.w), hgt = pos(p.h), d = pos(p.d);
      const region = { outer: [[-w / 2, -hgt / 2], [w / 2, -hgt / 2], [-w / 2, hgt / 2]], holes: [] };
      return extrudeRegion(region, -d / 2, d / 2);
    }
    case 'extrude': {
      const regions = buildRegions(p.profiles || [], seg);
      if (!regions.length) throw new Error('El croquis no tiene perfiles cerrados');
      const [z0, z1] = extrudeRange(p);
      return combineRegionSolids(regions.map((r) => extrudeRegion(r, z0, z1)), regions);
    }
    case 'revolve':
      return buildRevolve(p, seg);
    case 'mesh': {
      const arr = ctx.meshStore.get(node.meshRef);
      if (!arr) throw new Error('Datos de malla no encontrados');
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      return toCreasedNormals(g, 30 * DEG);
    }
    case 'boolean': {
      const kids = (node.children || []).filter((c) => !c.suppressed);
      if (!kids.length) return new THREE.BufferGeometry();
      const geoms = kids.map((c) => bakeGeometry(getGeometry(c, ctx), nodeMatrix(c)));
      if (geoms.length === 1) return geoms[0];
      return csgCombine(geoms, OPS[node.op]?.csg ?? ADDITION);
    }
  }
  throw new Error('Tipo desconocido: ' + node.type);
}

// ---------------------------------------------------------------------------
// Caché de geometría por firma
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_MAX = 120;
export const geomInUse = new Set();

const tf = (n) => `${n.pos}|${n.rot}|${n.scl}`;

export function nodeSig(node, seg) {
  if (node.type === 'boolean') {
    const kids = (node.children || []).filter((c) => !c.suppressed);
    return `B:${node.op}[${kids.map((c) => nodeSig(c, seg) + '@' + tf(c)).join(';')}]`;
  }
  if (node.type === 'mesh') return 'M:' + node.meshRef;
  return `${node.type}:${seg}:${JSON.stringify(node.params)}`;
}

export function getGeometry(node, ctx) {
  const key = hashStr(nodeSig(node, ctx.seg));
  let g = cache.get(key);
  if (g) {
    cache.delete(key);
    cache.set(key, g);
    return g;
  }
  g = cleanAttrs(buildLocal(node, ctx));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  cache.set(key, g);
  while (cache.size > CACHE_MAX) {
    const [k, old] = cache.entries().next().value;
    cache.delete(k);
    if (!geomInUse.has(old)) old.dispose();
  }
  return g;
}

export function isCached(g) {
  for (const v of cache.values()) if (v === g) return true;
  return false;
}

export function clearGeometryCache() {
  for (const g of cache.values()) if (!geomInUse.has(g)) g.dispose();
  cache.clear();
}

// ---------------------------------------------------------------------------
// Transformaciones
// ---------------------------------------------------------------------------
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

export function nodeMatrix(node, target = new THREE.Matrix4()) {
  const [x, y, z] = node.pos || [0, 0, 0];
  const [rx, ry, rz] = node.rot || [0, 0, 0];
  const [sx, sy, sz] = node.scl || [1, 1, 1];
  _e.set(rx * DEG, ry * DEG, rz * DEG, 'XYZ');
  _q.setFromEuler(_e);
  return target.compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(sx, sy, sz));
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

export function setNodeMatrix(node, m) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  _e.setFromQuaternion(q, 'XYZ');
  node.pos = [r6(p.x), r6(p.y), r6(p.z)];
  node.rot = [r6(_e.x / DEG), r6(_e.y / DEG), r6(_e.z / DEG)];
  node.scl = [r6(s.x), r6(s.y), r6(s.z)];
}

// ---------------------------------------------------------------------------
// Propiedades físicas (volumen, área, centro de masa, caja envolvente)
// ---------------------------------------------------------------------------
export function massProps(geom, matrix) {
  const pa = geom.attributes.position;
  const idx = geom.index;
  const count = idx ? idx.count : pa.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  const box = new THREE.Box3();
  let vol = 0, area = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pa, i0).applyMatrix4(matrix);
    b.fromBufferAttribute(pa, i1).applyMatrix4(matrix);
    c.fromBufferAttribute(pa, i2).applyMatrix4(matrix);
    box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cr.crossVectors(ab, ac);
    area += cr.length() / 2;
    const v = a.dot(cr.crossVectors(b, c)) / 6;
    vol += v;
    cx += (v * (a.x + b.x + c.x)) / 4;
    cy += (v * (a.y + b.y + c.y)) / 4;
    cz += (v * (a.z + b.z + c.z)) / 4;
  }
  if (matrix.determinant() < 0) {
    vol = -vol;
    cx = -cx; cy = -cy; cz = -cz;
  }
  const center = Math.abs(vol) > 1e-12 ? new THREE.Vector3(cx / vol, cy / vol, cz / vol) : box.getCenter(new THREE.Vector3());
  return { volume: vol, area, center, box, triangles: Math.floor(count / 3) };
}
