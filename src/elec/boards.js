// Placas: Arduino UNO (con serigrafía y componentes) y protoboard.
import * as THREE from 'three';
import { P, mat, box, cyl, cached, METAL, BLACK } from './shapes.js';

// ================================================================ Arduino UNO
const UNO_W = 68.58;
const UNO_D = 53.34;
const PCB_T = 1.6;
const HEADER_H = 8.5;
const UNO_TOP = ['SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'];
const UNO_TOP2 = ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'];
const UNO_PWR = ['NC', 'IOREF', 'RESET', '3V3', '5V', 'GND', 'GND2', 'VIN'];
const UNO_ANA = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
export const PWM_PINS = [3, 5, 6, 9, 10, 11];
export const UNO_BRIDGES = [['GND', 'GND2', 'GND3'], ['SDA', 'A4'], ['SCL', 'A5']];

const HEADERS = [
  { ids: UNO_TOP, x0: -15.5, z: -24.1 },
  { ids: UNO_TOP2, x0: -15.5 + 10 * P + 1.5, z: -24.1 },
  { ids: UNO_PWR, x0: -11, z: 24.1 },
  { ids: UNO_ANA, x0: -11 + 8 * P + 2, z: 24.1 },
];

export function unoPins() {
  const pins = [];
  const y = PCB_T + HEADER_H;
  for (const hd of HEADERS) {
    hd.ids.forEach((id, i) => {
      const n = /^D(\d+)$/.exec(id);
      const lbl = id === 'GND2' || id === 'GND3' ? 'GND' : id === 'D0' ? 'D0 (RX)' : id === 'D1' ? 'D1 (TX)' : n && PWM_PINS.includes(+n[1]) ? id + ' ~' : id;
      pins.push({ id, label: lbl, pos: [hd.x0 + i * P, y, hd.z] });
    });
  }
  return pins;
}

// Contorno real de la placa (coordenadas del plano de Arduino, en mm)
const OUTLINE = [[0, 0], [66.04, 0], [68.58, 2.54], [68.58, 38.1], [66.04, 40.64], [66.04, 51.82], [64.52, 53.34], [0, 53.34]];
const HOLES = [[13.97, 2.54], [15.24, 50.8], [66.04, 7.62], [66.04, 35.56]];
// Plano de Arduino (X, Y) → escena (x, z)
const ux = (X) => X - UNO_W / 2;
const uz = (Y) => UNO_D / 2 - Y;

function pcbGeometry() {
  return cached('uno-pcb', () => {
    const shape = new THREE.Shape(OUTLINE.map(([X, Y]) => new THREE.Vector2(ux(X), -uz(Y))));
    for (const [X, Y] of HOLES) {
      const hole = new THREE.Path();
      hole.absarc(ux(X), -uz(Y), 1.6, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
    const g = new THREE.ExtrudeGeometry(shape, { depth: PCB_T, bevelEnabled: false, curveSegments: 16 });
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

// Serigrafía blanca (textos y contornos) dibujada en una textura
let unoSilkTexture = null;
function unoSilk() {
  if (unoSilkTexture || typeof document === 'undefined') return unoSilkTexture;
  const S = 16; // píxeles por mm
  const cv = document.createElement('canvas');
  cv.width = Math.round(UNO_W * S);
  cv.height = Math.round(UNO_D * S);
  const c = cv.getContext('2d');
  // (x, z) de escena → píxel
  const px = (x) => (x + UNO_W / 2) * S;
  const pz = (z) => (z + UNO_D / 2) * S;
  c.fillStyle = '#ffffff';
  c.strokeStyle = '#ffffff';
  c.textBaseline = 'middle';
  const text = (t, x, z, size, opts = {}) => {
    c.save();
    c.translate(px(x), pz(z));
    if (opts.rot) c.rotate(opts.rot);
    c.font = `${opts.weight || 700} ${size * S}px "Segoe UI", Arial, sans-serif`;
    c.textAlign = opts.align || 'center';
    c.fillText(t, 0, 0);
    c.restore();
  };
  const rect = (x, z, w, d, lw = 0.25) => {
    c.lineWidth = lw * S;
    c.strokeRect(px(x - w / 2), pz(z - d / 2), w * S, d * S);
  };
  // Etiquetas de los pines (en vertical, como en la placa real)
  const pinText = {
    SCL: 'SCL', SDA: 'SDA', AREF: 'AREF', GND3: 'GND', D13: '13', D12: '12', D11: '~11', D10: '~10', D9: '~9', D8: '8',
    D7: '7', D6: '~6', D5: '~5', D4: '4', D3: '~3', D2: '2', D1: 'TX→1', D0: 'RX←0',
    NC: '', IOREF: 'IOREF', RESET: 'RESET', '3V3': '3.3V', '5V': '5V', GND: 'GND', GND2: 'GND', VIN: 'Vin',
    A0: 'A0', A1: 'A1', A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5',
  };
  for (const hd of HEADERS) {
    const top = hd.z < 0;
    hd.ids.forEach((id, i) => {
      const x = hd.x0 + i * P;
      text(pinText[id] || '', x, hd.z + (top ? 2.3 : -2.3), 1.05, { rot: -Math.PI / 2, align: top ? 'right' : 'left' });
    });
    // Recuadro de la cabecera
    rect(hd.x0 - P / 2 + (hd.ids.length * P) / 2, hd.z, hd.ids.length * P + 0.6, P + 0.6, 0.18);
  }
  text('DIGITAL (PWM~)', 8, -14.4, 1.7);
  c.lineWidth = 0.22 * S;
  c.beginPath();
  c.moveTo(px(-15), pz(-15.6));
  c.lineTo(px(29), pz(-15.6));
  c.stroke();
  text('POWER', -2, 14.7, 1.5);
  text('ANALOG IN', 17.7, 14.7, 1.5);
  // Logotipo y nombre
  const lx = 3, lz = -6;
  c.lineWidth = 0.75 * S;
  c.beginPath();
  c.ellipse(px(lx - 3.1), pz(lz), 3 * S, 2.3 * S, 0, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.ellipse(px(lx + 3.1), pz(lz), 3 * S, 2.3 * S, 0, 0, Math.PI * 2);
  c.stroke();
  text('−', lx - 3.1, lz - 0.2, 3);
  text('+', lx + 3.1, lz - 0.1, 3);
  text('UNO', 22, -6, 5.6, { weight: 800 });
  text('ARDUINO', 3, -0.8, 2.4, { weight: 800 });
  // Indicadores junto a los LEDs
  text('L', -8, -19.3, 1.2);
  text('TX', -4.3, -11.4, 1.1, { align: 'left' });
  text('RX', -4.3, -9.1, 1.1, { align: 'left' });
  text('ON', 25.2, 14.2, 1.2, { align: 'left' });
  text('RESET', -27.8, -18.2, 1.1);
  text('ICSP', 29.7, -6.2, 1.1);
  text('ICSP', -19.6, -21.7, 1);
  // Contornos de componentes
  rect(10.7, 7.9, 38, 9.8, 0.2);
  rect(-27.8, -22.2, 7, 7, 0.18);
  rect(29.7, 0, 6, 8.6, 0.18);
  text('MADE IN ITALY', -24, 4, 0.9, { weight: 600 });
  unoSilkTexture = new THREE.CanvasTexture(cv);
  unoSilkTexture.colorSpace = THREE.SRGBColorSpace;
  unoSilkTexture.anisotropy = 4;
  return unoSilkTexture;
}

function chipLabel(g, text, w, d, x, y, z, rot = 0) {
  if (typeof document === 'undefined') return;
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = Math.round((512 * d) / w);
  const c = cv.getContext('2d');
  c.fillStyle = '#c8ccd2';
  c.font = `600 ${Math.round(cv.height * 0.32)}px Consolas, monospace`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const lines = text.split('\n');
  lines.forEach((l, i) => c.fillText(l, cv.width / 2, (cv.height * (i + 1)) / (lines.length + 1)));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = rot;
  m.position.set(x, y, z);
  m.userData.noPick = true;
  g.add(m);
}

export function buildUno() {
  const g = new THREE.Group();
  const parts = {};
  const pcb = new THREE.Mesh(pcbGeometry(), mat(0x00878f, { shininess: 30 }));
  g.add(pcb);
  const silk = unoSilk();
  if (silk) {
    const plane = new THREE.Mesh(cached('uno-silk', () => new THREE.PlaneGeometry(UNO_W, UNO_D).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ map: silk, transparent: true, depthWrite: false }));
    plane.position.y = PCB_T + 0.03;
    plane.userData.noPick = true;
    g.add(plane);
  }
  const top = PCB_T;
  const metal = METAL();
  const dark = BLACK();
  const gold = mat(0xd9b04a, { shininess: 100, specular: 0x998844 });

  // Conector USB-B (con su abertura)
  box(g, 16.3, 10.9, 12, metal, ux(-6.35 + 16.3 / 2), top + 5.45, uz(37.8));
  box(g, 0.6, 7.4, 8.4, mat(0x0b0c0e), ux(-6.35) - 0.25, top + 5.2, uz(37.8));
  box(g, 0.7, 2.6, 5.4, mat(0xf2f2f2), ux(-6.35) + 0.1, top + 4.6, uz(37.8));
  // Jack de alimentación (cilindro hueco)
  box(g, 14.2, 11, 9, dark, ux(-1.8 + 7.1), top + 5.5, uz(7.8));
  const hole = cyl(g, 3.1, 0.8, mat(0x050505), ux(-1.8) - 0.3, top + 5.8, uz(7.8), 'x', 20);
  hole.renderOrder = 1;
  cyl(g, 1, 1, metal, ux(-1.8) - 0.5, top + 5.8, uz(7.8), 'x', 10);

  // Microcontrolador ATmega328P (DIP-28)
  const cx = 10.7, cz = 7.9;
  box(g, 35.5, 3.3, 7.3, mat(0x16171a, { shininess: 50 }), cx, top + 2.75, cz);
  cyl(g, 0.9, 0.3, mat(0x2a2c30), cx - 16.2, top + 4.4, cz, 'y', 16);
  for (let i = 0; i < 14; i++) {
    const x = cx - 16.51 + i * P;
    for (const s of [-1, 1]) {
      box(g, 0.5, 0.35, 1.2, metal, x, top + 2.4, cz + s * 4.2);
      box(g, 0.5, 2.4, 0.3, metal, x, top + 1.2, cz + s * 4.8);
    }
  }
  chipLabel(g, 'ATMEGA328P-PU\n1932  AU', 26, 5.2, cx + 2, top + 4.42, cz);
  // Cristal de 16 MHz y chip USB (16U2)
  const xx = -14, xz = 1;
  box(g, 10.2, 3.5, 4.4, metal, xx, top + 1.75, xz);
  cyl(g, 2.2, 3.5, metal, xx - 5.1, top + 1.75, xz, 'y', 16);
  cyl(g, 2.2, 3.5, metal, xx + 5.1, top + 1.75, xz, 'y', 16);
  chipLabel(g, '16.000', 8, 2.6, xx, top + 3.52, xz);
  box(g, 7, 1, 7, mat(0x16171a), -13, top + 0.5, -6.5);
  chipLabel(g, '16U2', 5.6, 3, -13, top + 1.02, -6.5);
  // Regulador de tensión y condensadores electrolíticos
  box(g, 6.5, 1.6, 3.5, dark, -14, top + 0.8, 18.5);
  box(g, 3.2, 0.3, 2, metal, -14, top + 0.15, 21);
  for (const [x, z] of [[-24.5, 15.5], [-24.5, 22]]) {
    cyl(g, 3.1, 6, mat(0x1f2329), x, top + 3, z, 'y', 24);
    cyl(g, 3.12, 0.4, metal, x, top + 6.1, z, 'y', 24);
    box(g, 0.6, 6.01, 3.4, mat(0x8a8f99), x + 2.7, top + 3, z);
  }
  // Botón de reset
  box(g, 6, 1.5, 6, metal, -27.8, top + 0.75, -22.2);
  cyl(g, 1.7, 1, mat(0xb5432b), -27.8, top + 2, -22.2, 'y', 16);
  // Cabeceras ICSP (2×3 pines macho)
  const icsp = (x, z) => {
    box(g, 5.08, 2.5, 7.62, dark, x, top + 1.25, z);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) cyl(g, 0.32, 6, gold, x - P / 2 + i * P, top + 3.5, z - P + j * P, 'y', 6);
  };
  icsp(29.7, 0);
  icsp(-19.6, -17.2);
  // Pequeños componentes SMD (resistencias y condensadores)
  const smd = [
    [-9, -4, 0], [-9, -2, 0], [-6, 2, 1], [16, -2, 1], [18, -2, 1], [22, 4, 0], [-18, 8, 0], [-18, 10.5, 0],
    [2, 16, 1], [4.5, 16, 1], [-5, 12, 0], [26, 9, 0], [-3, -18, 1], [-1, -18, 1], [-22, -10, 0],
  ];
  const smdR = mat(0x2a2c30), smdC = mat(0xc9a77a);
  smd.forEach(([x, z, r], i) => {
    const m = box(g, 1.6, 0.5, 0.8, i % 3 === 0 ? smdC : smdR, x, top + 0.25, z);
    if (r) m.rotation.y = Math.PI / 2;
  });
  // LEDs de la placa: L (pin 13), TX, RX y ON
  const led = (color, x, z) => {
    const m = mat(color, { emissive: 0x000000 });
    box(g, 1.6, 0.7, 0.9, m, x, top + 0.35, z);
    return m;
  };
  parts.ledL = led(0x553300, -8, -17);
  parts.ledTX = led(0x553300, -6, -11.4);
  parts.ledRX = led(0x553300, -6, -9.1);
  parts.ledOn = led(0x0b3d12, 23.6, 14.2);
  // Cabeceras hembra
  const hdr = mat(0x18191c, { shininess: 35 });
  for (const hd of HEADERS) {
    const len = hd.ids.length * P;
    box(g, len, HEADER_H, P, hdr, hd.x0 - P / 2 + len / 2, top + HEADER_H / 2, hd.z);
  }
  // Patas soldadas de las cabeceras por debajo
  return { group: g, parts };
}

// ================================================================ Protoboard
const BB = { w: 82.5, d: 55, h: 8.5 };
const ROWS_TOP = ['j', 'i', 'h', 'g', 'f'];
const ROWS_BOT = ['e', 'd', 'c', 'b', 'a'];
const ROW_Z = {};
ROWS_TOP.forEach((r, i) => (ROW_Z[r] = -13.97 + i * P));
ROWS_BOT.forEach((r, i) => (ROW_Z[r] = 3.81 + i * P));
const RAILS = [
  { id: 't-', z: -21.59, label: 'Riel − superior', color: '#2f6bd6' },
  { id: 't+', z: -19.05, label: 'Riel + superior', color: '#d63031' },
  { id: 'b+', z: 19.05, label: 'Riel + inferior', color: '#d63031' },
  { id: 'b-', z: 21.59, label: 'Riel − inferior', color: '#2f6bd6' },
];
const colX = (c) => (c - 15.5) * P;
const railCols = () => {
  const cols = [];
  for (let gI = 0; gI < 5; gI++) for (let i = 0; i < 5; i++) cols.push(2 + gI * 6 + i);
  return cols;
};

export function bbPins() {
  const pins = [];
  for (let c = 1; c <= 30; c++) {
    for (const r of [...ROWS_TOP, ...ROWS_BOT]) pins.push({ id: `${c}${r}`, label: `Columna ${c}, fila ${r}`, pos: [colX(c), BB.h, ROW_Z[r]] });
  }
  for (const rail of RAILS) {
    railCols().forEach((c, k) => pins.push({ id: `${rail.id}${k + 1}`, label: rail.label, pos: [colX(c), BB.h, rail.z] }));
  }
  return pins;
}

export function bbBridges() {
  const out = [];
  for (let c = 1; c <= 30; c++) {
    out.push(ROWS_TOP.map((r) => `${c}${r}`));
    out.push(ROWS_BOT.map((r) => `${c}${r}`));
  }
  for (const rail of RAILS) out.push(railCols().map((_, k) => `${rail.id}${k + 1}`));
  return out;
}

// Grupo eléctrico al que pertenece un agujero (para resaltar la columna)
export function bbGroupOf(pinId) {
  const m = /^(\d+)([a-j])$/.exec(pinId);
  if (m) return ROWS_TOP.includes(m[2]) ? `${m[1]}top` : `${m[1]}bot`;
  const r = /^([tb][+-])\d+$/.exec(pinId);
  return r ? r[1] : null;
}

// Agujero más cercano a un punto local (o null)
export function bbHoleAt(x, z, tol = 1) {
  const c = Math.round(x / P + 15.5);
  let best = null, bd = tol;
  if (c >= 1 && c <= 30) {
    for (const r of [...ROWS_TOP, ...ROWS_BOT]) {
      const d = Math.hypot(colX(c) - x, ROW_Z[r] - z);
      if (d < bd) { bd = d; best = { id: `${c}${r}`, x: colX(c), z: ROW_Z[r] }; }
    }
  }
  const rc = railCols();
  for (const rail of RAILS) {
    const k = rc.indexOf(c);
    if (k < 0) continue;
    const d = Math.hypot(colX(c) - x, rail.z - z);
    if (d < bd) { bd = d; best = { id: `${rail.id}${k + 1}`, x: colX(c), z: rail.z }; }
  }
  return best;
}

export const BB_TOP = BB.h;

let bbTexture = null;
function bbTop() {
  if (bbTexture || typeof document === 'undefined') return bbTexture;
  const S = 14;
  const cv = document.createElement('canvas');
  cv.width = Math.round(BB.w * S);
  cv.height = Math.round(BB.d * S);
  const c = cv.getContext('2d');
  const px = (x) => (x + BB.w / 2) * S;
  const pz = (z) => (z + BB.d / 2) * S;
  c.fillStyle = '#f3f1ea';
  c.fillRect(0, 0, cv.width, cv.height);
  // Canal central
  c.fillStyle = '#dcd8cc';
  c.fillRect(0, pz(-1.3), cv.width, 2.6 * S);
  // Líneas de los rieles
  for (const rail of RAILS) {
    c.strokeStyle = rail.color;
    c.lineWidth = 0.35 * S;
    const off = rail.id.endsWith('-') ? (rail.z < 0 ? -1.8 : 1.8) : rail.z < 0 ? 1.6 : -1.6;
    c.beginPath();
    c.moveTo(px(-37), pz(rail.z + off));
    c.lineTo(px(37), pz(rail.z + off));
    c.stroke();
    c.fillStyle = rail.color;
    c.font = `700 ${2.4 * S}px Arial`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(rail.id.endsWith('+') ? '+' : '−', px(-39.6), pz(rail.z));
  }
  // Agujeros
  const holeSq = (x, z) => {
    c.fillStyle = '#3b3d42';
    c.fillRect(px(x) - 0.6 * S, pz(z) - 0.6 * S, 1.2 * S, 1.2 * S);
  };
  for (let col = 1; col <= 30; col++) for (const r of [...ROWS_TOP, ...ROWS_BOT]) holeSq(colX(col), ROW_Z[r]);
  for (const rail of RAILS) for (const col of railCols()) holeSq(colX(col), rail.z);
  // Numeración de columnas y letras de filas
  c.fillStyle = '#8a8c93';
  c.font = `600 ${1.25 * S}px Arial`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let col = 1; col <= 30; col++) {
    if (col === 1 || col % 5 === 0) {
      c.fillText(String(col), px(colX(col)), pz(-16.3));
      c.fillText(String(col), px(colX(col)), pz(16.3));
    }
  }
  for (const r of [...ROWS_TOP, ...ROWS_BOT]) {
    c.fillText(r, px(-38.9), pz(ROW_Z[r]));
    c.fillText(r, px(38.9), pz(ROW_Z[r]));
  }
  bbTexture = new THREE.CanvasTexture(cv);
  bbTexture.colorSpace = THREE.SRGBColorSpace;
  bbTexture.anisotropy = 4;
  return bbTexture;
}

export function buildBreadboard() {
  const g = new THREE.Group();
  box(g, BB.w, BB.h - 0.02, BB.d, mat(0xeeebe2, { shininess: 20 }), 0, (BB.h - 0.02) / 2, 0);
  const tex = bbTop();
  const topMat = tex ? new THREE.MeshPhongMaterial({ map: tex, shininess: 15 }) : mat(0xf3f1ea);
  const plane = new THREE.Mesh(cached('bb-top', () => new THREE.PlaneGeometry(BB.w, BB.d).rotateX(-Math.PI / 2)), topMat);
  plane.position.y = BB.h;
  g.add(plane);
  // Canal central hundido
  box(g, BB.w - 4, 0.6, 2.4, mat(0xd5d1c4), 0, BB.h - 0.25, 0);
  return { group: g, parts: {} };
}
