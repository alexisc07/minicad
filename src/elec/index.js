// Módulo de electrónica y mecatrónica: une la biblioteca de componentes,
// los cables, el simulador y el panel de código con la aplicación.
import * as THREE from 'three';
import { PARTS, PART_ORDER, partDefaults, partPins, formatOhms } from './parts.js';
import { ElecLayer, autoWireColor, WIRE_COLORS, applyNodeTransform } from './layer.js';
import { Simulator } from './sim.js';
import { CodePanel } from './panel.js';
import { EXAMPLES, BLANK_CODE } from './examples.js';
import { defaultParams, setNodeMatrix } from '../geometry.js';
import { h, toast, evalNum } from '../util.js';
import { icon } from '../icons.js';

const OHM_PRESETS = [100, 220, 330, 470, 1000, 2200, 4700, 10000, 47000, 100000, 1000000];

function section(title, ...children) {
  return h('div', { class: 'psection' }, h('div', { class: 'psec-title' }, title), h('div', { class: 'psec-body' }, ...children));
}

function info(label, value) {
  return h('div', { class: 'info' }, h('span', null, label), h('b', null, value));
}

export class Electronics {
  constructor(app) {
    this.app = app;
    this.layer = new ElecLayer(app);
    this.sim = new Simulator(app, this.layer);
    this.panel = new CodePanel(this, EXAMPLES);
    this.sim.on('serial', (s) => this.panel.appendSerial(s));
    this.sim.on('error', (err) => {
      this.panel.showError(err);
      toast('Error en el programa' + (err.line ? ` (línea ${err.line})` : '') + ': ' + err.message, 'error', 6000);
    });
    this.sim.on('info', (m) => toast(m, 'warn', 4000));
    this.sim.on('start', () => {
      this.panel.setRunning(true);
      this.app.setHint('Simulando · Clic en botones e interruptores para accionarlos · Arrastra potenciómetros · F5 o el botón Detener para parar');
      this.app.renderRibbon();
      this.app.attachGizmo();
    });
    this.sim.on('stop', () => {
      this.panel.setRunning(false);
      this.app.setHint();
      this.app.renderRibbon();
    });
    this.sim.on('tick', () => this.updateLive());
    this.bindInteraction();
  }

  // ------------------------------------------------------------ integración con la escena
  sync() {
    const doc = this.app.doc;
    doc.wires ||= [];
    this.layer.sync();
    if (this.sim.running) {
      if (this.sim.arduino && !doc.get(this.sim.arduino.id)) this.sim.stop();
      else {
        this.sim.arduino = doc.nodes.find((n) => n.type === 'ecomp' && n.part === 'arduino') || null;
        this.sim.rebuild();
        this.sim.captureMounts();
      }
    }
    this.panel.refreshCode();
  }

  pickables() {
    return this.layer.pickables();
  }

  objectFor(id) {
    return this.layer.groups.get(id);
  }

  worldBox(id) {
    return this.layer.worldBox(id);
  }

  partInfo(node) {
    const def = PARTS[node.part];
    return { label: def?.label || 'Componente', icon: def?.icon || 'chip' };
  }

  makeNode(part, params) {
    const doc = this.app.doc;
    const def = PARTS[part];
    const key = 'part_' + part;
    doc.counters[key] = (doc.counters[key] || 0) + 1;
    return doc.makeNode('ecomp', params || partDefaults(part), {
      part,
      name: `${def.label} ${doc.counters[key]}`,
      color: def.color,
    });
  }

  ghost(part) {
    const node = { id: '__ghost', part, params: partDefaults(part) };
    const { group } = PARTS[part].build(node.params);
    group.traverse((o) => {
      if (o.material) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.6;
      }
    });
    const box = new THREE.Box3().setFromObject(group);
    group.userData.minY = box.min.y;
    return group;
  }

  pruneWires() {
    const doc = this.app.doc;
    doc.wires = (doc.wires || []).filter((w) => {
      const a = doc.get(w.a.n), b = doc.get(w.b.n);
      return a && b && partPins(a).some((p) => p.id === w.a.p) && partPins(b).some((p) => p.id === w.b.p);
    });
  }

  // ------------------------------------------------------------ cinta de opciones
  ribbonTab(T) {
    const sim = this.sim.running;
    const comp = (p) => T(PARTS[p].icon, shortLabel(p), `${PARTS[p].label}: clic en la escena para colocarlo`, () => this.app.startPlace(null, p));
    return {
      label: 'Electrónica',
      compact: true,
      groups: [
        { label: 'Placa', items: [comp('arduino')] },
        { label: 'Componentes', items: ['led', 'resistor', 'button', 'switch', 'pot', 'ldr', 'buzzer', 'ultrasonic', 'battery'].map(comp) },
        { label: 'Potencia y movimiento', items: ['servo', 'motor', 'npn', 'diode'].map(comp) },
        {
          label: 'Conexiones',
          items: [
            T('cable', 'Cable', 'Conectar pines con cables: clic en un pin y luego en otro', () => this.startWire(), { active: this.app.mode === 'wire' }),
            T('link', 'Acoplar', 'Acoplar la pieza seleccionada al brazo de un servo o al eje de un motor', (e) => this.mountMenu(e?.currentTarget), { disabled: !this.app.selection.length }),
          ],
        },
        {
          label: 'Programa',
          items: [
            T('code', 'Código', 'Editor del programa del Arduino', () => this.panel.toggle('code'), { active: this.panel.visible && this.panel.tab === 'code' }),
            T('serial', 'Monitor', 'Monitor serie (Serial.print)', () => this.panel.toggle('serial'), { active: this.panel.visible && this.panel.tab === 'serial' }),
            T('book', 'Ejemplos', 'Proyectos de ejemplo listos para simular', (e) => this.examplesMenu(e?.currentTarget)),
          ],
        },
        {
          label: 'Simulación',
          items: [T(sim ? 'stop' : 'play', sim ? 'Detener' : 'Simular', sim ? 'Detener la simulación (F5)' : 'Iniciar la simulación (F5)', () => this.toggleSim(), { primary: true, active: sim })],
        },
      ],
    };
  }

  toggleSim() {
    if (this.sim.running) this.sim.stop();
    else {
      if (this.app.mode !== 'select') this.app.cancelMode();
      this.app.commit('Editar código');
      this.panel.clearError();
      if (this.sim.start() && this.app.doc.code?.trim() && !this.panel.visible) this.panel.open('serial');
    }
  }

  examplesMenu(anchor) {
    const r = anchor?.getBoundingClientRect() || { left: 200, bottom: 120 };
    this.app.showMenu(r.left, r.bottom + 4, EXAMPLES.map((x) => ({ label: x.label, icon: 'book', action: () => this.loadExample(x.id) })));
  }

  async loadExample(id) {
    const ex = EXAMPLES.find((x) => x.id === id);
    if (!ex) return;
    const app = this.app;
    if (app.doc.nodes.length && !(await app.confirm('Abrir ejemplo', `Se reemplazará el modelo actual por el ejemplo "${ex.label}". ¿Continuar?`, 'Abrir ejemplo'))) return;
    this.sim.stop();
    if (app.mode !== 'select') app.cancelMode();
    const doc = app.doc;
    doc.reset();
    const api = {
      add: (part, params, pos, rot) => {
        const n = this.makeNode(part, { ...partDefaults(part), ...params });
        n.pos = pos;
        if (rot) n.rot = rot;
        doc.nodes.push(n);
        return n;
      },
      wire: (a, pa, b, pb, color) => {
        doc.wires.push({ id: doc.newId(), a: { n: a.id, p: pa }, b: { n: b.id, p: pb }, color: color || autoWireColor(pa, pb, doc.wires.length) });
      },
      body: (type, params, pos, name, color, rot) => {
        const n = doc.makeNode(type, { ...defaultParams(type), ...params });
        n.pos = pos;
        if (rot) n.rot = rot;
        n.name = name;
        n.color = color;
        doc.nodes.push(n);
        return n;
      },
      mount: (body, actuator) => (body.mount = { to: actuator.id }),
    };
    ex.build(api);
    doc.code = ex.code;
    app.history.clear();
    app.selection = [];
    app.docName = ex.label;
    app.fileHandle = null;
    app.dirty = false;
    this.panel.clearSerial();
    app.tab = 'electronica';
    app.refresh();
    this.panel.refreshCode();
    this.panel.open('code');
    // Encuadra cuando el visor ya se ha reducido para dejar sitio al panel
    await new Promise((r) => setTimeout(r, 60));
    app.viewer.resize();
    app.viewer.fit(app.viewer.sceneBox(), new THREE.Vector3(0.9, 1.1, 1.2), 0.95);
    app.doAutosave();
    toast(`Ejemplo "${ex.label}" listo: pulsa Simular`);
  }

  // ------------------------------------------------------------ cables
  startWire() {
    const app = this.app;
    if (app.mode === 'wire') return app.cancelMode();
    if (app.mode !== 'select') app.cancelMode();
    if (!this.layer.groups.size) return toast('Primero coloca algún componente', 'warn');
    app.mode = 'wire';
    app.select(null);
    this.layer.setWireStart(null);
    app.setHint('Cable: clic en un pin y después en otro · Esc: cancelar');
    app.renderRibbon();
  }

  wireHover(e) {
    const pin = this.layer.nearestPin(e);
    const extra = this.layer.wireStart ? (pin ? 'Clic para conectar' : '') : pin ? 'Clic para empezar el cable' : '';
    this.layer.showPinTip(pin, extra);
    this.layer.updateRubber(e, pin);
  }

  wireClick(e) {
    const pin = this.layer.nearestPin(e);
    if (!pin) return;
    const start = this.layer.wireStart;
    if (!start) return this.layer.setWireStart(pin);
    if (start.n === pin.n && start.p === pin.p) return this.layer.setWireStart(null);
    const doc = this.app.doc;
    doc.wires ||= [];
    const dup = doc.wires.some((w) => (w.a.n === start.n && w.a.p === start.p && w.b.n === pin.n && w.b.p === pin.p) || (w.b.n === start.n && w.b.p === start.p && w.a.n === pin.n && w.a.p === pin.p));
    if (!dup) doc.wires.push({ id: doc.newId(), a: { n: start.n, p: start.p }, b: { n: pin.n, p: pin.p }, color: autoWireColor(start.p, pin.p, doc.wires.length) });
    this.layer.setWireStart(null);
    this.app.commit('Cable');
    this.layer.showPinTip(pin, 'Conectado');
  }

  wireEscape() {
    if (this.layer.wireStart) {
      this.layer.setWireStart(null);
      return true;
    }
    return false;
  }

  wireLabel(end) {
    const n = this.app.doc.get(end.n);
    const pin = n && partPins(n).find((p) => p.id === end.p);
    return `${n?.name || '?'} · ${pin?.label || end.p}`;
  }

  wireProps(id) {
    const doc = this.app.doc;
    const w = doc.wires.find((x) => x.id === id);
    if (!w) return null;
    return [
      h('div', { class: 'ptitle' }, h('span', { style: { color: w.color }, html: icon('cable', 18) }), h('span', null, 'Cable')),
      section(
        'Conexión',
        info('Desde', this.wireLabel(w.a)),
        info('Hasta', this.wireLabel(w.b)),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'flab' }, 'Color'),
          h('div', { class: 'swatches' }, WIRE_COLORS.map(([c, l]) => h('button', { class: 'sw' + (c === w.color ? ' on' : ''), style: { background: c }, title: l, onclick: () => { w.color = c; this.app.commit('Color del cable'); } })))
        ),
        h('button', { class: 'wide danger', onclick: () => this.deleteWire(id), html: icon('trash', 16) + ' Eliminar cable' })
      ),
    ];
  }

  deleteWire(id) {
    const doc = this.app.doc;
    doc.wires = doc.wires.filter((w) => w.id !== id);
    this.layer.selectWire(null);
    this.app.commit('Eliminar cable');
  }

  // ------------------------------------------------------------ acoplamientos mecánicos
  actuators(excludeId) {
    // Evita ciclos: no se ofrece un actuador que ya cuelga (directa o indirectamente) de la pieza
    const doc = this.app.doc;
    const dependsOn = (id, target) => {
      const seen = new Set();
      let cur = doc.get(id)?.mount?.to;
      while (cur && !seen.has(cur)) {
        if (cur === target) return true;
        seen.add(cur);
        cur = doc.get(cur)?.mount?.to;
      }
      return false;
    };
    return doc.nodes.filter((n) => n.type === 'ecomp' && PARTS[n.part]?.actuator && n.id !== excludeId && !dependsOn(n.id, excludeId));
  }

  mountMenu(anchor) {
    const tops = this.app.topSelected();
    if (!tops.length) return toast('Selecciona la pieza que quieres acoplar', 'warn');
    const acts = this.actuators(tops[0].id);
    if (!acts.length) return toast('Añade un servo o un motor para acoplar piezas', 'warn');
    const r = anchor?.getBoundingClientRect() || { left: 300, bottom: 120 };
    this.app.showMenu(r.left, r.bottom + 4, [
      ...acts.map((a) => ({ label: `${a.name} (${PARTS[a.part].actuator === 'servo' ? 'brazo' : 'eje'})`, icon: PARTS[a.part].icon, action: () => this.setMount(tops, a.id) })),
      { sep: true },
      { label: 'Desacoplar', icon: 'x', action: () => this.setMount(tops, null) },
    ]);
  }

  setMount(nodes, toId) {
    for (const n of nodes) {
      if (n.id === toId) continue;
      if (toId) n.mount = { to: toId };
      else delete n.mount;
    }
    this.app.commit(toId ? 'Acoplar' : 'Desacoplar');
    if (toId) toast('Pieza acoplada: se moverá con el actuador al simular');
  }

  mountSection(node) {
    const acts = this.actuators(node.id);
    if (!acts.length && !node.mount) return null;
    const opts = [['', '— Ninguno —'], ...acts.map((a) => [a.id, `${a.name} (${PARTS[a.part].actuator === 'servo' ? 'brazo' : 'eje'})`])];
    return section(
      'Mecatrónica',
      this.app.selectField('Acoplado a', node.mount?.to || '', opts, (v) => this.setMount([node], v || null)),
      h('p', { class: 'muted small' }, 'Una pieza acoplada gira con el brazo del servo o el eje del motor durante la simulación.')
    );
  }

  // ------------------------------------------------------------ propiedades
  propSections(node) {
    const app = this.app;
    const def = PARTS[node.part];
    const out = [];
    if (def.info) out.push(h('p', { class: 'muted small pad pinfo' }, def.info));
    // Parámetros
    const fields = def.params.map(([k, label, , kind, options]) => {
      const set = (v) => {
        node.params = { ...node.params, [k]: v };
        app.commit('Editar ' + label.toLowerCase());
      };
      if (kind === 'select') return app.selectField(label, String(node.params[k]), options, (v) => set(isNaN(+v) || k === 'model' || k === 'color' || k === 'kind' ? v : +v));
      if (kind === 'ohms') {
        const cur = +node.params[k];
        return h(
          'div',
          { class: 'col' },
          app.numField(label, cur, (v) => set(Math.max(0.1, v)), { key: 'p_' + k, min: 0.1, unit: 'Ω' }),
          app.selectField('Valor común', OHM_PRESETS.includes(cur) ? String(cur) : '', [['', '—'], ...OHM_PRESETS.map((v) => [String(v), formatOhms(v)])], (v) => v && set(+v))
        );
      }
      return app.numField(label, +node.params[k], (v) => set(v), { key: 'p_' + k, min: 0.1 });
    });
    if (fields.length) out.push(section('Características', ...fields));

    // Controles interactivos
    const ctl = this.controls(node);
    if (ctl) out.push(ctl);

    // Lecturas en vivo
    this.liveEl = h('div', { class: 'live' });
    this.liveId = node.id;
    out.push(section(this.sim.running ? 'Medidas (en vivo)' : 'Medidas', this.liveEl));
    this.updateLive();

    // Conexiones
    const pins = partPins(node);
    const wires = this.app.doc.wires || [];
    const rows = pins
      .filter((p) => node.part !== 'arduino' || wires.some((w) => (w.a.n === node.id && w.a.p === p.id) || (w.b.n === node.id && w.b.p === p.id)))
      .map((p) => {
        const conns = wires
          .filter((w) => (w.a.n === node.id && w.a.p === p.id) || (w.b.n === node.id && w.b.p === p.id))
          .map((w) => this.wireLabel(w.a.n === node.id && w.a.p === p.id ? w.b : w.a));
        return h('div', { class: 'pinrow' + (conns.length ? '' : ' free') }, h('b', null, p.label), h('span', null, conns.join(', ') || 'sin conectar'));
      });
    out.push(section('Conexiones', ...(rows.length ? rows : [h('p', { class: 'muted small' }, 'Sin cables. Usa la herramienta Cable.')]), h('button', { class: 'wide', onclick: () => this.startWire(), html: icon('cable', 16) + ' Conectar cables' })));
    if (node.part === 'arduino') {
      out.push(section('Programa', h('div', { class: 'btnrow' }, h('button', { class: 'abtn', onclick: () => this.panel.open('code'), html: icon('code', 16) + '<span>Editar código</span>' }), h('button', { class: 'abtn', onclick: () => this.toggleSim(), html: icon(this.sim.running ? 'stop' : 'play', 16) + `<span>${this.sim.running ? 'Detener' : 'Simular'}</span>` }))));
    }
    return out;
  }

  // Estado controlable por el usuario (potenciómetro, luz, botón, interruptor)
  controlState(id) {
    if (this.sim.running) return this.sim.state.get(id) || {};
    this.sim.keptState ||= new Map();
    if (!this.sim.keptState.has(id)) {
      const n = this.app.doc.get(id);
      this.sim.keptState.set(id, { ...(PARTS[n.part].state?.() || {}) });
    }
    return this.sim.keptState.get(id);
  }

  setControl(id, values) {
    if (this.sim.running) this.sim.interact(id, 'set', values);
    else Object.assign(this.controlState(id), values);
  }

  controls(node) {
    const st = this.controlState(node.id);
    const slider = (label, key, fmt) => {
      const val = h('b', null, fmt(st[key] ?? 0.5));
      const inp = h('input', { type: 'range', min: 0, max: 1000, value: Math.round((st[key] ?? 0.5) * 1000) });
      inp.addEventListener('input', () => {
        const v = inp.value / 1000;
        this.setControl(node.id, { [key]: v });
        val.textContent = fmt(v);
      });
      return h('div', { class: 'slider' }, h('div', { class: 'info' }, h('span', null, label), val), inp);
    };
    if (node.part === 'pot') return section('Control', slider('Posición del mando', 'pos', (v) => `${Math.round(v * 100)} %`));
    if (node.part === 'ldr') return section('Control', slider('Luz ambiente', 'light', (v) => (v < 0.15 ? 'Oscuro' : v > 0.85 ? 'Mucha luz' : `${Math.round(v * 100)} %`)));
    if (node.part === 'switch') return section('Control', this.app.checkField('Encendido', !!st.on, (v) => this.setControl(node.id, { on: v })));
    if (node.part === 'button') {
      const b = h('button', { class: 'wide' }, 'Mantener pulsado');
      b.addEventListener('pointerdown', () => this.setControl(node.id, { pressed: true }));
      const up = () => this.setControl(node.id, { pressed: false });
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      return section('Control', b);
    }
    return null;
  }

  updateLive() {
    const el = this.liveEl;
    if (!el || !el.isConnected) return;
    const rows = this.sim.readings(this.liveId);
    if (!rows) {
      el.replaceChildren(h('p', { class: 'muted small' }, 'Pulsa Simular para ver tensiones, corrientes y movimiento en tiempo real.'));
      return;
    }
    el.replaceChildren(...rows.map(([a, b]) => info(a, b)));
  }

  // ------------------------------------------------------------ interacción con el ratón durante la simulación
  bindInteraction() {
    const cv = this.app.viewer.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.sim.running || this.app.mode !== 'select' || e.button !== 0) return;
      const hit = this.app.viewer.pick(e, this.layer.pickables());
      if (!hit) return;
      const id = hit.object.userData.nodeId;
      const node = this.app.doc.get(id);
      const kind = PARTS[node?.part]?.interactive;
      if (!kind) return;
      this.app.viewer.controls.enabled = false;
      this.app.down = null;
      this.app.suppressClick = true;
      if (kind === 'press') this.sim.interact(id, 'press', true);
      if (kind === 'toggle') this.sim.interact(id, 'toggle');
      const key = node.part === 'pot' ? 'pos' : 'light';
      const start = { y: e.clientY, v: this.sim.state.get(id)?.[key] ?? 0.5 };
      const move = (ev) => {
        if (kind === 'drag') this.sim.interact(id, 'set', { [key]: Math.min(1, Math.max(0, start.v + (start.y - ev.clientY) / 200)) });
      };
      const up = () => {
        if (kind === 'press') this.sim.interact(id, 'press', false);
        this.app.viewer.controls.enabled = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (this.liveId === id) this.app.renderProps();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        if (!this.sim.running) return;
        const hit = this.app.viewer.pick(e, this.layer.pickables());
        const node = hit && this.app.doc.get(hit.object.userData.nodeId);
        if (!node || PARTS[node.part]?.interactive !== 'drag') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const key = node.part === 'pot' ? 'pos' : 'light';
        const v = this.sim.state.get(node.id)?.[key] ?? 0.5;
        this.sim.interact(node.id, 'set', { [key]: Math.min(1, Math.max(0, v - Math.sign(e.deltaY) * 0.05)) });
      },
      { capture: true, passive: false }
    );
  }
}

function shortLabel(p) {
  return { arduino: 'Arduino', ultrasonic: 'Distancia', ldr: 'Luz', npn: 'Transistor', pot: 'Potenc.', servo: 'Servo', battery: 'Batería', switch: 'Interrup.', button: 'Pulsador', resistor: 'Resist.', buzzer: 'Zumbador', motor: 'Motor' }[p] || PARTS[p].label;
}

export { BLANK_CODE, PART_ORDER };
