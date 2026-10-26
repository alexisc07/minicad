// Representación 3D de los componentes electrónicos, cables y protoboard.
import * as THREE from 'three';
import { PARTS, partPins, LED_COLORS } from './parts.js';
import { BB_TOP, bbHoleAt, bbGroupOf } from './boards.js';
import { h } from '../util.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export const WIRE_COLORS = [
  ['#f2c230', 'Amarillo'], ['#2f7df6', 'Azul'], ['#2fb35a', 'Verde'], ['#f08a24', 'Naranja'],
  ['#9b59d6', 'Morado'], ['#f4f4f4', 'Blanco'], ['#d12b2b', 'Rojo'], ['#24272c', 'Negro'],
  ['#8a8f99', 'Gris'], ['#7a4a1d', 'Marrón'], ['#e26ab0', 'Rosa'], ['#26c6da', 'Turquesa'],
];
export const WIRE_GAUGES = { fina: 0.35, normal: 0.55, gruesa: 0.85 };
export const WIRE_STYLES = { curva: 'Curva', recta: 'Recta (esquinas)' };

export function autoWireColor(pa, pb, index) {
  const isGnd = (p) => /^(GND\d?|-|[tb]-\d+)$/.test(p);
  const isPwr = (p) => /^(5V|VCC|\+|VIN|3V3|[tb]\+\d+)$/.test(p);
  if (isGnd(pa) || isGnd(pb)) return '#24272c';
  if (isPwr(pa) || isPwr(pb)) return '#d12b2b';
  return WIRE_COLORS[index % 5][0];
}

// ---------------------------------------------------------------- trazado de cables
function autoLift(a, b) {
  return Math.min(40, Math.max(6, a.distanceTo(b) * 0.3));
}

// Polilínea con las esquinas redondeadas
function roundedPath(points, radius) {
  const path = new THREE.CurvePath();
  let prev = points[0].clone();
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], p = points[i], b = points[i + 1];
    const d1 = p.clone().sub(a), d2 = b.clone().sub(p);
    const l1 = d1.length(), l2 = d2.length();
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = p.clone().addScaledVector(d1.normalize(), -r);
    const p2 = p.clone().addScaledVector(d2.normalize(), r);
    if (prev.distanceTo(p1) > 1e-6) path.add(new THREE.LineCurve3(prev, p1));
    path.add(new THREE.QuadraticBezierCurve3(p1, p.clone(), p2));
    prev = p2;
  }
  const last = points[points.length - 1].clone();
  if (prev.distanceTo(last) > 1e-6) path.add(new THREE.LineCurve3(prev, last));
  return path;
}

// Puntos de control del cable: pin A → (dobleces) → pin B
export function wireControlPoints(a, b, w) {
  const pts = (w.pts || []).map((p) => new THREE.Vector3(...p));
  const lift = w.lift ?? autoLift(a, b);
  if (!pts.length) {
    if (w.style === 'recta') return [a, a.clone().addScaledVector(UP, lift), b.clone().addScaledVector(UP, lift), b];
    return [a, a.clone().addScaledVector(UP, lift * 0.6), a.clone().lerp(b, 0.5).addScaledVector(UP, lift), b.clone().addScaledVector(UP, lift * 0.6), b];
  }
  const rise = Math.min(lift, 5);
  const out = [a];
  if (pts[0].y < a.y + rise - 0.01 || Math.hypot(pts[0].x - a.x, pts[0].z - a.z) > 0.5) out.push(a.clone().addScaledVector(UP, rise));
  out.push(...pts);
  const lp = pts[pts.length - 1];
  if (lp.y < b.y + rise - 0.01 || Math.hypot(lp.x - b.x, lp.z - b.z) > 0.5) out.push(b.clone().addScaledVector(UP, rise));
  out.push(b);
  return out;
}

export function wirePath(a, b, w) {
  const cps = wireControlPoints(a, b, w);
  if (w.style === 'recta') return roundedPath(cps, 3);
  return new THREE.CatmullRomCurve3(cps, false, 'centripetal');
}

export class ElecLayer {
  constructor(app) {
    this.app = app;
    this.viewer = app.viewer;
    this.groups = new Map(); // id -> Group
    this.root = new THREE.Group();
    this.wireRoot = new THREE.Group();
    this.viewer.world.add(this.root);
    this.viewer.world.add(this.wireRoot);
    this.wireMeshes = new Map(); // wireId -> Mesh (tubo)
    this.overlay = new THREE.Group();
    this.viewer.overlay.add(this.overlay);
    this.hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xd9a441);
    this.hoverBox.visible = false;
    this.overlay.add(this.hoverBox);
    this.selBoxes = [];
    // Marcadores del pin bajo el cursor
    const mk = (color, r = 1.3) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 50;
      m.visible = false;
      this.overlay.add(m);
      return m;
    };
    this.pinMarker = mk(0xffb000);
    this.pinStart = mk(0x2fb35a);
    this.rubber = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffb000, dashSize: 2, gapSize: 1.5, depthTest: false }));
    this.rubber.renderOrder = 49;
    this.rubber.visible = false;
    this.overlay.add(this.rubber);
    // Agujeros ocupados de la protoboard y columna resaltada
    const sq = new THREE.BoxGeometry(1.5, 0.15, 1.5);
    this.bbUsed = new THREE.InstancedMesh(sq, new THREE.MeshBasicMaterial({ color: 0x22c55e }), 400);
    this.bbUsed.count = 0;
    this.bbUsed.raycast = () => {};
    this.bbGroup = new THREE.InstancedMesh(sq, new THREE.MeshBasicMaterial({ color: 0xffb000, depthTest: false, transparent: true, opacity: 0.9 }), 30);
    this.bbGroup.count = 0;
    this.bbGroup.renderOrder = 48;
    this.overlay.add(this.bbUsed, this.bbGroup);
    // Asas para editar el cable seleccionado
    this.handles = new THREE.Group();
    this.overlay.add(this.handles);
    this.handleList = [];
    this.tip = h('div', { class: 'pin-tip' });
    this.viewer.container.append(this.tip);
    this.selectedWire = null;
    this.draft = null; // cable en construcción {start, pts}
  }

  // ------------------------------------------------------------ sincronización
  sync() {
    const doc = this.app.doc;
    const seen = new Set();
    for (const node of doc.nodes) {
      if (node.type !== 'ecomp') continue;
      seen.add(node.id);
      const key = node.part + JSON.stringify(node.params || {});
      let g = this.groups.get(node.id);
      if (!g || g.userData.key !== key) {
        if (g) this.disposeGroup(g);
        g = this.buildGroup(node);
        g.userData.key = key;
        this.root.add(g);
        this.groups.set(node.id, g);
      }
      applyNodeTransform(g, node);
      g.visible = node.visible !== false;
    }
    for (const [id, g] of this.groups) {
      if (!seen.has(id)) {
        this.disposeGroup(g);
        this.groups.delete(id);
      }
    }
    this.root.updateMatrixWorld(true);
    this.syncWires();
    this.updateBoardMarkers();
    this.updateSelection();
  }

  buildGroup(node) {
    const def = PARTS[node.part];
    const { group, parts } = def.build(node.params || {});
    group.userData.nodeId = node.id;
    group.userData.parts = parts;
    group.userData.pins = partPins(node);
    group.traverse((o) => {
      if (o.isMesh && !o.userData.noPick) o.userData.nodeId = node.id;
      if (o.isMesh && o.geometry && !o.geometry.boundingBox) o.geometry.computeBoundingBox();
    });
    // Agujeros de los pines en las cabeceras del Arduino
    if (node.part === 'arduino') {
      const holeGeo = new THREE.BoxGeometry(1.1, 0.12, 1.1);
      const holeMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
      for (const p of group.userData.pins) {
        const m = new THREE.Mesh(holeGeo, holeMat);
        m.position.set(p.pos[0], p.pos[1] + 0.02, p.pos[2]);
        m.userData.nodeId = node.id;
        group.add(m);
      }
    }
    return group;
  }

  disposeGroup(g) {
    this.root.remove(g);
    g.traverse((o) => {
      if (o.material && !o.material.userData?.shared) o.material.dispose();
    });
  }

  rebuildGroup(id) {
    const g = this.groups.get(id);
    if (g) g.userData.key = null;
    this.sync();
  }

  pinWorld(nodeId, pinId, target = new THREE.Vector3()) {
    const g = this.groups.get(nodeId);
    if (!g) return null;
    const pin = g.userData.pins.find((p) => p.id === pinId);
    if (!pin) return null;
    g.updateMatrixWorld();
    return target.set(...pin.pos).applyMatrix4(g.matrixWorld);
  }

  // ------------------------------------------------------------ protoboard
  boards() {
    return this.app.doc.nodes.filter((n) => n.type === 'ecomp' && n.part === 'breadboard' && this.groups.has(n.id));
  }

  // Patas de componentes insertadas en agujeros de la protoboard
  contacts() {
    const out = [];
    const boards = this.boards();
    if (!boards.length) return out;
    const v = new THREE.Vector3();
    for (const b of boards) {
      const gb = this.groups.get(b.id);
      gb.updateMatrixWorld();
      const inv = gb.matrixWorld.clone().invert();
      for (const [id, g] of this.groups) {
        const node = this.app.doc.get(id);
        if (!node || PARTS[node.part]?.board) continue;
        g.updateMatrixWorld();
        for (const p of g.userData.pins) {
          v.set(...p.pos).applyMatrix4(g.matrixWorld).applyMatrix4(inv);
          if (Math.abs(v.y - BB_TOP) > 1.2) continue;
          const hole = bbHoleAt(v.x, v.z, 0.9);
          if (hole) out.push({ a: { n: id, p: p.id }, b: { n: b.id, p: hole.id } });
        }
      }
    }
    return out;
  }

  updateBoardMarkers() {
    const m = new THREE.Matrix4();
    let i = 0;
    const used = new Set();
    for (const c of this.contacts()) used.add(`${c.b.n}:${c.b.p}`);
    for (const w of this.app.doc.wires || []) {
      for (const end of [w.a, w.b]) if (this.app.doc.get(end.n)?.part === 'breadboard') used.add(`${end.n}:${end.p}`);
    }
    for (const key of used) {
      const [n, p] = key.split(':');
      const pos = this.pinWorld(n, p);
      if (!pos || i >= 400) continue;
      m.makeTranslation(pos.x, pos.y + 0.05, pos.z);
      this.bbUsed.setMatrixAt(i++, m);
    }
    this.bbUsed.count = i;
    this.bbUsed.instanceMatrix.needsUpdate = true;
  }

  showBoardGroup(nodeId, pinId) {
    const g = this.groups.get(nodeId);
    const grp = g && this.app.doc.get(nodeId)?.part === 'breadboard' ? bbGroupOf(pinId) : null;
    let i = 0;
    if (grp) {
      const m = new THREE.Matrix4();
      for (const p of g.userData.pins) {
        if (bbGroupOf(p.id) !== grp || i >= 30) continue;
        const pos = this.pinWorld(nodeId, p.id);
        m.makeTranslation(pos.x, pos.y + 0.1, pos.z);
        this.bbGroup.setMatrixAt(i++, m);
      }
    }
    this.bbGroup.count = i;
    this.bbGroup.instanceMatrix.needsUpdate = true;
  }

  // Encaja un componente en los agujeros de la protoboard que tenga debajo
  snapToBoard(obj, pins, excludeId) {
    if (!pins?.length) return false;
    obj.updateMatrixWorld(true);
    const first = new THREE.Vector3(...pins[0].pos).applyMatrix4(obj.matrixWorld);
    for (const b of this.boards()) {
      if (b.id === excludeId) continue;
      const gb = this.groups.get(b.id);
      gb.updateMatrixWorld();
      const local = first.clone().applyMatrix4(gb.matrixWorld.clone().invert());
      if (Math.abs(local.y - BB_TOP) > 4 || Math.abs(local.x) > 42 || Math.abs(local.z) > 28) continue;
      const hole = bbHoleAt(local.x, local.z, 2.6);
      if (!hole) continue;
      const target = new THREE.Vector3(hole.x, BB_TOP, hole.z).applyMatrix4(gb.matrixWorld);
      obj.position.add(target.sub(first));
      obj.updateMatrix();
      obj.updateMatrixWorld(true);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ cables
  syncWires(onlyIds = null) {
    const doc = this.app.doc;
    const valid = new Set();
    for (const w of doc.wires || []) {
      const a = this.pinWorld(w.a.n, w.a.p);
      const b = this.pinWorld(w.b.n, w.b.p);
      if (!a || !b) continue;
      valid.add(w.id);
      if (onlyIds && !onlyIds.has(w.id)) continue;
      this.buildWire(w, a, b);
    }
    if (onlyIds) return;
    for (const [id, m] of this.wireMeshes) {
      if (!valid.has(id)) {
        this.disposeWire(m);
        this.wireMeshes.delete(id);
      }
    }
    if (this.selectedWire && !valid.has(this.selectedWire)) this.selectedWire = null;
    this.updateHandles();
  }

  buildWire(w, a, b) {
    let mesh = this.wireMeshes.get(w.id);
    const path = wirePath(a, b, w);
    const len = path.getLength();
    const r = WIRE_GAUGES[w.gauge] || WIRE_GAUGES.normal;
    const geo = new THREE.TubeGeometry(path, Math.max(20, Math.min(360, Math.round(len / (w.style === 'recta' ? 0.8 : 1.6)))), r, 8, false);
    if (!mesh) {
      mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: w.color, shininess: 70, specular: 0x444444 }));
      mesh.userData.wireId = w.id;
      this.wireRoot.add(mesh);
      this.wireMeshes.set(w.id, mesh);
    } else {
      mesh.geometry.dispose();
      mesh.geometry = geo;
      mesh.material.color.set(w.color);
    }
    mesh.material.emissive.setHex(this.selectedWire === w.id ? 0x0c2350 : 0x000000);
    // Conectores tipo "jumper" en los extremos
    for (const c of [...mesh.children]) {
      mesh.remove(c);
      c.traverse((o) => o.geometry?.dispose());
    }
    if (w.ends !== false) {
      mesh.add(connector(a, path.getTangentAt(0.0001)), connector(b, path.getTangentAt(0.9999).negate()));
    }
  }

  disposeWire(m) {
    this.wireRoot.remove(m);
    m.geometry.dispose();
    m.material.dispose();
    for (const c of m.children) c.traverse((o) => o.geometry?.dispose());
  }

  wiresOf(nodeIds) {
    return (this.app.doc.wires || []).filter((w) => nodeIds.has(w.a.n) || nodeIds.has(w.b.n));
  }

  pickWire(ev) {
    const hit = this.viewer.pick(ev, [...this.wireMeshes.values()]);
    return hit ? hit.object.userData.wireId : null;
  }

  selectWire(id) {
    this.selectedWire = id;
    for (const [wid, m] of this.wireMeshes) m.material.emissive.setHex(wid === id ? 0x0c2350 : 0x000000);
    this.updateHandles();
    this.viewer.requestRender();
  }

  wire(id) {
    return (this.app.doc.wires || []).find((w) => w.id === id) || null;
  }

  // Asas: dobleces (blancas), puntos intermedios (+) y extremos (naranja)
  updateHandles() {
    for (const c of [...this.handles.children]) {
      this.handles.remove(c);
      c.material.dispose();
    }
    this.handleList = [];
    const w = this.selectedWire && this.wire(this.selectedWire);
    if (!w || this.app.mode !== 'select') return this.viewer.requestRender();
    const a = this.pinWorld(w.a.n, w.a.p), b = this.pinWorld(w.b.n, w.b.p);
    if (!a || !b) return;
    const pts = (w.pts || []).map((p) => new THREE.Vector3(...p));
    const add = (kind, pos, color, r, extra = {}) => {
      const m = new THREE.Mesh(handleGeo(r), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: kind === 'mid' ? 0.75 : 1 }));
      m.position.copy(pos);
      m.renderOrder = 60;
      this.handles.add(m);
      this.handleList.push({ kind, pos: pos.clone(), mesh: m, ...extra });
    };
    pts.forEach((p, i) => add('bend', p, 0xffffff, 1.5, { index: i }));
    // Puntos intermedios: entre cada par de puntos de control
    const chain = [a, ...pts, b];
    for (let i = 0; i < chain.length - 1; i++) {
      const mid = chain[i].clone().lerp(chain[i + 1], 0.5);
      if (!pts.length) mid.y = Math.max(a.y, b.y) + (w.lift ?? autoLift(a, b)) * (w.style === 'recta' ? 1 : 0.85);
      add('mid', mid, 0x7fb2ff, 1.05, { index: i });
    }
    add('end', a, 0xf08a24, 1.4, { end: 'a' });
    add('end', b, 0xf08a24, 1.4, { end: 'b' });
    this.viewer.requestRender();
  }

  nearestHandle(ev, maxPx = 12) {
    if (!this.handleList.length) return null;
    const rect = this.viewer.container.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    let best = null, bd = maxPx;
    for (const hd of this.handleList) {
      const s = this.viewer.toScreen(hd.pos);
      const d = Math.hypot(s.x - sx, s.y - sy) - (hd.kind === 'mid' ? 2 : 0);
      if (d < bd) { bd = d; best = hd; }
    }
    return best;
  }

  // ------------------------------------------------------------ selección y picking
  pickables() {
    const out = [];
    for (const g of this.groups.values()) {
      if (!g.visible) continue;
      g.traverse((o) => {
        if (o.isMesh && o.userData.nodeId) out.push(o);
      });
    }
    return out;
  }

  worldBox(id) {
    const g = this.groups.get(id);
    if (!g) return new THREE.Box3();
    g.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(g, true);
  }

  updateSelection() {
    for (const b of this.selBoxes) this.overlay.remove(b);
    this.selBoxes = [];
    for (const id of this.app.selection) {
      if (!this.groups.has(id)) continue;
      const helper = new THREE.Box3Helper(this.worldBox(id).expandByScalar(1.5), 0x2f7df6);
      this.overlay.add(helper);
      this.selBoxes.push(helper);
    }
    this.viewer.requestRender();
  }

  setHover(id) {
    if (id && this.groups.has(id) && !this.app.selection.includes(id)) {
      this.hoverBox.box.copy(this.worldBox(id).expandByScalar(1.5));
      this.hoverBox.visible = true;
    } else this.hoverBox.visible = false;
    this.viewer.requestRender();
  }

  // ------------------------------------------------------------ pines (herramienta cable)
  nearestPin(ev, maxPx = 16, exclude = null) {
    const rect = this.viewer.container.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    let best = null, bd = maxPx;
    const v = new THREE.Vector3();
    for (const [id, g] of this.groups) {
      if (!g.visible) continue;
      g.updateMatrixWorld();
      for (const p of g.userData.pins) {
        if (exclude && exclude.n === id && exclude.p === p.id) continue;
        v.set(...p.pos).applyMatrix4(g.matrixWorld);
        const s = this.viewer.toScreen(v);
        if (s.behind) continue;
        const d = Math.hypot(s.x - sx, s.y - sy);
        if (d < bd) {
          bd = d;
          best = { n: id, p: p.id, label: p.label, world: v.clone(), sx: s.x, sy: s.y };
        }
      }
    }
    return best;
  }

  showPinTip(pin, extra = '') {
    if (!pin) {
      this.tip.style.display = 'none';
      this.pinMarker.visible = false;
      this.showBoardGroup(null);
      return;
    }
    const node = this.app.doc.get(pin.n);
    this.tip.style.display = 'block';
    this.tip.innerHTML = `<b>${escape(pin.label)}</b><span>${escape(node?.name || '')}</span>${extra ? `<em>${escape(extra)}</em>` : ''}`;
    this.tip.style.left = pin.sx + 14 + 'px';
    this.tip.style.top = pin.sy - 10 + 'px';
    this.pinMarker.position.copy(pin.world);
    this.pinMarker.visible = true;
    this.showBoardGroup(pin.n, pin.p);
    this.viewer.requestRender();
  }

  // Cable en construcción: pin inicial + dobleces
  setWireStart(pin) {
    this.draft = pin ? { start: pin, pts: [] } : null;
    this.wireStart = pin;
    this.pinStart.visible = !!pin;
    if (pin) this.pinStart.position.copy(pin.world);
    this.rubber.visible = false;
    this.viewer.requestRender();
  }

  updateRubber(cursorPoint) {
    if (!this.draft || !cursorPoint) {
      this.rubber.visible = false;
      return;
    }
    const pts = [this.draft.start.world, ...this.draft.pts.map((p) => new THREE.Vector3(...p)), cursorPoint];
    this.rubber.geometry.dispose();
    this.rubber.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.rubber.computeLineDistances();
    this.rubber.visible = true;
    this.viewer.requestRender();
  }

  clearWireTool() {
    this.setWireStart(null);
    this.showPinTip(null);
    this.rubber.visible = false;
  }

  // ------------------------------------------------------------ actuadores (vista)
  setActuatorAngle(id, angle) {
    const g = this.groups.get(id);
    if (!g) return;
    const parts = g.userData.parts;
    if (parts.horn) parts.horn.rotation.y = (angle - 90) * DEG;
    if (parts.shaft) parts.shaft.rotation.x = angle * DEG;
  }

  resetVisuals() {
    for (const [id, g] of this.groups) {
      const node = this.app.doc.get(id);
      const def = node && PARTS[node.part];
      if (def?.restAngle != null) this.setActuatorAngle(id, def.restAngle);
      const parts = g.userData.parts;
      if (parts.dome) {
        parts.dome.emissive.setHex(0x000000);
        parts.dome.color.setHex((LED_COLORS[node?.params?.color] || LED_COLORS.rojo).hex);
      }
      for (const k of ['ledL', 'ledOn', 'ledTX', 'ledRX']) parts[k]?.emissive.setHex(0x000000);
      if (parts.cap) parts.cap.position.y = 5.5;
      if (parts.knob && node?.part === 'switch') parts.knob.position.x = -1.5;
      if (g.userData.halo) g.userData.halo.visible = false;
    }
  }
}

const handleGeos = new Map();
function handleGeo(r) {
  let g = handleGeos.get(r);
  if (!g) handleGeos.set(r, (g = new THREE.SphereGeometry(r, 14, 10)));
  return g;
}

// Conector de cable "jumper": pin metálico + carcasa negra, orientado según el cable
const connMat = new THREE.MeshPhongMaterial({ color: 0x1b1c20, shininess: 40 });
const pinMat = new THREE.MeshPhongMaterial({ color: 0xd9d4c4, shininess: 100, specular: 0x888888 });
function connector(at, dir) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(2.4, 7, 2.4), connMat);
  const d = dir.clone().normalize();
  g.quaternion.setFromUnitVectors(UP, d);
  g.position.copy(at).addScaledVector(d, 1.2 + 3.5);
  g.raycast = () => {};
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 3.6, 6), pinMat);
  pin.position.set(0, -3.5 - 1.2 + 0.6, 0);
  pin.raycast = () => {};
  g.add(pin);
  return g;
}

export function applyNodeTransform(obj, node) {
  obj.position.set(...(node.pos || [0, 0, 0]));
  const r = node.rot || [0, 0, 0];
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
  obj.scale.set(...(node.scl || [1, 1, 1]));
  obj.updateMatrix();
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
