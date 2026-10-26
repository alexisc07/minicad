// Simulador de mecatrónica: ejecuta el programa del Arduino, resuelve el
// circuito y mueve los actuadores (y las piezas acopladas a ellos).
import * as THREE from 'three';
import { PARTS, partPins } from './parts.js';
import { buildNets, solve, elementCurrent } from './circuit.js';
import { createRuntime } from './arduino.js';
import { nodeMatrix } from '../geometry.js';
import { toast } from '../util.js';

const pinId = (i) => (i < 14 ? 'D' + i : 'A' + (i - 14));

export class Simulator {
  constructor(app, layer) {
    this.app = app;
    this.layer = layer;
    this.running = false;
    this.listeners = {};
  }

  on(evt, fn) {
    (this.listeners[evt] ||= []).push(fn);
  }

  emit(evt, ...a) {
    for (const fn of this.listeners[evt] || []) fn(...a);
  }

  comps() {
    return this.app.doc.nodes.filter((n) => n.type === 'ecomp');
  }

  // ------------------------------------------------------------ control
  start() {
    if (this.running) return;
    const comps = this.comps();
    if (!comps.length) {
      toast('Añade componentes desde la pestaña Electrónica antes de simular.', 'warn');
      return false;
    }
    this.running = true;
    this.t0 = performance.now();
    this.warned = new Set();
    this.state = new Map(); // id -> estado de simulación
    for (const n of comps) this.state.set(n.id, { ...(PARTS[n.part].state?.() || {}), ...(this.keptState?.get(n.id) || {}) });
    this.arduino = comps.find((n) => n.part === 'arduino') || null;
    this.pins = { mode: new Array(20).fill(0), out: new Array(20).fill(0), pwm: new Array(20).fill(null) };
    this.servoTargets = new Map(); // pin -> ángulo
    this.tones = new Map(); // pin -> {f, until}
    this.trigTime = new Map(); // pin -> último disparo
    this.angles = new Map();
    for (const n of comps) {
      const def = PARTS[n.part];
      if (def.restAngle != null) this.angles.set(n.id, def.restAngle);
    }
    this.rebuild();
    this.captureMounts();
    this.startAudio();
    this.dirty = true;
    this.solveNow();

    if (this.arduino && this.app.doc.code?.trim()) {
      try {
        this.runtime = createRuntime(this.app.doc.code, this.hw());
        this.runtime.run((err) => this.emit('error', err));
      } catch (err) {
        this.emit('error', err);
      }
    } else if (this.arduino) this.emit('info', 'El Arduino no tiene programa: escribe uno en la pestaña Código.');
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.frame(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.emit('start');
    return true;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.runtime?.stop();
    this.runtime = null;
    this.stopAudio();
    // Conserva la posición de potenciómetros, luz e interruptores entre simulaciones
    this.keptState = new Map();
    for (const [id, st] of this.state) this.keptState.set(id, { pos: st.pos, light: st.light, on: st.on });
    this.layer.resetVisuals();
    for (const b of this.beams?.values() || []) this.layer.overlay.remove(b);
    this.beams = new Map();
    this.emit('stop');
    this.app.refresh();
  }

  // Reconstruye la red (al iniciar o si cambia el circuito durante la simulación)
  rebuild() {
    const comps = this.comps();
    for (const n of comps) if (!this.state.has(n.id)) this.state.set(n.id, { ...(PARTS[n.part].state?.() || {}) });
    // Cables + patas insertadas en la protoboard
    this.nets = buildNets(comps, [...(this.app.doc.wires || []), ...this.layer.contacts()]);
    this.netKey = (id, pin) => this.nets.netOf.get(`${id}:${pin}`);
    const gnd = this.arduino ? this.netKey(this.arduino.id, 'GND') : comps.filter((n) => n.part === 'battery').map((n) => this.netKey(n.id, '-'))[0];
    this.ref = gnd ?? 0;
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  // ------------------------------------------------------------ circuito
  elements(phase) {
    const els = [];
    const comps = this.comps();
    for (const n of comps) {
      const def = PARTS[n.part];
      const st = this.state.get(n.id) || {};
      if (n.part === 'led' && st.burnt) continue;
      const list = def.elements?.(n.params || {}, st) || [];
      for (const e of list) {
        const el = { ...e, node: n.id };
        let ok = true;
        for (const key of ['a', 'b', 'c', 'p', 'n', 'e']) {
          if (key in e && !(e.k === 'Q' && key === 'b' && false)) {
            const net = this.netKey(n.id, e[key]);
            if (net == null) ok = false;
            el[key] = net;
          }
        }
        if (e.k === 'Q') {
          el.b = this.netKey(n.id, e.b);
          el.c = this.netKey(n.id, e.c);
          el.e = this.netKey(n.id, e.e);
          ok = el.b != null && el.c != null && el.e != null;
        }
        if (ok) els.push(el);
      }
    }
    // Arduino: alimentación (USB) y pines
    if (this.arduino) {
      const id = this.arduino.id;
      const gnd = this.netKey(id, 'GND');
      els.push({ k: 'V', p: this.netKey(id, '5V'), n: gnd, v: 5, r: 0.05, node: id, tag: 'usb5v' });
      els.push({ k: 'V', p: this.netKey(id, '3V3'), n: gnd, v: 3.3, r: 0.5, node: id, tag: 'usb3v3' });
      for (let i = 0; i < 20; i++) {
        const net = this.netKey(id, pinId(i));
        if (net == null) continue;
        const mode = this.pins.mode[i];
        if (mode === 1) {
          const duty = this.pins.pwm[i];
          let v = this.pins.out[i] * 5;
          if (duty != null) v = duty >= 1 ? 5 : duty <= 0 ? 0 : phase === 'low' ? 0 : 5;
          els.push({ k: 'V', p: net, n: gnd, v, r: 25, node: id, tag: 'pin', pin: i });
        } else if (mode === 2) els.push({ k: 'V', p: net, n: gnd, v: 5, r: 35000, node: id, tag: 'pullup', pin: i });
      }
    }
    return els;
  }

  solveNow() {
    if (!this.dirty || !this.running) return;
    this.dirty = false;
    const n = this.nets.count;
    const pwmPins = [];
    for (let i = 0; i < 20; i++) {
      const d = this.pins.pwm[i];
      if (this.pins.mode[i] === 1 && d != null && d > 0 && d < 1) pwmPins.push(i);
    }
    const hi = this.elements('high');
    const vHi = solve(n, this.ref, hi);
    let lo = null, vLo = null;
    const netW = new Float64Array(n).fill(1); // peso de la fase "alta" en cada net
    if (pwmPins.length && this.arduino) {
      lo = this.elements('low');
      vLo = solve(n, this.ref, lo);
      netW.fill(-1);
      // Propagación de la influencia de cada pin PWM por el circuito
      const adj = Array.from({ length: n }, () => []);
      const supplies = new Set([this.ref]);
      for (const el of hi) if (el.k === 'V' && el.tag !== 'pin') supplies.add(el.p);
      for (const el of hi) {
        const ns = [el.a, el.b, el.c, el.e].filter((x) => x != null);
        if (el.k === 'V') continue;
        for (const x of ns) for (const y of ns) if (x !== y) adj[x].push(y);
      }
      for (const pin of pwmPins) {
        const start = this.netKey(this.arduino.id, pinId(pin));
        const duty = this.pins.pwm[pin];
        const seen = new Set([start]);
        const q = [start];
        while (q.length) {
          const x = q.shift();
          netW[x] = Math.max(netW[x], duty);
          for (const y of adj[x]) if (!seen.has(y) && !supplies.has(y)) {
            seen.add(y);
            q.push(y);
          }
        }
      }
    }
    // netW < 0: net sin influencia de ningún PWM (se usa la fase alta)
    this.v = new Float64Array(n);
    for (let i = 0; i < n; i++) this.v[i] = vLo && netW[i] >= 0 ? netW[i] * vHi[i] + (1 - netW[i]) * vLo[i] : vHi[i];
    this.computeOutputs(hi, vHi, lo, vLo, netW);
  }

  computeOutputs(hi, vHi, lo, vLo, netW) {
    const out = new Map();
    const get = (id) => {
      let o = out.get(id);
      if (!o) out.set(id, (o = {}));
      return o;
    };
    const mix = (el, idx, fn) => {
      const a = fn(hi[idx], vHi);
      if (!lo) return a;
      const ws = [el.a, el.b, el.c, el.p, el.n, el.e].filter((x) => x != null).map((x) => netW[x]).filter((w) => w >= 0);
      if (!ws.length) return a;
      const w = Math.max(...ws);
      return w * a + (1 - w) * fn(lo[idx], vLo);
    };
    hi.forEach((el, idx) => {
      const o = get(el.node);
      const cur = mix(el, idx, (e, v) => elementCurrent(e, v));
      const vab = mix(el, idx, (e, v) => (e.k === 'V' ? v[e.p] - v[e.n] : e.k === 'Q' ? v[e.c] - v[e.e] : v[e.a] - v[e.b ?? e.c]));
      switch (el.tag) {
        case 'led':
          o.i = cur;
          break;
        case 'motor':
          o.v = vab;
          o.i = cur;
          break;
        case 'supply':
          o.vs = vab;
          break;
        case 'buzzer':
          o.v = vab;
          break;
        case 'battery':
          o.i = cur;
          break;
        case 'usb5v':
          o.i5 = cur;
          break;
        case 'pin':
          (o.pinI ||= {})[el.pin] = Math.abs(cur);
          break;
      }
      if (el.k === 'Q') o.ic = cur;
    });
    this.outputs = out;
    this.checkWarnings();
  }

  checkWarnings() {
    const warn = (key, msg) => {
      if (this.warned.has(key)) return;
      this.warned.add(key);
      toast(msg, 'warn', 5000);
      this.emit('warning', msg);
    };
    for (const n of this.comps()) {
      const o = this.outputs.get(n.id) || {};
      const st = this.state.get(n.id);
      if (n.part === 'led' && o.i > 0.04 && !st.burnt) {
        st.burnt = true;
        this.dirty = true;
        warn('led' + n.id, `${n.name} se ha quemado (${(o.i * 1000).toFixed(0)} mA). Pon una resistencia en serie de 220 Ω o más.`);
      }
      if (n.part === 'arduino') {
        for (const [pin, cur] of Object.entries(o.pinI || {})) {
          if (cur > 0.04) warn('pin' + pin, `El pin ${pinId(+pin)} entrega ${(cur * 1000).toFixed(0)} mA: el máximo es 40 mA y podría dañarse. Usa un transistor o una resistencia.`);
        }
        if (o.i5 > 0.5) warn('5v', `Consumo de ${(o.i5 * 1000).toFixed(0)} mA en el pin 5V: parece un cortocircuito o demasiada carga.`);
      }
      if (n.part === 'battery' && o.i > 3) warn('bat' + n.id, `${n.name}: cortocircuito (${o.i.toFixed(1)} A).`);
    }
  }

  netVoltage(net) {
    this.solveNow();
    return net == null ? 0 : this.v?.[net] ?? 0;
  }

  // ------------------------------------------------------------ interfaz con el programa
  hw() {
    const sim = this;
    const ard = () => sim.arduino;
    const pinNet = (p) => (ard() ? sim.netKey(ard().id, pinId(p)) : null);
    return {
      speed: () => 1,
      now: () => performance.now() - sim.t0,
      serialBegin: () => {},
      serialWrite: (s) => {
        sim.txAt = performance.now();
        sim.emit('serial', s);
      },
      pinMode(p, m) {
        sim.pins.mode[p] = m === 1 ? 1 : m === 2 ? 2 : 0;
        if (m !== 1) sim.pins.pwm[p] = null;
        sim.dirty = true;
      },
      digitalWrite(p, v) {
        if (sim.pins.mode[p] !== 1) {
          // En Arduino, escribir HIGH en una entrada activa la resistencia pull-up
          sim.pins.mode[p] = v ? 2 : 0;
        }
        sim.pins.out[p] = v;
        sim.pins.pwm[p] = null;
        if (v) sim.trigTime.set(pinNet(p), performance.now());
        sim.dirty = true;
      },
      digitalRead(p) {
        if (sim.pins.mode[p] === 1) return sim.pins.out[p];
        return sim.netVoltage(pinNet(p)) > 2.5 ? 1 : 0;
      },
      analogRead(p) {
        const v = sim.netVoltage(pinNet(p));
        return Math.max(0, Math.min(1023, Math.round((v / 5) * 1023)));
      },
      analogWrite(p, val) {
        sim.pins.mode[p] = 1;
        const pwm = [3, 5, 6, 9, 10, 11].includes(p);
        if (!pwm || val === 0 || val === 255) {
          sim.pins.pwm[p] = null;
          sim.pins.out[p] = val >= 128 ? 1 : 0;
        } else sim.pins.pwm[p] = val / 255;
        sim.dirty = true;
      },
      servoAttach() {},
      servoWrite(p, angle) {
        sim.servoTargets.set(pinNet(p), angle);
      },
      tone(p, f, d) {
        sim.tones.set(pinNet(p), { f, until: d ? performance.now() + Number(d) : Infinity });
      },
      noTone(p) {
        sim.tones.delete(pinNet(p));
      },
      pulseIn(p, state, timeout) {
        return sim.pulseIn(pinNet(p), timeout);
      },
    };
  }

  pulseIn(net, timeout) {
    for (const n of this.comps()) {
      if (n.part !== 'ultrasonic' || this.netKey(n.id, 'ECHO') !== net) continue;
      const powered = (this.outputs.get(n.id)?.vs || 0) > 4.2;
      const trig = this.trigTime.get(this.netKey(n.id, 'TRIG'));
      if (!powered || !trig || performance.now() - trig > 200) continue;
      const d = this.measure(n);
      this.state.get(n.id).dist = d;
      this.state.get(n.id).pingAt = performance.now();
      return d == null ? 38000 : Math.round((d / 10) * 58.2);
    }
    return 0;
  }

  // Distancia (mm) desde el sensor hasta la pieza más cercana delante de él
  measure(n) {
    const g = this.layer.groups.get(n.id);
    const beam = PARTS.ultrasonic.beam;
    g.updateMatrixWorld();
    const o = new THREE.Vector3(...beam.origin).applyMatrix4(g.matrixWorld);
    const d = new THREE.Vector3(...beam.dir).transformDirection(g.matrixWorld);
    const rc = new THREE.Raycaster(o, d, 20, 4000);
    const own = new Set();
    g.traverse((x) => own.add(x));
    const targets = [...this.app.sync.pickables()].filter((m) => !own.has(m));
    const hit = rc.intersectObjects(targets, false)[0];
    return hit ? hit.distance : null;
  }

  // ------------------------------------------------------------ interacción del usuario
  interact(nodeId, action, value) {
    const n = this.app.doc.get(nodeId);
    const st = this.state?.get(nodeId);
    if (!n || !st) return;
    if (action === 'press') st.pressed = value;
    if (action === 'toggle') st.on = !st.on;
    if (action === 'set') Object.assign(st, value);
    this.dirty = true;
    this.emit('interact', nodeId);
  }

  // ------------------------------------------------------------ piezas acopladas
  captureMounts() {
    const doc = this.app.doc;
    this.mounts = new Map();
    for (const n of doc.nodes) {
      const to = n.mount?.to && doc.get(n.mount.to);
      if (!to || to.type !== 'ecomp' || !PARTS[to.part]?.partMatrix) continue;
      const def = PARTS[to.part];
      const rest = nodeMatrix(to).multiply(def.partMatrix(def.restAngle));
      this.mounts.set(n.id, { to: to.id, rel: rest.invert().multiply(nodeMatrix(n)) });
    }
    // Evita ciclos
    for (const id of this.mounts.keys()) {
      const seen = new Set([id]);
      let cur = this.mounts.get(id)?.to;
      while (cur && this.mounts.has(cur)) {
        if (seen.has(cur)) {
          this.mounts.delete(id);
          break;
        }
        seen.add(cur);
        cur = this.mounts.get(cur).to;
      }
    }
    this.movingWires = new Set();
    const moving = new Set(this.mounts.keys());
    for (const w of doc.wires || []) if (moving.has(w.a.n) || moving.has(w.b.n)) this.movingWires.add(w.id);
  }

  worldOf(id, memo) {
    if (memo.has(id)) return memo.get(id);
    const node = this.app.doc.get(id);
    const m = this.mounts.get(id);
    let w;
    if (m) {
      const to = this.app.doc.get(m.to);
      const def = PARTS[to.part];
      w = this.worldOf(m.to, memo).clone().multiply(def.partMatrix(this.angles.get(m.to) ?? def.restAngle)).multiply(m.rel);
    } else w = nodeMatrix(node);
    memo.set(id, w);
    return w;
  }

  applyMounts() {
    if (!this.mounts.size) return;
    const memo = new Map();
    for (const id of this.mounts.keys()) {
      const obj = this.app.sync.objectFor(id);
      if (!obj) continue;
      this.worldOf(id, memo).decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrix();
      obj.updateMatrixWorld(true);
    }
    if (this.movingWires.size) this.layer.syncWires(this.movingWires);
  }

  // ------------------------------------------------------------ sonido
  startAudio() {
    try {
      this.audio = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.audio.createGain();
      this.master.gain.value = 0.05;
      this.master.connect(this.audio.destination);
    } catch {
      this.audio = null;
    }
    this.voices = new Map();
  }

  stopAudio() {
    for (const v of this.voices?.values() || []) v.osc.stop();
    this.voices = new Map();
    this.audio?.close();
    this.audio = null;
  }

  voice(id, freq) {
    if (!this.audio) return;
    let v = this.voices.get(id);
    if (freq > 0) {
      if (!v) {
        const osc = this.audio.createOscillator();
        const g = this.audio.createGain();
        osc.type = 'square';
        osc.connect(g);
        g.connect(this.master);
        osc.start();
        v = { osc, g };
        this.voices.set(id, v);
      }
      v.osc.frequency.setTargetAtTime(freq, this.audio.currentTime, 0.005);
      v.g.gain.setTargetAtTime(1, this.audio.currentTime, 0.005);
    } else if (v) v.g.gain.setTargetAtTime(0, this.audio.currentTime, 0.005);
  }

  // ------------------------------------------------------------ fotograma
  frame(dt) {
    this.solveNow();
    const now = performance.now();
    for (const [net, t] of this.tones) if (t.until < now) this.tones.delete(net);
    for (const n of this.comps()) {
      const g = this.layer.groups.get(n.id);
      if (!g) continue;
      const parts = g.userData.parts;
      const o = this.outputs.get(n.id) || {};
      const st = this.state.get(n.id) || {};
      switch (n.part) {
        case 'led': {
          const c = new THREE.Color(parts.dome.color);
          const k = st.burnt ? 0 : Math.min(1, Math.max(0, (o.i || 0) / 0.012));
          parts.dome.emissive.copy(c).multiplyScalar(k * 0.95);
          if (st.burnt) parts.dome.color.setHex(0x333333);
          this.halo(g, k, c);
          break;
        }
        case 'arduino': {
          parts.ledOn.emissive.setHex(0x22ff44);
          const on13 = this.pins.mode[13] === 1 && (this.pins.out[13] || (this.pins.pwm[13] ?? 0) > 0.5);
          parts.ledL.emissive.setHex(on13 ? 0xffb020 : 0x000000);
          parts.ledTX?.emissive.setHex(now - (this.txAt || 0) < 70 ? 0xffb020 : 0x000000);
          parts.ledRX?.emissive.setHex(now - (this.rxAt || 0) < 70 ? 0xffb020 : 0x000000);
          break;
        }
        case 'servo': {
          const powered = (o.vs || 0) > 4;
          const target = this.servoTargets.get(this.netKey(n.id, 'SIG'));
          let a = this.angles.get(n.id) ?? 90;
          if (powered && target != null) {
            const step = 600 * dt;
            a = Math.abs(target - a) <= step ? target : a + Math.sign(target - a) * step;
            this.angles.set(n.id, a);
          }
          st.angle = a;
          st.powered = powered;
          this.layer.setActuatorAngle(n.id, a);
          break;
        }
        case 'motor': {
          const p = n.params || {};
          const rpm = ((o.v || 0) / (+p.vn || 6)) * (+p.rpm || 200);
          st.rpm = Math.abs(rpm) < 1 ? 0 : rpm;
          const a = ((this.angles.get(n.id) ?? 0) + st.rpm * 6 * dt) % 360;
          this.angles.set(n.id, a);
          this.layer.setActuatorAngle(n.id, a);
          break;
        }
        case 'button':
          parts.cap.position.y = st.pressed ? 4.9 : 5.5;
          break;
        case 'switch':
          parts.knob.position.x = st.on ? 1.5 : -1.5;
          break;
        case 'pot':
          parts.knob.rotation.y = (0.5 - (st.pos ?? 0.5)) * 270 * (Math.PI / 180);
          break;
        case 'buzzer': {
          const active = n.params?.kind === 'activo';
          let f = 0;
          if (active) f = (o.v || 0) > 2.5 ? 2300 : 0;
          else {
            const t = this.tones.get(this.netKey(n.id, '+'));
            if (t) f = t.f;
          }
          st.freq = f;
          this.voice(n.id, f);
          break;
        }
        case 'ultrasonic':
          this.updateBeam(n, g, st);
          break;
      }
    }
    this.applyMounts();
    this.app.viewer.render();
    this.frameCount = (this.frameCount || 0) + 1;
    if (this.frameCount % 12 === 0) this.emit('tick');
  }

  halo(g, k, color) {
    let s = g.userData.halo;
    if (!s) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const c = cv.getContext('2d');
      const grd = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.3, 'rgba(255,255,255,0.5)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, 64, 64);
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.position.set(0, 19, 0);
      s.scale.set(16, 16, 1);
      s.raycast = () => {};
      g.add(s);
      g.userData.halo = s;
    }
    s.visible = k > 0.02;
    s.material.color.copy(color);
    s.material.opacity = k * 0.8;
  }

  updateBeam(n, g, st) {
    this.beams ||= new Map();
    let line = this.beams.get(n.id);
    const recent = st.pingAt && performance.now() - st.pingAt < 400;
    if (!recent) {
      if (line) line.visible = false;
      return;
    }
    if (!line) {
      line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x2fb35a, transparent: true, opacity: 0.9, depthTest: false }));
      line.renderOrder = 40;
      this.layer.overlay.add(line);
      this.beams.set(n.id, line);
    }
    const beam = PARTS.ultrasonic.beam;
    const o = new THREE.Vector3(...beam.origin).applyMatrix4(g.matrixWorld);
    const d = new THREE.Vector3(...beam.dir).transformDirection(g.matrixWorld);
    const len = st.dist ?? 400;
    line.geometry.setFromPoints([o, o.clone().addScaledVector(d, len)]);
    line.material.color.setHex(st.dist != null ? 0x2fb35a : 0xd9534f);
    line.visible = true;
  }

  // Lecturas para el panel de propiedades
  readings(id) {
    if (!this.running) return null;
    const n = this.app.doc.get(id);
    if (!n) return null;
    const o = this.outputs?.get(id) || {};
    const st = this.state.get(id) || {};
    const mA = (x) => `${((x || 0) * 1000).toFixed(1)} mA`;
    switch (n.part) {
      case 'led':
        return st.burnt ? [['Estado', 'Quemado']] : [['Corriente', mA(o.i)], ['Brillo', `${Math.round(Math.min(1, (o.i || 0) / 0.012) * 100)} %`]];
      case 'servo':
        return [['Ángulo', `${Math.round(st.angle ?? 90)}°`], ['Alimentación', st.powered ? `${(o.vs || 0).toFixed(2)} V` : 'Sin alimentación']];
      case 'motor':
        return [['Tensión', `${(o.v || 0).toFixed(2)} V`], ['Corriente', mA(o.i)], ['Velocidad', `${Math.round(st.rpm || 0)} rpm`]];
      case 'ultrasonic':
        return [['Distancia', st.dist != null ? `${(st.dist / 10).toFixed(1)} cm` : 'Sin obstáculo'], ['Alimentación', `${(o.vs || 0).toFixed(2)} V`]];
      case 'buzzer':
        return [['Frecuencia', st.freq ? `${Math.round(st.freq)} Hz` : 'En silencio']];
      case 'battery':
        return [['Corriente', mA(o.i)]];
      case 'npn':
        return [['Corriente colector', mA(o.ic)]];
      case 'arduino': {
        const outs = [];
        for (let i = 0; i < 20; i++) {
          if (this.pins.mode[i] !== 1) continue;
          const d = this.pins.pwm[i];
          outs.push(`${pinId(i)}=${d != null ? Math.round(d * 255) : this.pins.out[i] ? 'HIGH' : 'LOW'}`);
        }
        return [['Salidas', outs.join('  ') || '—'], ['Consumo 5V', mA(o.i5)]];
      }
    }
    // Tensión en cada pin
    return partPins(n).map((p) => [p.label, `${this.netVoltage(this.netKey(id, p.id)).toFixed(2)} V`]);
  }
}
