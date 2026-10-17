// Visor 3D: renderizado bajo demanda (sólo cuando algo cambia), cámaras,
// rejilla, planos de referencia, indicador de ejes y vistas estándar.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { acceleratedRaycast } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

const VIEWS = {
  front: { dir: [0, 0, 1], label: 'Frontal' },
  back: { dir: [0, 0, -1], label: 'Posterior' },
  right: { dir: [1, 0, 0], label: 'Derecha' },
  left: { dir: [-1, 0, 0], label: 'Izquierda' },
  top: { dir: [0, 1, 0.0001], label: 'Superior' },
  bottom: { dir: [0, -1, 0.0001], label: 'Inferior' },
  iso: { dir: [1, 0.8, 1], label: 'Isométrica' },
};
export { VIEWS };

export class Viewer extends THREE.EventDispatcher {
  constructor(container, settings) {
    super();
    this.container = container;
    this.settings = settings;
    const r = (this.renderer = new THREE.WebGLRenderer({
      antialias: !settings.light,
      alpha: true,
      stencil: false,
      powerPreference: 'default',
    }));
    r.setPixelRatio(settings.light ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    r.setClearColor(0x000000, 0);
    r.localClippingEnabled = true;
    container.prepend(r.domElement);

    this.scene = new THREE.Scene();
    this.world = new THREE.Group(); // cuerpos
    this.overlay = new THREE.Group(); // ayudas (croquis, medidas, previsualización)
    this.helpers = new THREE.Group(); // rejilla, ejes, planos
    this.scene.add(this.helpers, this.world, this.overlay);

    this.persp = new THREE.PerspectiveCamera(35, 1, 0.1, 1e5);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    this.camera = this.persp;
    this.persp.position.set(160, 130, 200);

    // Luces que siguen a la cámara (iluminación tipo CAD)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
    this.lightRig = new THREE.Object3D();
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
    this.keyLight.position.set(-0.6, 0.9, 0.2);
    this.keyLight.target.position.set(0, 0, -1);
    this.lightRig.add(this.keyLight, this.keyLight.target);
    this.scene.add(this.lightRig);

    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    c.screenSpacePanning = true;
    c.zoomToCursor = true;
    c.rotateSpeed = 0.9;
    c.target.set(0, 10, 0);
    c.addEventListener('change', () => this.requestRender());
    this.defaultButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    c.mouseButtons = { ...this.defaultButtons };

    this.tc = new TransformControls(this.camera, r.domElement);
    this.tc.setSize(0.85);
    this.tc.addEventListener('change', () => this.requestRender());
    this.tc.addEventListener('dragging-changed', (e) => (c.enabled = !e.value));
    this.scene.add(this.tc.getHelper());

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 1;

    this.buildHelpers();
    this.buildAxisGizmo();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();
  }

  // ---------------------------------------------------------------- render
  requestRender() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => {
      this._pending = false;
      this.render();
    });
  }

  render() {
    const cam = this.camera;
    const dist = cam.position.distanceTo(this.controls.target);
    if (cam.isPerspectiveCamera) {
      cam.near = Math.max(0.05, dist / 400);
      cam.far = Math.max(2000, dist * 60);
      cam.updateProjectionMatrix();
    }
    this.lightRig.position.copy(cam.position);
    this.lightRig.quaternion.copy(cam.quaternion);
    this.dispatchEvent({ type: 'beforerender' });
    this.renderer.render(this.scene, cam);
    this.drawAxisGizmo();
    this.dispatchEvent({ type: 'render' });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.requestRender();
  }

  updateOrthoFrustum() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const halfH = this._orthoHalf || 100;
    this.ortho.left = (-halfH * w) / h;
    this.ortho.right = (halfH * w) / h;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- cámaras
  setProjection(ortho) {
    if (ortho === this.camera.isOrthographicCamera) return;
    const from = this.camera, target = this.controls.target;
    if (ortho) {
      const dist = from.position.distanceTo(target);
      this._orthoHalf = dist * Math.tan((this.persp.fov * Math.PI) / 360);
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
      this.ortho.position.copy(from.position);
      this.ortho.quaternion.copy(from.quaternion);
      this.camera = this.ortho;
    } else {
      const halfH = (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom;
      const dist = halfH / Math.tan((this.persp.fov * Math.PI) / 360);
      const dir = new THREE.Vector3().subVectors(from.position, target).normalize();
      this.persp.position.copy(target).addScaledVector(dir, dist);
      this.camera = this.persp;
    }
    this.controls.object = this.camera;
    this.tc.camera = this.camera;
    this.controls.update();
    this.dispatchEvent({ type: 'camerachange' });
    this.requestRender();
  }

  // Encuadra una caja (o toda la escena) con animación
  fit(box, dir) {
    if (!box || box.isEmpty()) {
      box = new THREE.Box3(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 50, 50));
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const d = dir ? dir.clone().normalize() : new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const dist = (radius / Math.sin((this.persp.fov * Math.PI) / 360)) * 1.5;
    this.animateTo(sphere.center.clone().addScaledVector(d, dist), sphere.center, radius * 1.5);
  }

  sceneBox(onlyVisible = true) {
    const box = new THREE.Box3();
    this.world.traverse((o) => {
      if (o.isMesh && o.userData.nodeId && (!onlyVisible || o.visible) && o.geometry.boundingBox) {
        const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        box.union(b);
      }
    });
    return box;
  }

  setView(name) {
    const v = VIEWS[name];
    if (!v) return;
    const dir = new THREE.Vector3(...v.dir).normalize();
    const box = this.sceneBox();
    this.fit(box.isEmpty() ? null : box, dir);
  }

  // Orienta la cámara normal a un plano (para croquis)
  lookAtPlane(origin, normal, size = 150) {
    const target = origin.clone();
    const n = normal.clone().normalize();
    if (Math.abs(n.y) > 0.999) n.z += 0.0001 * Math.sign(n.y || 1);
    n.normalize();
    const dist = (size / Math.sin((this.persp.fov * Math.PI) / 360)) * 0.6;
    this.animateTo(target.clone().addScaledVector(n, dist), target, size * 0.6);
  }

  animateTo(pos, target, orthoHalf) {
    const cam = this.camera;
    const p0 = cam.position.clone(), t0 = this.controls.target.clone();
    const z0 = this.ortho.zoom, h0 = this._orthoHalf || 100;
    const dur = 320;
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      cam.position.lerpVectors(p0, pos, e);
      this.controls.target.lerpVectors(t0, target, e);
      if (cam.isOrthographicCamera && orthoHalf) {
        this._orthoHalf = h0 + (orthoHalf - h0) * e;
        cam.zoom = z0 + (1 - z0) * e;
        this.updateOrthoFrustum();
      }
      cam.lookAt(this.controls.target);
      this.controls.update();
      this.render();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- ayudas
  buildHelpers() {
    this.helpers.clear();
    const dark = document.documentElement.dataset.theme === 'dark';
    const size = this.settings.gridSize || 400;
    const step = this.settings.gridStep || 10;
    const minor = [], major = [];
    const n = Math.round(size / step / 2);
    for (let i = -n; i <= n; i++) {
      const v = i * step;
      const arr = i % 5 === 0 ? major : minor;
      if (i !== 0) arr.push(-n * step, 0, v, n * step, 0, v, v, 0, -n * step, v, 0, n * step);
    }
    const mk = (arr, color, op) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, depthWrite: false }));
    };
    this.grid = new THREE.Group();
    this.grid.add(mk(minor, dark ? 0x5a6472 : 0x8f9bab, 0.35), mk(major, dark ? 0x6b7684 : 0x76849a, 0.6));
    const L = n * step;
    const ax = (a, b, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
    };
    this.grid.add(ax(new THREE.Vector3(-L, 0, 0), new THREE.Vector3(L, 0, 0), 0xd9534f));
    this.grid.add(ax(new THREE.Vector3(0, 0, -L), new THREE.Vector3(0, 0, L), 0x3b7ddd));
    this.grid.renderOrder = -1;
    this.grid.visible = this.settings.grid !== false;
    this.helpers.add(this.grid);

    // Planos de referencia (Alzado, Planta, Perfil)
    this.planes = new THREE.Group();
    const ps = 60;
    const defs = [
      { name: 'front', label: 'Alzado (XY)', rot: [0, 0, 0] },
      { name: 'top', label: 'Planta (XZ)', rot: [-Math.PI / 2, 0, 0] },
      { name: 'right', label: 'Perfil (YZ)', rot: [0, Math.PI / 2, 0] },
    ];
    for (const d of defs) {
      const grp = new THREE.Group();
      grp.rotation.set(...d.rot);
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(ps * 2, ps * 2),
        new THREE.MeshBasicMaterial({ color: 0x4f8fe0, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })
      );
      quad.userData.planeName = d.name;
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-ps, -ps, 0), new THREE.Vector3(ps, -ps, 0),
          new THREE.Vector3(ps, ps, 0), new THREE.Vector3(-ps, ps, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x4f8fe0, transparent: true, opacity: 0.45, depthWrite: false })
      );
      grp.add(quad, border);
      grp.userData = { planeName: d.name, quad, border };
      this.planes.add(grp);
    }
    this.planes.visible = this.settings.planes !== false;
    this.helpers.add(this.planes);

    // Origen
    const o = new THREE.Group();
    const oa = (to, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    };
    o.add(oa(new THREE.Vector3(12, 0, 0), 0xd9534f), oa(new THREE.Vector3(0, 12, 0), 0x3aa655), oa(new THREE.Vector3(0, 0, 12), 0x3b7ddd));
    o.renderOrder = 10;
    this.helpers.add(o);
    this.requestRender();
  }

  highlightPlane(name) {
    for (const g of this.planes.children) {
      const on = g.userData.planeName === name;
      g.userData.quad.material.opacity = on ? 0.22 : 0.06;
      g.userData.border.material.opacity = on ? 1 : 0.45;
    }
    this.requestRender();
  }

  // ---------------------------------------------------------------- picking
  setPointer(ev) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    return this.raycaster;
  }

  pick(ev, objects, recursive = false) {
    this.setPointer(ev);
    const hits = this.raycaster.intersectObjects(objects, recursive);
    return hits.find((h) => this.isClipVisible(h.point)) || null;
  }

  isClipVisible(p) {
    const cp = this.clipPlane;
    return !cp || cp.distanceToPoint(p) >= -1e-6;
  }

  rayPlane(ev, plane) {
    this.setPointer(ev);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
  }

  toScreen(v) {
    const p = v.clone().project(this.camera);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, behind: p.z > 1 };
  }

  // mm por píxel en el punto dado (para tolerancias)
  pixelSize(at) {
    const h = this.container.clientHeight || 1;
    if (this.camera.isOrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / h;
    const d = this.camera.position.distanceTo(at || this.controls.target);
    return (2 * d * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
  }

  // ---------------------------------------------------------------- gizmo de ejes
  buildAxisGizmo() {
    const cv = (this.axisCanvas = document.createElement('canvas'));
    cv.className = 'axis-gizmo';
    const s = 96;
    cv.width = s * 2;
    cv.height = s * 2;
    cv.style.width = s + 'px';
    cv.style.height = s + 'px';
    this.container.append(cv);
    this._axisHits = [];
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 14;
      for (const hit of this._axisHits) {
        const d = Math.hypot(hit.x - x, hit.y - y);
        if (d < bd) { bd = d; best = hit; }
      }
      if (best) this.setView(best.view);
    });
  }

  drawAxisGizmo() {
    const cv = this.axisCanvas;
    const ctx = cv.getContext('2d');
    const s = cv.width / 2;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, s, s);
    const q = this.camera.quaternion.clone().invert();
    const c = s / 2, R = s * 0.34;
    const axes = [
      { v: [1, 0, 0], col: '#e0524c', l: 'X', view: 'right' },
      { v: [0, 1, 0], col: '#3aa655', l: 'Y', view: 'top' },
      { v: [0, 0, 1], col: '#3b7ddd', l: 'Z', view: 'front' },
      { v: [-1, 0, 0], col: '#e0524c', l: '', view: 'left' },
      { v: [0, -1, 0], col: '#3aa655', l: '', view: 'bottom' },
      { v: [0, 0, -1], col: '#3b7ddd', l: '', view: 'back' },
    ].map((a) => {
      const p = new THREE.Vector3(...a.v).applyQuaternion(q);
      return { ...a, x: c + p.x * R, y: c - p.y * R, z: p.z };
    });
    axes.sort((a, b) => a.z - b.z);
    this._axisHits = axes;
    const dark = document.documentElement.dataset.theme === 'dark';
    ctx.fillStyle = dark ? 'rgba(30,34,40,.55)' : 'rgba(255,255,255,.55)';
    ctx.beginPath();
    ctx.arc(c, c, s * 0.47, 0, Math.PI * 2);
    ctx.fill();
    for (const a of axes) {
      ctx.globalAlpha = a.l ? 1 : 0.55;
      if (a.l) {
        ctx.strokeStyle = a.col;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(a.x, a.y);
        ctx.stroke();
      }
      ctx.fillStyle = a.col;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.l ? 8 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (a.l) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.l, a.x, a.y + 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }
}
