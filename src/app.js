// Aplicación principal: interfaz, herramientas y flujo de trabajo.
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { SceneSync, EMPTY, applyTransform, edgesOf } from './scene.js';
import { Sketcher, SKETCH_TOOLS, entitiesToDXF, dxfToEntities } from './sketch.js';
import { affine, transformEntity, rectArray, polarArray, entityCenter, offsetEntity, cornerOp, toPoly } from './sketchops.js';
import { Tutorial } from './tutorial.js';
import { Doc, History, PALETTE } from './model.js';
import { TYPES, OPS, defaultParams, nodeMatrix, setNodeMatrix, massProps, clearGeometryCache, buildRegions } from './geometry.js';
import { exportSTL, exportOBJ, importMeshFile } from './io.js';
import { Electronics, BLANK_CODE } from './elec/index.js';
import { PARTS } from './elec/parts.js';
import { icon } from './icons.js';
import { h, evalNum, fmt, toast, debounce, storageGet, storageSet, downloadBlob, pickFile, DEG } from './util.js';

const VERSION = '1.2';

const DEFAULTS = {
  theme: 'light',
  quality: 48,
  light: false,
  display: 'edges',
  grid: true,
  planes: false,
  snap: 1,
  sketchSnap: 1,
  sketchOrtho: false,
  sketchDims: true,
  gridSize: 400,
  gridStep: 10,
  stlZUp: true,
  autosave: true,
  density: '7.85',
  ortho: false,
};

const MATERIALS = [
  ['7.85', 'Acero'], ['8.00', 'Acero inoxidable'], ['2.70', 'Aluminio'], ['8.96', 'Cobre'], ['8.50', 'Latón'],
  ['1.24', 'PLA'], ['1.04', 'ABS'], ['1.27', 'PETG'], ['1.15', 'Nylon'], ['0.60', 'Madera (pino)'],
  ['0.75', 'MDF'], ['2.40', 'Hormigón'], ['1.00', 'Agua'],
];

const PLANES = {
  front: { label: 'Alzado (XY)', o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] },
  top: { label: 'Planta (XZ)', o: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], n: [0, 1, 0] },
  right: { label: 'Perfil (YZ)', o: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], n: [1, 0, 0] },
};

const DISPLAY = {
  edges: 'Sombreado con aristas',
  shaded: 'Sombreado',
  wire: 'Alambre (sólo aristas)',
  xray: 'Transparente',
};

function planeFrom(def) {
  const v = (a) => new THREE.Vector3(...a);
  return { o: v(def.o), x: v(def.x), y: v(def.y), n: v(def.n), label: def.label };
}

// Plano de croquis a partir de un punto y una normal (cara de un sólido)
function planeFromNormal(n, p) {
  n = n.clone().normalize();
  let x, y;
  if (Math.abs(n.y) > 0.9) {
    x = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x).normalize();
    y = new THREE.Vector3().crossVectors(n, x).normalize();
  } else {
    y = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    x = new THREE.Vector3().crossVectors(y, n).normalize();
  }
  // Origen: proyección del origen del mundo sobre el plano (conserva la rejilla)
  const o = n.clone().multiplyScalar(n.dot(p));
  return { o, x, y, n, label: 'Cara' };
}

export class App {
  constructor(root) {
    this.root = root;
    this.settings = { ...DEFAULTS, ...storageGet('minicad.settings', {}) };
    document.documentElement.dataset.theme = this.settings.theme;
    this.doc = new Doc();
    this.history = new History(this.doc);
    this.selection = [];
    this.expanded = new Set();
    this.mode = 'select';
    this.gizmoMode = 'translate';
    this.featureForm = null;
    this.docName = 'Sin título';
    this.fileHandle = null;
    this.clipboard = null;
    this.tab = 'modelar';

    this.buildLayout();
    this.viewer = new Viewer(this.el.viewport, this.settings);
    this.sync = new SceneSync(this);
    this.elec = new Electronics(this);
    this.sketcher = new Sketcher(this);
    this.tutorial = new Tutorial(this);
    if (this.settings.ortho) this.viewer.setProjection(true);
    this.previewGroup = new THREE.Group();
    this.viewer.overlay.add(this.previewGroup);
    this.measureGroup = new THREE.Group();
    this.viewer.overlay.add(this.measureGroup);
    this.measures = [];

    this.bindViewport();
    this.bindGizmo();
    this.bindKeys();
    this.autosave = debounce(() => this.doAutosave(), 1200);
    this.restoreAutosave();
    this.renderRibbon();
    this.refresh();
    const ex = /^#ejemplo=(\w+)(&simular)?/.exec(location.hash);
    if (location.hash === '#demo') this.loadDemo(false);
    else if (ex) {
      this.doc.reset();
      this.elec.loadExample(ex[1]).then(() => ex[2] && this.elec.toggleSim());
    } else this.viewer.setView('iso');
    if (location.hash === '#tutorial') this.tutorial.start();
    else if (!location.hash && !storageGet('minicad.welcome')) setTimeout(() => this.showWelcome(), 300);
    setInterval(() => this.updateMemory(), 3000);
    this.updateMemory();
    this.setHint();
  }

  // =====================================================================
  // Diseño de la interfaz
  // =====================================================================
  buildLayout() {
    const qa = (ic, title, fn, id) =>
      h('button', { class: 'qa', title, onclick: fn, id, html: icon(ic, 18) });
    this.el = {};
    this.el.title = h('div', { class: 'doc-title' });
    const titlebar = h(
      'header',
      { class: 'titlebar' },
      h('div', { class: 'brand', html: icon('box', 20) + '<b>MiniCAD</b><span>3D</span>' }),
      h(
        'div',
        { class: 'quick' },
        qa('new', 'Nuevo (Ctrl+Alt+N)', () => this.newDoc()),
        qa('open', 'Abrir (Ctrl+O)', () => this.openDoc()),
        qa('save', 'Guardar (Ctrl+S)', () => this.saveDoc()),
        h('span', { class: 'sep' }),
        qa('import', 'Importar STL / OBJ / DXF', () => this.importFile()),
        qa('export', 'Exportar…', (e) => this.exportMenu(e.currentTarget)),
        h('span', { class: 'sep' }),
        qa('undo', 'Deshacer (Ctrl+Z)', () => this.undo(), 'btn-undo'),
        qa('redo', 'Rehacer (Ctrl+Y)', () => this.redo(), 'btn-redo')
      ),
      this.el.title,
      h(
        'div',
        { class: 'quick right' },
        qa('theme', 'Tema claro / oscuro', () => this.toggleTheme()),
        qa('school', 'Tutorial de inicio', () => this.tutorial.start()),
        qa('settings', 'Opciones', () => this.openSettings()),
        qa('help', 'Ayuda y atajos (F1)', () => this.openHelp())
      )
    );
    this.el.tabs = h('div', { class: 'tabs' });
    this.el.ribbonBody = h('div', { class: 'ribbon-body' });
    const ribbon = h('nav', { class: 'ribbon' }, this.el.tabs, this.el.ribbonBody);

    this.el.tree = h('div', { class: 'tree' });
    this.el.props = h('div', { class: 'props' });
    this.el.viewport = h('section', { class: 'viewport' });
    this.el.hud = h('div', { class: 'hud' });
    this.el.viewport.append(this.el.hud);
    this.el.banner = h('div', { class: 'banner' });
    this.el.viewport.append(this.el.banner);
    this.el.section = h('div', { class: 'floating section-panel' });
    this.el.viewport.append(this.el.section);
    this.el.measureLabels = h('div', { class: 'measure-labels' });
    this.el.viewport.append(this.el.measureLabels);
    this.el.marker = h('div', { class: 'snap-marker point' });
    this.el.viewport.append(this.el.marker);

    const left = h('aside', { class: 'panel left' }, h('div', { class: 'panel-title' }, 'Árbol de diseño'), this.el.tree);
    const right = h('aside', { class: 'panel right' }, this.el.props);

    this.el.hint = h('span', { class: 'hint' });
    this.el.coords = h('span', { class: 'coords' });
    this.el.mem = h('span', { class: 'mem' });
    this.el.tris = h('span', { class: 'tris' });
    const snapSel = h(
      'select',
      { title: 'Ajuste de movimiento (rejilla)', onchange: (e) => this.setSetting('snap', +e.target.value) },
      [0, 0.1, 0.5, 1, 2, 5, 10].map((v) => h('option', { value: v }, v ? `Ajuste ${v} mm` : 'Sin ajuste'))
    );
    snapSel.value = String(this.settings.snap);
    this.el.snapSel = snapSel;
    const status = h('footer', { class: 'status' }, this.el.hint, h('span', { class: 'grow' }), this.el.coords, this.el.tris, snapSel, this.el.mem);

    this.root.append(titlebar, ribbon, h('main', { class: 'main' }, left, this.el.viewport, right), status);
    this.buildHud();
  }

  buildHud() {
    const b = (ic, title, fn) => h('button', { title, onclick: fn, html: icon(ic, 18) });
    this.el.hud.append(
      b('fit', 'Ajustar a la pantalla (F)', () => this.fitView()),
      h('span', { class: 'sep' }),
      b('v-iso', 'Isométrica (4)', () => this.viewer.setView('iso')),
      b('v-front', 'Frontal (1)', () => this.viewer.setView('front')),
      b('v-top', 'Superior (2)', () => this.viewer.setView('top')),
      b('v-right', 'Derecha (3)', () => this.viewer.setView('right')),
      h('span', { class: 'sep' }),
      b('edges', 'Estilo de visualización', (e) => this.displayMenu(e.currentTarget)),
      b('section', 'Vista de sección', () => this.toggleSection()),
      b('persp', 'Perspectiva / Ortogonal', () => this.toggleProjection())
    );
  }

  // ---------------------------------------------------------------- cinta
  ribbonDef() {
    const T = (ic, label, title, fn, opts = {}) => ({ ic, label, title, fn, ...opts });
    const prim = (t) => T(TYPES[t].icon, TYPES[t].label, `${TYPES[t].label}: clic en la rejilla para colocar`, () => this.startPlace(t));
    if (this.mode === 'sketch') {
      const sk = this.sketcher;
      const tool = (t, ic) => T(ic, SKETCH_TOOLS[t].label, `${SKETCH_TOOLS[t].label} (${SKETCH_TOOLS[t].key})`, () => sk.setTool(t), { active: sk.tool === t });
      const finish = sk.editNodeId
        ? [T('check', 'Aceptar', 'Aplicar los cambios del croquis', () => this.acceptSketchEdit(), { primary: true })]
        : [
            T('extrude', 'Extruir', 'Extruir el croquis (saliente o corte)', () => this.finishSketch('extrude'), { primary: true }),
            T('revolve', 'Revolución', 'Revolucionar el croquis alrededor de un eje', () => this.finishSketch('revolve'), { primary: true }),
          ];
      return {
        croquis: {
          label: 'Croquis',
          groups: [
            { label: 'Dibujar', items: [tool('select', 'select'), tool('line', 'line'), tool('rect', 'rect'), tool('rectc', 'rectc'), tool('circle', 'circle'), tool('ngon', 'ngon'), tool('slot', 'slot')] },
            {
              label: 'Modificar',
              items: [
                tool('offset', 'offset'),
                tool('fillet', 'fillet'),
                tool('chamfer', 'chamfer'),
                T('mirror', 'Simetría', 'Copia simétrica de la entidad seleccionada', () => this.sketchModify('mirror'), { disabled: sk.selected < 0 }),
                T('move', 'Mover', 'Mover o copiar la entidad seleccionada', () => this.sketchModify('move'), { disabled: sk.selected < 0 }),
                T('rotate', 'Girar', 'Girar la entidad seleccionada', () => this.sketchModify('rotate'), { disabled: sk.selected < 0 }),
                T('pattern-lin', 'Matriz', 'Copias de la entidad seleccionada en filas y columnas o alrededor de un centro', (e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  this.showMenu(r.left, r.bottom + 4, [
                    { label: 'Matriz rectangular…', icon: 'pattern-lin', action: () => this.sketchModify('array') },
                    { label: 'Matriz polar…', icon: 'pattern-circ', action: () => this.sketchModify('polar') },
                  ]);
                }, { disabled: sk.selected < 0 }),
              ],
            },
            {
              label: 'Ayudas',
              items: [
                T('ortho2d', 'Orto', 'Modo Orto: líneas sólo horizontales o verticales (F8)', () => this.toggleSketchSetting('sketchOrtho'), { active: this.settings.sketchOrtho }),
                T('dims', 'Cotas', 'Mostrar las medidas de las entidades (D)', () => this.toggleSketchSetting('sketchDims'), { active: this.settings.sketchDims }),
              ],
            },
            { label: 'Operación', items: finish },
            { label: 'Salir', items: [T('x', 'Cancelar', 'Salir del croquis sin crear operación', () => this.cancelSketch())] },
            {
              label: 'Editar',
              items: [
                T('undo', 'Deshacer', 'Deshacer en el croquis (Ctrl+Z)', () => sk.undo()),
                T('trash', 'Borrar', 'Borrar entidad seleccionada (Supr)', () => sk.deleteSelected()),
                T('clear', 'Limpiar', 'Borrar todo el croquis', () => sk.clearAll()),
                T('import', 'DXF', 'Importar entidades desde un archivo DXF', () => this.importDXFIntoSketch()),
                T('dxf', 'Exportar', 'Exportar el croquis a DXF (AutoCAD)', () => this.exportSketchDXF()),
              ],
            },
          ],
        },
        vista: this.viewTab(T),
      };
    }
    const sel = this.selection.length;
    return {
      modelar: {
        label: 'Modelar',
        groups: [
          { label: 'Croquis', items: [T('sketch', 'Croquis', 'Nuevo croquis sobre un plano o una cara (K)', () => this.startSketchPick(), { primary: true })] },
          { label: 'Sólidos básicos', items: ['box', 'cylinder', 'cone', 'sphere', 'torus', 'tube', 'prism', 'wedge'].map(prim) },
          {
            label: 'Combinar',
            items: [
              T('union', 'Unir', 'Unir los cuerpos seleccionados', () => this.booleanSelected('union'), { disabled: sel < 2 }),
              T('subtract', 'Restar', 'Restar al primero los demás cuerpos seleccionados', () => this.booleanSelected('subtract'), { disabled: sel < 2 }),
              T('intersect', 'Intersecar', 'Conservar sólo el volumen común', () => this.booleanSelected('intersect'), { disabled: sel < 2 }),
              T('dissolve', 'Separar', 'Deshacer una operación y recuperar sus cuerpos', () => this.dissolveSelected(), { disabled: !this.selectedNodes().some((n) => n.type === 'boolean') }),
            ],
          },
        ],
      },
      editar: {
        label: 'Editar',
        groups: [
          {
            label: 'Transformar',
            items: [
              T('move', 'Mover', 'Mover (W)', () => this.setGizmo('translate'), { active: this.gizmoMode === 'translate' }),
              T('rotate', 'Rotar', 'Rotar (E)', () => this.setGizmo('rotate'), { active: this.gizmoMode === 'rotate' }),
              T('scale', 'Escalar', 'Escalar (R)', () => this.setGizmo('scale'), { active: this.gizmoMode === 'scale' }),
              T('ground', 'Al suelo', 'Apoyar sobre el suelo (Y = 0)', () => this.alignSelected('ground'), { disabled: !sel }),
              T('center', 'Centrar', 'Centrar en el origen (X y Z)', () => this.alignSelected('center'), { disabled: !sel }),
            ],
          },
          {
            label: 'Copiar',
            items: [
              T('duplicate', 'Duplicar', 'Duplicar (Ctrl+D)', () => this.duplicateSelected(), { disabled: !sel }),
              T('mirror', 'Simetría', 'Crear una copia simétrica', () => this.openMirror(), { disabled: !sel }),
              T('pattern-lin', 'Matriz lineal', 'Copias en línea', () => this.openLinearPattern(), { disabled: !sel }),
              T('pattern-circ', 'Matriz circular', 'Copias alrededor de un eje', () => this.openCircularPattern(), { disabled: !sel }),
            ],
          },
          { label: 'Eliminar', items: [T('trash', 'Eliminar', 'Eliminar selección (Supr)', () => this.deleteSelected(), { disabled: !sel })] },
        ],
      },
      evaluar: {
        label: 'Evaluar',
        groups: [
          {
            label: 'Medición',
            items: [
              T('measure', 'Medir', 'Medir distancias entre puntos (M)', () => this.startMeasure(), { active: this.mode === 'measure' }),
              T('mass', 'Prop. físicas', 'Volumen, área y masa de la selección', () => this.showMassProps(), { disabled: !sel }),
            ],
          },
          { label: 'Sección', items: [T('section', 'Sección', 'Cortar la vista con un plano', () => this.toggleSection(), { active: !!this.sectionState })] },
        ],
      },
      electronica: this.elec.ribbonTab(T),
      vista: this.viewTab(T),
    };
  }

  viewTab(T) {
    const s = this.settings;
    return {
      label: 'Vista',
      groups: [
        {
          label: 'Orientación',
          items: [
            T('v-iso', 'Isométrica', 'Vista isométrica (4)', () => this.viewer.setView('iso')),
            T('v-front', 'Frontal', 'Vista frontal (1)', () => this.viewer.setView('front')),
            T('v-top', 'Superior', 'Vista superior (2)', () => this.viewer.setView('top')),
            T('v-right', 'Derecha', 'Vista derecha (3)', () => this.viewer.setView('right')),
            T('fit', 'Ajustar', 'Ajustar a la pantalla (F)', () => this.fitView()),
          ],
        },
        {
          label: 'Estilo',
          items: [
            T('edges', 'Aristas', DISPLAY.edges, () => this.setDisplay('edges'), { active: s.display === 'edges' }),
            T('shaded', 'Sombreado', DISPLAY.shaded, () => this.setDisplay('shaded'), { active: s.display === 'shaded' }),
            T('wire', 'Alambre', DISPLAY.wire, () => this.setDisplay('wire'), { active: s.display === 'wire' }),
            T('xray', 'Rayos X', DISPLAY.xray, () => this.setDisplay('xray'), { active: s.display === 'xray' }),
          ],
        },
        {
          label: 'Mostrar',
          items: [
            T('grid', 'Rejilla', 'Mostrar u ocultar la rejilla', () => this.toggleSetting('grid'), { active: s.grid }),
            T('planes', 'Planos', 'Mostrar u ocultar los planos de referencia', () => this.toggleSetting('planes'), { active: s.planes }),
            T(s.ortho ? 'ortho' : 'persp', s.ortho ? 'Ortogonal' : 'Perspectiva', 'Cambiar proyección', () => this.toggleProjection()),
          ],
        },
      ],
    };
  }

  renderRibbon() {
    const def = this.ribbonDef();
    if (!def[this.tab]) this.tab = Object.keys(def)[0];
    this.el.tabs.replaceChildren(
      ...Object.entries(def).map(([k, t]) =>
        h('button', { class: 'tab' + (k === this.tab ? ' on' : '') + (k === 'croquis' ? ' sketch' : ''), onclick: () => { this.tab = k; this.renderRibbon(); } }, t.label)
      )
    );
    const tab = def[this.tab];
    this.el.ribbonBody.classList.toggle('compact', !!tab.compact);
    const groups = tab.groups.map((g) =>
      h(
        'div',
        { class: 'rgroup' },
        h(
          'div',
          { class: 'ritems' },
          g.items.map((it) =>
            h(
              'button',
              {
                class: 'rbtn' + (it.active ? ' on' : '') + (it.primary ? ' primary' : ''),
                'data-label': it.label,
                title: it.title,
                disabled: !!it.disabled,
                onclick: it.fn,
              },
              h('span', { html: icon(it.ic, 22) }),
              h('span', { class: 'lbl' }, it.label)
            )
          )
        ),
        h('div', { class: 'glabel' }, g.label)
      )
    );
    this.el.ribbonBody.replaceChildren(...groups);
  }

  // =====================================================================
  // Estado general
  // =====================================================================
  refresh() {
    const dt = this.sync.sync();
    this.selection = this.selection.filter((id) => this.doc.get(id));
    this.sync.applyHighlight();
    this.renderTree();
    this.renderProps();
    this.renderRibbon();
    this.attachGizmo();
    this.updateTitle();
    $id('btn-undo').disabled = !this.history.canUndo();
    $id('btn-redo').disabled = !this.history.canRedo();
    let tris = 0;
    for (const m of this.sync.meshes.values()) if (m.visible) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    this.el.tris.textContent = `${Math.round(tris).toLocaleString('es')} triángulos`;
    if (dt > 400) this.el.tris.title = `Última reconstrucción: ${Math.round(dt)} ms`;
    if (this.sectionState) this.updateSection();
  }

  commit(label) {
    if (this.history.push(label)) {
      this.dirty = true;
      this.autosave();
    }
    this.refresh();
  }

  undo() {
    if (this.mode === 'sketch') return this.sketcher.undo();
    const l = this.history.undo();
    if (l != null) {
      toast('Deshacer: ' + l);
      this.refresh();
      this.autosave();
    }
  }

  redo() {
    if (this.mode === 'sketch') return this.sketcher.redo();
    const l = this.history.redo();
    if (l != null) {
      toast('Rehacer: ' + l);
      this.refresh();
      this.autosave();
    }
  }

  updateTitle() {
    this.el.title.textContent = this.docName + (this.dirty ? ' •' : '');
    document.title = `${this.docName} — MiniCAD 3D`;
  }

  setHint(text) {
    const defaults = {
      select: 'Clic: seleccionar · Ctrl+clic: añadir a la selección · Arrastrar: girar · Clic derecho arrastrando: desplazar · Rueda: zoom',
      place: 'Clic en la rejilla o sobre una cara para colocar · Mayús+clic: colocar varios · Esc: cancelar',
      pickPlane: 'Elige un plano (Alzado, Planta, Perfil) o haz clic sobre una cara plana de un sólido · Esc: cancelar',
      measure: 'Clic en dos puntos para medir (se ajusta a los vértices) · Esc: terminar',
      wire: 'Cable: clic en un pin y después en otro · Esc: cancelar',
      sketch: SKETCH_TOOLS[this.sketcher?.tool]?.hint + ' · Botón central: girar · Botón derecho: desplazar',
    };
    this.el.hint.textContent = text || defaults[this.mode] || '';
  }

  setCoords(t) {
    this.el.coords.textContent = t || '';
  }

  updateMemory() {
    const m = performance.memory;
    if (m) {
      const mb = m.usedJSHeapSize / 1048576;
      this.el.mem.textContent = `RAM ${mb.toFixed(0)} MB`;
      this.el.mem.className = 'mem' + (mb > 600 ? ' high' : '');
    } else this.el.mem.textContent = '';
  }

  setSetting(k, v) {
    this.settings[k] = v;
    storageSet('minicad.settings', this.settings);
    if (k === 'snap') this.applySnap();
  }

  toggleSetting(k) {
    this.setSetting(k, !this.settings[k]);
    if (k === 'grid') this.viewer.grid.visible = this.settings.grid;
    if (k === 'planes') this.viewer.planes.visible = this.settings.planes;
    this.viewer.requestRender();
    this.renderRibbon();
    this.renderTree();
  }

  toggleSketchSetting(k) {
    this.setSetting(k, !this.settings[k]);
    if (k === 'sketchOrtho') toast('Orto ' + (this.settings.sketchOrtho ? 'activado: líneas horizontales y verticales' : 'desactivado'));
    if (this.sketcher.active) {
      this.sketcher.updatePreview();
      this.sketcher.updateHud();
    }
    this.renderRibbon();
    this.renderProps();
  }

  toggleTheme() {
    const t = this.settings.theme === 'dark' ? 'light' : 'dark';
    this.setSetting('theme', t);
    document.documentElement.dataset.theme = t;
    this.viewer.buildHelpers();
    this.sync.edgeMat.color.set(t === 'dark' ? 0x0b0e12 : 0x1d232b);
  }

  setDisplay(mode) {
    this.setSetting('display', mode);
    this.sync.applyDisplay();
    this.renderRibbon();
  }

  displayMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    this.showMenu(r.left, r.bottom + 4, Object.entries(DISPLAY).map(([k, label]) => ({ label, icon: k, checked: this.settings.display === k, action: () => this.setDisplay(k) })));
  }

  toggleProjection() {
    const o = !this.viewer.camera.isOrthographicCamera;
    this.viewer.setProjection(o);
    this.setSetting('ortho', o);
    this.renderRibbon();
  }

  fitView() {
    const ids = this.selection;
    if (ids.length) {
      const box = new THREE.Box3();
      for (const id of ids) box.union(this.sync.worldBox(id));
      this.viewer.fit(box);
    } else this.viewer.fit(this.viewer.sceneBox());
  }

  // =====================================================================
  // Selección
  // =====================================================================
  selectedNodes() {
    return this.selection.map((id) => this.doc.get(id)).filter(Boolean);
  }

  topSelected() {
    const out = [];
    for (const id of this.selection) {
      const t = this.doc.topOf(id);
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  select(id, additive = false) {
    if (id === undefined) {
      /* sólo refresca la selección actual */
    } else if (id === null) this.selection = additive ? this.selection : [];
    else if (additive) {
      const i = this.selection.indexOf(id);
      if (i >= 0) this.selection.splice(i, 1);
      else this.selection.push(id);
    } else this.selection = [id];
    if (id) this.elec.layer.selectWire(null);
    // Expande los padres en el árbol
    for (const sid of this.selection) {
      const f = this.doc.find(sid);
      f?.parents.forEach((p) => this.expanded.add(p.id));
    }
    this.sync.applyHighlight();
    this.renderTree();
    this.renderProps();
    this.renderRibbon();
    this.attachGizmo();
  }

  // =====================================================================
  // Visor: eventos de ratón
  // =====================================================================
  bindViewport() {
    const cv = this.viewer.renderer.domElement;
    cv.tabIndex = 0;
    cv.addEventListener('pointerdown', (e) => {
      cv.focus({ preventScroll: true });
      this.down = { x: e.clientX, y: e.clientY, button: e.button, tc: this.viewer.tc.axis != null && this.viewer.tc.object };
    });
    cv.addEventListener('pointermove', (e) => {
      this._lastMove = e;
      if (this._moveQueued) return;
      this._moveQueued = true;
      requestAnimationFrame(() => {
        this._moveQueued = false;
        this.onHover(this._lastMove);
      });
    });
    cv.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || d.tc) return;
      if (d.button === 0) this.onClick(e);
      else if (d.button === 2) this.onContext(e);
    });
    cv.addEventListener('dblclick', (e) => this.onDblClick(e));
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerleave', () => {
      if (this.mode === 'select') this.sync.setHover(null);
    });
    this.viewer.addEventListener('render', () => this.updateMeasureLabels());
  }

  pickBody(e) {
    return this.viewer.pick(e, this.sync.pickables());
  }

  onHover(e) {
    if (!e) return;
    const busy = e.buttons !== 0;
    switch (this.mode) {
      case 'sketch':
        if (!busy) this.sketcher.onMove(e);
        return;
      case 'place':
        this.updatePlaceGhost(e);
        return;
      case 'wire':
        if (!busy) this.elec.wireHover(e);
        return;
      case 'pickPlane': {
        const hit = this.pickBody(e);
        const ph = hit ? null : this.viewer.pick(e, this.viewer.planes.children.map((g) => g.userData.quad));
        if (hit) {
          this.sync.setHover(hit.object.userData.nodeId);
          this.viewer.highlightPlane(null);
        } else {
          this.sync.setHover(null);
          this.viewer.highlightPlane(ph ? ph.object.userData.planeName : null);
        }
        return;
      }
      case 'measure': {
        const p = this.measurePoint(e);
        this.measureHover = p;
        const m = this.el.marker;
        if (p) {
          const s = this.viewer.toScreen(p.point);
          m.style.display = 'block';
          m.className = 'snap-marker ' + (p.vertex ? 'point' : 'face');
          m.style.left = s.x + 'px';
          m.style.top = s.y + 'px';
          this.setCoords(`X ${fmt(p.point.x, 2)}  Y ${fmt(p.point.y, 2)}  Z ${fmt(p.point.z, 2)}`);
        } else m.style.display = 'none';
        return;
      }
      default: {
        if (busy) return;
        const hit = this.pickBody(e);
        this.sync.setHover(hit ? hit.object.userData.nodeId : null);
        const p = hit ? hit.point : this.viewer.rayPlane(e, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
        this.setCoords(p ? `X ${fmt(p.x, 1)}  Y ${fmt(p.y, 1)}  Z ${fmt(p.z, 1)}` : '');
      }
    }
  }

  onClick(e) {
    switch (this.mode) {
      case 'sketch':
        return this.sketcher.onClick(e);
      case 'place':
        return this.placeAt(e);
      case 'pickPlane':
        return this.pickPlaneAt(e);
      case 'measure':
        return this.measureClick(e);
      case 'wire':
        return this.elec.wireClick(e);
      default: {
        if (this.featureForm) return;
        const hit = this.pickBody(e);
        const add = e.ctrlKey || e.shiftKey || e.metaKey;
        const wireHit = this.viewer.pick(e, [...this.elec.layer.wireMeshes.values()]);
        if (wireHit && (!hit || wireHit.distance < hit.distance)) {
          this.selection = [];
          this.elec.layer.selectWire(wireHit.object.userData.wireId);
          this.select(undefined);
          return;
        }
        if (this.elec.layer.selectedWire) this.elec.layer.selectWire(null);
        if (hit) this.select(hit.object.userData.nodeId, add);
        else if (!add) this.select(null);
      }
    }
  }

  onDblClick(e) {
    if (this.mode === 'sketch') return this.sketcher.onDblClick(e);
    if (this.mode !== 'select') return;
    const hit = this.pickBody(e);
    if (!hit) return;
    const node = this.doc.get(hit.object.userData.nodeId);
    if (node && (node.type === 'extrude' || node.type === 'revolve')) this.editSketch(node.id);
  }

  onContext(e) {
    if (this.mode === 'sketch') {
      const i = this.sketcher.hitEntity(e);
      if (i >= 0) {
        this.sketcher.selected = i;
        this.sketcher.redraw();
        this.onSketchSelect(i);
        this.showMenu(e.clientX, e.clientY, [
          { label: 'Simetría…', icon: 'mirror', action: () => this.sketchModify('mirror') },
          { label: 'Mover / copiar…', icon: 'move', action: () => this.sketchModify('move') },
          { label: 'Girar…', icon: 'rotate', action: () => this.sketchModify('rotate') },
          { label: 'Matriz rectangular…', icon: 'pattern-lin', action: () => this.sketchModify('array') },
          { label: 'Matriz polar…', icon: 'pattern-circ', action: () => this.sketchModify('polar') },
          { label: 'Desfase…', icon: 'offset', action: () => this.sketchModify('offset') },
          { sep: true },
          { label: 'Borrar entidad', icon: 'trash', danger: true, action: () => this.sketcher.deleteSelected() },
        ]);
      }
      return;
    }
    if (this.mode !== 'select') return;
    const hit = this.pickBody(e);
    if (hit) {
      const id = hit.object.userData.nodeId;
      if (!this.selection.includes(id)) this.select(id);
      this.nodeMenu(e.clientX, e.clientY, id);
    } else {
      this.showMenu(e.clientX, e.clientY, [
        { label: 'Nuevo croquis', icon: 'sketch', action: () => this.startSketchPick() },
        { label: 'Mostrar todo', icon: 'eye', action: () => this.showAll() },
        { label: 'Ajustar a la pantalla', icon: 'fit', action: () => this.fitView() },
        { sep: true },
        { label: 'Pegar', icon: 'duplicate', disabled: !this.clipboard, action: () => this.paste() },
      ]);
    }
  }

  // =====================================================================
  // Gizmo de transformación
  // =====================================================================
  bindGizmo() {
    const tc = this.viewer.tc;
    this.applySnap();
    tc.addEventListener('mouseDown', () => {
      this._tcStart = this._tcTargets?.map((t) => t.mesh.matrix.clone());
      this._pivotStart = this._pivot ? this._pivot.matrixWorld.clone() : null;
    });
    tc.addEventListener('objectChange', () => {
      if (this._pivot && this._tcStart) {
        this._pivot.updateMatrixWorld();
        const delta = this._pivot.matrixWorld.clone().multiply(this._pivotStart.clone().invert());
        this._tcTargets.forEach((t, i) => {
          const m = delta.clone().multiply(this._tcStart[i]);
          m.decompose(t.mesh.position, t.mesh.quaternion, t.mesh.scale);
          t.mesh.updateMatrix();
        });
      }
      const o = tc.object;
      if (o) this.setCoords(`X ${fmt(o.position.x, 2)}  Y ${fmt(o.position.y, 2)}  Z ${fmt(o.position.z, 2)}`);
    });
    tc.addEventListener('mouseUp', () => {
      if (!this._tcTargets) return;
      for (const t of this._tcTargets) {
        t.mesh.updateMatrix();
        setNodeMatrix(t.node, t.mesh.matrix);
      }
      const label = { translate: 'Mover', rotate: 'Rotar', scale: 'Escalar' }[tc.mode];
      this.commit(label);
    });
  }

  applySnap() {
    const tc = this.viewer.tc;
    const s = this.settings.snap;
    tc.setTranslationSnap(s > 0 ? s : null);
    tc.setRotationSnap(s > 0 ? 15 * DEG : null);
    tc.setScaleSnap(s > 0 ? 0.05 : null);
    if (this.el.snapSel) this.el.snapSel.value = String(s);
  }

  setGizmo(mode) {
    this.gizmoMode = this.gizmoMode === mode ? 'none' : mode;
    if (this.mode !== 'select') this.cancelMode();
    this.attachGizmo();
    this.renderRibbon();
  }

  clearGhost() {
    if (this._ghost) {
      this.viewer.overlay.remove(this._ghost);
      this._ghost = null;
    }
  }

  attachGizmo() {
    const tc = this.viewer.tc;
    tc.detach();
    this.clearGhost();
    this._tcTargets = null;
    if (this._pivot) {
      this.viewer.overlay.remove(this._pivot);
      this._pivot = null;
    }
    if (this.mode !== 'select' || this.featureForm || this.gizmoMode === 'none' || !this.selection.length) {
      this.viewer.requestRender();
      return;
    }
    tc.setMode(this.gizmoMode);
    const nodes = this.selectedNodes();
    if (nodes.length === 1) {
      const node = nodes[0];
      const f = this.doc.find(node.id);
      if (f.parents.length) {
        // Operando dentro de una operación: se edita a través de un "fantasma"
        const root = new THREE.Group();
        root.matrixAutoUpdate = false;
        root.matrix.copy(this.sync.parentMatrix(node.id));
        const g = this.sync.geometryFor(node);
        const ghost = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf08a24, transparent: true, opacity: 0.18, depthWrite: false }));
        ghost.add(new THREE.LineSegments(edgesOf(g), new THREE.LineBasicMaterial({ color: 0xf08a24, depthTest: false, transparent: true })));
        ghost.renderOrder = 30;
        applyTransform(ghost, node);
        root.add(ghost);
        this.viewer.overlay.add(root);
        root.updateMatrixWorld(true);
        this._ghost = root;
        this._tcTargets = [{ node, mesh: ghost }];
        tc.attach(ghost);
      } else {
        const mesh = this.sync.objectFor(node.id);
        if (!mesh || !mesh.visible) return;
        this._tcTargets = [{ node, mesh }];
        tc.attach(mesh);
      }
    } else {
      const tops = this.topSelected();
      const box = new THREE.Box3();
      const targets = [];
      for (const n of tops) {
        const mesh = this.sync.objectFor(n.id);
        if (mesh && mesh.visible) {
          targets.push({ node: n, mesh });
          box.union(this.sync.worldBox(n.id));
        }
      }
      if (!targets.length) return;
      const pivot = new THREE.Object3D();
      box.getCenter(pivot.position);
      this.viewer.overlay.add(pivot);
      pivot.updateMatrixWorld();
      this._pivot = pivot;
      this._tcTargets = targets;
      tc.attach(pivot);
    }
    this.viewer.requestRender();
  }

  // =====================================================================
  // Teclado
  // =====================================================================
  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === 'F1') {
        e.preventDefault();
        return this.openHelp();
      }
      if (e.key === 'F5' && !this.modal) {
        e.preventDefault();
        return this.elec.toggleSim();
      }
      if (typing) return;
      if (this.modal) {
        if (e.key === 'Escape') this.closeModal();
        return;
      }
      if (this.menuEl && e.key === 'Escape') return this.closeMenu();
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && k === 's') {
        e.preventDefault();
        return this.saveDoc(e.shiftKey);
      }
      if (ctrl && k === 'o') {
        e.preventDefault();
        return this.openDoc();
      }
      if (ctrl && e.altKey && k === 'n') {
        e.preventDefault();
        return this.newDoc();
      }
      if (this.mode === 'sketch') {
        if (this.featureForm) {
          if (e.key === 'Escape') this.featureForm.cancel();
          if (e.key === 'Enter') this.featureForm.ok();
          return;
        }
        if (this.sketcher.onKey(e)) {
          e.preventDefault();
          this.setHint();
        }
        return;
      }
      if (this.featureForm) {
        if (e.key === 'Escape') this.featureForm.cancel();
        if (e.key === 'Enter') this.featureForm.ok();
        return;
      }
      if (ctrl && k === 'z') {
        e.preventDefault();
        return e.shiftKey ? this.redo() : this.undo();
      }
      if (ctrl && k === 'y') {
        e.preventDefault();
        return this.redo();
      }
      if (ctrl && k === 'd') {
        e.preventDefault();
        return this.duplicateSelected();
      }
      if (ctrl && k === 'c') return this.copy();
      if (ctrl && k === 'v') return this.paste();
      if (ctrl && k === 'a') {
        e.preventDefault();
        this.selection = this.doc.nodes.map((n) => n.id);
        return this.select(undefined, true);
      }
      if (ctrl) return;
      switch (e.key) {
        case 'Escape':
          if (this.mode === 'wire' && this.elec.wireEscape()) return;
          if (this.mode !== 'select') this.cancelMode();
          else {
            this.elec.layer.selectWire(null);
            this.select(null);
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (!this.selection.length && this.elec.layer.selectedWire) return this.elec.deleteWire(this.elec.layer.selectedWire);
          return this.deleteSelected();
      }
      switch (k) {
        case 'w': return this.setGizmo('translate');
        case 'e': return this.setGizmo('rotate');
        case 'r': return this.setGizmo('scale');
        case 'q': this.gizmoMode = 'none'; this.attachGizmo(); return this.renderRibbon();
        case ' ':
          e.preventDefault();
          this.viewer.tc.setSpace(this.viewer.tc.space === 'local' ? 'world' : 'local');
          return toast('Ejes del gizmo: ' + (this.viewer.tc.space === 'local' ? 'locales' : 'globales'));
        case 'f': return this.fitView();
        case 'h': return this.toggleHideSelected();
        case 'k': return this.startSketchPick();
        case 'm': return this.startMeasure();
        case '1': return this.viewer.setView('front');
        case '2': return this.viewer.setView('top');
        case '3': return this.viewer.setView('right');
        case '4': return this.viewer.setView('iso');
        case '5': return this.viewer.setView('back');
        case '6': return this.viewer.setView('bottom');
      }
    });
  }

  cancelMode() {
    const m = this.mode;
    if (m === 'sketch') return this.cancelSketch();
    if (m === 'place') this.clearPlaceGhost();
    if (m === 'pickPlane') {
      this.viewer.highlightPlane(null);
      this.viewer.planes.visible = this.settings.planes;
      this.el.banner.style.display = 'none';
    }
    if (m === 'measure') this.endMeasure();
    if (m === 'wire') this.elec.layer.clearWireTool();
    this.sync.setHover(null);
    this.mode = 'select';
    this.setHint();
    this.renderRibbon();
    this.attachGizmo();
    this.viewer.requestRender();
  }

  // =====================================================================
  // Colocar sólidos básicos
  // =====================================================================
  startPlace(type, part = null) {
    if (this.mode !== 'select') this.cancelMode();
    this.mode = 'place';
    this.placeType = type;
    this.placePart = part;
    this.attachGizmo();
    if (part) {
      const ghost = this.elec.ghost(part);
      ghost.visible = false;
      this.placeGhost = ghost;
      this.viewer.overlay.add(ghost);
      this.setHint();
      this.renderRibbon();
      return;
    }
    const tmp = { id: '__place', type, params: defaultParams(type) };
    const g = this.sync.geometryFor(tmp);
    const ghost = new THREE.Mesh(g, new THREE.MeshPhongMaterial({ color: 0x3fae6a, transparent: true, opacity: 0.55, depthWrite: false }));
    ghost.add(new THREE.LineSegments(edgesOf(g), new THREE.LineBasicMaterial({ color: 0x1f7a44 })));
    ghost.visible = false;
    ghost.userData.minY = g.boundingBox.min.y;
    this.placeGhost = ghost;
    this.viewer.overlay.add(ghost);
    this.setHint();
    this.renderRibbon();
  }

  clearPlaceGhost() {
    if (this.placeGhost) {
      this.viewer.overlay.remove(this.placeGhost);
      this.placeGhost.material?.dispose();
      this.placeGhost = null;
    }
  }

  updatePlaceGhost(e) {
    const g = this.placeGhost;
    if (!g) return;
    let p = null;
    const hit = this.pickBody(e);
    if (hit) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (n.y > 0.7) p = hit.point.clone();
    }
    if (!p) p = this.viewer.rayPlane(e, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
    if (!p) return;
    const s = this.settings.snap;
    if (s > 0) {
      p.x = Math.round(p.x / s) * s;
      p.z = Math.round(p.z / s) * s;
    }
    g.position.set(p.x, p.y - g.userData.minY, p.z);
    g.visible = true;
    this.setCoords(`X ${fmt(p.x, 1)}  Y ${fmt(p.y, 1)}  Z ${fmt(p.z, 1)}`);
    this.viewer.requestRender();
  }

  placeAt(e) {
    this.updatePlaceGhost(e);
    const g = this.placeGhost;
    if (!g || !g.visible) return;
    const node = this.placePart ? this.elec.makeNode(this.placePart) : this.doc.makeNode(this.placeType);
    if (this.placePart === 'arduino' && !this.doc.code?.trim()) this.doc.code = BLANK_CODE;
    node.pos = [g.position.x, g.position.y, g.position.z].map((v) => Math.round(v * 1e4) / 1e4);
    this.doc.nodes.push(node);
    if (!e.shiftKey) {
      this.clearPlaceGhost();
      this.mode = 'select';
      this.setHint();
    }
    this.selection = [node.id];
    this.commit('Crear ' + (node.type === 'ecomp' ? PARTS[node.part].label : TYPES[node.type].label));
  }

  // =====================================================================
  // Croquis
  // =====================================================================
  startSketchPick() {
    if (this.mode === 'sketch') return;
    if (this.mode !== 'select') this.cancelMode();
    this.mode = 'pickPlane';
    this.attachGizmo();
    this.viewer.planes.visible = true;
    this.viewer.requestRender();
    const b = this.el.banner;
    b.replaceChildren(
      h('span', null, 'Croquis en:'),
      ...Object.entries(PLANES).map(([k, p]) => h('button', { onclick: () => this.startSketch({ plane: planeFrom(p) }) }, p.label)),
      h('span', { class: 'muted' }, 'o haz clic en una cara'),
      h('button', { class: 'ghost', onclick: () => this.cancelMode() }, 'Cancelar')
    );
    b.style.display = 'flex';
    this.setHint();
    this.renderTree();
  }

  pickPlaneAt(e) {
    const hit = this.pickBody(e);
    const ph = this.viewer.pick(e, this.viewer.planes.children.map((g) => g.userData.quad));
    if (hit) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (hit.object.matrixWorld.determinant() < 0) n.negate();
      const plane = planeFromNormal(n, hit.point);
      this.startSketch({ plane, faceBodyId: hit.object.userData.nodeId });
    } else if (ph) {
      this.startSketch({ plane: planeFrom(PLANES[ph.object.userData.planeName]) });
    }
  }

  startSketch(opts) {
    if (this.mode === 'pickPlane') this.cancelMode();
    else if (this.mode !== 'select') this.cancelMode();
    this.select(null);
    // Recuerda la vista para volver a ella al salir del croquis
    const v = this.viewer;
    this.preSketchView = { dir: v.camera.position.clone().sub(v.controls.target).normalize(), target: v.controls.target.clone(), dist: v.camera.position.distanceTo(v.controls.target) };
    this.mode = 'sketch';
    this.prevTab = this.tab;
    this.tab = 'croquis';
    this.viewer.tc.detach();
    this.viewer.planes.visible = false;
    this.sync.setHover(null);
    this.sketcher.start(opts);
    this.renderRibbon();
    this.renderTree();
    this.renderProps();
    this.setHint();
  }

  async cancelSketch() {
    const sk = this.sketcher;
    const changed = JSON.stringify(sk.entities) !== JSON.stringify(sk.editNodeId ? this.doc.get(sk.editNodeId)?.params.profiles || [] : []);
    if (changed && !(await this.confirm('Salir del croquis', 'Se descartarán los cambios del croquis. ¿Salir?', 'Descartar'))) return;
    this.exitSketch();
  }

  exitSketch(created = false) {
    this.closeForm();
    this.sketcher.stop();
    this.mode = 'select';
    this.tab = this.prevTab && this.prevTab !== 'croquis' ? this.prevTab : 'modelar';
    this.viewer.planes.visible = this.settings.planes;
    this.setCoords('');
    this.setHint();
    this.refresh();
    const pv = this.preSketchView;
    if (pv) {
      // Si la vista anterior era una vista plana, se pasa a la isométrica
      const flat = Math.max(Math.abs(pv.dir.x), Math.abs(pv.dir.y), Math.abs(pv.dir.z)) > 0.97;
      const dir = flat ? new THREE.Vector3(1, 0.8, 1).normalize() : pv.dir;
      if (created) this.viewer.fit(this.viewer.sceneBox(), dir);
      else this.viewer.animateTo(pv.target.clone().addScaledVector(dir, pv.dist), pv.target);
      this.preSketchView = null;
    }
  }

  onSketchTool() {
    this.renderRibbon();
    this.renderProps();
    this.setHint();
  }

  onSketchSelect() {
    this.renderProps();
    this.renderTree();
    this.renderRibbon();
  }

  editSketch(id) {
    const node = this.doc.get(id);
    if (!node || !(node.type === 'extrude' || node.type === 'revolve')) return;
    const m = this.sync.worldMatrix(id);
    const o = new THREE.Vector3(), x = new THREE.Vector3(), y = new THREE.Vector3(), n = new THREE.Vector3();
    m.extractBasis(x, y, n);
    o.setFromMatrixPosition(m);
    this.startSketch({ plane: { o, x: x.normalize(), y: y.normalize(), n: n.normalize(), label: node.name }, entities: node.params.profiles || [], editNodeId: id });
  }

  acceptSketchEdit() {
    const sk = this.sketcher;
    if (!sk.validate()) return;
    const node = this.doc.get(sk.editNodeId);
    if (node) node.params.profiles = JSON.parse(JSON.stringify(sk.entities));
    const id = sk.editNodeId;
    this.selection = [id];
    this.exitSketch(true);
    this.commit('Editar croquis');
  }

  importDXFIntoSketch() {
    pickFile('.dxf').then(async (f) => {
      if (!f) return;
      try {
        const ents = dxfToEntities(await f.text());
        if (!ents.length) return toast('No se encontraron perfiles cerrados en el DXF', 'warn');
        this.sketcher.pushUndo();
        this.sketcher.entities.push(...ents);
        this.sketcher.changed();
        toast(`${ents.length} perfiles importados`);
      } catch (err) {
        toast('Error al leer el DXF: ' + err.message, 'error');
      }
    });
  }

  exportSketchDXF() {
    if (!this.sketcher.entities.length) return toast('El croquis está vacío', 'warn');
    downloadBlob(new Blob([entitiesToDXF(this.sketcher.entities)], { type: 'application/dxf' }), 'croquis.dxf');
  }

  // Formulario de operación (extruir / revolución) con previsualización
  finishSketch(kind) {
    const sk = this.sketcher;
    if (!sk.validate()) return;
    sk.pts = [];
    sk.updatePreview();
    const bodies = this.doc.nodes.filter((n) => n.visible !== false);
    const faceTop = sk.faceBodyId ? this.doc.topOf(sk.faceBodyId) : null;
    const bodyOpts = bodies.map((b) => [b.id, b.name]);
    const plane = sk.plane;
    const planeM = new THREE.Matrix4().makeBasis(plane.x, plane.y, plane.n).setPosition(plane.o);
    const fields = [
      { key: 'op', label: 'Tipo', type: 'select', value: 'add', options: [['add', 'Saliente (añadir)'], ['cut', 'Corte (quitar)']], disabledOptions: bodies.length ? [] : ['cut'] },
      { key: 'target', label: 'Combinar con', type: 'select', value: faceTop ? faceTop.id : '', options: [['', '— Nuevo cuerpo —'], ...bodyOpts], show: (v) => v.op === 'add' },
      { key: 'cutTarget', label: 'Cortar de', type: 'select', value: faceTop ? faceTop.id : bodies[0]?.id || '', options: bodyOpts, show: (v) => v.op === 'cut' },
    ];
    if (kind === 'extrude') {
      fields.push(
        { key: 'depth', label: 'Profundidad', type: 'number', value: 20, min: 0.01, unit: 'mm', show: (v) => !(v.op === 'cut' && v.through) },
        { key: 'dir', label: 'Dirección', type: 'select', value: '1', options: [['1', 'Normal (hacia fuera)'], ['-1', 'Invertida (hacia dentro)'], ['0', 'Simétrica (plano medio)']] },
        { key: 'through', label: 'Por todo', type: 'check', value: false, show: (v) => v.op === 'cut' }
      );
    } else {
      fields.push(
        { key: 'axis', label: 'Eje', type: 'select', value: 'y', options: [['y', 'Eje vertical del croquis (verde)'], ['x', 'Eje horizontal del croquis (rojo)']] },
        { key: 'angle', label: 'Ángulo', type: 'number', value: 360, min: 1, max: 360, unit: '°' }
      );
    }
    const profiles = JSON.parse(JSON.stringify(sk.entities));
    const params = (v) => {
      if (kind === 'extrude') {
        let depth = v.depth;
        const target = this.doc.get(v.op === 'cut' ? v.cutTarget : v.target);
        if (v.op === 'cut' && v.through && target) {
          const box = this.sync.worldBox(target.id);
          const c = box.getCenter(new THREE.Vector3());
          depth = (box.getSize(new THREE.Vector3()).length() + Math.abs(plane.n.dot(c.sub(plane.o)))) * 1.2 + 1;
        }
        const dir = +v.dir;
        return { profiles, depth, dir, extra: target && dir !== 0 ? 0.02 : 0 };
      }
      return { profiles, axis: v.axis, angle: Math.min(360, Math.max(1, v.angle)) };
    };
    let prevOp = 'add';
    this.openForm({
      title: kind === 'extrude' ? 'Extruir' : 'Revolución',
      icon: kind,
      fields,
      onChange: (v) => {
        if (kind === 'extrude' && v.op !== prevOp) {
          if (v.op === 'cut' && v.dir === '1') v.dir = '-1';
          if (v.op === 'add' && v.dir === '-1') v.dir = '1';
          prevOp = v.op;
        }
        const tmp = { id: '__preview', type: kind, params: params(v) };
        const g = this.sync.geometryFor(tmp);
        const err = this.sync.errors.get('__preview');
        this.setPreview([{ geometry: g, matrix: planeM }], v.op === 'cut' ? 0xd9534f : 0x2fae66);
        return err ? 'Error: ' + err : null;
      },
      onOk: (v) => {
        const tmp = { id: '__preview', type: kind, params: params(v) };
        this.sync.geometryFor(tmp);
        if (this.sync.errors.get('__preview')) return toast(this.sync.errors.get('__preview'), 'error');
        const node = this.doc.makeNode(kind, params(v));
        setNodeMatrix(node, planeM);
        let result = node;
        const targetId = v.op === 'cut' ? v.cutTarget : v.target;
        const target = targetId ? this.doc.get(targetId) : null;
        if (v.op === 'cut' && !target) return toast('Elige el cuerpo a cortar', 'warn');
        if (target) {
          node.color = target.color;
          result = this.combineInto(target, node, v.op === 'cut' ? 'subtract' : 'union');
        } else this.doc.nodes.push(node);
        this.selection = [result.id];
        this.exitSketch(true);
        this.commit(kind === 'extrude' ? 'Extruir' : 'Revolución');
      },
      onCancel: () => {},
    });
  }

  // Añade "tool" a "target" (de nivel superior) mediante una operación booleana
  combineInto(target, tool, op) {
    const f = this.doc.find(target.id);
    if (target.type === 'boolean' && target.op === op && !f.parents.length) {
      const rel = nodeMatrix(target).invert().multiply(nodeMatrix(tool));
      setNodeMatrix(tool, rel);
      target.children.push(tool);
      return target;
    }
    const b = this.makeBoolean(op, [target, tool]);
    b.color = target.color;
    f.list.splice(f.index, 1, b);
    return b;
  }

  makeBoolean(op, children) {
    const key = 'op_' + op;
    this.doc.counters[key] = (this.doc.counters[key] || 0) + 1;
    return this.doc.makeNode('boolean', {}, { op, children, name: `${OPS[op].label} ${this.doc.counters[key]}` });
  }

  // =====================================================================
  // Operaciones sobre la selección
  // =====================================================================
  booleanSelected(op) {
    const nodes = this.topSelected();
    if (nodes.some((n) => n.type === 'ecomp')) return toast('Los componentes electrónicos no se pueden unir ni restar; usa piezas sólidas.', 'warn');
    if (nodes.length < 2) return toast('Selecciona al menos 2 cuerpos (Ctrl+clic)', 'warn');
    const idx = Math.min(...nodes.map((n) => this.doc.nodes.indexOf(n)));
    this.doc.nodes = this.doc.nodes.filter((n) => !nodes.includes(n));
    const b = this.makeBoolean(op, nodes);
    b.color = nodes[0].color;
    this.doc.nodes.splice(idx, 0, b);
    this.selection = [b.id];
    this.commit(OPS[op].label);
    if (this.sync.errors.has(b.id)) toast('La operación falló: ' + this.sync.errors.get(b.id), 'error');
  }

  dissolveSelected() {
    const bs = this.selectedNodes().filter((n) => n.type === 'boolean');
    if (!bs.length) return toast('Selecciona una operación (Unión, Corte…)', 'warn');
    const newSel = [];
    for (const b of bs) {
      const f = this.doc.find(b.id);
      if (!f) continue;
      const M = nodeMatrix(b);
      for (const c of b.children) {
        setNodeMatrix(c, M.clone().multiply(nodeMatrix(c)));
        c.suppressed = false;
        if (!c.color) c.color = b.color;
        newSel.push(c.id);
      }
      f.list.splice(f.index, 1, ...b.children);
    }
    this.selection = newSel;
    this.commit('Separar');
  }

  deleteSelected() {
    if (!this.selection.length) return;
    for (const id of [...this.selection]) this.doc.remove(id);
    for (const n of this.doc.nodes) if (n.mount && !this.doc.get(n.mount.to)) delete n.mount;
    this.elec.pruneWires();
    this.selection = [];
    this.commit('Eliminar');
  }

  duplicateSelected() {
    const tops = this.topSelected();
    if (!tops.length) return;
    const out = [];
    for (const n of tops) {
      const c = this.doc.cloneNode(n);
      const box = this.sync.worldBox(n.id);
      c.pos = [...c.pos];
      c.pos[0] += Math.max(10, Math.round(box.getSize(new THREE.Vector3()).x + 10));
      c.name = n.name + ' (copia)';
      this.doc.nodes.push(c);
      out.push(c.id);
    }
    this.selection = out;
    this.commit('Duplicar');
  }

  copy() {
    const tops = this.topSelected();
    if (!tops.length) return;
    this.clipboard = JSON.stringify(tops);
    this.pasteCount = 0;
    toast(`${tops.length} cuerpo(s) copiados`);
  }

  paste() {
    if (!this.clipboard) return;
    this.pasteCount = (this.pasteCount || 0) + 1;
    const out = [];
    for (const n of JSON.parse(this.clipboard)) {
      const c = this.doc.cloneNode(n);
      c.pos = [c.pos[0] + 10 * this.pasteCount, c.pos[1], c.pos[2] + 10 * this.pasteCount];
      this.doc.nodes.push(c);
      out.push(c.id);
    }
    this.selection = out;
    this.commit('Pegar');
  }

  alignSelected(how) {
    const tops = this.topSelected();
    for (const n of tops) {
      const box = this.sync.worldBox(n.id);
      if (box.isEmpty()) continue;
      if (how === 'ground') n.pos[1] = +(n.pos[1] - box.min.y).toFixed(6);
      else {
        const c = box.getCenter(new THREE.Vector3());
        n.pos[0] = +(n.pos[0] - c.x).toFixed(6);
        n.pos[2] = +(n.pos[2] - c.z).toFixed(6);
      }
    }
    this.commit(how === 'ground' ? 'Apoyar en el suelo' : 'Centrar');
  }

  toggleHideSelected() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    for (const n of nodes) {
      const f = this.doc.find(n.id);
      if (f.parents.length) n.suppressed = !n.suppressed;
      else n.visible = n.visible === false;
    }
    this.commit('Ocultar/mostrar');
  }

  showAll() {
    for (const n of this.doc.nodes) n.visible = true;
    this.commit('Mostrar todo');
  }

  isolate(id) {
    for (const n of this.doc.nodes) n.visible = n.id === id;
    this.commit('Aislar');
  }

  // ---------------------------------------------------------------- simetría y matrices
  setPreview(items, color = 0x2fae66) {
    const g = this.previewGroup;
    g.traverse((o) => {
      if (o.material && o.userData.own) o.material.dispose();
    });
    g.clear();
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
    for (const it of items) {
      if (!it.geometry || it.geometry === EMPTY) continue;
      const m = new THREE.Mesh(it.geometry, mat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(it.matrix);
      m.userData.own = true;
      const e = new THREE.LineSegments(edgesOf(it.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      e.userData.own = true;
      m.add(e);
      g.add(m);
    }
    g.updateMatrixWorld(true);
    this.viewer.requestRender();
  }

  clearPreview() {
    this.setPreview([]);
  }

  mirrorMatrix(axis, c) {
    const s = new THREE.Vector3(1, 1, 1);
    s[axis] = -1;
    const t = new THREE.Vector3();
    t[axis] = c;
    return new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(new THREE.Matrix4().makeScale(s.x, s.y, s.z)).multiply(new THREE.Matrix4().makeTranslation(-t.x, -t.y, -t.z));
  }

  openMirror() {
    const tops = this.topSelected();
    if (!tops.length) return toast('Selecciona un cuerpo', 'warn');
    const compute = (v) => {
      const box = new THREE.Box3();
      tops.forEach((n) => box.union(this.sync.worldBox(n.id)));
      const c = v.ref === 'origin' ? 0 : v.ref === 'max' ? box.max[v.axis] : box.min[v.axis];
      return this.mirrorMatrix(v.axis, c);
    };
    this.openForm({
      title: 'Simetría',
      icon: 'mirror',
      fields: [
        { key: 'axis', label: 'Plano de simetría', type: 'select', value: 'x', options: [['x', 'Plano YZ (invierte X)'], ['y', 'Plano XZ (invierte Y)'], ['z', 'Plano XY (invierte Z)']] },
        { key: 'ref', label: 'Situado en', type: 'select', value: 'max', options: [['max', 'Cara máxima del cuerpo'], ['min', 'Cara mínima del cuerpo'], ['origin', 'Origen']] },
        { key: 'keep', label: 'Conservar original', type: 'check', value: true },
        { key: 'join', label: 'Unir con el original', type: 'check', value: false, show: (v) => v.keep },
      ],
      onChange: (v) => {
        const M = compute(v);
        this.setPreview(tops.map((n) => ({ geometry: this.sync.geometryFor(n), matrix: M.clone().multiply(nodeMatrix(n)) })));
      },
      onOk: (v) => {
        const M = compute(v);
        const sel = [];
        for (const n of tops) {
          if (!v.keep) {
            setNodeMatrix(n, M.clone().multiply(nodeMatrix(n)));
            sel.push(n.id);
            continue;
          }
          const c = this.doc.cloneNode(n);
          c.name = n.name + ' (simétrico)';
          setNodeMatrix(c, M.clone().multiply(nodeMatrix(n)));
          if (v.join) {
            const f = this.doc.find(n.id);
            const b = this.makeBoolean('union', [n, c]);
            b.color = n.color;
            f.list.splice(f.index, 1, b);
            sel.push(b.id);
          } else {
            this.doc.nodes.push(c);
            sel.push(c.id);
          }
        }
        this.selection = sel;
        this.closeForm();
        this.commit('Simetría');
      },
    });
  }

  patternForm(kind) {
    const tops = this.topSelected();
    if (!tops.length) return toast('Selecciona un cuerpo', 'warn');
    const box = new THREE.Box3();
    tops.forEach((n) => box.union(this.sync.worldBox(n.id)));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const mats = (v) => {
      const out = [];
      const count = Math.max(2, Math.min(200, Math.round(v.count)));
      for (let k = 1; k < count; k++) {
        if (kind === 'lin') out.push(new THREE.Matrix4().makeTranslation(v.dx * k, v.dy * k, v.dz * k));
        else {
          const full = v.angle >= 359.999;
          const step = (full ? v.angle / count : v.angle / (count - 1)) * DEG;
          const c = v.center === 'origin' ? new THREE.Vector3() : center;
          const axis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[v.axis];
          const R = new THREE.Matrix4().makeRotationAxis(axis, step * k);
          out.push(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)));
        }
      }
      return out;
    };
    const fields =
      kind === 'lin'
        ? [
            { key: 'count', label: 'Cantidad total', type: 'int', value: 3, min: 2, max: 200 },
            { key: 'dx', label: 'Separación X', type: 'number', value: Math.round(size.x + 10), unit: 'mm' },
            { key: 'dy', label: 'Separación Y', type: 'number', value: 0, unit: 'mm' },
            { key: 'dz', label: 'Separación Z', type: 'number', value: 0, unit: 'mm' },
          ]
        : [
            { key: 'count', label: 'Cantidad total', type: 'int', value: 6, min: 2, max: 200 },
            { key: 'angle', label: 'Ángulo total', type: 'number', value: 360, min: 1, max: 360, unit: '°' },
            { key: 'axis', label: 'Eje', type: 'select', value: 'y', options: [['y', 'Eje Y (vertical)'], ['x', 'Eje X'], ['z', 'Eje Z']] },
            { key: 'center', label: 'Centro', type: 'select', value: 'origin', options: [['origin', 'Origen'], ['center', 'Centro de la selección']] },
          ];
    fields.push({ key: 'join', label: 'Unir en un solo cuerpo', type: 'check', value: false });
    this.openForm({
      title: kind === 'lin' ? 'Matriz lineal' : 'Matriz circular',
      icon: kind === 'lin' ? 'pattern-lin' : 'pattern-circ',
      fields,
      onChange: (v) => {
        const items = [];
        for (const M of mats(v)) for (const n of tops) items.push({ geometry: this.sync.geometryFor(n), matrix: M.clone().multiply(nodeMatrix(n)) });
        this.setPreview(items);
      },
      onOk: (v) => {
        const sel = [];
        const Ms = mats(v);
        for (const n of tops) {
          const copies = Ms.map((M, k) => {
            const c = this.doc.cloneNode(n);
            c.name = `${n.name} (${k + 2})`;
            setNodeMatrix(c, M.clone().multiply(nodeMatrix(n)));
            return c;
          });
          if (v.join) {
            const f = this.doc.find(n.id);
            const b = this.makeBoolean('union', [n, ...copies]);
            b.color = n.color;
            f.list.splice(f.index, 1, b);
            sel.push(b.id);
          } else {
            this.doc.nodes.push(...copies);
            sel.push(n.id, ...copies.map((c) => c.id));
          }
        }
        this.selection = sel;
        this.closeForm();
        this.commit(kind === 'lin' ? 'Matriz lineal' : 'Matriz circular');
      },
    });
  }

  openLinearPattern() {
    this.patternForm('lin');
  }

  openCircularPattern() {
    this.patternForm('circ');
  }

  // =====================================================================
  // Medición
  // =====================================================================
  startMeasure() {
    if (this.mode === 'measure') return this.cancelMode();
    if (this.mode !== 'select') this.cancelMode();
    this.mode = 'measure';
    this.measurePts = [];
    this.attachGizmo();
    this.setHint();
    this.renderRibbon();
  }

  endMeasure() {
    this.measureGroup.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    this.measureGroup.clear();
    this.measures = [];
    this.measurePts = [];
    this.el.measureLabels.replaceChildren();
    this.el.marker.style.display = 'none';
  }

  measurePoint(e) {
    const hit = this.pickBody(e);
    if (!hit) {
      const p = this.viewer.rayPlane(e, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
      return p ? { point: p, vertex: false } : null;
    }
    const obj = hit.object, g = obj.geometry, pa = g.attributes.position;
    const rect = this.viewer.container.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    let best = null, bd = 12;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const v = new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(obj.matrixWorld);
      const s = this.viewer.toScreen(v);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd) { bd = d; best = v; }
    }
    return best ? { point: best, vertex: true } : { point: hit.point.clone(), vertex: false };
  }

  measureClick(e) {
    const p = this.measurePoint(e);
    if (!p) return;
    this.measurePts.push(p.point);
    const dot = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([p.point]),
      new THREE.PointsMaterial({ color: 0xe8590c, size: 8, sizeAttenuation: false, depthTest: false })
    );
    dot.renderOrder = 40;
    this.measureGroup.add(dot);
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xe8590c, depthTest: false }));
      line.renderOrder = 40;
      this.measureGroup.add(line);
      const d = a.distanceTo(b);
      const lbl = h(
        'div',
        { class: 'mlabel' },
        h('b', null, `${fmt(d, 3)} mm`),
        h('small', null, `ΔX ${fmt(Math.abs(b.x - a.x), 2)} · ΔY ${fmt(Math.abs(b.y - a.y), 2)} · ΔZ ${fmt(Math.abs(b.z - a.z), 2)}`)
      );
      this.el.measureLabels.append(lbl);
      this.measures.push({ a, b, el: lbl });
      this.setHint(`Distancia: ${fmt(d, 3)} mm · Clic para otra medición · Esc: terminar`);
      this.measurePts = [];
    }
    this.viewer.requestRender();
  }

  updateMeasureLabels() {
    for (const m of this.measures || []) {
      const mid = m.a.clone().add(m.b).multiplyScalar(0.5);
      const s = this.viewer.toScreen(mid);
      m.el.style.left = s.x + 'px';
      m.el.style.top = s.y + 'px';
    }
  }

  // =====================================================================
  // Sección
  // =====================================================================
  toggleSection() {
    if (this.sectionState) {
      this.sectionState = null;
      this.sync.setSection(null);
      this.el.section.style.display = 'none';
      this.renderRibbon();
      return;
    }
    const box = this.viewer.sceneBox();
    if (box.isEmpty()) return toast('No hay cuerpos para seccionar', 'warn');
    this.sectionState = { axis: 'x', flip: false, t: 0.5 };
    this.buildSectionPanel();
    this.el.section.style.display = 'flex';
    this.updateSection();
    this.renderRibbon();
  }

  buildSectionPanel() {
    const st = this.sectionState;
    const p = this.el.section;
    const axisBtn = (a, label) =>
      h('button', { class: st.axis === a ? 'on' : '', onclick: () => { st.axis = a; this.buildSectionPanel(); this.updateSection(); } }, label);
    const slider = h('input', { type: 'range', min: 0, max: 1000, value: Math.round(st.t * 1000) });
    slider.addEventListener('input', () => {
      st.t = slider.value / 1000;
      this.updateSection();
    });
    this.el.sectionValue = h('span', { class: 'val' });
    p.replaceChildren(
      h('b', null, 'Sección'),
      axisBtn('x', 'X'), axisBtn('y', 'Y'), axisBtn('z', 'Z'),
      slider,
      this.el.sectionValue,
      h('label', null, h('input', { type: 'checkbox', checked: st.flip, onchange: (e) => { st.flip = e.target.checked; this.updateSection(); } }), ' Invertir'),
      h('button', { class: 'ghost', title: 'Cerrar sección', onclick: () => this.toggleSection(), html: icon('x', 16) })
    );
  }

  updateSection() {
    const st = this.sectionState;
    if (!st) return;
    const box = this.viewer.sceneBox();
    if (box.isEmpty()) return;
    const a = st.axis;
    const v = box.min[a] + (box.max[a] - box.min[a]) * st.t;
    const n = new THREE.Vector3();
    n[a] = st.flip ? 1 : -1;
    const plane = new THREE.Plane(n, st.flip ? -v : v);
    this.sync.setSection(plane);
    if (this.el.sectionValue) this.el.sectionValue.textContent = `${a.toUpperCase()} = ${fmt(v, 2)}`;
  }

  // =====================================================================
  // Propiedades físicas
  // =====================================================================
  computeMass(nodes) {
    let vol = 0, area = 0, tris = 0;
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    for (const n of nodes) {
      const g = this.sync.geometryFor(n);
      const r = massProps(g, this.sync.worldMatrix(n.id));
      vol += r.volume;
      area += r.area;
      tris += r.triangles;
      box.union(r.box);
      c.addScaledVector(r.center, r.volume);
    }
    if (Math.abs(vol) > 1e-12) c.divideScalar(vol);
    return { vol, area, box, center: c, tris };
  }

  showMassProps() {
    const nodes = this.selectedNodes();
    if (!nodes.length) return toast('Selecciona uno o varios cuerpos', 'warn');
    const r = this.computeMass(nodes);
    const size = r.box.getSize(new THREE.Vector3());
    const dens = +this.settings.density;
    const body = h(
      'div',
      { class: 'mass-table' },
      row('Volumen', `${fmt(r.vol / 1000, 3)} cm³  (${fmt(r.vol, 1)} mm³)`),
      row('Área superficial', `${fmt(r.area / 100, 3)} cm²`),
      row('Masa', `${fmt((r.vol / 1000) * dens, 2)} g  (densidad ${dens} g/cm³)`),
      row('Centro de masa', `X ${fmt(r.center.x, 2)} · Y ${fmt(r.center.y, 2)} · Z ${fmt(r.center.z, 2)}`),
      row('Dimensiones', `${fmt(size.x, 2)} × ${fmt(size.y, 2)} × ${fmt(size.z, 2)} mm`),
      row('Triángulos', r.tris.toLocaleString('es'))
    );
    this.showModal('Propiedades físicas', body, [{ label: 'Cerrar', primary: true }]);
    function row(a, b) {
      return h('div', { class: 'mrow' }, h('span', null, a), h('b', null, b));
    }
  }

  // =====================================================================
  // Árbol de diseño
  // =====================================================================
  renderTree() {
    const T = this.el.tree;
    const scroll = T.scrollTop;
    const rows = [];
    // Planos
    const picking = this.mode === 'pickPlane';
    rows.push(h('div', { class: 'tsection' }, 'Referencias'));
    for (const [k, p] of Object.entries(PLANES)) {
      rows.push(
        h(
          'div',
          {
            class: 'trow plane' + (picking ? ' pickable' : ''),
            title: picking ? 'Clic para dibujar en este plano' : 'Clic derecho: nuevo croquis en este plano',
            onclick: () => picking && this.startSketch({ plane: planeFrom(p) }),
            onmouseenter: () => this.mode !== 'sketch' && this.viewer.highlightPlane(k),
            onmouseleave: () => this.viewer.highlightPlane(null),
            oncontextmenu: (e) => {
              e.preventDefault();
              if (this.mode === 'sketch') return;
              this.showMenu(e.clientX, e.clientY, [{ label: 'Nuevo croquis aquí', icon: 'sketch', action: () => this.startSketch({ plane: planeFrom(p) }) }]);
            },
          },
          h('span', { class: 'caret' }),
          h('span', { class: 'ticon', html: icon('plane', 16) }),
          h('span', { class: 'tname' }, p.label),
          !picking && this.mode !== 'sketch' ? h('button', { class: 'tbtn', title: 'Nuevo croquis en este plano', onclick: (e) => { e.stopPropagation(); this.startSketch({ plane: planeFrom(p) }); }, html: icon('sketch', 15) }) : null
        )
      );
    }
    if (this.mode === 'sketch') {
      const sk = this.sketcher;
      rows.push(h('div', { class: 'tsection' }, sk.editNodeId ? 'Editando croquis' : 'Croquis activo'));
      if (!sk.entities.length) rows.push(h('div', { class: 'tempty' }, 'Sin entidades todavía'));
      sk.entities.forEach((e, i) =>
        rows.push(
          h(
            'div',
            {
              class: 'trow' + (sk.selected === i ? ' sel' : ''),
              onclick: () => {
                sk.selected = i;
                sk.redraw();
                this.onSketchSelect(i);
              },
            },
            h('span', { class: 'caret' }),
            h('span', { class: 'ticon', html: icon({ rect: 'rect', circle: 'circle', ngon: 'ngon', slot: 'slot', poly: 'line' }[e.t], 16) }),
            h('span', { class: 'tname' }, `${sk.entityLabel(e)} ${i + 1}`)
          )
        )
      );
    } else {
      rows.push(h('div', { class: 'tsection' }, `Cuerpos (${this.doc.nodes.length})`));
      if (!this.doc.nodes.length) {
        rows.push(h('div', { class: 'tempty' }, 'Empieza con un sólido básico o un croquis desde la pestaña Modelar.'));
      }
      const walk = (list, depth, parentHidden) => {
        for (const n of list) {
          const hasKids = n.children && n.children.length;
          const open = this.expanded.has(n.id);
          const isChild = depth > 0;
          const hidden = isChild ? n.suppressed : n.visible === false;
          const err = this.sync.errors.get(n.id);
          const ic = n.type === 'ecomp' ? PARTS[n.part]?.icon : n.type === 'boolean' ? OPS[n.op]?.icon : TYPES[n.type]?.icon;
          rows.push(
            h(
              'div',
              {
                class: 'trow' + (this.selection.includes(n.id) ? ' sel' : '') + (hidden || parentHidden ? ' dim' : ''),
                style: { paddingLeft: 6 + depth * 14 + 'px' },
                onclick: (e) => this.select(n.id, e.ctrlKey || e.shiftKey || e.metaKey),
                ondblclick: (e) => {
                  if (e.target.classList.contains('tname')) this.renameInline(e.target, n);
                },
                oncontextmenu: (e) => {
                  e.preventDefault();
                  if (!this.selection.includes(n.id)) this.select(n.id);
                  this.nodeMenu(e.clientX, e.clientY, n.id);
                },
              },
              h('span', {
                class: 'caret' + (hasKids ? (open ? ' open' : ' closed') : ''),
                html: hasKids ? icon('chevron', 12) : '',
                onclick: (e) => {
                  e.stopPropagation();
                  if (open) this.expanded.delete(n.id);
                  else this.expanded.add(n.id);
                  this.renderTree();
                },
              }),
              h('span', { class: 'ticon', style: { color: n.color }, html: icon(ic || 'box', 16) }),
              h('span', { class: 'tname' }, n.name),
              n.mount ? h('span', { class: 'tlink', title: 'Acoplado a ' + (this.doc.get(n.mount.to)?.name || '?'), html: icon('link', 13) }) : null,
              err ? h('span', { class: 'terr', title: err, html: icon('warn', 14) }) : null,
              h('button', {
                class: 'tbtn eye',
                title: isChild ? (n.suppressed ? 'Activar en la operación' : 'Suprimir en la operación') : hidden ? 'Mostrar' : 'Ocultar',
                html: icon(isChild ? (n.suppressed ? 'suppress' : 'eye') : hidden ? 'eye-off' : 'eye', 15),
                onclick: (e) => {
                  e.stopPropagation();
                  if (isChild) n.suppressed = !n.suppressed;
                  else n.visible = n.visible === false;
                  this.commit(isChild ? 'Suprimir' : 'Ocultar/mostrar');
                },
              })
            )
          );
          if (hasKids && open) walk(n.children, depth + 1, hidden || parentHidden);
        }
      };
      walk(this.doc.nodes, 0, false);
    }
    T.replaceChildren(...rows);
    T.scrollTop = scroll;
  }

  renameInline(span, node) {
    const inp = h('input', { class: 'rename', value: node.name });
    span.replaceWith(inp);
    inp.focus();
    inp.select();
    const done = (ok) => {
      if (ok && inp.value.trim() && inp.value.trim() !== node.name) {
        node.name = inp.value.trim();
        this.commit('Renombrar');
      } else this.renderTree();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(true));
  }

  nodeMenu(x, y, id) {
    const n = this.doc.get(id);
    if (!n) return;
    const f = this.doc.find(id);
    const isChild = f.parents.length > 0;
    const items = [];
    if (n.type === 'extrude' || n.type === 'revolve') items.push({ label: 'Editar croquis', icon: 'edit', action: () => this.editSketch(id) });
    items.push({ label: 'Renombrar', icon: 'edit', action: () => this.renameFromMenu(id) });
    if (isChild) items.push({ label: n.suppressed ? 'Activar en la operación' : 'Suprimir en la operación', icon: 'suppress', action: () => { n.suppressed = !n.suppressed; this.commit('Suprimir'); } });
    else {
      items.push({ label: n.visible === false ? 'Mostrar' : 'Ocultar', icon: 'eye', action: () => { n.visible = n.visible === false; this.commit('Ocultar/mostrar'); } });
      items.push({ label: 'Aislar (ocultar el resto)', icon: 'eye-off', action: () => this.isolate(id) });
    }
    items.push({ label: 'Mostrar todo', icon: 'eye', action: () => this.showAll() });
    items.push({ label: 'Ajustar a la selección', icon: 'fit', action: () => this.fitView() });
    items.push({ sep: true });
    items.push({ label: 'Duplicar', icon: 'duplicate', action: () => this.duplicateSelected(), disabled: isChild });
    items.push({ label: 'Copiar', icon: 'duplicate', action: () => this.copy(), disabled: isChild });
    if (n.type === 'boolean') items.push({ label: 'Separar operación', icon: 'dissolve', action: () => this.dissolveSelected() });
    items.push({ label: 'Propiedades físicas', icon: 'mass', action: () => this.showMassProps() });
    items.push({ sep: true });
    items.push({ label: 'Eliminar', icon: 'trash', danger: true, action: () => this.deleteSelected() });
    this.showMenu(x, y, items);
  }

  renameFromMenu(id) {
    this.select(id);
    const row = this.el.tree.querySelector('.trow.sel .tname');
    if (row) this.renameInline(row, this.doc.get(id));
  }

  // =====================================================================
  // Panel de propiedades
  // =====================================================================
  renderProps() {
    if (this.featureForm) return this.renderForm();
    const P = this.el.props;
    const focusKey = document.activeElement?.dataset?.key;
    const scroll = P.scrollTop;
    const out = [];
    if (this.mode === 'sketch') out.push(...this.sketchProps());
    else {
      const nodes = this.selectedNodes();
      const wp = !nodes.length && this.elec.layer.selectedWire ? this.elec.wireProps(this.elec.layer.selectedWire) : null;
      if (wp) out.push(...wp);
      else if (!nodes.length) out.push(...this.docProps());
      else if (nodes.length > 1) out.push(...this.multiProps(nodes));
      else out.push(...this.nodeProps(nodes[0]));
    }
    P.replaceChildren(...out);
    P.scrollTop = scroll;
    if (focusKey) {
      const el = P.querySelector(`[data-key="${focusKey}"]`);
      if (el) {
        el.focus();
        if (el.tagName === 'INPUT') el.select();
      }
    }
  }

  docProps() {
    const n = this.doc.nodes.length;
    return [
      h('div', { class: 'ptitle' }, h('span', { html: icon('folder', 18) }), h('span', null, this.docName)),
      section(
        'Documento',
        info('Cuerpos', String(n)),
        info('Unidades', 'milímetros (mm)'),
        info('Calidad de curvas', { 24: 'Baja', 48: 'Media', 96: 'Alta' }[this.settings.quality] || this.settings.quality)
      ),
      section(
        'Electrónica y mecatrónica',
        h('p', { class: 'muted small' }, 'Arduino, servos, motores, sensores y LEDs con simulación en tiempo real. Abre la pestaña Electrónica o empieza con un ejemplo.'),
        h('button', { class: 'wide', onclick: (e) => this.elec.examplesMenu(e.currentTarget), html: icon('book', 16) + ' Ejemplos de electrónica' })
      ),
      section(
        'Cómo empezar',
        h(
          'ol',
          { class: 'tips' },
          h('li', null, 'Pulsa ', h('b', null, 'Croquis'), ' y elige un plano o una cara.'),
          h('li', null, 'Dibuja un perfil cerrado (rectángulo, círculo…). Escribe números para medidas exactas.'),
          h('li', null, 'Pulsa ', h('b', null, 'Extruir'), ' o ', h('b', null, 'Revolución'), ' para crear el sólido.'),
          h('li', null, 'Dibuja sobre una cara y elige ', h('b', null, 'Corte'), ' para hacer agujeros y ranuras.'),
          h('li', null, 'También puedes colocar ', h('b', null, 'sólidos básicos'), ' y combinarlos con Unir / Restar.')
        )
      ),
      section(
        'Aprender',
        h('div', { class: 'stack' },
          h('button', { class: 'wide primary', onclick: () => this.tutorial.start(), html: icon('school', 16) + ' Tutorial guiado (5 min)' }),
          h('button', { class: 'wide', onclick: () => this.loadDemo(true), html: icon('open', 16) + ' Abrir modelo de ejemplo' }),
          h('button', { class: 'wide', onclick: () => this.openHelp(), html: icon('help', 16) + ' Atajos y comandos (F1)' })
        )
      ),
    ];
  }

  multiProps(nodes) {
    return [
      h('div', { class: 'ptitle' }, h('span', { html: icon('box', 18) }), h('span', null, `${nodes.length} elementos seleccionados`)),
      section(
        'Acciones',
        h(
          'div',
          { class: 'btnrow' },
          actionBtn('union', 'Unir', () => this.booleanSelected('union')),
          actionBtn('subtract', 'Restar', () => this.booleanSelected('subtract')),
          actionBtn('intersect', 'Intersecar', () => this.booleanSelected('intersect'))
        ),
        h('p', { class: 'muted small' }, 'En "Restar", al primer cuerpo seleccionado se le quitan los demás.'),
        h('div', { class: 'btnrow' }, actionBtn('duplicate', 'Duplicar', () => this.duplicateSelected()), actionBtn('trash', 'Eliminar', () => this.deleteSelected()))
      ),
      section('Apariencia', this.colorField(nodes)),
    ];
  }

  nodeProps(node) {
    const f = this.doc.find(node.id);
    const isChild = f.parents.length > 0;
    const out = [];
    const pinfo = node.type === 'ecomp' ? this.elec.partInfo(node) : null;
    const typeLabel = pinfo ? pinfo.label : node.type === 'boolean' ? OPS[node.op]?.label : TYPES[node.type]?.label;
    const nameInput = h('input', { class: 'name-input', value: node.name, 'data-key': 'name' });
    nameInput.addEventListener('change', () => {
      if (nameInput.value.trim()) {
        node.name = nameInput.value.trim();
        this.commit('Renombrar');
      }
    });
    out.push(h('div', { class: 'ptitle' }, h('span', { style: { color: node.color }, html: icon(pinfo ? pinfo.icon : node.type === 'boolean' ? OPS[node.op]?.icon : TYPES[node.type]?.icon, 18) }), nameInput));
    out.push(h('div', { class: 'ptype' }, typeLabel + (isChild ? ` · dentro de "${f.parents[f.parents.length - 1].name}"` : '')));
    const err = this.sync.errors.get(node.id) || (isChild ? null : this.findChildError(node));
    if (err) out.push(h('div', { class: 'perror', html: icon('warn', 16) + ' ' + escapeHtml(err) }));

    // Parámetros
    const setParam = (k, v, label) => {
      node.params[k] = v;
      this.commit('Editar ' + label.toLowerCase());
    };
    const defs = TYPES[node.type]?.params || [];
    if (defs.length) {
      out.push(section('Dimensiones', ...defs.map(([k, label, , kind]) => this.numField(label, node.params[k], (v) => setParam(k, v, label), { key: 'p_' + k, min: kind === 'int' ? 3 : 0.001, int: kind === 'int', unit: kind === 'int' ? '' : 'mm' }))));
    }
    if (node.type === 'extrude') {
      const p = node.params;
      out.push(
        section(
          'Extrusión',
          this.numField('Profundidad', p.depth, (v) => setParam('depth', v, 'Profundidad'), { key: 'depth', min: 0.001, unit: 'mm' }),
          this.selectField('Dirección', String(p.dir ?? 1), [['1', 'Normal'], ['-1', 'Invertida'], ['0', 'Simétrica']], (v) => setParam('dir', +v, 'Dirección')),
          info('Perfiles', String((p.profiles || []).length)),
          h('button', { class: 'wide', onclick: () => this.editSketch(node.id), html: icon('edit', 16) + ' Editar croquis' })
        )
      );
    }
    if (node.type === 'revolve') {
      const p = node.params;
      out.push(
        section(
          'Revolución',
          this.numField('Ángulo', p.angle ?? 360, (v) => setParam('angle', Math.min(360, Math.max(1, v)), 'Ángulo'), { key: 'angle', min: 1, max: 360, unit: '°' }),
          this.selectField('Eje', p.axis || 'y', [['y', 'Vertical del croquis'], ['x', 'Horizontal del croquis']], (v) => setParam('axis', v, 'Eje')),
          h('button', { class: 'wide', onclick: () => this.editSketch(node.id), html: icon('edit', 16) + ' Editar croquis' })
        )
      );
    }
    if (node.type === 'boolean') {
      out.push(
        section(
          'Operación',
          this.selectField('Tipo', node.op, Object.entries(OPS).map(([k, o]) => [k, o.label]), (v) => {
            node.op = v;
            this.commit('Cambiar operación');
          }),
          h(
            'div',
            { class: 'kids' },
            node.children.map((c, i) =>
              h(
                'div',
                { class: 'kid' + (c.suppressed ? ' dim' : ''), onclick: () => this.select(c.id) },
                h('span', { class: 'kidx' }, i === 0 ? 'Base' : node.op === 'subtract' ? '−' : node.op === 'union' ? '+' : '∩'),
                h('span', { html: icon(c.type === 'boolean' ? OPS[c.op]?.icon : TYPES[c.type]?.icon, 14) }),
                h('span', null, c.name)
              )
            )
          ),
          h('p', { class: 'muted small' }, 'Selecciona un operando para cambiar sus medidas o moverlo; la operación se recalcula sola.'),
          h('button', { class: 'wide', onclick: () => this.dissolveSelected(), html: icon('dissolve', 16) + ' Separar operación' })
        )
      );
    }
    if (node.type === 'mesh') {
      const g = this.sync.geometryFor(node);
      out.push(section('Malla', info('Triángulos', (g.attributes.position.count / 3).toLocaleString('es')), h('p', { class: 'muted small' }, 'Las mallas importadas se pueden mover, escalar y combinar con otros cuerpos (deben ser cerradas).')));
    }
    if (node.type === 'ecomp') out.push(...this.elec.propSections(node));
    if (!isChild) {
      const ms = this.elec.mountSection(node);
      if (ms) out.push(ms);
    }

    // Transformación
    const setT = (arr, i, v, label) => {
      node[arr] = [...node[arr]];
      node[arr][i] = v;
      this.commit(label);
    };
    const tf = (arr, axis, i, label, opts = {}) => this.numField(axis, node[arr][i], (v) => setT(arr, i, v, label), { key: arr + i, compact: true, ...opts });
    out.push(
      section(
        isChild ? 'Posición (relativa a la operación)' : 'Posición',
        h('div', { class: 'xyz' }, tf('pos', 'X', 0, 'Mover', { unit: 'mm' }), tf('pos', 'Y', 1, 'Mover', { unit: 'mm' }), tf('pos', 'Z', 2, 'Mover', { unit: 'mm' })),
        h('div', { class: 'flabel' }, 'Rotación (°)'),
        h('div', { class: 'xyz' }, tf('rot', 'X', 0, 'Rotar'), tf('rot', 'Y', 1, 'Rotar'), tf('rot', 'Z', 2, 'Rotar')),
        h('div', { class: 'flabel' }, 'Escala'),
        h('div', { class: 'xyz' }, tf('scl', 'X', 0, 'Escalar', { step: 0.1 }), tf('scl', 'Y', 1, 'Escalar', { step: 0.1 }), tf('scl', 'Z', 2, 'Escalar', { step: 0.1 })),
        h(
          'div',
          { class: 'btnrow' },
          actionBtn('ground', 'Al suelo', () => this.alignSelected('ground'), isChild),
          actionBtn('center', 'Centrar', () => this.alignSelected('center'), isChild),
          actionBtn('rotate', 'Reiniciar giro', () => {
            node.rot = [0, 0, 0];
            node.scl = [1, 1, 1];
            this.commit('Reiniciar giro');
          })
        )
      )
    );

    // Apariencia
    const appearance = node.type === 'ecomp' ? [] : [this.colorField([node])];
    if (isChild) {
      appearance.push(this.checkField('Suprimido en la operación', !!node.suppressed, (v) => { node.suppressed = v; this.commit('Suprimir'); }));
    } else appearance.push(this.checkField('Visible', node.visible !== false, (v) => { node.visible = v; this.commit('Ocultar/mostrar'); }));
    out.push(section('Apariencia', ...appearance));

    // Propiedades físicas (rápidas)
    const g = this.sync.geometryFor(node);
    if (g !== EMPTY && g.attributes.position.count < 600000) {
      const r = this.computeMass([node]);
      const size = r.box.getSize(new THREE.Vector3());
      const dens = +this.settings.density;
      out.push(
        section(
          'Propiedades físicas',
          info('Dimensiones', `${fmt(size.x, 2)} × ${fmt(size.y, 2)} × ${fmt(size.z, 2)} mm`),
          info('Volumen', `${fmt(r.vol / 1000, 3)} cm³`),
          info('Área', `${fmt(r.area / 100, 2)} cm²`),
          this.selectField('Material', this.settings.density, MATERIALS.map(([d, l]) => [d, `${l} (${d} g/cm³)`]), (v) => {
            this.setSetting('density', v);
            this.renderProps();
          }),
          info('Masa', `${fmt((r.vol / 1000) * dens, 2)} g`)
        )
      );
    }
    return out;
  }

  findChildError(node) {
    if (!node.children) return null;
    for (const c of this.doc.walk(node.children)) if (this.sync.errors.has(c.id)) return this.sync.errors.get(c.id);
    return null;
  }

  sketchProps() {
    const sk = this.sketcher;
    const out = [];
    if (sk.selected >= 0 && sk.entities[sk.selected]) {
      const e = sk.entities[sk.selected];
      const i = sk.selected;
      out.push(h('div', { class: 'ptitle' }, h('span', { html: icon({ rect: 'rect', circle: 'circle', ngon: 'ngon', slot: 'slot', poly: 'line' }[e.t], 18) }), h('span', null, `${sk.entityLabel(e)} ${i + 1}`)));
      // Las polilíneas con muchos puntos (arcos) no muestran cada coordenada
      const many = e.t === 'poly' && e.pts.length > 24;
      out.push(
        section(
          'Medidas',
          ...(many
            ? [info('Puntos', String(e.pts.length)), h('p', { class: 'muted small' }, 'Contorno con arcos: usa las herramientas de Modificar para cambiarlo.')]
            : sk.entityFields(i).map(([k, label, v]) =>
                this.numField(label, v, (nv) => { sk.updateEntity(i, k, nv); this.renderProps(); }, { key: 'e_' + k, int: k === 'n', unit: k === 'n' ? '' : k === 'a' ? '°' : 'mm' })
              )),
          h('button', { class: 'wide danger', onclick: () => sk.deleteSelected(), html: icon('trash', 16) + ' Borrar entidad' })
        )
      );
      const corners = ['rect', 'ngon', 'poly'].includes(e.t);
      out.push(
        section(
          'Modificar',
          h(
            'div',
            { class: 'btnrow' },
            actionBtn('mirror', 'Simetría', () => this.sketchModify('mirror')),
            actionBtn('move', 'Mover / copiar', () => this.sketchModify('move')),
            actionBtn('rotate', 'Girar', () => this.sketchModify('rotate')),
            actionBtn('offset', 'Desfase', () => this.sketchModify('offset')),
            actionBtn('pattern-lin', 'Matriz', () => this.sketchModify('array')),
            actionBtn('pattern-circ', 'Matriz polar', () => this.sketchModify('polar')),
            corners ? actionBtn('fillet', 'Redondear esquinas', () => this.sketchModify('fillet')) : null,
            corners ? actionBtn('chamfer', 'Chaflán en esquinas', () => this.sketchModify('chamfer')) : null,
            e.t === 'rect' || e.t === 'ngon' ? actionBtn('line', 'Convertir en polilínea', () => sk.applyEdit(i, toPoly(e))) : null
          )
        )
      );
      return out;
    }
    const regions = (() => {
      try {
        return buildRegions(sk.entities, 32);
      } catch {
        return [];
      }
    })();
    out.push(h('div', { class: 'ptitle' }, h('span', { html: icon('sketch', 18) }), h('span', null, sk.editNodeId ? 'Editando croquis' : 'Croquis')));
    out.push(
      section(
        'Croquis',
        info('Plano', sk.plane.label || '—'),
        info('Entidades', String(sk.entities.length)),
        info('Regiones cerradas', String(regions.length)),
        info('Agujeros', String(regions.reduce((s, r) => s + r.holes.length, 0)))
      )
    );
    out.push(
      section(
        'Opciones',
        this.selectField('Ajuste a rejilla', String(this.settings.sketchSnap), [['0', 'Sin ajuste'], ['0.1', '0.1 mm'], ['0.5', '0.5 mm'], ['1', '1 mm'], ['2', '2 mm'], ['5', '5 mm'], ['10', '10 mm']], (v) => this.setSetting('sketchSnap', +v)),
        this.numField('Lados del polígono', sk.ngonSides, (v) => { sk.ngonSides = Math.max(3, Math.min(64, Math.round(v))); this.renderProps(); }, { key: 'ngon', int: true, min: 3 }),
        this.numField('Distancia de desfase', sk.offsetDist, (v) => { sk.offsetDist = v; sk.updatePreview(); }, { key: 'offd', min: 0.001, unit: 'mm' }),
        this.numField('Radio de empalme', sk.filletR, (v) => { sk.filletR = v; sk.updatePreview(); }, { key: 'filr', min: 0.001, unit: 'mm' }),
        this.numField('Distancia de chaflán', sk.chamferD, (v) => { sk.chamferD = v; sk.updatePreview(); }, { key: 'chd', min: 0.001, unit: 'mm' }),
        this.checkField('Orto: sólo horizontal / vertical (F8)', this.settings.sketchOrtho, () => this.toggleSketchSetting('sketchOrtho')),
        this.checkField('Mostrar cotas (D)', this.settings.sketchDims, () => this.toggleSketchSetting('sketchDims'))
      )
    );
    out.push(
      section(
        'Ayuda',
        h('p', { class: 'muted small' }, SKETCH_TOOLS[sk.tool]?.hint || ''),
        h(
          'ul',
          { class: 'tips' },
          h('li', null, 'Los perfiles dentro de otros se convierten en agujeros.'),
          h('li', null, 'Mientras dibujas, escribe un número y pulsa Enter para una medida exacta.'),
          h('li', null, 'Coordenadas como en AutoCAD: ', h('b', null, '30,20'), ' (absoluta), ', h('b', null, '@40,0'), ' (relativa), ', h('b', null, '@50<30'), ' (polar).'),
          h('li', null, 'Selecciona una entidad para editar sus medidas aquí.'),
          h('li', null, 'Botón central del ratón: girar · derecho: desplazar.')
        )
      )
    );
    return out;
  }

  // Formularios de Modificar del croquis (con vista previa en verde)
  sketchModify(kind) {
    const sk = this.sketcher;
    const i = sk.selected;
    const src = sk.entities[i];
    if (!src) return toast('Selecciona primero una entidad (herramienta Seleccionar, S).', 'warn');
    const [cx, cy] = entityCenter(src).map((v) => Math.round(v * 1e4) / 1e4);
    const keep = { key: 'keep', label: 'Conservar el original', type: 'check', value: true };
    const center = (label) => [
      { key: 'about', label, type: 'select', value: 'entity', options: [['entity', 'Centro de la entidad'], ['origin', 'Origen (0,0)'], ['custom', 'Otro punto…']] },
      { key: 'px', label: 'Centro X', type: 'number', value: cx, unit: 'mm', show: (v) => v.about === 'custom' },
      { key: 'py', label: 'Centro Y', type: 'number', value: cy, unit: 'mm', show: (v) => v.about === 'custom' },
    ];
    const pivot = (v) => (v.about === 'origin' ? [0, 0] : v.about === 'custom' ? [v.px, v.py] : [cx, cy]);
    const defs = {
      mirror: {
        title: 'Simetría',
        fields: [
          { key: 'axis', label: 'Eje', type: 'select', value: 'v', options: [['v', 'Vertical (verde)'], ['h', 'Horizontal (rojo)'], ['a', 'Inclinado…']] },
          { key: 'ang', label: 'Ángulo', type: 'number', value: 45, unit: '°', show: (v) => v.axis === 'a' },
          { key: 'through', label: 'Pasa por', type: 'select', value: 'origin', options: [['origin', 'Origen (0,0)'], ['entity', 'Centro de la entidad'], ['custom', 'Otro punto…']] },
          { key: 'px', label: 'Punto X', type: 'number', value: 0, unit: 'mm', show: (v) => v.through === 'custom' },
          { key: 'py', label: 'Punto Y', type: 'number', value: 0, unit: 'mm', show: (v) => v.through === 'custom' },
          keep,
        ],
        run: (v) => {
          const ang = v.axis === 'v' ? 90 : v.axis === 'h' ? 0 : v.ang;
          const [px, py] = v.through === 'custom' ? [v.px, v.py] : v.through === 'entity' ? [cx, cy] : [0, 0];
          return { out: [transformEntity(src, affine.mirror(ang, px, py))], keep: v.keep };
        },
      },
      move: {
        title: 'Mover / copiar',
        fields: [
          { key: 'dx', label: 'Mover en X', type: 'number', value: 20, unit: 'mm' },
          { key: 'dy', label: 'Mover en Y', type: 'number', value: 0, unit: 'mm' },
          { ...keep, label: 'Copiar (conservar el original)', value: false },
        ],
        run: (v) => ({ out: [transformEntity(src, affine.translate(v.dx, v.dy))], keep: v.keep }),
      },
      rotate: {
        title: 'Girar',
        fields: [{ key: 'ang', label: 'Ángulo (+ antihorario)', type: 'number', value: 90, unit: '°' }, ...center('Centro de giro'), { ...keep, value: false }],
        run: (v) => ({ out: [transformEntity(src, affine.rotate(v.ang, ...pivot(v)))], keep: v.keep }),
      },
      array: {
        title: 'Matriz rectangular',
        fields: [
          { key: 'cols', label: 'Columnas', type: 'int', value: 3, min: 1, max: 50 },
          { key: 'rows', label: 'Filas', type: 'int', value: 1, min: 1, max: 50 },
          { key: 'dx', label: 'Separación X', type: 'number', value: 20, unit: 'mm' },
          { key: 'dy', label: 'Separación Y', type: 'number', value: 20, unit: 'mm' },
        ],
        run: (v) => ({ out: rectArray(src, v.cols, v.rows, v.dx, v.dy), keep: true }),
      },
      polar: {
        title: 'Matriz polar',
        fields: [
          { key: 'n', label: 'Número total', type: 'int', value: 6, min: 2, max: 100 },
          { key: 'total', label: 'Ángulo total', type: 'number', value: 360, unit: '°' },
          { key: 'about', label: 'Centro', type: 'select', value: 'origin', options: [['origin', 'Origen (0,0)'], ['custom', 'Otro punto…']] },
          { key: 'px', label: 'Centro X', type: 'number', value: 0, unit: 'mm', show: (v) => v.about === 'custom' },
          { key: 'py', label: 'Centro Y', type: 'number', value: 0, unit: 'mm', show: (v) => v.about === 'custom' },
          { key: 'rot', label: 'Girar las copias', type: 'check', value: true },
        ],
        run: (v) => ({ out: polarArray(src, v.n, v.total, ...pivot(v), v.rot), keep: true }),
      },
      offset: {
        title: 'Desfase',
        fields: [
          { key: 'd', label: 'Distancia', type: 'number', value: sk.offsetDist, min: 0.001, unit: 'mm' },
          { key: 'side', label: 'Lado', type: 'select', value: 'out', options: [['out', 'Hacia fuera'], ['in', 'Hacia dentro'], ['both', 'Ambos lados']] },
        ],
        run: (v) => {
          sk.offsetDist = v.d;
          const out = [v.side !== 'in' && offsetEntity(src, v.d), v.side !== 'out' && offsetEntity(src, -v.d)].filter(Boolean);
          return { out, keep: true, error: out.length ? null : 'No cabe un desfase de esa distancia.' };
        },
      },
      fillet: {
        title: 'Redondear esquinas',
        fields: [{ key: 'r', label: 'Radio', type: 'number', value: sk.filletR, min: 0.001, unit: 'mm' }],
        run: (v) => {
          sk.filletR = v.r;
          const e = cornerOp(src, 'all', 'fillet', v.r, 32);
          return { out: e ? [e] : [], keep: false, error: e ? null : 'El radio es demasiado grande para estas esquinas.' };
        },
      },
      chamfer: {
        title: 'Chaflán en esquinas',
        fields: [{ key: 'd', label: 'Distancia', type: 'number', value: sk.chamferD, min: 0.001, unit: 'mm' }],
        run: (v) => {
          sk.chamferD = v.d;
          const e = cornerOp(src, 'all', 'chamfer', v.d);
          return { out: e ? [e] : [], keep: false, error: e ? null : 'La distancia es demasiado grande para estas esquinas.' };
        },
      },
    };
    const def = defs[kind];
    this.openForm({
      title: def.title,
      icon: { array: 'pattern-lin', polar: 'pattern-circ' }[kind] || kind,
      fields: def.fields,
      onChange: (v) => {
        const r = def.run(v);
        sk.setGhost(r.out);
        return r.error || null;
      },
      onOk: (v) => {
        const r = def.run(v);
        if (!r.out.length) return toast(r.error || 'No hay nada que crear', 'warn');
        if (r.keep) sk.applyEdit(-1, null, r.out);
        else sk.applyEdit(i, r.out[0], r.out.slice(1));
        this.closeForm();
      },
    });
  }

  // ---------------------------------------------------------------- campos
  numField(label, value, onCommit, opts = {}) {
    const { key, min = -Infinity, max = Infinity, int = false, unit = '', step = 1, compact = false } = opts;
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: fmt(+value || 0, 4), 'data-key': key, spellcheck: 'false' });
    let last = +value || 0;
    const commit = () => {
      let v = evalNum(inp.value, NaN);
      if (!isFinite(v)) {
        inp.value = fmt(last, 4);
        inp.classList.add('bad');
        setTimeout(() => inp.classList.remove('bad'), 600);
        return;
      }
      if (int) v = Math.round(v);
      v = Math.min(max, Math.max(min, v));
      v = Math.round(v * 1e6) / 1e6;
      if (v === last) {
        inp.value = fmt(v, 4);
        return;
      }
      last = v;
      onCommit(v);
    };
    // Diferido: deja que el foco pase al siguiente campo (Tab) antes de redibujar
    inp.addEventListener('change', () => setTimeout(commit, 0));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        // Devuelve el foco al visor para que funcionen los atajos de teclado
        this.viewer.renderer.domElement.focus({ preventScroll: true });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = evalNum(inp.value, last);
        const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        inp.value = fmt(cur + d, 4);
        commit();
      } else if (e.key === 'Escape') {
        inp.value = fmt(last, 4);
        inp.blur();
      }
    });
    inp.addEventListener('focus', () => setTimeout(() => inp.select(), 0));
    return h('label', { class: 'field' + (compact ? ' compact' : '') }, h('span', { class: 'flab' }, label), h('span', { class: 'finput' }, inp, unit ? h('span', { class: 'unit' }, unit) : null));
  }

  selectField(label, value, options, onChange) {
    const sel = h('select', { 'data-key': 's_' + label, onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = value;
    return h('label', { class: 'field' }, h('span', { class: 'flab' }, label), sel);
  }

  checkField(label, value, onChange) {
    return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value, onchange: (e) => onChange(e.target.checked) }), h('span', null, label));
  }

  colorField(nodes) {
    const cur = nodes[0].color || '#a9b8cc';
    const apply = (c) => {
      for (const n of nodes) n.color = c;
      this.commit('Color');
    };
    const inp = h('input', { type: 'color', value: cur, onchange: (e) => apply(e.target.value) });
    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'flab' }, 'Color'),
      h('div', { class: 'swatches' }, PALETTE.map((c) => h('button', { class: 'sw' + (c === cur ? ' on' : ''), style: { background: c }, title: c, onclick: () => apply(c) })), inp)
    );
  }

  // ---------------------------------------------------------------- formularios de operación
  openForm({ title, icon: ic, fields, onChange, onOk, onCancel }) {
    const values = {};
    for (const f of fields) values[f.key] = f.value;
    const form = {
      title,
      icon: ic,
      fields,
      values,
      onChange,
      error: null,
      ok: () => onOk(values),
      cancel: () => {
        onCancel?.();
        this.closeForm();
      },
    };
    this.featureForm = form;
    this.viewer.tc.detach();
    form.error = onChange?.(values) || null;
    this.renderForm();
    this.renderRibbon();
  }

  closeForm() {
    if (!this.featureForm) return;
    this.featureForm = null;
    this.clearPreview();
    if (this.sketcher.active) this.sketcher.setGhost(null);
    this.renderProps();
    this.attachGizmo();
    this.sketcher.active && this.sketcher.updateHud();
  }

  renderForm() {
    const F = this.featureForm;
    const P = this.el.props;
    const focusKey = document.activeElement?.dataset?.key;
    const changed = () => {
      F.error = F.onChange?.(F.values) || null;
      this.renderForm();
    };
    const rows = F.fields
      .filter((f) => !f.show || f.show(F.values))
      .map((f) => {
        if (f.type === 'select') {
          const sel = h(
            'select',
            { 'data-key': 'f_' + f.key, onchange: (e) => { F.values[f.key] = e.target.value; changed(); } },
            f.options.map(([v, l]) => h('option', { value: v, disabled: f.disabledOptions?.includes(v) }, l))
          );
          sel.value = F.values[f.key];
          return h('label', { class: 'field' }, h('span', { class: 'flab' }, f.label), sel);
        }
        if (f.type === 'check') return this.checkField(f.label, !!F.values[f.key], (v) => { F.values[f.key] = v; changed(); });
        return this.numField(f.label, F.values[f.key], (v) => { F.values[f.key] = v; changed(); }, { key: 'f_' + f.key, min: f.min, max: f.max, int: f.type === 'int', unit: f.unit || '' });
      });
    P.replaceChildren(
      h(
        'div',
        { class: 'form-head' },
        h('span', { html: icon(F.icon, 20) }),
        h('b', null, F.title),
        h('span', { class: 'grow' }),
        h('button', { class: 'okbtn', title: 'Aceptar (Enter)', onclick: () => F.ok(), html: icon('check', 18) }),
        h('button', { class: 'cancelbtn', title: 'Cancelar (Esc)', onclick: () => F.cancel(), html: icon('x', 18) })
      ),
      section('Parámetros', ...rows),
      ...(F.error ? [h('div', { class: 'perror', html: icon('warn', 16) + ' ' + escapeHtml(F.error) })] : []),
      h('p', { class: 'muted small pad' }, 'La vista previa se muestra en verde (añadir) o rojo (quitar).')
    );
    if (focusKey) P.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  // =====================================================================
  // Menús y diálogos
  // =====================================================================
  showMenu(x, y, items) {
    this.closeMenu();
    const m = h(
      'div',
      { class: 'menu' },
      items.map((it) =>
        it.sep
          ? h('div', { class: 'msep' })
          : h(
              'button',
              {
                class: 'mitem' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''),
                disabled: !!it.disabled,
                onclick: () => {
                  this.closeMenu();
                  it.action?.();
                },
              },
              h('span', { html: icon(it.icon || 'box', 16) }),
              h('span', null, it.label)
            )
      )
    );
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
    this.menuEl = m;
    setTimeout(() => {
      this._menuClose = (e) => {
        if (!m.contains(e.target)) this.closeMenu();
      };
      window.addEventListener('pointerdown', this._menuClose, true);
    }, 0);
  }

  closeMenu() {
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
      window.removeEventListener('pointerdown', this._menuClose, true);
    }
  }

  showModal(title, body, buttons = [{ label: 'Cerrar', primary: true }]) {
    this.closeModal();
    const wrap = h(
      'div',
      { class: 'modal-wrap', onclick: (e) => e.target === wrap && this.closeModal() },
      h(
        'div',
        { class: 'modal' },
        h('div', { class: 'modal-head' }, h('b', null, title), h('button', { class: 'ghost', onclick: () => this.closeModal(), html: icon('x', 18) })),
        h('div', { class: 'modal-body' }, body),
        !buttons.length ? null : h(
          'div',
          { class: 'modal-foot' },
          buttons.map((b) =>
            h('button', { class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: () => { if (b.action?.() !== false) this.closeModal(); } }, b.label)
          )
        )
      )
    );
    document.body.append(wrap);
    this.modal = wrap;
    wrap.querySelector('.modal-foot .primary')?.focus();
  }

  closeModal() {
    this.modal?.remove();
    this.modal = null;
  }

  confirm(title, text, okLabel = 'Aceptar') {
    return new Promise((res) => {
      this.showModal(title, h('p', null, text), [
        { label: 'Cancelar', action: () => res(false) },
        { label: okLabel, primary: true, action: () => res(true) },
      ]);
    });
  }

  openSettings() {
    const s = this.settings;
    const f = (label, el) => h('label', { class: 'field' }, h('span', { class: 'flab' }, label), el);
    const sel = (key, opts, num = false) => {
      const e = h('select', null, opts.map(([v, l]) => h('option', { value: v }, l)));
      e.value = String(s[key]);
      e.addEventListener('change', () => (pending[key] = num ? +e.value : e.value));
      return e;
    };
    const chk = (key, label) => {
      const e = h('input', { type: 'checkbox', checked: !!s[key] });
      e.addEventListener('change', () => (pending[key] = e.checked));
      return h('label', { class: 'check' }, e, h('span', null, label));
    };
    const pending = {};
    const body = h(
      'div',
      { class: 'settings' },
      h('h4', null, 'Rendimiento y memoria'),
      f('Calidad de curvas', sel('quality', [['24', 'Baja (menos RAM, más rápido)'], ['48', 'Media (recomendada)'], ['96', 'Alta (más suave)']], true)),
      chk('light', 'Modo ligero: sin suavizado de bordes y resolución 1x (se aplica al recargar)'),
      h('h4', null, 'Rejilla y ajustes'),
      f('Tamaño de la rejilla', sel('gridSize', [['200', '200 mm'], ['400', '400 mm'], ['1000', '1 m'], ['2000', '2 m'], ['5000', '5 m']], true)),
      f('Separación de la rejilla', sel('gridStep', [['1', '1 mm'], ['5', '5 mm'], ['10', '10 mm'], ['50', '50 mm'], ['100', '100 mm']], true)),
      h('h4', null, 'Archivos'),
      chk('stlZUp', 'Exportar/importar STL con Z hacia arriba (impresoras 3D, Cura, PrusaSlicer)'),
      chk('autosave', 'Autoguardado en el navegador'),
      h('p', { class: 'muted small' }, `MiniCAD ${VERSION} · Todo se ejecuta localmente en tu equipo.`)
    );
    this.showModal('Opciones', body, [
      { label: 'Cancelar' },
      {
        label: 'Guardar',
        primary: true,
        action: () => {
          const reload = 'light' in pending && pending.light !== s.light;
          for (const [k, v] of Object.entries(pending)) this.setSetting(k, v);
          if ('quality' in pending) {
            clearGeometryCache();
            this.refresh();
          }
          if ('gridSize' in pending || 'gridStep' in pending) this.viewer.buildHelpers();
          if (reload) toast('El modo ligero se aplicará al recargar la página');
        },
      },
    ]);
  }

  openHelp() {
    const k = (keys, desc) => h('div', { class: 'krow' }, h('span', null, ...keys.split('+').map((x, i) => [i ? '+' : '', h('kbd', null, x)])), h('span', null, desc));
    const body = h(
      'div',
      { class: 'help' },
      h('h4', null, 'Ratón'),
      k('Clic izq.', 'Seleccionar (Ctrl+clic: varios)'),
      k('Arrastrar izq.', 'Girar la vista (en croquis: botón central)'),
      k('Arrastrar der.', 'Desplazar la vista'),
      k('Rueda', 'Zoom hacia el cursor'),
      k('Doble clic', 'Editar el croquis de una extrusión'),
      h('h4', null, 'Teclado'),
      k('W / E / R', 'Mover / Rotar / Escalar · Q oculta el gizmo · Espacio: ejes locales/globales'),
      k('K', 'Nuevo croquis'),
      k('M', 'Medir'),
      k('F', 'Ajustar a la pantalla'),
      k('1 2 3 4', 'Vistas Frontal, Superior, Derecha, Isométrica'),
      k('H', 'Ocultar / mostrar selección'),
      k('Supr', 'Eliminar'),
      k('Ctrl+D', 'Duplicar'),
      k('Ctrl+C / Ctrl+V', 'Copiar / pegar'),
      k('Ctrl+Z / Ctrl+Y', 'Deshacer / rehacer'),
      k('Ctrl+S', 'Guardar (Ctrl+Mayús+S: guardar como)'),
      k('Esc', 'Cancelar / deseleccionar'),
      h('h4', null, 'Electrónica'),
      k('F5', 'Iniciar / detener la simulación'),
      k('Ctrl+Enter', 'Simular desde el editor de código'),
      k('Clic', 'En simulación: pulsa botones e interruptores'),
      k('Arrastrar / rueda', 'En simulación: gira potenciómetros y cambia la luz del LDR'),
      h('h4', null, 'Croquis'),
      k('L R T C P O', 'Polilínea, Rectángulo, Rect. centrado, Círculo, Polígono, Ranura'),
      k('E F H', 'Desfase, Empalme, Chaflán'),
      k('S', 'Seleccionar entidades'),
      k('Números', 'Mientras dibujas: medida exacta (ej. "40x20", "15", "30<45")'),
      k('F8', 'Orto: líneas sólo horizontales o verticales'),
      k('D', 'Mostrar u ocultar las cotas'),
      k('Enter', 'Cerrar polilínea'),
      h('h4', null, 'Coordenadas (como en AutoCAD)'),
      k('30,20', 'Punto absoluto: X = 30, Y = 20 desde el origen'),
      k('@40,0', 'Relativo: 40 en X y 0 en Y desde el último punto'),
      k('@50<30', 'Polar: 50 mm con un ángulo de 30° desde el último punto'),
      k('25', 'Longitud en la dirección del ratón (con Orto, recta)'),
      h('p', { class: 'muted small' }, 'La coma separa coordenadas; los decimales se escriben con punto (12.5).'),
      h('h4', null, 'Si vienes de AutoCAD'),
      h(
        'table',
        { class: 'cmdtable' },
        h('tr', null, h('th', null, 'AutoCAD'), h('th', null, 'MiniCAD')),
        [
          ['LINEA / POL', 'Polilínea (L)'],
          ['RECTANG', 'Rectángulo (R) / Rect. centrado (T)'],
          ['CIRCULO', 'Círculo (C)'],
          ['POLIGONO', 'Polígono (P)'],
          ['DESFASE (OFFSET)', 'Desfase (E)'],
          ['EMPALME (FILLET)', 'Empalme (F)'],
          ['CHAFLAN', 'Chaflán (H)'],
          ['SIMETRIA', 'Simetría'],
          ['DESPLAZA / COPIA', 'Mover / copiar'],
          ['GIRA', 'Girar'],
          ['MATRIZ', 'Matriz / Matriz polar'],
          ['BORRA', 'Supr'],
          ['ORTO (F8)', 'Orto (F8)'],
          ['REFENT (F3)', 'Ajuste automático a extremos, puntos medios y centros'],
          ['ACOTAR', 'Cotas (D) y medidas en el panel derecho'],
          ['EXTRUSION', 'Extruir'],
          ['REVOLUCION', 'Revolución'],
          ['UNION / DIFERENCIA', 'Unir / Restar'],
        ].map(([a, b]) => h('tr', null, h('td', null, a), h('td', null, b)))
      ),
      h('h4', null, 'Conceptos básicos'),
      h(
        'dl',
        { class: 'glossary' },
        [
          ['Croquis', 'Dibujo 2D sobre un plano. Sus perfiles cerrados se convierten en sólidos.'],
          ['Plano', 'Superficie plana donde dibujas: Alzado (frente), Planta (suelo), Perfil (lado) o la cara de un sólido.'],
          ['Perfil cerrado', 'Contorno sin huecos. Un perfil dentro de otro forma un agujero.'],
          ['Extruir', 'Da espesor a un perfil, como una galleta cortada con molde.'],
          ['Revolución', 'Gira un perfil alrededor de un eje (piezas de torno: ejes, poleas, vasos).'],
          ['Operaciones booleanas', 'Unir, restar o quedarse con la parte común de dos sólidos.'],
          ['Paramétrico', 'Las medidas se pueden cambiar después y el modelo se recalcula.'],
          ['Cota', 'Medida que se muestra sobre el dibujo.'],
        ].map(([a, b]) => [h('dt', null, a), h('dd', null, b)])
      ),
      h('h4', null, 'Consejos'),
      h(
        'ul',
        { class: 'tips' },
        h('li', null, 'Los campos numéricos aceptan operaciones: 20+5, 100/3, 2*15.'),
        h('li', null, 'Flechas ↑ ↓ en un campo cambian el valor (Mayús ×10).'),
        h('li', null, 'Selecciona un operando dentro de una operación para modificarlo: el resultado se recalcula.'),
        h('li', null, 'Para ahorrar memoria baja la calidad de curvas en Opciones.')
      )
    );
    this.showModal('Ayuda de MiniCAD', body, [
      { label: 'Tutorial de inicio', action: () => this.tutorial.start() },
      { label: 'Cerrar', primary: true },
    ]);
  }

  // Pantalla de bienvenida (sólo la primera vez)
  showWelcome() {
    storageSet('minicad.welcome', true);
    if (this.modal || this.tutorial.active) return;
    const choice = (ic, title, text, fn) =>
      h('button', { class: 'choice', onclick: () => { this.closeModal(); fn(); } }, h('span', { html: icon(ic, 26) }), h('span', null, h('b', null, title), h('small', null, text)));
    const body = h(
      'div',
      { class: 'welcome' },
      h('p', null, 'MiniCAD es un modelador 3D ligero para aprender CAD y crear piezas para impresión 3D, sin instalar nada.'),
      choice('school', 'Tutorial guiado', 'Modela tu primera pieza paso a paso (5 min).', () => this.tutorial.start()),
      choice('open', 'Ver un modelo de ejemplo', 'Un soporte con nervios, una polea y un eje.', () => this.loadDemo(true)),
      choice('new', 'Empezar en blanco', 'Pulsa Croquis (K) para empezar a dibujar.', () => {})
    );
    this.showModal('Bienvenido a MiniCAD 3D', body, []);
  }

  // =====================================================================
  // Archivos
  // =====================================================================
  // Modelo de ejemplo: soporte con nervios y una polea
  async loadDemo(ask = true) {
    if (ask && this.doc.nodes.length && !(await this.confirm('Modelo de ejemplo', 'Se reemplazará el modelo actual. ¿Continuar?', 'Abrir ejemplo'))) return;
    this.elec.sim.stop();
    if (this.mode !== 'select') this.cancelMode();
    const d = this.doc;
    d.reset();
    const basis = (x, y, n, p = [0, 0, 0]) => new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...n)).setPosition(...p);
    const TOP = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    const FRONT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const RIGHT = [[0, 0, -1], [0, 1, 0], [1, 0, 0]];
    const place = (node, b, p) => (setNodeMatrix(node, basis(...b, p)), node);
    const holes = [[-48, -23], [48, -23], [-48, 23], [48, 23]].map(([x, y]) => ({ t: 'circle', x, y, r: 4.5 }));
    const base = place(d.makeNode('extrude', { profiles: [{ t: 'rect', x: -60, y: -35, w: 120, h: 70, rr: 10 }, ...holes], depth: 10, dir: 1, extra: 0 }), TOP, [0, 0, 0]);
    const arch = [[-40, 0], [40, 0], [40, 40]];
    for (let i = 1; i < 24; i++) arch.push([40 * Math.cos((i / 24) * Math.PI), 40 + 40 * Math.sin((i / 24) * Math.PI)]);
    arch.push([-40, 40]);
    const wall = place(d.makeNode('extrude', { profiles: [{ t: 'poly', pts: arch }, { t: 'circle', x: 0, y: 40, r: 16 }], depth: 12, dir: 1, extra: 0 }), FRONT, [0, 10, -35]);
    const rib = (x) => place(d.makeNode('extrude', { profiles: [{ t: 'poly', pts: [[23, 10], [-8, 10], [23, 45]] }], depth: 8, dir: 0, extra: 0 }), RIGHT, [x, 0, 0]);
    const support = this.makeBoolean('union', [base, wall, rib(-28), rib(28)]);
    support.name = 'Soporte';
    support.color = '#a9b8cc';
    const pulley = place(
      d.makeNode('revolve', { profiles: [{ t: 'poly', pts: [[8, 0], [32, 0], [32, 4], [26, 8], [32, 12], [32, 16], [14, 16], [14, 26], [8, 26]] }], angle: 360, axis: 'y' }),
      FRONT,
      [115, 0, 10]
    );
    pulley.name = 'Polea';
    pulley.color = '#d2b48c';
    const pin = d.makeNode('cylinder', { r: 7.5, h: 70 });
    pin.pos = [0, 50, -10];
    pin.rot = [90, 0, 0];
    pin.name = 'Eje';
    pin.color = '#d79c9c';
    d.nodes.push(support, pulley, pin);
    this.history.clear();
    this.selection = [];
    this.docName = 'Ejemplo';
    this.fileHandle = null;
    this.dirty = false;
    this.refresh();
    this.viewer.fit(this.viewer.sceneBox(), new THREE.Vector3(1, 0.75, 1.15), 1.12);
  }

  async newDoc() {
    if (this.doc.nodes.length && this.dirty && !(await this.confirm('Nuevo modelo', 'Se perderán los cambios no guardados. ¿Continuar?', 'Nuevo'))) return;
    this.elec.sim.stop();
    if (this.mode !== 'select') this.cancelMode();
    this.doc.reset();
    this.history.clear();
    this.selection = [];
    this.docName = 'Sin título';
    this.fileHandle = null;
    this.dirty = false;
    clearGeometryCache();
    this.refresh();
    this.doAutosave();
    this.viewer.setView('iso');
  }

  async openDoc() {
    try {
      let text, name;
      if (window.showOpenFilePicker) {
        try {
          const [handle] = await window.showOpenFilePicker({ types: [{ description: 'Modelo MiniCAD', accept: { 'application/json': ['.mcad', '.json'] } }] });
          const file = await handle.getFile();
          text = await file.text();
          name = file.name;
          this.fileHandle = handle;
        } catch (err) {
          if (err.name === 'AbortError') return;
          throw err;
        }
      } else {
        const file = await pickFile('.mcad,.json');
        if (!file) return;
        text = await file.text();
        name = file.name;
        this.fileHandle = null;
      }
      this.elec.sim.stop();
      if (this.mode !== 'select') this.cancelMode();
      this.doc.fromFile(text);
      this.history.clear();
      this.selection = [];
      this.docName = name.replace(/\.(mcad|json)$/i, '');
      this.dirty = false;
      clearGeometryCache();
      this.refresh();
      this.doAutosave();
      this.viewer.fit(this.viewer.sceneBox());
      toast('Abierto: ' + name);
    } catch (err) {
      toast('No se pudo abrir: ' + err.message, 'error');
    }
  }

  async saveDoc(saveAs = false) {
    const text = this.doc.toFile();
    if (window.showSaveFilePicker) {
      try {
        if (!this.fileHandle || saveAs) {
          this.fileHandle = await window.showSaveFilePicker({
            suggestedName: this.docName + '.mcad',
            types: [{ description: 'Modelo MiniCAD', accept: { 'application/json': ['.mcad'] } }],
          });
        }
        const w = await this.fileHandle.createWritable();
        await w.write(text);
        await w.close();
        this.docName = this.fileHandle.name.replace(/\.(mcad|json)$/i, '');
        this.dirty = false;
        this.updateTitle();
        this.doAutosave();
        toast('Guardado: ' + this.fileHandle.name);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn(err);
      }
    }
    downloadBlob(new Blob([text], { type: 'application/json' }), this.docName + '.mcad');
    this.dirty = false;
    this.updateTitle();
    toast('Descargado: ' + this.docName + '.mcad');
  }

  doAutosave() {
    if (!this.settings.autosave) return;
    const text = this.doc.toFile();
    if (text.length > 4.5e6) {
      if (!this._warnedAutosave) toast('El modelo es grande: guarda con Ctrl+S (el autoguardado no cabe)', 'warn');
      this._warnedAutosave = true;
      return;
    }
    storageSet('minicad.autosave', { text, name: this.docName, dirty: this.dirty });
  }

  restoreAutosave() {
    if (!this.settings.autosave) return;
    const a = storageGet('minicad.autosave');
    if (!a?.text) return;
    try {
      this.doc.fromFile(a.text);
      this.history.clear();
      this.docName = a.name || 'Sin título';
      this.dirty = !!a.dirty;
      if (this.doc.nodes.length) setTimeout(() => toast('Se recuperó tu último trabajo'), 400);
    } catch {
      this.doc.reset();
    }
  }

  async importFile() {
    const file = await pickFile('.stl,.obj,.dxf');
    if (!file) return;
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.dxf')) {
        const ents = dxfToEntities(await file.text());
        if (!ents.length) return toast('No se encontraron perfiles cerrados en el DXF', 'warn');
        if (this.mode === 'sketch') {
          this.sketcher.pushUndo();
          this.sketcher.entities.push(...ents);
          this.sketcher.changed();
        } else {
          this.startSketch({ plane: planeFrom(PLANES.top), entities: ents });
          this.sketcher.setTool('select');
        }
        toast(`${ents.length} perfiles importados del DXF. Pulsa Extruir para crear el sólido.`);
        return;
      }
      toast('Importando ' + file.name + '…');
      const arr = await importMeshFile(file, this.settings.stlZUp);
      const ref = 'm' + Date.now().toString(36);
      this.doc.meshStore.set(ref, arr);
      const node = this.doc.makeNode('mesh', {}, { meshRef: ref, name: file.name.replace(/\.[^.]+$/, '') });
      this.doc.nodes.push(node);
      this.selection = [node.id];
      this.commit('Importar');
      this.fitView();
      toast(`Importado: ${(arr.length / 9).toLocaleString('es')} triángulos`);
    } catch (err) {
      toast('No se pudo importar: ' + err.message, 'error');
    }
  }

  exportMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const items = [
      { label: 'STL (impresión 3D)', icon: 'export', action: () => this.exportMesh('stl') },
      { label: 'OBJ', icon: 'export', action: () => this.exportMesh('obj') },
      { sep: true },
      { label: 'Guardar como… (.mcad)', icon: 'save', action: () => this.saveDoc(true) },
    ];
    if (this.mode === 'sketch') items.splice(2, 0, { label: 'DXF del croquis (AutoCAD)', icon: 'dxf', action: () => this.exportSketchDXF() });
    this.showMenu(r.left, r.bottom + 4, items);
  }

  exportMesh(fmtName) {
    let nodes = this.topSelected();
    if (!nodes.length) nodes = this.doc.nodes.filter((n) => n.visible !== false);
    nodes = nodes.filter((n) => n.type !== 'ecomp');
    if (!nodes.length) return toast('No hay piezas sólidas visibles para exportar', 'warn');
    const items = nodes.map((n) => ({ geometry: this.sync.geometryFor(n), matrix: nodeMatrix(n) }));
    const base = nodes.length === 1 ? nodes[0].name : this.docName;
    const safe = base.replace(/[\\/:*?"<>|]+/g, '_');
    if (fmtName === 'stl') downloadBlob(exportSTL(items, this.settings.stlZUp), safe + '.stl');
    else downloadBlob(exportOBJ(items, nodes.map((n) => n.name)), safe + '.obj');
    toast(`Exportado ${nodes.length} cuerpo(s) a ${fmtName.toUpperCase()}`);
  }
}

// ---------------------------------------------------------------- helpers de UI
function $id(id) {
  return document.getElementById(id);
}

function section(title, ...children) {
  return h('div', { class: 'psection' }, h('div', { class: 'psec-title' }, title), h('div', { class: 'psec-body' }, ...children));
}

function info(label, value) {
  return h('div', { class: 'info' }, h('span', null, label), h('b', null, value));
}

function actionBtn(ic, label, fn, disabled = false) {
  return h('button', { class: 'abtn', onclick: fn, disabled, html: icon(ic, 16) + `<span>${label}</span>` });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
