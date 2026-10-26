// Red de conexiones (nets) y resolución del circuito en corriente continua
// mediante análisis nodal modificado con modelos lineales a tramos.
import { PARTS, partPins } from './parts.js';

// Agrupa los pines conectados (cables + puentes internos) en nets
export function buildNets(nodes, wires) {
  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    let x = k;
    while (parent.get(x) !== r) {
      const nx = parent.get(x);
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const n of nodes) {
    for (const pin of partPins(n)) parent.set(`${n.id}:${pin.id}`, `${n.id}:${pin.id}`);
    for (const group of PARTS[n.part]?.bridges || []) {
      for (let i = 1; i < group.length; i++) union(`${n.id}:${group[0]}`, `${n.id}:${group[i]}`);
    }
  }
  for (const w of wires) union(`${w.a.n}:${w.a.p}`, `${w.b.n}:${w.b.p}`);
  const index = new Map();
  const netOf = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!index.has(r)) index.set(r, index.size);
    netOf.set(k, index.get(r));
  }
  return { netOf, count: index.size };
}

// Resolución lineal (eliminación gaussiana con pivote parcial)
function gauss(A, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = col, best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-18) continue;
    if (piv !== col) {
      for (let c = 0; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[piv * n + c];
        A[piv * n + c] = t;
      }
      const t = b[col]; b[col] = b[piv]; b[piv] = t;
    }
    const d = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / d;
      if (!f) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
    const d = A[r * n + r];
    x[r] = Math.abs(d) > 1e-18 ? s / d : 0;
  }
  return x;
}

const GMIN = 1e-9;

// elements: lista de {k, ...nets} con nets ya resueltos a índices.
//  R:  {a, b, r}
//  V:  {p, n, v, r}         fuente con resistencia interna
//  I:  {a, b, i}            corriente de a hacia b por fuera (inyecta en b)
//  D:  {a, c, vf, rs}       diodo / LED (lineal a tramos)
//  Q:  {b, c, e, vbe, beta} transistor NPN (corte / activa / saturación)
export function solve(count, ref, elements) {
  const n = Math.max(1, count);
  let v = new Float64Array(n);
  for (const el of elements) {
    if (el.k === 'D') el.on ??= false;
    if (el.k === 'Q') {
      el.beOn ??= false;
      el.mode ??= 'off';
      el.ib ??= 0;
    }
  }
  for (let iter = 0; iter < 60; iter++) {
    const A = new Float64Array(n * n);
    const b = new Float64Array(n);
    const G = (i, j, g) => {
      if (i === j) return;
      A[i * n + i] += g;
      A[j * n + j] += g;
      A[i * n + j] -= g;
      A[j * n + i] -= g;
    };
    const inj = (i, cur) => (b[i] += cur);
    // Rama "fuente en serie con resistencia": I(a→b) = (Va - Vb - vs) / r
    const branch = (a, c, vs, r) => {
      const g = 1 / r;
      G(a, c, g);
      inj(a, g * vs);
      inj(c, -g * vs);
    };
    for (const el of elements) {
      switch (el.k) {
        case 'R':
          G(el.a, el.b, 1 / el.r);
          break;
        case 'V':
          branch(el.p, el.n, el.v, el.r);
          break;
        case 'I':
          inj(el.a, -el.i);
          inj(el.b, el.i);
          break;
        case 'D':
          if (el.on) branch(el.a, el.c, el.vf, el.rs);
          break;
        case 'Q':
          if (el.beOn) branch(el.b, el.e, el.vbe, 25);
          if (el.mode === 'sat') branch(el.c, el.e, 0.15, 0.3);
          else if (el.mode === 'act') {
            inj(el.c, -el.beta * el.ib);
            inj(el.e, el.beta * el.ib);
          }
          break;
      }
    }
    for (let i = 0; i < n; i++) A[i * n + i] += GMIN;
    // Nodo de referencia a 0 V
    for (let c = 0; c < n; c++) A[ref * n + c] = 0;
    A[ref * n + ref] = 1;
    b[ref] = 0;
    v = gauss(A, b, n);

    let changed = false;
    for (const el of elements) {
      if (el.k === 'D') {
        const vd = v[el.a] - v[el.c];
        if (!el.on && vd > el.vf + 1e-6) { el.on = true; changed = true; }
        else if (el.on && (vd - el.vf) / el.rs < -1e-9) { el.on = false; changed = true; }
      } else if (el.k === 'Q') {
        const vbe = v[el.b] - v[el.e];
        const vce = v[el.c] - v[el.e];
        if (!el.beOn && vbe > el.vbe + 1e-6) { el.beOn = true; changed = true; }
        else if (el.beOn && vbe < el.vbe - 1e-6) { el.beOn = false; changed = true; }
        const ib = el.beOn ? Math.max(0, (vbe - el.vbe) / 25) : 0;
        const prevIb = el.ib;
        el.ib = ib;
        let mode = el.mode;
        if (ib <= 1e-7) mode = 'off';
        else if (mode === 'off') mode = 'sat';
        else if (mode === 'sat') {
          const ic = (vce - 0.15) / 0.3;
          if (ic > el.beta * ib * 1.001) mode = 'act';
        } else if (mode === 'act' && vce < 0.15) mode = 'sat';
        if (mode !== el.mode) { el.mode = mode; changed = true; }
        if (mode === 'act' && Math.abs(ib - prevIb) > 1e-6 * Math.max(1e-6, ib)) changed = true;
      }
    }
    if (!changed) break;
  }
  return v;
}

// Corriente que circula por un elemento con las tensiones dadas
export function elementCurrent(el, v) {
  switch (el.k) {
    case 'R':
      return (v[el.a] - v[el.b]) / el.r;
    case 'V':
      return (el.v - (v[el.p] - v[el.n])) / el.r;
    case 'D':
      return el.on ? Math.max(0, (v[el.a] - v[el.c] - el.vf) / el.rs) : 0;
    case 'Q':
      if (el.mode === 'sat') return Math.max(0, (v[el.c] - v[el.e] - 0.15) / 0.3);
      if (el.mode === 'act') return el.beta * el.ib;
      return 0;
  }
  return 0;
}
