// Biblioteca de componentes electrónicos: modelo 3D, pines y modelo eléctrico.
// Unidades: milímetros, eje Y hacia arriba. Los pines se dan en coordenadas
// locales del componente.
import * as THREE from 'three';
import { P, mat, box, cyl, sphere, leg, label, METAL, LEAD, BLACK } from './shapes.js';
import { buildUno, unoPins, UNO_BRIDGES, PWM_PINS, buildBreadboard, bbPins, bbBridges } from './boards.js';

const DEG = Math.PI / 180;

// Colores de las bandas de una resistencia
const BAND = ['#111111', '#7a4a1d', '#d42a2a', '#f07c16', '#f2d21b', '#2e9e3e', '#2463d6', '#7b3fbf', '#8a8a8a', '#f4f4f4'];
function resistorBands(ohms) {
  const r = Math.max(1, Math.round(ohms));
  const s = String(r);
  const d1 = +s[0], d2 = s.length > 1 ? +s[1] : 0;
  const mult = Math.max(0, s.length - 2);
  return [BAND[d1], BAND[d2], BAND[Math.min(9, mult)], '#c9a227'];
}

export function formatOhms(r) {
  if (r >= 1e6) return +(r / 1e6).toFixed(2) + ' MΩ';
  if (r >= 1e3) return +(r / 1e3).toFixed(2) + ' kΩ';
  return +r.toFixed(1) + ' Ω';
}

const LED_COLORS = {
  rojo: { hex: 0xff2a2a, vf: 1.8, label: 'Rojo' },
  verde: { hex: 0x22e046, vf: 2.1, label: 'Verde' },
  azul: { hex: 0x2f6bff, vf: 3.0, label: 'Azul' },
  amarillo: { hex: 0xffd21f, vf: 2.0, label: 'Amarillo' },
  blanco: { hex: 0xf4f6ff, vf: 3.0, label: 'Blanco' },
};

// ---------------------------------------------------------------- catálogo
export const PARTS = {
  arduino: {
    label: 'Arduino UNO',
    icon: 'chip',
    color: '#0a7c8c',
    params: [],
    pins: unoPins,
    bridges: UNO_BRIDGES,
    build: buildUno,
    board: true,
    info: 'Placa programable. Escribe el programa en el panel "Código" y pulsa Simular. Los LEDs TX/RX parpadean al usar el puerto serie.',
  },

  breadboard: {
    label: 'Protoboard',
    icon: 'breadboard',
    color: '#d8d4c6',
    params: [],
    board: true,
    pins: bbPins,
    bridges: bbBridges(),
    build: buildBreadboard,
    info: 'Coloca componentes encima: sus patas se conectan solas a los agujeros. Cada columna de 5 agujeros (a–e y f–j) está unida por dentro; las filas + y − de los lados recorren toda la placa.',
  },

  led: {
    label: 'LED',
    icon: 'led',
    color: '#ff4d4d',
    params: [['color', 'Color', 'rojo', 'select', Object.entries(LED_COLORS).map(([k, v]) => [k, v.label])]],
    pins: () => [
      { id: 'A', label: 'Ánodo (+, pata larga)', pos: [1.27, 0, 0] },
      { id: 'K', label: 'Cátodo (−)', pos: [-1.27, 0, 0] },
    ],
    build(p) {
      const g = new THREE.Group();
      const c = LED_COLORS[p.color] || LED_COLORS.rojo;
      const lm = LEAD();
      leg(g, 1.27, 0, 0, 15, lm);
      leg(g, -1.27, 0, 0, 15, lm);
      const dome = mat(c.hex, { transparent: true, opacity: 0.82, emissive: 0x000000, shininess: 100 });
      cyl(g, 2.9, 1, dome, 0, 15.5, 0);
      cyl(g, 2.5, 4.6, dome, 0, 18.3, 0);
      sphere(g, 2.5, dome, 0, 20.6, 0);
      return { group: g, parts: { dome } };
    },
    elements: (p) => [{ k: 'D', a: 'A', c: 'K', vf: (LED_COLORS[p.color] || LED_COLORS.rojo).vf, rs: 12, tag: 'led' }],
    info: 'La pata larga (ánodo) va hacia el positivo. Usa siempre una resistencia en serie (220 Ω – 1 kΩ).',
  },

  resistor: {
    label: 'Resistencia',
    icon: 'resistor',
    color: '#d8b87a',
    params: [['r', 'Resistencia (Ω)', 220, 'ohms']],
    pins: () => [
      { id: '1', label: 'Pin 1', pos: [-5.08, 0, 0] },
      { id: '2', label: 'Pin 2', pos: [5.08, 0, 0] },
    ],
    build(p) {
      const g = new THREE.Group();
      const lm = LEAD();
      cyl(g, 0.3, 10.16, lm, 0, 3, 0, 'x', 6);
      leg(g, -5.08, 0, 0, 3, lm);
      leg(g, 5.08, 0, 0, 3, lm);
      cyl(g, 1.25, 6.3, mat(0xd8c08e), 0, 3, 0, 'x');
      resistorBands(p.r).forEach((col, i) => cyl(g, 1.3, 0.55, mat(new THREE.Color(col)), -2.1 + i * 1.25 + (i === 3 ? 0.6 : 0), 3, 0, 'x'));
      return { group: g, parts: {} };
    },
    elements: (p) => [{ k: 'R', a: '1', b: '2', r: Math.max(0.01, +p.r || 220) }],
  },

  button: {
    label: 'Pulsador',
    icon: 'button',
    color: '#30343b',
    params: [],
    interactive: 'press',
    pins: () => [
      { id: '1', label: 'Pin 1', pos: [-1.5 * P, 0, 0] },
      { id: '2', label: 'Pin 2', pos: [1.5 * P, 0, 0] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      leg(g, -1.5 * P, 0, 0, 1, lm, 0.35);
      leg(g, 1.5 * P, 0, 0, 1, lm, 0.35);
      box(g, 6, 3.5, 6, BLACK(), 0, 2.75, 0);
      box(g, 6.2, 0.3, 6.2, METAL(), 0, 4.6, 0);
      const cap = new THREE.Group();
      cyl(cap, 1.75, 1.6, mat(0x3a3f47), 0, 0, 0);
      cap.position.set(0, 5.5, 0);
      g.add(cap);
      return { group: g, parts: { cap } };
    },
    elements: (p, st) => (st.pressed ? [{ k: 'R', a: '1', b: '2', r: 0.05 }] : []),
    info: 'Durante la simulación, mantén pulsado el clic sobre el botón para presionarlo.',
  },

  switch: {
    label: 'Interruptor',
    icon: 'switch',
    color: '#2f6bd6',
    params: [],
    interactive: 'toggle',
    pins: () => [
      { id: '1', label: 'Pin 1', pos: [-2.54, 0, 0] },
      { id: '2', label: 'Pin 2', pos: [2.54, 0, 0] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      leg(g, -2.54, 0, 0, 1, lm);
      leg(g, 2.54, 0, 0, 1, lm);
      box(g, 8.6, 4, 3.6, mat(0x2f6bd6), 0, 3, 0);
      const knob = box(g, 2, 3, 1.6, BLACK(), -1.5, 6.5, 0);
      return { group: g, parts: { knob } };
    },
    elements: (p, st) => (st.on ? [{ k: 'R', a: '1', b: '2', r: 0.05 }] : []),
    info: 'Durante la simulación, haz clic sobre el interruptor para encenderlo o apagarlo.',
  },

  pot: {
    label: 'Potenciómetro',
    icon: 'pot',
    color: '#2f6bd6',
    params: [['r', 'Resistencia total (Ω)', 10000, 'ohms']],
    interactive: 'drag',
    state: () => ({ pos: 0.5 }),
    pins: () => [
      { id: '1', label: 'Extremo 1', pos: [-P, 0, 5] },
      { id: 'W', label: 'Cursor (salida)', pos: [0, 0, 5] },
      { id: '2', label: 'Extremo 2', pos: [P, 0, 5] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      for (const x of [-P, 0, P]) {
        leg(g, x, 5, 0, 2, lm);
        box(g, 0.8, 0.4, 3, lm, x, 2, 3.6);
      }
      box(g, 10, 6, 10, mat(0x2f6bd6), 0, 5, 0);
      cyl(g, 3.5, 1.5, METAL(), 0, 8.75, 0);
      const knob = new THREE.Group();
      cyl(knob, 3, 9, mat(0x30343b), 0, 4.5, 0);
      box(knob, 0.8, 0.6, 2.6, mat(0xffffff), 0, 9.1, 1.4);
      knob.position.set(0, 9.5, 0);
      g.add(knob);
      return { group: g, parts: { knob } };
    },
    elements: (p, st) => {
      const R = Math.max(10, +p.r || 10000);
      const t = Math.min(1, Math.max(0, st.pos ?? 0.5));
      return [
        { k: 'R', a: '1', b: 'W', r: Math.max(0.5, R * t) },
        { k: 'R', a: 'W', b: '2', r: Math.max(0.5, R * (1 - t)) },
      ];
    },
    info: 'Durante la simulación, arrastra el mando arriba o abajo (o usa la rueda) para girarlo.',
  },

  ldr: {
    label: 'Sensor de luz (LDR)',
    icon: 'ldr',
    color: '#c9573a',
    params: [],
    interactive: 'drag',
    state: () => ({ light: 0.5 }),
    pins: () => [
      { id: '1', label: 'Pin 1', pos: [-P / 2, 0, 0] },
      { id: '2', label: 'Pin 2', pos: [P / 2, 0, 0] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      leg(g, -P / 2, 0, 0, 12, lm);
      leg(g, P / 2, 0, 0, 12, lm);
      const disk = cyl(g, 2.6, 1.6, mat(0xd8d2c0), 0, 13, 0, 'z');
      disk.rotation.x = Math.PI / 2;
      box(g, 3.6, 0.3, 0.2, mat(0xc9573a), 0, 13, 0.85);
      return { group: g, parts: {} };
    },
    elements: (p, st) => [{ k: 'R', a: '1', b: '2', r: Math.pow(10, 6 - 3 * Math.min(1, Math.max(0, st.light ?? 0.5))) }],
    info: 'Su resistencia baja con la luz (1 MΩ a oscuras, 1 kΩ con mucha luz). Ajusta la luz en el panel o arrastrando.',
  },

  servo: {
    label: 'Servo SG90',
    icon: 'servo',
    color: '#2f6bd6',
    params: [],
    actuator: 'servo',
    pins: () => [
      { id: 'GND', label: 'GND (marrón)', pos: [-32, 4, -P] },
      { id: 'VCC', label: '5V (rojo)', pos: [-32, 4, 0] },
      { id: 'SIG', label: 'Señal (naranja)', pos: [-32, 4, P] },
    ],
    build() {
      const g = new THREE.Group();
      const blue = mat(0x2f6bd6, { transparent: true, opacity: 0.92 });
      box(g, 22.5, 22.7, 12, blue, 0, 11.35, 0);
      box(g, 32.2, 2.5, 12, blue, 0, 17.2, 0);
      cyl(g, 6, 4, blue, 5.9, 24.7, 0);
      cyl(g, 2.4, 3, mat(0xf0f0f0), 5.9, 28, 0);
      label(g, 'SG90', 12, 4, -3, 11, 6.05, { vertical: true });
      // Cable y conector
      const cols = [0x6b3e1f, 0xd12b2b, 0xf08a24];
      cols.forEach((c, i) => cyl(g, 0.5, 20.75, mat(c), -21.6, 4, (i - 1) * P, 'x', 8));
      box(g, 3, 3, 8, BLACK(), -32, 4, 0);
      // Brazo (horn): gira alrededor del eje vertical del servo
      const horn = new THREE.Group();
      const white = mat(0xf4f4f4);
      cyl(horn, 3.6, 1.6, white, 0, 0.8, 0);
      box(horn, 16, 1.6, 4.2, white, 8, 0.8, 0);
      cyl(horn, 2.1, 1.6, white, 16, 0.8, 0);
      horn.position.set(5.9, 29.5, 0);
      g.add(horn);
      return { group: g, parts: { horn } };
    },
    // Marco del brazo para acoplar piezas (ángulo en grados, 90 = reposo)
    partMatrix: (angle) => new THREE.Matrix4().makeTranslation(5.9, 29.5, 0).multiply(new THREE.Matrix4().makeRotationY((angle - 90) * DEG)),
    restAngle: 90,
    elements: () => [{ k: 'R', a: 'VCC', b: 'GND', r: 50, tag: 'supply' }],
    info: 'Conecta marrón a GND, rojo a 5V y naranja a un pin digital. Usa la librería Servo. Puedes acoplar piezas a su brazo.',
  },

  motor: {
    label: 'Motor DC',
    icon: 'motor',
    color: '#c9ced6',
    params: [['vn', 'Tensión nominal (V)', 6, 'number'], ['rpm', 'Velocidad nominal (rpm)', 200, 'number']],
    actuator: 'motor',
    pins: () => [
      { id: '+', label: 'Terminal +', pos: [-15, 14, 4] },
      { id: '-', label: 'Terminal −', pos: [-15, 14, -4] },
    ],
    build() {
      const g = new THREE.Group();
      cyl(g, 10, 25, METAL(), 0, 10, 0, 'x', 32);
      cyl(g, 10.2, 3, mat(0x2b2f36), -12.5, 10, 0, 'x', 32);
      cyl(g, 3.5, 2, METAL(), 13.5, 10, 0, 'x');
      box(g, 2, 3, 1.2, mat(0xd9a441), -14.2, 14, 4);
      box(g, 2, 3, 1.2, mat(0xd9a441), -14.2, 14, -4);
      const shaft = new THREE.Group();
      cyl(shaft, 1, 10, METAL(), 5, 0, 0, 'x', 12);
      box(shaft, 1.2, 5, 1.2, mat(0xd94a3a), 8, 2.5, 0);
      shaft.position.set(14.5, 10, 0);
      g.add(shaft);
      return { group: g, parts: { shaft } };
    },
    partMatrix: (angle) => new THREE.Matrix4().makeTranslation(14.5, 10, 0).multiply(new THREE.Matrix4().makeRotationX(angle * DEG)),
    restAngle: 0,
    elements: () => [{ k: 'R', a: '+', b: '-', r: 8, tag: 'motor' }],
    info: 'Un pin de Arduino no da corriente suficiente: contrólalo con un transistor. Puedes acoplar ruedas o piezas a su eje.',
  },

  npn: {
    label: 'Transistor NPN',
    icon: 'transistor',
    color: '#1d1f23',
    params: [['model', 'Modelo', '2N2222', 'select', [['2N2222', '2N2222 (pequeña señal)'], ['TIP120', 'TIP120 (Darlington, potencia)']]]],
    pins: (p) =>
      p.model === 'TIP120'
        ? [
            { id: 'B', label: 'Base', pos: [-P, 0, 0] },
            { id: 'C', label: 'Colector', pos: [0, 0, 0] },
            { id: 'E', label: 'Emisor', pos: [P, 0, 0] },
          ]
        : [
            { id: 'E', label: 'Emisor', pos: [-P, 0, 0] },
            { id: 'B', label: 'Base', pos: [0, 0, 0] },
            { id: 'C', label: 'Colector', pos: [P, 0, 0] },
          ],
    build(p) {
      const g = new THREE.Group();
      const lm = LEAD();
      for (const x of [-P, 0, P]) leg(g, x, 0, 0, 12, lm, 0.25);
      if (p.model === 'TIP120') {
        box(g, 10, 9, 4.5, BLACK(), 0, 16.5, 0);
        box(g, 10, 6.5, 1.3, METAL(), 0, 24, -1.6);
        label(g, 'TIP120', 8, 2.5, 0, 16.5, 2.3, { vertical: true });
      } else {
        const b = cyl(g, 2.4, 5, BLACK(), 0, 15, 0, 'y', 24);
        b.scale.z = 0.75;
        label(g, '2N2222', 4.4, 1.6, 0, 15, 1.85, { vertical: true });
      }
      return { group: g, parts: {} };
    },
    elements: (p) => (p.model === 'TIP120' ? [{ k: 'Q', b: 'B', c: 'C', e: 'E', vbe: 1.4, beta: 1000 }] : [{ k: 'Q', b: 'B', c: 'C', e: 'E', vbe: 0.65, beta: 120 }]),
    info: 'Interruptor controlado: una pequeña corriente en la base deja pasar una grande entre colector y emisor. Pon una resistencia (1 kΩ) en la base.',
  },

  diode: {
    label: 'Diodo',
    icon: 'diode',
    color: '#1d1f23',
    params: [],
    pins: () => [
      { id: 'A', label: 'Ánodo', pos: [-5.08, 0, 0] },
      { id: 'K', label: 'Cátodo (banda)', pos: [5.08, 0, 0] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      cyl(g, 0.3, 10.16, lm, 0, 3, 0, 'x', 6);
      leg(g, -5.08, 0, 0, 3, lm);
      leg(g, 5.08, 0, 0, 3, lm);
      cyl(g, 1.35, 5, BLACK(), 0, 3, 0, 'x');
      cyl(g, 1.4, 0.7, METAL(), 1.9, 3, 0, 'x');
      return { group: g, parts: {} };
    },
    elements: () => [{ k: 'D', a: 'A', c: 'K', vf: 0.7, rs: 0.2 }],
    info: 'Deja pasar la corriente sólo del ánodo al cátodo (banda plateada). Úsalo en paralelo con motores como protección.',
  },

  buzzer: {
    label: 'Zumbador',
    icon: 'buzzer',
    color: '#1d1f23',
    params: [['kind', 'Tipo', 'pasivo', 'select', [['pasivo', 'Pasivo (usa tone())'], ['activo', 'Activo (suena con HIGH)']]]],
    pins: () => [
      { id: '+', label: 'Positivo (+)', pos: [-1.5 * P, 0, 0] },
      { id: '-', label: 'Negativo (−)', pos: [1.5 * P, 0, 0] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      leg(g, -1.5 * P, 0, 0, 2, lm);
      leg(g, 1.5 * P, 0, 0, 2, lm);
      cyl(g, 6, 7.5, BLACK(), 0, 5.75, 0, 'y', 32);
      cyl(g, 1.2, 0.2, mat(0x0a0a0a), 0, 9.55, 0);
      label(g, '+', 2.5, 2.5, -3.5, 9.52, 2.6);
      return { group: g, parts: {} };
    },
    elements: (p) => [{ k: 'R', a: '+', b: '-', r: p.kind === 'activo' ? 150 : 40, tag: 'buzzer' }],
    info: 'Pasivo: suena con tone(pin, frecuencia). Activo: suena al recibir HIGH.',
  },

  ultrasonic: {
    label: 'Ultrasonido HC-SR04',
    icon: 'ultrasonic',
    color: '#2463d6',
    params: [],
    pins: () => [
      { id: 'VCC', label: 'VCC (5V)', pos: [-3 * P / 2, 0, 0] },
      { id: 'TRIG', label: 'Trig', pos: [-P / 2, 0, 0] },
      { id: 'ECHO', label: 'Echo', pos: [P / 2, 0, 0] },
      { id: 'GND', label: 'GND', pos: [3 * P / 2, 0, 0] },
    ],
    build() {
      const g = new THREE.Group();
      const lm = LEAD();
      for (let i = 0; i < 4; i++) leg(g, (-1.5 + i) * P, 0, 0, 6, lm, 0.3);
      box(g, 4 * P, 2.5, 2.5, BLACK(), 0, 5, 0);
      box(g, 45, 20, 1.6, mat(0x2463d6), 0, 16, 0);
      for (const x of [-13, 13]) {
        cyl(g, 8, 12, METAL(), x, 16, 6.8, 'z', 32);
        cyl(g, 6.6, 0.4, mat(0x3a3f47), x, 16, 12.9, 'z', 32);
      }
      box(g, 5, 4, 3, METAL(), 0, 22, 1.6);
      label(g, 'HC-SR04', 12, 3, 0, 9.5, 0.82, { vertical: true });
      return { group: g, parts: {} };
    },
    // Origen y dirección del haz (coordenadas locales)
    beam: { origin: [0, 16, 13.2], dir: [0, 0, 1] },
    elements: () => [{ k: 'R', a: 'VCC', b: 'GND', r: 330, tag: 'supply' }],
    info: 'Mide la distancia hasta las piezas que tenga delante (hasta 4 m). Usa pulseIn() en el pin Echo.',
  },

  battery: {
    label: 'Batería',
    icon: 'battery',
    color: '#30343b',
    params: [['v', 'Tensión (V)', 9, 'select', [['9', '9 V'], ['3.7', '3,7 V (LiPo)'], ['4.5', '4,5 V (3×AA)'], ['6', '6 V (4×AA)'], ['12', '12 V']]]],
    pins: () => [
      { id: '+', label: 'Positivo (+)', pos: [-6.4, 51, 0] },
      { id: '-', label: 'Negativo (−)', pos: [6.4, 51, 0] },
    ],
    build(p) {
      const g = new THREE.Group();
      box(g, 26.5, 46, 17.5, mat(0x30343b), 0, 23, 0);
      box(g, 26.6, 14, 17.6, mat(0xe0a526), 0, 30, 0);
      cyl(g, 3, 4, METAL(), -6.4, 48, 0, 'y', 16);
      const neg = cyl(g, 4, 4, METAL(), 6.4, 48, 0, 'y', 6);
      neg.rotation.y = Math.PI / 6;
      label(g, `${p.v} V`, 14, 6, 0, 30, 8.85, { vertical: true, color: '#1d1f23' });
      label(g, '+', 4, 4, -6.4, 46.1, 6.5);
      label(g, '−', 4, 4, 6.4, 46.1, 6.5);
      return { group: g, parts: {} };
    },
    elements: (p) => [{ k: 'V', p: '+', n: '-', v: +p.v || 9, r: (+p.v || 9) >= 9 ? 1.5 : 0.3, tag: 'battery' }],
    info: 'Fuente de alimentación. Conecta su negativo con el GND del Arduino si los usas juntos.',
  },
};

export const PART_ORDER = ['arduino', 'breadboard', 'led', 'resistor', 'button', 'switch', 'pot', 'ldr', 'servo', 'motor', 'npn', 'diode', 'buzzer', 'ultrasonic', 'battery'];

export function partDefaults(part) {
  const p = {};
  for (const [k, , v] of PARTS[part].params) p[k] = v;
  return p;
}

export function partPins(node) {
  return PARTS[node.part]?.pins(node.params || {}) || [];
}

export { LED_COLORS, PWM_PINS };
