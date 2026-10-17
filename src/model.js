// Documento: árbol de nodos (cuerpos y operaciones), historial deshacer/rehacer.
import { TYPES, defaultParams } from './geometry.js';
import { f32ToB64, b64ToF32 } from './util.js';

export const PALETTE = ['#a9b8cc', '#d2b48c', '#9cc59a', '#d79c9c', '#b4a7d6', '#d9c77e', '#8cc7c2', '#c9a0c4'];

export class Doc {
  constructor() {
    this.reset();
  }

  reset() {
    this.nodes = [];
    this.nextId = 1;
    this.counters = {};
    this.meshStore = new Map();
    this.colorIdx = 0;
  }

  newId() {
    return 'n' + this.nextId++;
  }

  autoName(type) {
    this.counters[type] = (this.counters[type] || 0) + 1;
    return `${TYPES[type]?.label || type} ${this.counters[type]}`;
  }

  nextColor() {
    return PALETTE[this.colorIdx++ % PALETTE.length];
  }

  makeNode(type, params, extra = {}) {
    return {
      id: this.newId(),
      name: this.autoName(type),
      type,
      params: params || defaultParams(type),
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      scl: [1, 1, 1],
      color: this.nextColor(),
      visible: true,
      ...extra,
    };
  }

  // Busca un nodo por id. Devuelve {node, list, index, parents[]}
  find(id, list = this.nodes, parents = []) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, list, index: i, parents };
      if (n.children) {
        const r = this.find(id, n.children, [...parents, n]);
        if (r) return r;
      }
    }
    return null;
  }

  get(id) {
    return this.find(id)?.node || null;
  }

  *walk(list = this.nodes) {
    for (const n of list) {
      yield n;
      if (n.children) yield* this.walk(n.children);
    }
  }

  topOf(id) {
    const f = this.find(id);
    if (!f) return null;
    return f.parents.length ? f.parents[0] : f.node;
  }

  remove(id) {
    const f = this.find(id);
    if (!f) return null;
    f.list.splice(f.index, 1);
    // Una operación con un solo hijo deja de tener sentido: se disuelve
    const parent = f.parents[f.parents.length - 1];
    if (parent && parent.children.length === 0) this.remove(parent.id);
    return f.node;
  }

  // Copia profunda con ids nuevos
  cloneNode(n) {
    const c = JSON.parse(JSON.stringify(n));
    const reid = (x) => {
      x.id = this.newId();
      if (x.children) x.children.forEach(reid);
    };
    reid(c);
    return c;
  }

  usedMeshRefs() {
    const s = new Set();
    for (const n of this.walk()) if (n.type === 'mesh') s.add(n.meshRef);
    return s;
  }

  snapshot() {
    return JSON.stringify({ nodes: this.nodes, nextId: this.nextId, counters: this.counters, colorIdx: this.colorIdx });
  }

  restore(snap) {
    const d = JSON.parse(snap);
    this.nodes = d.nodes;
    this.nextId = d.nextId;
    this.counters = d.counters || {};
    this.colorIdx = d.colorIdx || 0;
  }

  // Formato de archivo .mcad
  toFile() {
    const meshes = {};
    for (const ref of this.usedMeshRefs()) {
      const arr = this.meshStore.get(ref);
      if (arr) meshes[ref] = f32ToB64(arr);
    }
    return JSON.stringify({ app: 'MiniCAD', version: 1, ...JSON.parse(this.snapshot()), meshes });
  }

  fromFile(text) {
    const d = JSON.parse(text);
    if (d.app !== 'MiniCAD' || !Array.isArray(d.nodes)) throw new Error('No es un archivo de MiniCAD válido');
    this.reset();
    this.nodes = d.nodes;
    this.nextId = d.nextId || 1;
    this.counters = d.counters || {};
    this.colorIdx = d.colorIdx || 0;
    for (const [ref, b64] of Object.entries(d.meshes || {})) this.meshStore.set(ref, b64ToF32(b64));
  }
}

export class History {
  constructor(doc, limit = 80) {
    this.doc = doc;
    this.limit = limit;
    this.clear();
  }

  clear() {
    this.stack = [this.doc.snapshot()];
    this.labels = ['Inicio'];
    this.index = 0;
  }

  push(label = '') {
    const s = this.doc.snapshot();
    if (s === this.stack[this.index]) return false;
    this.stack.length = this.index + 1;
    this.labels.length = this.index + 1;
    this.stack.push(s);
    this.labels.push(label);
    if (this.stack.length > this.limit) {
      this.stack.shift();
      this.labels.shift();
    }
    this.index = this.stack.length - 1;
    return true;
  }

  canUndo() {
    return this.index > 0;
  }

  canRedo() {
    return this.index < this.stack.length - 1;
  }

  undo() {
    if (!this.canUndo()) return null;
    const label = this.labels[this.index];
    this.index--;
    this.doc.restore(this.stack[this.index]);
    return label;
  }

  redo() {
    if (!this.canRedo()) return null;
    this.index++;
    this.doc.restore(this.stack[this.index]);
    return this.labels[this.index];
  }
}
