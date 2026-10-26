// Operaciones de edición del croquis al estilo AutoCAD: entrada de coordenadas,
// desfase (equidistancia), empalme, chaflán, simetría, giro y matrices.
// Funciones puras sobre entidades { t: 'rect' | 'circle' | 'ngon' | 'slot' | 'poly', ... }.
import { entityContour, polySelfIntersects } from './geometry.js';
import { evalNum, fmt, DEG } from './util.js';

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const EPS = 1e-9;

function signedArea(l) {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const p = l[i], q = l[(i + 1) % l.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// ---------------------------------------------------------------- coordenadas
// Interpreta un punto escrito como en AutoCAD:
//   "x,y"      absoluto            "@dx,dy"   relativo al último punto
//   "@d<a"     polar relativo      "d<a"      polar relativo (o desde el origen si no hay punto)
// La coma separa coordenadas; el decimal se escribe con punto.
// Devuelve { u, v } o null si el texto no es un punto.
export function parsePoint(txt, last) {
  let s = String(txt ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  const rel = s.startsWith('@');
  if (rel) s = s.slice(1);
  const base = rel || s.includes('<') ? last || { u: 0, v: 0 } : { u: 0, v: 0 };
  if (s.includes('<')) {
    const [ds, as] = s.split('<');
    const d = evalNum(ds), a = evalNum(as);
    if (!isFinite(d) || !isFinite(a)) return null;
    return { u: r6(base.u + d * Math.cos(a * DEG)), v: r6(base.v + d * Math.sin(a * DEG)) };
  }
  const parts = s.split(/[,;]/);
  if (parts.length !== 2) return null;
  // evalNum convierte comas en puntos, así que cada parte se evalúa por separado
  const x = evalNum(parts[0]), y = evalNum(parts[1]);
  if (!isFinite(x) || !isFinite(y)) return null;
  return { u: r6(base.u + x), v: r6(base.v + y) };
}

// ---------------------------------------------------------------- utilidades
export function entityCenter(e) {
  switch (e.t) {
    case 'rect': return [e.x + e.w / 2, e.y + e.h / 2];
    case 'circle':
    case 'ngon': return [e.x, e.y];
    case 'slot': return [(e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2];
  }
  const l = entityContour(e);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of l) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

// Convierte rectángulos y polígonos en polilíneas (para editar vértices sueltos)
export function toPoly(e, seg = 48) {
  if (e.t === 'poly') return { t: 'poly', pts: e.pts.map((p) => [p[0], p[1]]) };
  if (e.t === 'rect' || e.t === 'ngon') return { t: 'poly', pts: entityContour(e, seg).map((p) => [r6(p[0]), r6(p[1])]) };
  return null;
}

// Vértices "esquina" de una entidad (para empalme y chaflán)
export function cornerPoints(e) {
  if (e.t === 'poly') return e.pts;
  if (e.t === 'rect' && !(e.rr > 0)) return entityContour(e);
  if (e.t === 'ngon') return entityContour(e);
  return [];
}

// ---------------------------------------------------------------- transformaciones
// Transformación afín 2D: p' = [a b; c d]·p + [tx, ty]
export const affine = {
  translate: (dx, dy) => ({ a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy }),
  rotate(deg, cx = 0, cy = 0) {
    const co = Math.cos(deg * DEG), si = Math.sin(deg * DEG);
    return { a: co, b: -si, c: si, d: co, tx: cx - co * cx + si * cy, ty: cy - si * cx - co * cy };
  },
  // Simetría respecto a la recta que pasa por (px, py) con ángulo "deg"
  mirror(deg, px = 0, py = 0) {
    const t = 2 * deg * DEG;
    const co = Math.cos(t), si = Math.sin(t);
    return { a: co, b: si, c: si, d: -co, tx: px - co * px - si * py, ty: py - si * px + co * py };
  },
};

const apply = (m, p) => [r6(m.a * p[0] + m.b * p[1] + m.tx), r6(m.c * p[0] + m.d * p[1] + m.ty)];

export function transformEntity(e, m) {
  const det = m.a * m.d - m.b * m.c;
  switch (e.t) {
    case 'circle': {
      const [x, y] = apply(m, [e.x, e.y]);
      return { ...e, x, y };
    }
    case 'slot': {
      const [x1, y1] = apply(m, [e.x1, e.y1]);
      const [x2, y2] = apply(m, [e.x2, e.y2]);
      return { ...e, x1, y1, x2, y2 };
    }
    case 'ngon': {
      const [x, y] = apply(m, [e.x, e.y]);
      const a = (e.a ?? 90) * DEG;
      const dir = [m.a * Math.cos(a) + m.b * Math.sin(a), m.c * Math.cos(a) + m.d * Math.sin(a)];
      return { ...e, x, y, a: r6(Math.atan2(dir[1], dir[0]) / DEG) };
    }
    case 'rect': {
      const axisAligned = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 || Math.abs(m.a) < 1e-9 && Math.abs(m.d) < 1e-9;
      if (axisAligned) {
        const c = entityContour({ ...e, rr: 0 }).map((p) => apply(m, p));
        const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
        const x0 = Math.min(...xs), y0 = Math.min(...ys);
        return { ...e, x: x0, y: y0, w: r6(Math.max(...xs) - x0), h: r6(Math.max(...ys) - y0) };
      }
      return transformEntity(toPoly(e), m);
    }
    case 'poly': {
      const pts = e.pts.map((p) => apply(m, p));
      if (det < 0) pts.reverse();
      return { t: 'poly', pts };
    }
  }
  return { ...e };
}

// Matriz rectangular: columnas × filas con separación dx, dy (incluye el original)
export function rectArray(e, cols, rows, dx, dy) {
  const out = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!i && !j) continue;
      out.push(transformEntity(e, affine.translate(i * dx, j * dy)));
    }
  }
  return out;
}

// Matriz polar: "count" copias repartidas en "total" grados alrededor de (cx, cy)
export function polarArray(e, count, total, cx, cy, rotateItems = true) {
  const out = [];
  const full = Math.abs(Math.abs(total) - 360) < 1e-9;
  const step = count > 1 ? total / (full ? count : count - 1) : 0;
  const c0 = entityCenter(e);
  for (let k = 1; k < count; k++) {
    const ang = step * k;
    if (rotateItems) out.push(transformEntity(e, affine.rotate(ang, cx, cy)));
    else {
      const [nx, ny] = apply(affine.rotate(ang, cx, cy), c0);
      out.push(transformEntity(e, affine.translate(nx - c0[0], ny - c0[1])));
    }
  }
  return out;
}

// ---------------------------------------------------------------- desfase
// Desplaza el contorno una distancia d (d > 0 hacia fuera, d < 0 hacia dentro).
// Devuelve la nueva entidad o null si el resultado no es válido.
export function offsetEntity(e, d) {
  if (!isFinite(d) || Math.abs(d) < EPS) return null;
  switch (e.t) {
    case 'circle':
      return e.r + d > EPS ? { ...e, r: r6(e.r + d) } : null;
    case 'slot':
      return e.r + d > EPS ? { ...e, r: r6(e.r + d) } : null;
    case 'ngon': {
      // El apotema crece d; el radio crece d / cos(π/n)
      const r = e.r + d / Math.cos(Math.PI / Math.max(3, e.n));
      return r > EPS ? { ...e, r: r6(r) } : null;
    }
    case 'rect': {
      const x0 = Math.min(e.x, e.x + e.w), y0 = Math.min(e.y, e.y + e.h);
      const w = Math.abs(e.w) + 2 * d, hh = Math.abs(e.h) + 2 * d;
      if (w <= EPS || hh <= EPS) return null;
      const out = { t: 'rect', x: r6(x0 - d), y: r6(y0 - d), w: r6(w), h: r6(hh) };
      if (e.rr > 0) out.rr = r6(Math.max(0, e.rr + d));
      return out;
    }
    case 'poly': {
      const pts = offsetPolygon(e.pts, d);
      return pts ? { t: 'poly', pts } : null;
    }
  }
  return null;
}

// Desfase de un polígono con esquinas vivas (inglete)
export function offsetPolygon(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  const ccw = signedArea(pts) > 0;
  const s = ccw ? d : -d; // normal exterior: (dy, -dx) en sentido antihorario
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (len < EPS) return null;
    const nx = dy / len, ny = -dx / len;
    lines.push({ p: [p[0] + nx * s, p[1] + ny * s], dir: [dx / len, dy / len] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const cr = A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0];
    if (Math.abs(cr) < 1e-9) {
      out.push([r6(B.p[0]), r6(B.p[1])]); // aristas colineales
      continue;
    }
    const t = ((B.p[0] - A.p[0]) * B.dir[1] - (B.p[1] - A.p[1]) * B.dir[0]) / cr;
    out.push([r6(A.p[0] + A.dir[0] * t), r6(A.p[1] + A.dir[1] * t)]);
  }
  const a0 = signedArea(pts), a1 = signedArea(out);
  // Al encoger demasiado el polígono se invierte o se cruza: alguna arista cambia de sentido
  for (let i = 0; i < n; i++) {
    const p = out[i], q = out[(i + 1) % n];
    if ((q[0] - p[0]) * lines[i].dir[0] + (q[1] - p[1]) * lines[i].dir[1] <= 1e-9) return null;
  }
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 1e-9 || polySelfIntersects(out)) return null;
  if (d < 0 && Math.abs(a1) >= Math.abs(a0)) return null;
  return out;
}

// ---------------------------------------------------------------- empalme y chaflán
function cornerGeom(pts, i) {
  const n = pts.length;
  const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
  const l1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
  const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (l1 < EPS || l2 < EPS) return null;
  const u1 = [(p0[0] - p1[0]) / l1, (p0[1] - p1[1]) / l1];
  const u2 = [(p2[0] - p1[0]) / l2, (p2[1] - p1[1]) / l2];
  const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (theta < 1e-4 || theta > Math.PI - 1e-4) return null; // punta o vértice recto (colineal)
  return { p1, u1, u2, l1, l2, theta };
}

// Puntos del arco tangente que sustituye al vértice i (o null si no cabe).
// maxFrac limita qué parte de cada arista puede consumir el empalme.
function filletPoints(pts, i, r, seg, maxFrac = 1) {
  const g = cornerGeom(pts, i);
  if (!g || !(r > 0)) return null;
  const { p1, u1, u2, l1, l2, theta } = g;
  const t = r / Math.tan(theta / 2);
  if (t > l1 * maxFrac + 1e-9 || t > l2 * maxFrac + 1e-9) return null;
  const bis = [u1[0] + u2[0], u1[1] + u2[1]];
  const bl = Math.hypot(bis[0], bis[1]);
  const dc = r / Math.sin(theta / 2);
  const c = [p1[0] + (bis[0] / bl) * dc, p1[1] + (bis[1] / bl) * dc];
  const t1 = [p1[0] + u1[0] * t, p1[1] + u1[1] * t];
  const t2 = [p1[0] + u2[0] * t, p1[1] + u2[1] * t];
  const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
  let da = Math.atan2(t2[1] - c[1], t2[0] - c[0]) - a1;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const steps = Math.max(3, Math.ceil(Math.abs(da) / ((2 * Math.PI) / Math.max(16, seg))));
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const a = a1 + (da * k) / steps;
    out.push([r6(c[0] + r * Math.cos(a)), r6(c[1] + r * Math.sin(a))]);
  }
  return out;
}

function chamferPoints(pts, i, d, maxFrac = 1) {
  const g = cornerGeom(pts, i);
  if (!g || !(d > 0)) return null;
  const { p1, u1, u2, l1, l2 } = g;
  if (d > l1 * maxFrac + 1e-9 || d > l2 * maxFrac + 1e-9) return null;
  return [
    [r6(p1[0] + u1[0] * d), r6(p1[1] + u1[1] * d)],
    [r6(p1[0] + u2[0] * d), r6(p1[1] + u2[1] * d)],
  ];
}

// Redondea (kind = 'fillet') o achaflana (kind = 'chamfer') las esquinas indicadas
// de un contorno. Devuelve { pts, done } con el número de esquinas modificadas.
export function roundCorners(pts, indices, kind, value, seg = 48) {
  const all = indices.length > 1;
  const repl = new Map();
  for (const i of indices) {
    // Si se modifican varias esquinas, cada una sólo puede usar media arista
    const r = kind === 'fillet' ? filletPoints(pts, i, value, seg, all ? 0.5 : 1) : chamferPoints(pts, i, value, all ? 0.5 : 1);
    if (r) repl.set(i, r);
  }
  const out = [];
  pts.forEach((p, i) => (repl.has(i) ? out.push(...repl.get(i)) : out.push([p[0], p[1]])));
  // Elimina puntos duplicados consecutivos (empalmes que se tocan)
  const clean = out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7;
  });
  return { pts: clean, done: repl.size };
}

// Aplica empalme o chaflán a la esquina más cercana a (u, v), o a todas si index = 'all'
export function cornerOp(e, index, kind, value, seg = 48) {
  // Rectángulo sin cambiar de tipo: el empalme de todas las esquinas es su radio
  if (e.t === 'rect' && kind === 'fillet' && index === 'all') {
    const max = Math.min(Math.abs(e.w), Math.abs(e.h)) / 2;
    if (!(value > 0) || value > max + 1e-9) return null;
    return { ...e, rr: r6(value) };
  }
  const poly = toPoly(e, seg);
  if (!poly) return null;
  const idx = index === 'all' ? poly.pts.map((_, i) => i) : [index];
  const { pts, done } = roundCorners(poly.pts, idx, kind, value, seg);
  if (!done || pts.length < 3 || polySelfIntersects(pts)) return null;
  return { t: 'poly', pts };
}

// Índice de la esquina más cercana a un punto (en unidades del croquis)
export function nearestCorner(e, u, v) {
  const pts = cornerPoints(e);
  let best = -1, bd = Infinity;
  pts.forEach((p, i) => {
    const d = Math.hypot(p[0] - u, p[1] - v);
    if (d < bd) { bd = d; best = i; }
  });
  return best < 0 ? null : { index: best, point: pts[best], dist: bd };
}

// ---------------------------------------------------------------- cotas
// Etiquetas de cota de una entidad: [{ u, v, text, a?, b? }] en coordenadas del croquis.
// a/b son los extremos del tramo medido (para ocultar cotas demasiado pequeñas en pantalla).
export function entityDims(e) {
  const f = (n) => fmt(n, 2);
  switch (e.t) {
    case 'rect': {
      const x0 = Math.min(e.x, e.x + e.w), x1 = Math.max(e.x, e.x + e.w);
      const y0 = Math.min(e.y, e.y + e.h), y1 = Math.max(e.y, e.y + e.h);
      const out = [
        { u: (x0 + x1) / 2, v: y0, text: f(x1 - x0), a: [x0, y0], b: [x1, y0], side: 'below' },
        { u: x1, v: (y0 + y1) / 2, text: f(y1 - y0), a: [x1, y0], b: [x1, y1], side: 'right' },
      ];
      if (e.rr > 0) out.push({ u: x0, v: y1, text: 'R' + f(e.rr), side: 'above' });
      return out;
    }
    case 'circle':
      return [{ u: e.x, v: e.y + e.r, text: 'Ø' + f(e.r * 2), side: 'above' }];
    case 'ngon':
      return [{ u: e.x, v: e.y, text: `R${f(e.r)} · ${e.n} lados` }];
    case 'slot': {
      const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      return [{ u: (e.x1 + e.x2) / 2, v: (e.y1 + e.y2) / 2, text: `L${f(len)} · R${f(e.r)}`, a: [e.x1, e.y1], b: [e.x2, e.y2] }];
    }
    case 'poly':
      return e.pts.map((p, i) => {
        const q = e.pts[(i + 1) % e.pts.length];
        return { u: (p[0] + q[0]) / 2, v: (p[1] + q[1]) / 2, text: f(Math.hypot(q[0] - p[0], q[1] - p[1])), a: p, b: q };
      });
  }
  return [];
}
