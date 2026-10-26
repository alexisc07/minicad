// Modo croquis 2D: dibujo de perfiles sobre un plano con ajustes (snap),
// cotas en vivo, entrada numérica y edición de entidades.
import * as THREE from 'three';
import { entityContour, buildRegions, polySelfIntersects } from './geometry.js';
import { h, fmt, evalNum, toast, DEG } from './util.js';
import { parsePoint, offsetEntity, cornerOp, cornerPoints, entityDims } from './sketchops.js';

const COL = { ent: 0x1f5fd6, sel: 0xf08a24, hover: 0x2fa0ff, prev: 0x0f9d58 };
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export const SKETCH_TOOLS = {
  select: { label: 'Seleccionar', key: 'S', hint: 'Clic en una entidad para editar sus medidas. Supr la borra.' },
  line: { label: 'Polilínea', key: 'L', hint: 'Clic para añadir puntos. Clic en el primer punto, Enter o doble clic cierra el perfil.' },
  rect: { label: 'Rectángulo', key: 'R', hint: 'Clic en una esquina y luego en la opuesta. Escribe "ancho x alto" para medidas exactas.' },
  rectc: { label: 'Rect. centrado', key: 'T', hint: 'Clic en el centro y luego en una esquina. Escribe "ancho x alto".' },
  circle: { label: 'Círculo', key: 'C', hint: 'Clic en el centro y luego define el radio. Escribe el radio para un valor exacto.' },
  ngon: { label: 'Polígono', key: 'P', hint: 'Clic en el centro y luego en un vértice. Escribe el radio.' },
  slot: { label: 'Ranura', key: 'O', hint: 'Clic en el centro de un extremo, luego en el otro y define el radio.' },
  offset: { label: 'Desfase', key: 'E', hint: 'Clic en una entidad y luego en el lado hacia el que copiarla. Escribe un número para cambiar la distancia.' },
  fillet: { label: 'Empalme', key: 'F', hint: 'Clic en una esquina para redondearla. Escribe un número para cambiar el radio.' },
  chamfer: { label: 'Chaflán', key: 'H', hint: 'Clic en una esquina para cortarla en bisel. Escribe un número para cambiar la distancia.' },
};

// Herramientas que dibujan entidades nuevas a partir de puntos
const DRAW_TOOLS = ['line', 'rect', 'rectc', 'circle', 'ngon', 'slot'];
// Herramientas que modifican entidades existentes con un valor (distancia o radio)
const VALUE_TOOLS = { offset: 'offsetDist', fillet: 'filletR', chamfer: 'chamferD' };

export class Sketcher {
  constructor(app) {
    this.app = app;
    this.viewer = app.viewer;
    this.active = false;
    this.ngonSides = 6;
    this.offsetDist = 5;
    this.filletR = 5;
    this.chamferD = 3;
    this.viewer.addEventListener('render', () => this.active && this.updateHud());
  }

  start({ plane, entities = [], editNodeId = null, faceBodyId = null }) {
    this.active = true;
    this.plane = plane;
    this.entities = JSON.parse(JSON.stringify(entities));
    this.editNodeId = editNodeId;
    this.faceBodyId = faceBodyId;
    this.undoStack = [];
    this.redoStack = [];
    this.selected = -1;
    this.hover = -1;
    this.pts = [];
    this.cursor = null;
    this.offsetSrc = -1;
    this.corner = null;
    this.ghost = null;
    this.tool = this.entities.length ? 'select' : 'rect';

    const m = new THREE.Matrix4().makeBasis(plane.x, plane.y, plane.n).setPosition(plane.o);
    this.matrix = m;
    this.inv = m.clone().invert();
    this.threePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(plane.n, plane.o);

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(m);
    this.viewer.overlay.add(this.group);
    this.group.updateMatrixWorld(true);

    const box = this.viewer.sceneBox();
    const size = box.isEmpty() ? 150 : Math.max(150, box.getSize(new THREE.Vector3()).length() * 0.8);
    this.size = size;
    this.buildGrid(size);
    this.entLayer = new THREE.Group();
    this.prevLayer = new THREE.Group();
    this.group.add(this.entLayer, this.prevLayer);

    const vc = this.viewer.container;
    this.marker = h('div', { class: 'snap-marker' });
    this.label = h('div', { class: 'dim-label' });
    this.input = h('input', { class: 'dim-input', type: 'text', spellcheck: 'false' });
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.dimBox = h('div', { class: 'sk-dims' });
    vc.append(this.dimBox, this.marker, this.label, this.input);

    const c = this.viewer.controls;
    c.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.viewer.lookAtPlane(plane.o.clone().add(this.centerOffset()), plane.n, size * 0.5);
    this.redraw();
  }

  centerOffset() {
    // Si hay entidades, centra la vista en ellas
    if (!this.entities.length) return new THREE.Vector3();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of this.entities) {
      for (const p of entityContour(e, 16)) {
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      }
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return this.plane.x.clone().multiplyScalar(cx).add(this.plane.y.clone().multiplyScalar(cy));
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.viewer.overlay.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.marker.remove();
    this.label.remove();
    this.input.remove();
    this.dimBox.remove();
    this.viewer.controls.mouseButtons = { ...this.viewer.defaultButtons };
    this.viewer.requestRender();
  }

  buildGrid(size) {
    const step = size > 600 ? 50 : size > 250 ? 10 : 5;
    const n = Math.ceil(size / step);
    const minor = [], major = [];
    for (let i = -n; i <= n; i++) {
      const v = i * step;
      if (i === 0) continue;
      const arr = i % 5 === 0 ? major : minor;
      arr.push(-n * step, v, 0, n * step, v, 0, v, -n * step, 0, v, n * step, 0);
    }
    const mk = (arr, op) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5577aa, transparent: true, opacity: op, depthTest: false, depthWrite: false }));
      l.renderOrder = 15;
      return l;
    };
    const L = n * step;
    const axis = (a, b, color) => {
      const l = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
      );
      l.renderOrder = 16;
      return l;
    };
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(L * 2, L * 2),
      new THREE.MeshBasicMaterial({ color: 0xdfe9f7, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })
    );
    plate.renderOrder = 14;
    this.group.add(
      plate,
      mk(minor, 0.16),
      mk(major, 0.32),
      axis(new THREE.Vector3(-L, 0, 0), new THREE.Vector3(L, 0, 0), 0xd9534f),
      axis(new THREE.Vector3(0, -L, 0), new THREE.Vector3(0, L, 0), 0x2f9e4f)
    );
  }

  // ------------------------------------------------------------ coordenadas
  toWorld(u, v) {
    return new THREE.Vector3(u, v, 0).applyMatrix4(this.matrix);
  }

  toLocal(p) {
    const l = p.clone().applyMatrix4(this.inv);
    return { u: l.x, v: l.y };
  }

  screenOf(u, v) {
    return this.viewer.toScreen(this.toWorld(u, v));
  }

  // Puntos de referencia (como las "referencias a objetos" de AutoCAD): [u, v, tipo]
  keyPoints() {
    const pts = [[0, 0, 'center']];
    const ends = (l, closed = true) => {
      for (let i = 0; i < l.length; i++) {
        pts.push([l[i][0], l[i][1], 'end']);
        const q = l[(i + 1) % l.length];
        if (closed || i < l.length - 1) pts.push([(l[i][0] + q[0]) / 2, (l[i][1] + q[1]) / 2, 'mid']);
      }
    };
    for (const e of this.entities) {
      switch (e.t) {
        case 'rect':
          ends(entityContour({ ...e, rr: 0 }));
          pts.push([e.x + e.w / 2, e.y + e.h / 2, 'center']);
          break;
        case 'circle':
          pts.push([e.x, e.y, 'center'], [e.x + e.r, e.y, 'end'], [e.x - e.r, e.y, 'end'], [e.x, e.y + e.r, 'end'], [e.x, e.y - e.r, 'end']);
          break;
        case 'ngon':
          pts.push([e.x, e.y, 'center']);
          ends(entityContour(e));
          break;
        case 'slot':
          pts.push([e.x1, e.y1, 'center'], [e.x2, e.y2, 'center']);
          break;
        case 'poly':
          // Las polilíneas con muchos puntos (arcos de empalme) sólo aportan sus extremos
          if (e.pts.length > 64) pts.push(...e.pts.map((p) => [p[0], p[1], 'end']));
          else ends(e.pts);
          break;
      }
    }
    if (this.pts.length) ends(this.pts.map((p) => [p.u, p.v]), false);
    return pts;
  }

  cursorFrom(ev) {
    const wp = this.viewer.rayPlane(ev, this.threePlane);
    if (!wp) return null;
    const { u, v } = this.toLocal(wp);
    const sx = ev.clientX - this.viewer.container.getBoundingClientRect().left;
    const sy = ev.clientY - this.viewer.container.getBoundingClientRect().top;
    // 1) Puntos clave cercanos (en píxeles)
    let best = null, bd = 11;
    for (const kp of this.keyPoints()) {
      const s = this.screenOf(kp[0], kp[1]);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd) { bd = d; best = kp; }
    }
    if (best) return { u: best[0], v: best[1], snap: 'point', kind: best[2] };
    // 2) Rejilla
    const step = this.app.settings.sketchSnap;
    let su = step > 0 ? Math.round(u / step) * step : u;
    let sv = step > 0 ? Math.round(v / step) * step : v;
    let snap = step > 0 ? 'grid' : null;
    // 3) Horizontal / vertical respecto al punto anterior (con Orto siempre)
    if (this.pts.length && (this.tool === 'line' || (this.tool === 'slot' && this.pts.length === 1))) {
      const last = this.pts[this.pts.length - 1];
      if (this.app.settings.sketchOrtho) {
        if (Math.abs(u - last.u) >= Math.abs(v - last.v)) { sv = last.v; snap = 'H'; }
        else { su = last.u; snap = 'V'; }
      } else {
        const ls = this.screenOf(last.u, last.v);
        if (Math.abs(ls.y - sy) < 8) { sv = last.v; snap = 'H'; }
        else if (Math.abs(ls.x - sx) < 8) { su = last.u; snap = 'V'; }
      }
    }
    return { u: r6(su), v: r6(sv), snap };
  }

  // ------------------------------------------------------------ eventos
  onMove(ev) {
    if (this.app.featureForm) return;
    this.cursor = this.cursorFrom(ev);
    this.lastEvent = { clientX: ev.clientX, clientY: ev.clientY };
    if (this.tool === 'select' || (this.tool === 'offset' && this.offsetSrc < 0)) {
      const i = this.hitEntity(ev);
      if (i !== this.hover) {
        this.hover = i;
        this.redraw();
      }
    }
    if (this.tool === 'fillet' || this.tool === 'chamfer') this.corner = this.hitCorner(ev);
    this.updatePreview();
  }

  onClick(ev) {
    if (this.app.featureForm) return;
    const c = this.cursorFrom(ev);
    if (!c) return;
    const t = this.tool;
    if (t === 'select') {
      this.selected = this.hitEntity(ev);
      this.redraw();
      this.app.onSketchSelect(this.selected);
      return;
    }
    if (t === 'offset') {
      if (this.offsetSrc < 0) {
        this.offsetSrc = this.hitEntity(ev);
        this.hover = -1;
        this.redraw();
        this.updatePreview();
        return;
      }
      const e = this.offsetResult(c);
      this.offsetSrc = -1;
      if (e) this.addEntity(e);
      else {
        toast('No cabe un desfase de esa distancia hacia ese lado.', 'warn');
        this.redraw();
      }
      return;
    }
    if (t === 'fillet' || t === 'chamfer') {
      const k = this.hitCorner(ev);
      if (!k) return toast('Haz clic cerca de una esquina.', 'warn');
      const e = this.cornerResult(k);
      if (!e) return toast(t === 'fillet' ? 'El radio es demasiado grande para esa esquina.' : 'La distancia es demasiado grande para esa esquina.', 'warn');
      this.pushUndo();
      this.entities[k.i] = e;
      this.corner = null;
      this.changed();
      return;
    }
    if (t === 'line') {
      const last = this.pts[this.pts.length - 1];
      if (last && Math.abs(last.u - c.u) < 1e-9 && Math.abs(last.v - c.v) < 1e-9) return;
      const first = this.pts[0];
      if (first && this.pts.length >= 3 && Math.abs(first.u - c.u) < 1e-9 && Math.abs(first.v - c.v) < 1e-9) {
        this.closePoly();
        return;
      }
      this.pts.push(c);
      this.updatePreview();
      return;
    }
    if (t === 'slot') {
      if (this.pts.length < 2) {
        const last = this.pts[0];
        if (last && Math.hypot(last.u - c.u, last.v - c.v) < 1e-9) return;
        this.pts.push(c);
        this.updatePreview();
        return;
      }
      const [a, b] = this.pts;
      this.addEntity({ t: 'slot', x1: a.u, y1: a.v, x2: b.u, y2: b.v, r: r6(Math.max(0.01, distToSeg(c, a, b))) });
      this.pts = [];
      return;
    }
    if (!this.pts.length) {
      this.pts.push(c);
      this.updatePreview();
      return;
    }
    const e = this.entityFrom(this.pts[0], c);
    this.pts = [];
    if (e) this.addEntity(e);
    else this.updatePreview();
  }

  onDblClick() {
    if (this.tool === 'line' && this.pts.length >= 3) this.closePoly();
  }

  onKey(e) {
    const k = e.key;
    if (k === 'Escape') {
      if (this.input.style.display === 'block') return this.hideInput();
      if (this.offsetSrc >= 0) {
        this.offsetSrc = -1;
        this.redraw();
        this.updatePreview();
      } else if (this.pts.length) {
        this.pts = [];
        this.updatePreview();
      } else if (this.tool !== 'select') this.setTool('select');
      else if (this.selected >= 0) {
        this.selected = -1;
        this.redraw();
        this.app.onSketchSelect(-1);
      }
      return true;
    }
    if (k === 'Enter') {
      if (this.tool === 'line' && this.pts.length >= 3) this.closePoly();
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && this.selected >= 0) {
      this.deleteSelected();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      this.undo();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') {
      this.redo();
      return true;
    }
    if (k === 'F8') {
      this.app.toggleSketchSetting('sketchOrtho');
      return true;
    }
    // Entrada numérica: medidas, coordenadas (x,y  @dx,dy  d<ángulo) o el valor de la herramienta
    const typed = k === '@' || (/^[0-9.,\-]$/.test(k) && !e.ctrlKey);
    if (typed && (this.pts.length || DRAW_TOOLS.includes(this.tool) || VALUE_TOOLS[this.tool])) {
      this.showInput(k);
      return true;
    }
    if (!e.ctrlKey && !e.altKey && k.toLowerCase() === 'd') {
      this.app.toggleSketchSetting('sketchDims');
      return true;
    }
    if (!e.ctrlKey && !e.altKey) {
      for (const [name, def] of Object.entries(SKETCH_TOOLS)) {
        if (def.key.toLowerCase() === k.toLowerCase()) {
          this.setTool(name);
          return true;
        }
      }
    }
    return false;
  }

  setTool(t) {
    this.tool = t;
    this.pts = [];
    this.hover = -1;
    this.offsetSrc = -1;
    this.corner = null;
    this.hideInput();
    this.updatePreview();
    this.redraw();
    this.app.onSketchTool(t);
  }

  // ------------------------------------------------------------ entidades
  entityFrom(a, c) {
    const dx = c.u - a.u, dy = c.v - a.v;
    const d = Math.hypot(dx, dy);
    switch (this.tool) {
      case 'rect':
        if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) return null;
        return { t: 'rect', x: a.u, y: a.v, w: r6(dx), h: r6(dy) };
      case 'rectc':
        if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) return null;
        return { t: 'rect', x: r6(a.u - Math.abs(dx)), y: r6(a.v - Math.abs(dy)), w: r6(2 * Math.abs(dx)), h: r6(2 * Math.abs(dy)) };
      case 'circle':
        return d < 1e-6 ? null : { t: 'circle', x: a.u, y: a.v, r: r6(d) };
      case 'ngon':
        return d < 1e-6 ? null : { t: 'ngon', x: a.u, y: a.v, r: r6(d), n: this.ngonSides, a: r6(Math.atan2(dy, dx) / DEG) };
    }
    return null;
  }

  closePoly() {
    const pts = this.pts.map((p) => [p.u, p.v]);
    this.pts = [];
    if (polySelfIntersects(pts)) {
      toast('El perfil se cruza a sí mismo; dibújalo sin cruces.', 'warn');
      this.updatePreview();
      return;
    }
    this.addEntity({ t: 'poly', pts });
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.entities));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (this.pts.length) {
      this.pts.pop();
      this.updatePreview();
      return;
    }
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.entities));
    this.entities = JSON.parse(this.undoStack.pop());
    this.selected = -1;
    this.changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.entities));
    this.entities = JSON.parse(this.redoStack.pop());
    this.selected = -1;
    this.changed();
  }

  addEntity(e) {
    this.pushUndo();
    this.entities.push(e);
    this.changed();
  }

  // Sustituye la entidad i (si se da) y añade otras nuevas en un solo paso de deshacer
  applyEdit(i, replacement, added = []) {
    this.pushUndo();
    if (i >= 0 && replacement) this.entities[i] = replacement;
    this.entities.push(...added);
    this.changed();
  }

  setGhost(ents) {
    this.ghost = ents && ents.length ? ents : null;
    this.updatePreview();
  }

  // ------------------------------------------------------------ desfase, empalme y chaflán
  offsetResult(c) {
    const src = this.entities[this.offsetSrc];
    if (!src || !c) return null;
    const inside = pointIn([c.u, c.v], entityContour(src, 64));
    return offsetEntity(src, inside ? -this.offsetDist : this.offsetDist);
  }

  hitCorner(ev) {
    const rect = this.viewer.container.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    let best = null, bd = 14;
    this.entities.forEach((e, i) => {
      cornerPoints(e).forEach((p, index) => {
        const s = this.screenOf(p[0], p[1]);
        const d = Math.hypot(s.x - sx, s.y - sy);
        if (d < bd) { bd = d; best = { i, index, p }; }
      });
    });
    return best;
  }

  cornerResult(k) {
    const e = this.entities[k.i];
    if (!e) return null;
    return this.tool === 'fillet' ? cornerOp(e, k.index, 'fillet', this.filletR, 32) : cornerOp(e, k.index, 'chamfer', this.chamferD);
  }

  deleteSelected() {
    if (this.selected < 0) return;
    this.pushUndo();
    this.entities.splice(this.selected, 1);
    this.selected = -1;
    this.changed();
  }

  clearAll() {
    if (!this.entities.length) return;
    this.pushUndo();
    this.entities = [];
    this.selected = -1;
    this.changed();
  }

  changed() {
    this.redraw();
    this.updatePreview();
    this.app.onSketchSelect(this.selected);
  }

  updateEntity(i, key, value) {
    const e = this.entities[i];
    if (!e) return;
    this.pushUndo();
    const m = /^p(\d+)([xy])$/.exec(key);
    if (m) e.pts[+m[1]][m[2] === 'x' ? 0 : 1] = value;
    else if (key === 'n') e.n = Math.max(3, Math.min(64, Math.round(value)));
    else if (key === 'r') e.r = Math.max(0.001, value);
    else if (key === 'd') e.r = Math.max(0.0005, value / 2);
    else if (key === 'rr') e.rr = Math.max(0, value);
    else if (key === 'w' || key === 'h') e[key] = Math.abs(value) < 1e-6 ? e[key] : value;
    else e[key] = value;
    this.redraw();
  }

  entityFields(i) {
    const e = this.entities[i];
    if (!e) return [];
    switch (e.t) {
      case 'rect':
        return [['x', 'X esquina', e.x], ['y', 'Y esquina', e.y], ['w', 'Ancho', e.w], ['h', 'Alto', e.h], ['rr', 'Radio de esquinas', e.rr || 0]];
      case 'circle':
        return [['x', 'Centro X', e.x], ['y', 'Centro Y', e.y], ['r', 'Radio', e.r], ['d', 'Diámetro', e.r * 2]];
      case 'ngon':
        return [['x', 'Centro X', e.x], ['y', 'Centro Y', e.y], ['r', 'Radio', e.r], ['n', 'Lados', e.n], ['a', 'Ángulo (°)', e.a ?? 90]];
      case 'slot':
        return [['x1', 'X extremo 1', e.x1], ['y1', 'Y extremo 1', e.y1], ['x2', 'X extremo 2', e.x2], ['y2', 'Y extremo 2', e.y2], ['r', 'Radio', e.r]];
      case 'poly':
        return e.pts.flatMap((p, k) => [[`p${k}x`, `P${k + 1} X`, p[0]], [`p${k}y`, `P${k + 1} Y`, p[1]]]);
    }
    return [];
  }

  entityLabel(e) {
    return { rect: 'Rectángulo', circle: 'Círculo', ngon: 'Polígono', slot: 'Ranura', poly: 'Polilínea' }[e.t] || e.t;
  }

  hitEntity(ev) {
    const rect = this.viewer.container.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    let best = -1, bd = 8;
    this.entities.forEach((e, i) => {
      const pts = entityContour(e, 32).map((p) => this.screenOf(p[0], p[1]));
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const d = distToSeg({ u: sx, v: sy }, { u: a.x, v: a.y }, { u: b.x, v: b.y });
        if (d < bd) { bd = d; best = i; }
      }
    });
    if (best >= 0) return best;
    // Dentro de un perfil: el más pequeño que contenga el punto
    const c = this.cursorFrom(ev);
    if (!c) return -1;
    let area = Infinity;
    this.entities.forEach((e, i) => {
      const l = entityContour(e, 32);
      if (pointIn([c.u, c.v], l)) {
        const a = Math.abs(polyAreaOf(l));
        if (a < area) { area = a; best = i; }
      }
    });
    return best;
  }

  // ------------------------------------------------------------ dibujo
  lineMat(color) {
    return new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
  }

  redraw() {
    const L = this.entLayer;
    L.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    L.clear();
    // Relleno de regiones cerradas
    try {
      const regions = buildRegions(this.entities, 64);
      for (const r of regions) {
        const shape = new THREE.Shape(r.outer.map((p) => new THREE.Vector2(p[0], p[1])));
        shape.holes = r.holes.map((hh) => new THREE.Path(hh.map((p) => new THREE.Vector2(p[0], p[1]))));
        const fill = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({ color: 0x3d7be0, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
        );
        fill.renderOrder = 17;
        L.add(fill);
      }
    } catch (err) {
      /* región inválida: sólo se dibujan los contornos */
    }
    const pts = [];
    this.entities.forEach((e, i) => {
      const col = i === this.selected || i === this.offsetSrc ? COL.sel : i === this.hover ? COL.hover : COL.ent;
      const loop = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(entityContour(e, 64).map((p) => new THREE.Vector3(p[0], p[1], 0))),
        this.lineMat(col)
      );
      loop.renderOrder = 20;
      L.add(loop);
      if (e.t === 'circle' || e.t === 'ngon') pts.push(e.x, e.y, 0);
      if (e.t === 'slot') pts.push(e.x1, e.y1, 0, e.x2, e.y2, 0);
      if (e.t === 'rect') for (const p of entityContour({ ...e, rr: 0 })) pts.push(p[0], p[1], 0);
      if (e.t === 'ngon') for (const p of entityContour(e)) pts.push(p[0], p[1], 0);
      if (e.t === 'poly') for (const p of polyCorners(e.pts)) pts.push(p[0], p[1], 0);
    });
    if (pts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x0b3d91, size: 5, sizeAttenuation: false, depthTest: false }));
      p.renderOrder = 21;
      L.add(p);
    }
    this.viewer.requestRender();
  }

  updatePreview() {
    const P = this.prevLayer;
    P.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    P.clear();
    const c = this.cursor;
    let label = '';
    const drawLoop = (l, color = COL.prev) => {
      const obj = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(l.map((p) => new THREE.Vector3(p[0], p[1], 0))), this.lineMat(color));
      obj.renderOrder = 22;
      P.add(obj);
    };
    for (const g of this.ghost || []) drawLoop(entityContour(g, 64));
    if (this.tool === 'offset') {
      label = `Desfase ${fmt(this.offsetDist, 2)}`;
      const e = this.offsetSrc >= 0 && this.offsetResult(c);
      if (e) drawLoop(entityContour(e, 64));
    }
    if ((this.tool === 'fillet' || this.tool === 'chamfer') && c) {
      label = this.tool === 'fillet' ? `Empalme R ${fmt(this.filletR, 2)}` : `Chaflán ${fmt(this.chamferD, 2)}`;
      const e = this.corner && this.cornerResult(this.corner);
      if (e) drawLoop(entityContour(e, 64));
      else if (this.corner) label += ' (no cabe)';
    }
    if (c && this.pts.length) {
      const a = this.pts[0];
      let contour = null, open = null;
      const dx = c.u - a.u, dy = c.v - a.v;
      switch (this.tool) {
        case 'rect':
          contour = entityContour({ t: 'rect', x: a.u, y: a.v, w: dx, h: dy });
          label = `${fmt(Math.abs(dx), 2)} × ${fmt(Math.abs(dy), 2)}`;
          break;
        case 'rectc':
          contour = entityContour({ t: 'rect', x: a.u - Math.abs(dx), y: a.v - Math.abs(dy), w: 2 * Math.abs(dx), h: 2 * Math.abs(dy) });
          label = `${fmt(2 * Math.abs(dx), 2)} × ${fmt(2 * Math.abs(dy), 2)}`;
          break;
        case 'circle':
          contour = entityContour({ t: 'circle', x: a.u, y: a.v, r: Math.hypot(dx, dy) }, 64);
          label = `R ${fmt(Math.hypot(dx, dy), 2)}  Ø ${fmt(2 * Math.hypot(dx, dy), 2)}`;
          break;
        case 'ngon':
          contour = entityContour({ t: 'ngon', x: a.u, y: a.v, r: Math.hypot(dx, dy), n: this.ngonSides, a: Math.atan2(dy, dx) / DEG });
          label = `R ${fmt(Math.hypot(dx, dy), 2)}  (${this.ngonSides} lados)`;
          break;
        case 'line': {
          open = [...this.pts, c].map((p) => [p.u, p.v]);
          const last = this.pts[this.pts.length - 1];
          const len = Math.hypot(c.u - last.u, c.v - last.v);
          const ang = Math.atan2(c.v - last.v, c.u - last.u) / DEG;
          label = `L ${fmt(len, 2)}  ∠ ${fmt(ang, 1)}°`;
          break;
        }
        case 'slot':
          if (this.pts.length === 1) {
            open = [[a.u, a.v], [c.u, c.v]];
            label = `L ${fmt(Math.hypot(dx, dy), 2)}`;
          } else {
            const b = this.pts[1];
            const r = Math.max(0.01, distToSeg(c, a, b));
            contour = entityContour({ t: 'slot', x1: a.u, y1: a.v, x2: b.u, y2: b.v, r }, 48);
            label = `R ${fmt(r, 2)}`;
          }
          break;
      }
      const pts = contour || open;
      if (pts) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p[0], p[1], 0)));
        const obj = contour ? new THREE.LineLoop(geo, this.lineMat(COL.prev)) : new THREE.Line(geo, this.lineMat(COL.prev));
        obj.renderOrder = 22;
        P.add(obj);
      }
    }
    this.labelText = label;
    this.viewer.requestRender();
  }

  updateHud() {
    this.updateDims();
    const c = this.cursor;
    if (!c || this.app.featureForm) {
      this.marker.style.display = 'none';
      this.label.style.display = 'none';
      this.app.setCoords(null);
      return;
    }
    const s = this.screenOf(c.u, c.v);
    this.marker.style.display = c.snap === 'point' || c.snap === 'H' || c.snap === 'V' ? 'block' : 'none';
    this.marker.className = 'snap-marker ' + (c.snap || '') + (c.kind ? ' ' + c.kind : '');
    this.marker.textContent = c.snap === 'H' ? '—' : c.snap === 'V' ? '|' : '';
    this.marker.style.left = s.x + 'px';
    this.marker.style.top = s.y + 'px';
    if (this.labelText) {
      this.label.style.display = 'block';
      this.label.textContent = this.labelText;
      this.label.style.left = s.x + 16 + 'px';
      this.label.style.top = s.y + 14 + 'px';
    } else this.label.style.display = 'none';
    if (this.input.style.display === 'block') {
      this.input.style.left = s.x + 16 + 'px';
      this.input.style.top = s.y + 38 + 'px';
    }
    const last = this.pts[this.pts.length - 1];
    const rel = last ? `   @${fmt(c.u - last.u, 2)},${fmt(c.v - last.v, 2)}` : '';
    this.app.setCoords(`Croquis  X ${fmt(c.u, 2)}  Y ${fmt(c.v, 2)}${rel}${this.app.settings.sketchOrtho ? '   ORTO' : ''}`);
  }

  // Cotas de todas las entidades, colocadas junto a su tramo en pantalla
  updateDims() {
    const box = this.dimBox;
    if (!this.app.settings.sketchDims || this.app.featureForm) {
      box.replaceChildren();
      return;
    }
    const o = this.screenOf(0, 0), ux = this.screenOf(1, 0);
    const ppu = Math.max(1e-6, Math.hypot(ux.x - o.x, ux.y - o.y)); // píxeles por mm
    const shift = { below: [0, -16 / ppu], above: [0, 14 / ppu], right: [16 / ppu, 0] };
    const labels = [];
    for (const e of this.entities) {
      const dims = entityDims(e);
      if (e.t === 'poly' && dims.length > 40) continue;
      for (const d of dims) {
        if (d.a) {
          const a = this.screenOf(d.a[0], d.a[1]), b = this.screenOf(d.b[0], d.b[1]);
          if (Math.hypot(a.x - b.x, a.y - b.y) < 40) continue;
        }
        const [du, dv] = shift[d.side] || [0, 0];
        const s = this.screenOf(d.u + du, d.v + dv);
        labels.push([s, d.text]);
      }
    }
    while (box.children.length > labels.length) box.lastChild.remove();
    while (box.children.length < labels.length) box.append(h('span', { class: 'sk-dim' }));
    labels.forEach(([s, text], i) => {
      const el = box.children[i];
      if (el.textContent !== text) el.textContent = text;
      el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    });
  }

  // ------------------------------------------------------------ entrada numérica
  showInput(first) {
    const ph = VALUE_TOOLS[this.tool]
      ? { offset: 'distancia de desfase', fillet: 'radio de empalme', chamfer: 'distancia del chaflán' }[this.tool]
      : !this.pts.length
        ? 'primer punto: x,y'
        : {
            rect: 'ancho x alto  o  @dx,dy',
            rectc: 'ancho x alto',
            circle: 'radio',
            ngon: 'radio',
            line: 'longitud · x,y · @dx,dy · @long<ángulo',
            slot: this.pts.length === 1 ? 'longitud · x,y · @dx,dy · @long<ángulo' : 'radio',
          }[this.tool];
    if (!ph) return;
    this.input.placeholder = ph;
    this.input.value = first || '';
    this.input.style.display = 'block';
    this.updateHud();
    this.input.focus();
  }

  hideInput() {
    this.input.style.display = 'none';
    this.input.value = '';
    this.viewer.renderer.domElement.focus?.();
  }

  onInputKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') return this.hideInput();
    if (e.key !== 'Enter') return;
    const txt = this.input.value.trim();
    this.hideInput();
    this.applyTyped(txt);
  }

  applyTyped(txt) {
    const vk = VALUE_TOOLS[this.tool];
    if (vk) {
      const v = Math.abs(evalNum(txt));
      if (!(v > 0)) return toast('Valor no válido', 'warn');
      this[vk] = r6(v);
      this.updatePreview();
      this.app.renderProps();
      return;
    }
    const a = this.pts[0];
    if (!a) {
      // Primer punto escrito con coordenadas
      const p = parsePoint(txt, null);
      if (!p) return toast('Escribe el punto como x,y (por ejemplo 0,0 o -40,25)', 'warn');
      this.pts.push(p);
      this.updatePreview();
      return;
    }
    const c = this.cursor || a;
    // Segundo punto relativo: "@dx,dy" (en el rectángulo también "x,y" absoluto)
    const pointLike = txt.trim().startsWith('@') || (this.tool === 'rect' && txt.includes(','));
    if (pointLike && ['rect', 'rectc', 'circle', 'ngon'].includes(this.tool)) {
      const p = parsePoint(txt, a);
      const e = p && this.entityFrom(a, p);
      if (!e) return toast('Punto no válido', 'warn');
      this.pts = [];
      this.addEntity(e);
      return;
    }
    const parts = txt.split(/\s*[x×;*\s]\s*/i).filter(Boolean).map((s) => evalNum(s));
    const [n1, n2] = parts;
    const sign = (v) => (v < 0 ? -1 : 1);
    if (this.tool === 'rect' || this.tool === 'rectc') {
      const w = Math.abs(n1), hh = Math.abs(isFinite(n2) ? n2 : n1);
      if (!(w > 0 && hh > 0)) return toast('Medida no válida', 'warn');
      const e = this.tool === 'rect'
        ? { t: 'rect', x: a.u, y: a.v, w: r6(w * sign(c.u - a.u)), h: r6(hh * sign(c.v - a.v)) }
        : { t: 'rect', x: r6(a.u - w / 2), y: r6(a.v - hh / 2), w: r6(w), h: r6(hh) };
      this.pts = [];
      this.addEntity(e);
      return;
    }
    if (this.tool === 'circle' || this.tool === 'ngon' || (this.tool === 'slot' && this.pts.length === 2)) {
      const r = Math.abs(n1);
      if (!(r > 0)) return toast('Radio no válido', 'warn');
      let e;
      if (this.tool === 'circle') e = { t: 'circle', x: a.u, y: a.v, r: r6(r) };
      else if (this.tool === 'ngon') e = { t: 'ngon', x: a.u, y: a.v, r: r6(r), n: this.ngonSides, a: r6(Math.atan2(c.v - a.v, c.u - a.u) / DEG || 90) };
      else e = { t: 'slot', x1: a.u, y1: a.v, x2: this.pts[1].u, y2: this.pts[1].v, r: r6(r) };
      this.pts = [];
      this.addEntity(e);
      return;
    }
    if (this.tool === 'line' || this.tool === 'slot') {
      const last = this.pts[this.pts.length - 1];
      const pt = parsePoint(txt, last);
      if (pt) {
        if (Math.hypot(pt.u - last.u, pt.v - last.v) < 1e-9) return;
        const first = this.pts[0];
        if (this.tool === 'line' && this.pts.length >= 3 && Math.hypot(pt.u - first.u, pt.v - first.v) < 1e-9) return this.closePoly();
        this.pts.push(pt);
        this.updatePreview();
        return;
      }
      const [ls, as] = txt.split(/[<@]/);
      const len = evalNum(ls);
      if (!(len > 0)) return toast('Longitud no válida', 'warn');
      let ang;
      if (as != null && as.trim()) ang = evalNum(as) * DEG;
      else {
        const dx = c.u - last.u, dy = c.v - last.v;
        ang = Math.hypot(dx, dy) > 1e-9 ? Math.atan2(dy, dx) : 0;
      }
      const p = { u: r6(last.u + len * Math.cos(ang)), v: r6(last.v + len * Math.sin(ang)) };
      this.pts.push(p);
      this.updatePreview();
    }
  }

  // ------------------------------------------------------------ resultado
  validate() {
    const regions = buildRegions(this.entities, 32);
    if (!regions.length) {
      toast('Dibuja al menos un perfil cerrado.', 'warn');
      return false;
    }
    return true;
  }
}

function distToSeg(p, a, b) {
  const dx = b.u - a.u, dy = b.v - a.v;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.u - a.u) * dx + (p.v - a.v) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.u - (a.u + t * dx), p.v - (a.v + t * dy));
}

// Vértices de una polilínea que son esquinas (omite los puntos intermedios de los arcos)
function polyCorners(l) {
  if (l.length <= 12) return l;
  return l.filter((p, i) => {
    const a = l[(i - 1 + l.length) % l.length], b = l[(i + 1) % l.length];
    const t1 = Math.atan2(p[1] - a[1], p[0] - a[0]), t2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d > 20 * DEG;
  });
}

function pointIn(pt, l) {
  let inside = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const [xi, yi] = l[i], [xj, yj] = l[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyAreaOf(l) {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const p = l[i], q = l[(i + 1) % l.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// ---------------------------------------------------------------- DXF
export function entitiesToDXF(entities) {
  const out = ['0', 'SECTION', '2', 'ENTITIES'];
  const n = (v) => String(Math.round(v * 1e6) / 1e6);
  const line = (a, b) => out.push('0', 'LINE', '8', '0', '10', n(a[0]), '20', n(a[1]), '30', '0', '11', n(b[0]), '21', n(b[1]), '31', '0');
  const arc = (cx, cy, r, a0, a1) => out.push('0', 'ARC', '8', '0', '10', n(cx), '20', n(cy), '30', '0', '40', n(r), '50', n(a0), '51', n(a1));
  for (const e of entities) {
    if (e.t === 'circle') {
      out.push('0', 'CIRCLE', '8', '0', '10', n(e.x), '20', n(e.y), '30', '0', '40', n(e.r));
    } else if (e.t === 'slot') {
      const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
      const s = Math.sin(ang), c = Math.cos(ang), r = e.r;
      const A = ang / DEG;
      arc(e.x2, e.y2, r, A - 90, A + 90);
      arc(e.x1, e.y1, r, A + 90, A + 270);
      line([e.x1 + r * s, e.y1 - r * c], [e.x2 + r * s, e.y2 - r * c]);
      line([e.x2 - r * s, e.y2 + r * c], [e.x1 - r * s, e.y1 + r * c]);
    } else {
      const l = entityContour(e);
      for (let i = 0; i < l.length; i++) line(l[i], l[(i + 1) % l.length]);
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

// Importa un DXF (LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE) y forma perfiles cerrados
export function dxfToEntities(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  const ents = [];
  let inEntities = false;
  for (let i = 0; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 2 && val === 'ENTITIES') inEntities = true;
    if (code === 0 && val === 'ENDSEC') inEntities = false;
    if (!inEntities || code !== 0) continue;
    const ent = { type: val, data: [] };
    let j = i + 1;
    while (j < pairs.length && pairs[j][0] !== 0) ent.data.push(pairs[j++]);
    // POLYLINE R12: reúne VERTEX hasta SEQEND
    if (val === 'POLYLINE') {
      ent.verts = [];
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'SEQEND')) {
        if (pairs[j][0] === 0 && pairs[j][1] === 'VERTEX') {
          const v = { x: 0, y: 0, b: 0 };
          j++;
          while (j < pairs.length && pairs[j][0] !== 0) {
            const [c, s] = pairs[j++];
            if (c === 10) v.x = +s;
            if (c === 20) v.y = +s;
            if (c === 42) v.b = +s;
          }
          ent.verts.push(v);
        } else j++;
      }
    }
    ents.push(ent);
    i = j - 1;
  }
  const result = [];
  const segs = []; // segmentos abiertos [{pts}]
  const bulgePts = (a, b, bulge, out) => {
    if (!bulge) return;
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = (b[0] - a[0]) / chord, dy = (b[1] - a[1]) / chord;
    const sag = r * Math.cos(theta / 2);
    const cx = mx - dy * sag, cy = my + dx * sag;
    const a0 = Math.atan2(a[1] - cy, a[0] - cx);
    const steps = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 16)));
    for (let k = 1; k < steps; k++) {
      const t = a0 + (theta * k) / steps;
      out.push([cx + Math.abs(r) * Math.cos(t), cy + Math.abs(r) * Math.sin(t)]);
    }
  };
  const polyFrom = (verts, closed) => {
    const pts = [];
    for (let k = 0; k < verts.length; k++) {
      const v = verts[k];
      pts.push([v.x, v.y]);
      const nx = verts[(k + 1) % verts.length];
      if (k < verts.length - 1 || closed) bulgePts([v.x, v.y], [nx.x, nx.y], v.b, pts);
    }
    return pts;
  };
  for (const e of ents) {
    const g = (c) => e.data.find((d) => d[0] === c)?.[1];
    const num = (c, d = 0) => (g(c) != null ? +g(c) : d);
    if (e.type === 'LINE') segs.push([[num(10), num(20)], [num(11), num(21)]]);
    else if (e.type === 'CIRCLE') result.push({ t: 'circle', x: num(10), y: num(20), r: num(40) });
    else if (e.type === 'ARC') {
      const cx = num(10), cy = num(20), r = num(40);
      let a0 = num(50) * DEG, a1 = num(51) * DEG;
      if (a1 <= a0) a1 += Math.PI * 2;
      const steps = Math.max(4, Math.ceil((a1 - a0) / (Math.PI / 24)));
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const t = a0 + ((a1 - a0) * k) / steps;
        pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
      }
      segs.push(pts);
    } else if (e.type === 'LWPOLYLINE') {
      const verts = [];
      for (const [c, s] of e.data) {
        if (c === 10) verts.push({ x: +s, y: 0, b: 0 });
        else if (c === 20 && verts.length) verts[verts.length - 1].y = +s;
        else if (c === 42 && verts.length) verts[verts.length - 1].b = +s;
      }
      const closed = (num(70) & 1) === 1;
      const pts = polyFrom(verts, closed);
      if (closed && pts.length >= 3) result.push({ t: 'poly', pts });
      else if (pts.length >= 2) segs.push(pts);
    } else if (e.type === 'POLYLINE' && e.verts) {
      const closed = (num(70) & 1) === 1;
      const pts = polyFrom(e.verts, closed);
      if (closed && pts.length >= 3) result.push({ t: 'poly', pts });
      else if (pts.length >= 2) segs.push(pts);
    }
  }
  // Encadena segmentos abiertos en lazos cerrados
  const tol = 1e-3;
  const same = (a, b) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  const pool = segs.slice();
  while (pool.length) {
    let chain = pool.shift().slice();
    let grown = true;
    while (grown && !same(chain[0], chain[chain.length - 1])) {
      grown = false;
      for (let k = 0; k < pool.length; k++) {
        const s = pool[k];
        const end = chain[chain.length - 1];
        if (same(end, s[0])) chain = chain.concat(s.slice(1));
        else if (same(end, s[s.length - 1])) chain = chain.concat(s.slice().reverse().slice(1));
        else continue;
        pool.splice(k, 1);
        grown = true;
        break;
      }
    }
    if (chain.length >= 4 && same(chain[0], chain[chain.length - 1])) {
      chain.pop();
      result.push({ t: 'poly', pts: chain.map((p) => [r6(p[0]), r6(p[1])]) });
    }
  }
  return result;
}
