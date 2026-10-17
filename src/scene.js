// Sincroniza el documento con la escena 3D: mallas, aristas, selección,
// modos de visualización y vista de sección.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { getGeometry, nodeMatrix, geomInUse, isCached } from './geometry.js';
import { DEG } from './util.js';
import { featureEdges } from './edges.js';

const EMPTY = new THREE.BufferGeometry();
EMPTY.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
EMPTY.computeBoundingBox();
EMPTY.computeBoundingSphere();

const edgeCache = new WeakMap();
export function edgesOf(geom) {
  let e = edgeCache.get(geom);
  if (!e) {
    e = featureEdges(geom, 28);
    edgeCache.set(geom, e);
  }
  return e;
}

export class SceneSync {
  constructor(app) {
    this.app = app;
    this.viewer = app.viewer;
    this.meshes = new Map(); // id -> Mesh
    this.errors = new Map(); // id -> mensaje
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x1d232b, transparent: true, opacity: 0.85 });
    this.selEdgeMat = new THREE.LineBasicMaterial({ color: 0x2f7df6 });
    this.capMat = new THREE.MeshBasicMaterial({ color: 0xe0874a, side: THREE.BackSide });
    this.hoverId = null;
    this.clipPlanes = null;
  }

  ctx() {
    return { seg: this.app.settings.quality || 48, meshStore: this.app.doc.meshStore };
  }

  geometryFor(node) {
    try {
      const g = getGeometry(node, this.ctx());
      this.errors.delete(node.id);
      return g;
    } catch (err) {
      console.warn(err);
      this.errors.set(node.id, err.message || String(err));
      return EMPTY;
    }
  }

  sync() {
    const doc = this.app.doc;
    const seen = new Set();
    const t0 = performance.now();
    for (const node of doc.nodes) {
      seen.add(node.id);
      let mesh = this.meshes.get(node.id);
      if (!mesh) {
        const mat = new THREE.MeshPhongMaterial({
          color: node.color,
          shininess: 45,
          specular: 0x2a2a2a,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        mesh = new THREE.Mesh(EMPTY, mat);
        mesh.userData.nodeId = node.id;
        const edges = new THREE.LineSegments(EMPTY, this.edgeMat);
        edges.raycast = () => {};
        mesh.add(edges);
        mesh.userData.edges = edges;
        this.viewer.world.add(mesh);
        this.meshes.set(node.id, mesh);
      }
      const g = this.geometryFor(node);
      if (mesh.geometry !== g) this.setGeometry(mesh, g);
      applyTransform(mesh, node);
      mesh.material.color.set(node.color || '#a9b8cc');
      mesh.visible = node.visible !== false;
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) {
        this.viewer.world.remove(mesh);
        this.releaseGeometry(mesh.geometry);
        mesh.material.dispose();
        this.meshes.delete(id);
      }
    }
    this.viewer.world.updateMatrixWorld(true);
    this.applyDisplay();
    this.applyHighlight();
    this.viewer.requestRender();
    return performance.now() - t0;
  }

  setGeometry(mesh, g) {
    const old = mesh.geometry;
    mesh.geometry = g;
    geomInUse.add(g);
    this.releaseGeometry(old);
    this.updateEdges(mesh);
  }

  releaseGeometry(g) {
    if (!g || g === EMPTY) return;
    for (const m of this.meshes.values()) if (m.geometry === g) return;
    geomInUse.delete(g);
    if (!isCached(g)) {
      edgeCache.get(g)?.dispose();
      g.dispose();
    }
  }

  updateEdges(mesh) {
    const mode = this.app.settings.display;
    const want = mode !== 'shaded' && mesh.geometry !== EMPTY;
    mesh.userData.edges.geometry = want ? edgesOf(mesh.geometry) : EMPTY;
  }

  applyDisplay() {
    const mode = this.app.settings.display || 'edges';
    for (const mesh of this.meshes.values()) {
      const m = mesh.material;
      m.visible = mode !== 'wire';
      m.transparent = mode === 'xray';
      m.opacity = mode === 'xray' ? 0.35 : 1;
      m.depthWrite = mode !== 'xray';
      m.clippingPlanes = this.clipPlanes;
      m.needsUpdate = true;
      this.updateEdges(mesh);
      this.updateCap(mesh);
    }
    for (const em of [this.edgeMat, this.selEdgeMat]) {
      em.clippingPlanes = this.clipPlanes;
      em.needsUpdate = true;
    }
    this.applyHighlight();
  }

  // Tapas de sección: caras traseras pintadas de color sólido
  updateCap(mesh) {
    let cap = mesh.userData.cap;
    if (this.clipPlanes) {
      if (!cap) {
        cap = new THREE.Mesh(mesh.geometry, this.capMat);
        cap.raycast = () => {};
        mesh.add(cap);
        mesh.userData.cap = cap;
      }
      cap.geometry = mesh.geometry;
      this.capMat.clippingPlanes = this.clipPlanes;
    } else if (cap) {
      mesh.remove(cap);
      mesh.userData.cap = null;
    }
  }

  setSection(plane) {
    this.clipPlanes = plane ? [plane] : null;
    this.viewer.clipPlane = plane || null;
    this.applyDisplay();
  }

  applyHighlight() {
    const sel = new Set(this.app.selection.map((id) => this.app.doc.topOf(id)?.id));
    const direct = new Set(this.app.selection);
    for (const [id, mesh] of this.meshes) {
      const m = mesh.material;
      if (direct.has(id)) m.emissive.setHex(0x1f4fa8);
      else if (sel.has(id)) m.emissive.setHex(0x0c1f40);
      else if (this.hoverId === id) m.emissive.setHex(0x3a3320);
      else m.emissive.setHex(0x000000);
      const edges = mesh.userData.edges;
      const on = direct.has(id) || sel.has(id);
      edges.material = on ? this.selEdgeMat : this.edgeMat;
      edges.renderOrder = on ? 5 : 0;
      if (on && edges.geometry === EMPTY && mesh.geometry !== EMPTY) edges.geometry = edgesOf(mesh.geometry);
      else if (!on && this.app.settings.display === 'shaded') edges.geometry = EMPTY;
    }
    this.viewer.requestRender();
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.applyHighlight();
  }

  pickables() {
    const out = [];
    for (const m of this.meshes.values()) {
      if (!m.visible || m.geometry === EMPTY) continue;
      const g = m.geometry;
      if (!g.boundsTree && g.attributes.position.count > 3000) {
        g.boundsTree = new MeshBVH(g, { indirect: true });
      }
      out.push(m);
    }
    return out;
  }

  // Matriz del nodo en coordenadas del mundo (considerando sus padres)
  worldMatrix(id) {
    const f = this.app.doc.find(id);
    if (!f) return new THREE.Matrix4();
    const m = new THREE.Matrix4();
    for (const p of f.parents) m.multiply(nodeMatrix(p));
    return m.multiply(nodeMatrix(f.node));
  }

  parentMatrix(id) {
    const f = this.app.doc.find(id);
    const m = new THREE.Matrix4();
    if (f) for (const p of f.parents) m.multiply(nodeMatrix(p));
    return m;
  }

  worldBox(id) {
    const node = this.app.doc.get(id);
    if (!node) return new THREE.Box3();
    const g = this.geometryFor(node);
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox.clone().applyMatrix4(this.worldMatrix(id));
  }
}

export function applyTransform(obj, node) {
  obj.position.set(...(node.pos || [0, 0, 0]));
  const r = node.rot || [0, 0, 0];
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
  obj.scale.set(...(node.scl || [1, 1, 1]));
  obj.updateMatrix();
}

export { EMPTY };
