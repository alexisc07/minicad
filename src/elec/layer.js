// Representación 3D de los componentes electrónicos y de los cables.
import * as THREE from 'three';
import { PARTS, partPins, LED_COLORS } from './parts.js';
import { h } from '../util.js';

const DEG = Math.PI / 180;
export const WIRE_COLORS = [
  ['#f2c230', 'Amarillo'], ['#2f7df6', 'Azul'], ['#2fb35a', 'Verde'], ['#f08a24', 'Naranja'],
  ['#9b59d6', 'Morado'], ['#f4f4f4', 'Blanco'], ['#d12b2b', 'Rojo'], ['#24272c', 'Negro'],
];

export function autoWireColor(pa, pb, index) {
  const isGnd = (p) => /^(GND\d?|-)$/.test(p);
  const isPwr = (p) => /^(5V|VCC|\+|VIN|3V3)$/.test(p);
  if (isGnd(pa) || isGnd(pb)) return '#24272c';
  if (isPwr(pa) || isPwr(pb)) return '#d12b2b';
  return WIRE_COLORS[index % 5][0];
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
    this.wireMeshes = new Map(); // wireId -> Mesh
    this.overlay = new THREE.Group();
    this.viewer.overlay.add(this.overlay);
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0x2f7df6);
    this.selBox.visible = false;
    this.hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0xd9a441);
    this.hoverBox.visible = false;
    this.overlay.add(this.selBox, this.hoverBox);
    this.selBoxes = [];
    // Marcador del pin bajo el cursor
    this.pinMarker = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffb000, depthTest: false, transparent: true, opacity: 0.9 }));
    this.pinMarker.renderOrder = 50;
    this.pinMarker.visible = false;
    this.pinStart = this.pinMarker.clone();
    this.pinStart.material = new THREE.MeshBasicMaterial({ color: 0x2fb35a, depthTest: false });
    this.pinStart.renderOrder = 50;
    this.pinStart.visible = false;
    this.rubber = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xffb000, dashSize: 2, gapSize: 1.5, depthTest: false }));
    this.rubber.renderOrder = 49;
    this.rubber.visible = false;
    this.overlay.add(this.pinMarker, this.pinStart, this.rubber);
    this.tip = h('div', { class: 'pin-tip' });
    this.viewer.container.append(this.tip);
    this.selectedWire = null;
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
      if (o.material) {
        o.material.map?.dispose();
        o.material.dispose();
      }
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
      let mesh = this.wireMeshes.get(w.id);
      const geo = wireGeometry(a, b);
      if (!mesh) {
        mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: w.color, shininess: 60 }));
        mesh.userData.wireId = w.id;
        this.wireRoot.add(mesh);
        this.wireMeshes.set(w.id, mesh);
      } else {
        mesh.geometry.dispose();
        mesh.geometry = geo;
        mesh.material.color.set(w.color);
      }
      mesh.material.emissive.setHex(this.selectedWire === w.id ? 0x1f4fa8 : 0x000000);
    }
    if (onlyIds) return;
    for (const [id, m] of this.wireMeshes) {
      if (!valid.has(id)) {
        this.wireRoot.remove(m);
        m.geometry.dispose();
        m.material.dispose();
        this.wireMeshes.delete(id);
      }
    }
    if (this.selectedWire && !valid.has(this.selectedWire)) this.selectedWire = null;
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
    for (const [wid, m] of this.wireMeshes) m.material.emissive.setHex(wid === id ? 0x1f4fa8 : 0x000000);
    this.viewer.requestRender();
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
    const sel = this.app.selection;
    for (const id of sel) {
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
  nearestPin(ev, maxPx = 16) {
    const rect = this.viewer.container.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    let best = null, bd = maxPx;
    const v = new THREE.Vector3();
    for (const [id, g] of this.groups) {
      if (!g.visible) continue;
      g.updateMatrixWorld();
      for (const p of g.userData.pins) {
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
      return;
    }
    const node = this.app.doc.get(pin.n);
    this.tip.style.display = 'block';
    this.tip.innerHTML = `<b>${escape(pin.label)}</b><span>${escape(node?.name || '')}</span>${extra ? `<em>${escape(extra)}</em>` : ''}`;
    this.tip.style.left = pin.sx + 14 + 'px';
    this.tip.style.top = pin.sy - 10 + 'px';
    this.pinMarker.position.copy(pin.world);
    this.pinMarker.visible = true;
    this.viewer.requestRender();
  }

  setWireStart(pin) {
    this.wireStart = pin;
    this.pinStart.visible = !!pin;
    if (pin) this.pinStart.position.copy(pin.world);
    this.rubber.visible = false;
    this.viewer.requestRender();
  }

  updateRubber(ev, hoverPin) {
    if (!this.wireStart) return;
    let end = hoverPin?.world;
    if (!end) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.wireStart.world.y);
      end = this.viewer.rayPlane(ev, plane);
    }
    if (!end) return;
    this.rubber.geometry.setFromPoints([this.wireStart.world, end]);
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
      if (parts.ledL) parts.ledL.emissive.setHex(0x000000);
      if (parts.ledOn) parts.ledOn.emissive.setHex(0x000000);
      if (parts.cap) parts.cap.position.y = 5.5;
      if (parts.knob && node?.part === 'switch') parts.knob.position.x = -1.5;
      if (g.userData.halo) g.userData.halo.visible = false;
    }
  }
}

export function applyNodeTransform(obj, node) {
  obj.position.set(...(node.pos || [0, 0, 0]));
  const r = node.rot || [0, 0, 0];
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
  obj.scale.set(...(node.scl || [1, 1, 1]));
  obj.updateMatrix();
}

// Cable curvo entre dos pines
function wireGeometry(a, b) {
  const d = a.distanceTo(b);
  const lift = Math.min(40, Math.max(6, d * 0.3));
  const up = new THREE.Vector3(0, 1, 0);
  const pts = [
    a.clone(),
    a.clone().addScaledVector(up, lift * 0.6),
    a.clone().lerp(b, 0.5).addScaledVector(up, lift),
    b.clone().addScaledVector(up, lift * 0.6),
    b.clone(),
  ];
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(16, Math.min(64, Math.round(d / 3))), 0.55, 6, false);
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
