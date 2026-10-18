import assert from 'node:assert/strict';
import { parsePoint, offsetEntity, offsetPolygon, cornerOp, nearestCorner, transformEntity, affine, rectArray, polarArray, entityDims } from '../src/sketchops.js';
import { entityContour } from '../src/geometry.js';

const area = (l) => Math.abs(l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('coordenadas absolutas', () => assert.deepEqual(parsePoint('30,40', { u: 5, v: 5 }), { u: 30, v: 40 }));
t('coordenadas relativas', () => assert.deepEqual(parsePoint('@10,-5', { u: 5, v: 5 }), { u: 15, v: 0 }));
t('coordenadas polares', () => {
  const p = parsePoint('@10<90', { u: 1, v: 1 });
  near(p.u, 1); near(p.v, 11);
  const q = parsePoint('20<0', null);
  near(q.u, 20); near(q.v, 0);
});
t('expresiones y decimales', () => assert.deepEqual(parsePoint('10+5, 2.5*2', null), { u: 15, v: 5 }));
t('un solo número no es un punto', () => assert.equal(parsePoint('25', null), null));

t('desfase de círculo', () => {
  assert.equal(offsetEntity({ t: 'circle', x: 0, y: 0, r: 10 }, 5).r, 15);
  assert.equal(offsetEntity({ t: 'circle', x: 0, y: 0, r: 10 }, -12), null);
});
t('desfase de rectángulo', () => {
  const r = offsetEntity({ t: 'rect', x: 0, y: 0, w: 40, h: -20 }, 2);
  assert.deepEqual(r, { t: 'rect', x: -2, y: -22, w: 44, h: 24 });
  assert.equal(offsetEntity({ t: 'rect', x: 0, y: 0, w: 10, h: 10 }, -5), null);
});
t('desfase de polilínea (ambos sentidos de giro)', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  near(area(offsetPolygon(sq, 1)), 144);
  near(area(offsetPolygon(sq.slice().reverse(), 1)), 144);
  near(area(offsetPolygon(sq, -2)), 36);
  assert.equal(offsetPolygon(sq, -6), null);
});
t('desfase de polígono regular conserva la distancia', () => {
  const e = { t: 'ngon', x: 0, y: 0, r: 10, n: 6, a: 90 };
  const o = offsetEntity(e, 3);
  const apo = (g) => g.r * Math.cos(Math.PI / g.n);
  near(apo(o) - apo(e), 3);
});

t('empalme de una esquina', () => {
  const e = { t: 'poly', pts: [[0, 0], [20, 0], [20, 20], [0, 20]] };
  const f = cornerOp(e, 1, 'fillet', 5);
  assert.equal(f.t, 'poly');
  // Área = 400 - (r² - πr²/4)
  near(area(f.pts), 400 - (25 - (Math.PI * 25) / 4), 0.2);
  assert.ok(f.pts.every((p) => p[0] <= 20 + 1e-9 && p[1] >= -1e-9));
});
t('empalme demasiado grande se rechaza', () => {
  const e = { t: 'poly', pts: [[0, 0], [20, 0], [20, 20], [0, 20]] };
  assert.equal(cornerOp(e, 1, 'fillet', 25), null);
});
t('empalme de todas las esquinas de un rectángulo usa su radio', () => {
  assert.deepEqual(cornerOp({ t: 'rect', x: 0, y: 0, w: 30, h: 20 }, 'all', 'fillet', 4), { t: 'rect', x: 0, y: 0, w: 30, h: 20, rr: 4 });
  assert.equal(cornerOp({ t: 'rect', x: 0, y: 0, w: 30, h: 20 }, 'all', 'fillet', 11), null);
});
t('chaflán de todas las esquinas', () => {
  const c = cornerOp({ t: 'rect', x: 0, y: 0, w: 20, h: 20 }, 'all', 'chamfer', 2);
  assert.equal(c.pts.length, 8);
  near(area(c.pts), 400 - 4 * 2);
});
t('empalme en polígono regular', () => {
  const c = cornerOp({ t: 'ngon', x: 0, y: 0, r: 10, n: 6, a: 90 }, 'all', 'fillet', 1);
  assert.ok(c && c.pts.length > 12);
});
t('esquina más cercana', () => {
  const r = nearestCorner({ t: 'rect', x: 0, y: 0, w: 10, h: 10 }, 9, 11);
  assert.deepEqual(r.point, [10, 10]);
});

t('simetría respecto al eje vertical', () => {
  const m = affine.mirror(90);
  assert.deepEqual(transformEntity({ t: 'circle', x: 10, y: 3, r: 2 }, m), { t: 'circle', x: -10, y: 3, r: 2 });
  const r = transformEntity({ t: 'rect', x: 5, y: 0, w: 10, h: 4 }, m);
  assert.deepEqual(r, { t: 'rect', x: -15, y: 0, w: 10, h: 4 });
});
t('giro de 45° convierte el rectángulo en polilínea', () => {
  const r = transformEntity({ t: 'rect', x: 0, y: 0, w: 10, h: 10 }, affine.rotate(45));
  assert.equal(r.t, 'poly');
  near(area(r.pts), 100);
});
t('giro de 90° mantiene el rectángulo', () => {
  const r = transformEntity({ t: 'rect', x: 0, y: 0, w: 10, h: 4 }, affine.rotate(90));
  assert.equal(r.t, 'rect');
  near(r.w, 4); near(r.h, 10); near(r.x, -4);
});
t('simetría de polilínea conserva el área', () => {
  const p = { t: 'poly', pts: [[0, 0], [10, 0], [3, 7]] };
  const m = transformEntity(p, affine.mirror(30, 2, 2));
  near(area(m.pts), area(p.pts));
});
t('matriz rectangular', () => {
  const out = rectArray({ t: 'circle', x: 0, y: 0, r: 1 }, 3, 2, 10, 5);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((e) => [e.x, e.y]), [[10, 0], [20, 0], [0, 5], [10, 5], [20, 5]]);
});
t('matriz polar completa', () => {
  const out = polarArray({ t: 'circle', x: 10, y: 0, r: 1 }, 4, 360, 0, 0);
  assert.equal(out.length, 3);
  near(out[0].x, 0); near(out[0].y, 10);
  near(out[1].x, -10); near(out[2].y, -10);
});
t('matriz polar parcial reparte los extremos', () => {
  const out = polarArray({ t: 'circle', x: 10, y: 0, r: 1 }, 3, 180, 0, 0);
  near(out[1].x, -10); near(out[1].y, 0);
});
t('cotas', () => {
  const d = entityDims({ t: 'rect', x: 0, y: 0, w: 40, h: 20 });
  assert.deepEqual(d.map((x) => x.text), ['40', '20']);
  assert.equal(entityDims({ t: 'circle', x: 0, y: 0, r: 5 })[0].text, 'Ø10');
  const ent = { t: 'poly', pts: [[0, 0], [3, 0], [3, 4]] };
  assert.deepEqual(entityDims(ent).map((x) => x.text), ['3', '4', '5']);
  assert.ok(entityContour(ent).length === 3);
});

console.log(`\n${n} pruebas superadas`);
