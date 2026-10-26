// Traductor de programas Arduino (C++) a JavaScript asíncrono y entorno de
// ejecución con la API de Arduino (pinMode, digitalWrite, Serial, Servo…).
import { parse as acornParse } from 'acorn';

const TYPE_WORDS = new Set([
  'void', 'int', 'long', 'float', 'double', 'bool', 'boolean', 'byte', 'char', 'short', 'word', 'unsigned', 'signed',
  'size_t', 'String', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t', 'Servo',
  'const', 'static', 'volatile', 'auto',
]);
const QUALIFIERS = new Set(['const', 'static', 'volatile', 'unsigned', 'signed']);
const INT_TYPES = new Set(['int', 'long', 'byte', 'short', 'word', 'unsigned', 'signed', 'size_t', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t']);
const ASYNC_API = ['delay', 'delayMicroseconds', 'pulseIn'];

export class ArduinoError extends Error {
  constructor(msg, line) {
    super(msg);
    this.line = line;
  }
}

// ---------------------------------------------------------------- léxico
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const ops3 = ['<<=', '>>='];
  const ops2 = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', '::'];
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(src[j])) j++;
      toks.push({ t: 'ws', v: src.slice(i, j) });
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      toks.push({ t: 'ws', v: ' ' });
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      if (j < 0) j = n - 2;
      const body = src.slice(i, j + 2);
      toks.push({ t: 'ws', v: body.replace(/[^\n]/g, ' ') });
      i = j + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      toks.push({ t: c === '"' ? 'str' : 'chr', v: src.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '#') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      toks.push({ t: 'pp', v: src.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[\w]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i;
      if (c === '0' && /[xXbB]/.test(src[i + 1])) j += 2;
      while (j < n && /[\w.]/.test(src[j])) j++;
      // Notación científica con signo (1e-3)
      if (/[eE]/.test(src[j - 1]) && /[+-]/.test(src[j]) && !/^0[xX]/.test(src.slice(i, j))) {
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      let num = src.slice(i, j);
      num = /^0[xX]/.test(num) ? num.replace(/[uUlL]+$/, '') : num.replace(/[uUlLfF]+$/, '');
      if (/^0[bB]/.test(num)) num = String(parseInt(num.slice(2), 2));
      else if (/^0[0-7]+$/.test(num)) num = '0o' + num.slice(1);
      toks.push({ t: 'num', v: num });
      i = j;
    } else {
      const s3 = src.slice(i, i + 3), s2 = src.slice(i, i + 2);
      const op = ops3.includes(s3) ? s3 : ops2.includes(s2) ? s2 : c;
      toks.push({ t: 'op', v: op });
      i += op.length;
    }
  }
  return toks;
}

// ---------------------------------------------------------------- traducción
export function transpile(src) {
  const toks = tokenize(src.replace(/\r\n?/g, '\n'));
  const out = [];
  const hoisted = [];
  const userFns = new Set();
  const intVars = new Set();
  let depth = 0;

  // Índice del siguiente token significativo
  const next = (i) => {
    let j = i;
    while (j < toks.length && toks[j].t === 'ws') j++;
    return j;
  };
  const prevSig = () => {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].t !== 'ws' && out[k].v !== '') return out[k];
    return null;
  };
  const matchClose = (i, open, close) => {
    let d = 0;
    for (let j = i; j < toks.length; j++) {
      if (toks[j].v === open) d++;
      else if (toks[j].v === close && --d === 0) return j;
    }
    return toks.length - 1;
  };
  const emit = (v, t = 'op') => out.push({ t, v });
  const keepWs = (from, to) => {
    // Conserva los saltos de línea entre from y to para no desplazar las líneas
    for (let j = from; j < to; j++) {
      const nl = (toks[j].v.match(/\n/g) || []).length;
      if (nl) emit('\n'.repeat(nl), 'ws');
    }
  };
  const convertInit = (arr) => arr.map((t) => (t.v === '{' ? { ...t, v: '[' } : t.v === '}' ? { ...t, v: ']' } : t));
  const text = (arr) => arr.map((t) => (t.t === 'chr' ? charLit(t.v) : t.v)).join('');

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'pp') {
      const m = /^#\s*define\s+([A-Za-z_]\w*)(?:\s+(.*))?$/.exec(tk.v.trim());
      if (m && !/\(/.test(tk.v.slice(tk.v.indexOf(m[1]) + m[1].length, tk.v.indexOf(m[1]) + m[1].length + 1))) {
        emit(`const ${m[1]} = ${(m[2] || '1').replace(/\/\/.*$/, '').trim() || '1'};`);
      }
      continue;
    }
    if (tk.v === '{') depth++;
    if (tk.v === '}') depth--;

    // Conversión de tipo: (int)x → ~~x ; (float)x → x
    if (tk.v === '(') {
      const j = next(i + 1);
      if (toks[j]?.t === 'id' && TYPE_WORDS.has(toks[j].v) && toks[j].v !== 'const') {
        let k = j;
        const words = [];
        while (toks[k] && (toks[k].t === 'ws' || (toks[k].t === 'id' && TYPE_WORDS.has(toks[k].v)) || toks[k].v === '*')) {
          if (toks[k].t === 'id') words.push(toks[k].v);
          k++;
        }
        if (toks[k]?.v === ')') {
          const base = words[words.length - 1];
          emit(INT_TYPES.has(base) || base === 'char' ? '~~' : '');
          i = k;
          continue;
        }
      }
    }

    // Declaraciones (variables y funciones)
    const prev = prevSig();
    const lastCh = prev ? prev.v.trim().slice(-1) : '';
    const atStmt = !prev || [';', '{', '}', '(', ')'].includes(lastCh);
    if (tk.t === 'id' && TYPE_WORDS.has(tk.v) && atStmt && !(lastCh === ')' && depth === 0)) {
      let k = i;
      const words = [];
      while (toks[k] && (toks[k].t === 'ws' || (toks[k].t === 'id' && TYPE_WORDS.has(toks[k].v)))) {
        if (toks[k].t === 'id') words.push(toks[k].v);
        k++;
      }
      while (toks[k] && (toks[k].v === '*' || toks[k].v === '&' || toks[k].t === 'ws')) k++;
      const nameTok = toks[k];
      if (nameTok && nameTok.t === 'id' && !TYPE_WORDS.has(nameTok.v)) {
        const baseWords = words.filter((w) => !QUALIFIERS.has(w));
        const base = baseWords[baseWords.length - 1] || (words.includes('unsigned') || words.includes('signed') ? 'int' : 'int');
        const isStatic = words.includes('static');
        const afterName = next(k + 1);
        // Función: tipo nombre( ... ) { ... }   o prototipo ...;
        if (toks[afterName]?.v === '(' && depth === 0) {
          const close = matchClose(afterName, '(', ')');
          const body = next(close + 1);
          if (toks[body]?.v === ';') {
            keepWs(i, body);
            i = body;
            continue;
          }
          const params = splitTop(toks.slice(afterName + 1, close))
            .map((p) => {
              const ids = p.filter((t) => t.t === 'id' && !TYPE_WORDS.has(t.v));
              const eq = p.findIndex((t) => t.v === '=');
              if (!ids.length) return '';
              const nm = (eq >= 0 ? p.slice(0, eq) : p).filter((t) => t.t === 'id' && !TYPE_WORDS.has(t.v)).pop();
              return nm ? nm.v + (eq >= 0 ? ' = ' + text(p.slice(eq + 1)).trim() : '') : '';
            })
            .filter(Boolean);
          userFns.add(nameTok.v);
          keepWs(i, close);
          emit(`async function ${nameTok.v}(${params.join(', ')})`);
          i = close;
          continue;
        }
        // Variable(s): tipo a = 1, b[3], c;
        let j = k;
        let end = j;
        let d = 0;
        for (; end < toks.length; end++) {
          const v = toks[end].v;
          if (v === '(' || v === '[' || v === '{') d++;
          else if (v === ')' || v === ']' || v === '}') {
            if (d === 0) break;
            d--;
          } else if (v === ';' && d === 0) break;
        }
        const decls = splitTop(toks.slice(j, end)).map((part) => {
          const ids = part.filter((t) => t.t !== 'ws');
          const name = ids[0]?.v;
          let p = 1;
          const dims = [];
          while (ids[p]?.v === '[') {
            const c = ids.findIndex((t, q) => q > p && t.v === ']');
            dims.push(text(ids.slice(p + 1, c)).trim());
            p = c + 1;
          }
          let init = null;
          if (ids[p]?.v === '=') init = text(convertInit(ids.slice(p + 1))).trim();
          else if (ids[p]?.v === '(') init = base === 'String' ? `String(${text(ids.slice(p + 1, ids.length - 1))})` : null;
          const isInt = INT_TYPES.has(base) && !dims.length;
          if (isInt) intVars.add(name);
          if (init == null) {
            const def = base === 'Servo' ? 'new Servo()' : base === 'String' ? '""' : base === 'bool' || base === 'boolean' ? 'false' : '0';
            init = dims.length ? `__arr([${dims.join(',')}], () => ${def})` : def;
          } else if (isInt) init = `__int(${init})`;
          return `${name} = ${init}`;
        });
        const decl = `let ${decls.join(', ')}`;
        if (isStatic && depth > 0) {
          hoisted.push(decl + ';');
          keepWs(i, end);
          i = end; // el ';' se emite vacío
          emit('');
          continue;
        }
        keepWs(i, k);
        emit(decl);
        keepWs(k, end);
        i = end - 1;
        continue;
      }
    }

    // Asignaciones a variables enteras: x = expr;  x /= expr;
    if (tk.t === 'id' && intVars.has(tk.v) && atStmt) {
      const j = next(i + 1);
      if (toks[j]?.v === '=' || toks[j]?.v === '/=') {
        let end = j + 1, d = 0;
        for (; end < toks.length; end++) {
          const v = toks[end].v;
          if (v === '(' || v === '[') d++;
          else if (v === ')' || v === ']') {
            if (d === 0) break;
            d--;
          } else if ((v === ';' || v === ',') && d === 0) break;
        }
        const expr = text(toks.slice(j + 1, end)).trim();
        emit(toks[j].v === '/=' ? `${tk.v} = __int(${tk.v} / (${expr}))` : `${tk.v} = __int(${expr})`);
        keepWs(j, end);
        i = end - 1;
        continue;
      }
    }

    // Bucles: se inserta una pausa cooperativa para no bloquear la ventana
    if (tk.t === 'id' && (tk.v === 'while' || tk.v === 'for')) {
      const po = next(i + 1);
      if (toks[po]?.v === '(') {
        const pc = matchClose(po, '(', ')');
        const doTail = tk.v === 'while' && lastCh === '}' && toks[next(pc + 1)]?.v === ';' && lastDoClosed(out);
        if (!doTail) {
          // Emite cabecera procesando su interior con la misma lógica (for (int i...))
          emit(tk.v);
          const inner = transpileFragment(toks.slice(i + 1, pc + 1), userFns, intVars);
          emit(inner);
          const b = next(pc + 1);
          if (toks[b]?.v === '{') {
            emit(' {');
            emit(' await __tick();');
            depth++;
            i = b;
          } else if (toks[b]?.v === ';') {
            emit(' { await __tick(); }');
            i = b;
          } else {
            emit(' { await __tick(); ');
            // Sentencia simple: hasta el ';' de su nivel
            let e = b, dd = 0;
            for (; e < toks.length; e++) {
              const v = toks[e].v;
              if (v === '(' || v === '{' || v === '[') dd++;
              else if (v === ')' || v === '}' || v === ']') dd--;
              else if (v === ';' && dd === 0) break;
            }
            emit(transpileFragment(toks.slice(b, e + 1), userFns, intVars));
            emit(' }');
            i = e;
          }
          continue;
        }
      }
    }
    if (tk.t === 'id' && tk.v === 'do') {
      const b = next(i + 1);
      if (toks[b]?.v === '{') {
        emit('do { await __tick();');
        out[out.length - 1].doOpen = true;
        depth++;
        i = b;
        continue;
      }
    }

    if (tk.t === 'chr') emit(charLit(tk.v), 'chr');
    else out.push(tk);
  }

  let js = out.map((t) => t.v).join('');
  js = postProcess(js, userFns);
  return { js, hoisted: hoisted.join(' '), userFns: [...userFns] };
}

function lastDoClosed(out) {
  // Heurística: hay un "do {" abierto anteriormente
  return out.some((t) => t.doOpen);
}

function transpileFragment(toks, userFns, intVars) {
  // Traduce un fragmento (cabecera de for o sentencia suelta)
  const src = toks.map((t) => t.v).join('');
  const r = transpile(src);
  r.userFns.forEach((f) => userFns.add(f));
  return r.js;
}

function charLit(v) {
  return v; // 'a' se mantiene como cadena de un carácter
}

function splitTop(toks) {
  const parts = [];
  let cur = [], d = 0;
  for (const t of toks) {
    if (t.v === '(' || t.v === '[' || t.v === '{') d++;
    if (t.v === ')' || t.v === ']' || t.v === '}') d--;
    if (t.v === ',' && d === 0) {
      parts.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.some((t) => t.t !== 'ws')) parts.push(cur);
  return parts;
}

function postProcess(js, userFns) {
  js = js.replace(/sizeof\s*\(\s*(\w+)\s*\)\s*\/\s*sizeof\s*\(\s*\1\s*\[\s*0\s*\]\s*\)/g, '$1.length');
  js = js.replace(/sizeof\s*\(\s*(\w+)\s*\)/g, '$1.length');
  js = js.replace(/\.length\s*\(\s*\)/g, '.length');
  js = js.replace(/\bF\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/g, '$1');
  const names = [...userFns, ...ASYNC_API];
  if (names.length) {
    const re = new RegExp(`(?<![\\w.$])(?<!function\\s)(?<!await\\s)\\b(${names.join('|')})\\s*\\(`, 'g');
    js = js.replace(re, (m, name, off) => {
      // No dentro de cadenas: comprobación sencilla por comillas en la línea
      const lineStart = js.lastIndexOf('\n', off) + 1;
      const before = js.slice(lineStart, off);
      if ((before.match(/"/g) || []).length % 2 === 1) return m;
      return `await ${name}(`;
    });
  }
  return js;
}

// ---------------------------------------------------------------- ejecución
const STOP = Symbol('stop');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export const HEADER_LINES = 2;

export const CONSTANTS = {
  HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, LED_BUILTIN: 13,
  A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19,
  DEC: 10, HEX: 16, BIN: 2, OCT: 8,
  PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI,
};

// hw: interfaz con el simulador (lectura/escritura de pines, servos, sonido…)
export function createRuntime(code, hw) {
  const { js, hoisted } = transpile(code);
  let stopped = false;
  const t0 = performance.now();
  let lastYield = performance.now();
  let ticks = 0;
  const channel = new MessageChannel();
  const waiters = [];
  channel.port1.onmessage = () => waiters.shift()?.();
  const yieldNow = () => new Promise((r) => {
    waiters.push(r);
    channel.port2.postMessage(0);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = () => {
    if (stopped) throw STOP;
  };

  const pinOf = (p) => {
    p = Math.round(Number(p));
    if (!(p >= 0 && p <= 19)) throw new ArduinoError(`Pin no válido: ${p}`);
    return p;
  };

  const fmt = (v, base) => {
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') {
      if (base === 2 || base === 8 || base === 10 || base === 16) {
        if (Number.isInteger(v)) return base === 10 ? String(v) : (v < 0 ? v >>> 0 : v).toString(base).toUpperCase();
      }
      if (Number.isInteger(v)) return String(v);
      if (!isFinite(v)) return isNaN(v) ? 'nan' : 'inf';
      return v.toFixed(base != null && base >= 0 && base <= 10 ? base : 2);
    }
    return String(v);
  };

  const serialBuf = [];
  const Serial = {
    begin: (baud) => hw.serialBegin?.(baud),
    end: () => {},
    print: (v = '', base) => hw.serialWrite(fmt(v, base)),
    println: (v = '', base) => hw.serialWrite((v === '' ? '' : fmt(v, base)) + '\n'),
    write: (v) => hw.serialWrite(typeof v === 'number' ? String.fromCharCode(v) : String(v)),
    available: () => serialBuf.length,
    read: () => (serialBuf.length ? serialBuf.shift() : -1),
    peek: () => (serialBuf.length ? serialBuf[0] : -1),
    readString: () => serialBuf.splice(0).join(''),
    readStringUntil: (c) => {
      const i = serialBuf.indexOf(String(c));
      const part = i < 0 ? serialBuf.splice(0) : serialBuf.splice(0, i + 1).slice(0, -1);
      return part.join('');
    },
    parseInt: () => {
      const s = serialBuf.splice(0).join('');
      const m = /-?\d+/.exec(s);
      return m ? parseInt(m[0], 10) : 0;
    },
    parseFloat: () => {
      const s = serialBuf.splice(0).join('');
      const m = /-?\d+(\.\d+)?/.exec(s);
      return m ? parseFloat(m[0]) : 0;
    },
    flush: () => {},
    setTimeout: () => {},
  };

  class Servo {
    constructor() {
      this.pin = -1;
      this.angle = 90;
    }
    attach(pin) {
      this.pin = pinOf(pin);
      hw.servoAttach(this.pin);
      return 1;
    }
    detach() {
      this.pin = -1;
    }
    attached() {
      return this.pin >= 0;
    }
    write(a) {
      a = Number(a);
      if (a >= 500) return this.writeMicroseconds(a);
      this.angle = Math.max(0, Math.min(180, Math.round(a)));
      if (this.pin >= 0) hw.servoWrite(this.pin, this.angle);
    }
    writeMicroseconds(us) {
      this.write(((Math.max(544, Math.min(2400, us)) - 544) * 180) / (2400 - 544));
    }
    read() {
      return this.angle;
    }
  }

  const api = {
    ...CONSTANTS,
    Serial,
    Servo,
    pinMode: (p, m) => hw.pinMode(pinOf(p), m),
    digitalWrite: (p, v) => hw.digitalWrite(pinOf(p), v ? 1 : 0),
    digitalRead: (p) => hw.digitalRead(pinOf(p)),
    analogRead: (p) => {
      p = Math.round(Number(p));
      if (p >= 0 && p <= 5) p += 14;
      if (!(p >= 14 && p <= 19)) throw new ArduinoError(`analogRead sólo funciona en A0–A5 (pin ${p})`);
      return hw.analogRead(p);
    },
    analogWrite: (p, v) => hw.analogWrite(pinOf(p), Math.max(0, Math.min(255, Math.round(Number(v) || 0)))),
    delay: async (ms) => {
      check();
      ms = Math.max(0, Number(ms) || 0);
      if (ms <= 0) await yieldNow();
      else await sleep(ms / hw.speed());
      lastYield = performance.now();
      check();
    },
    delayMicroseconds: async (us) => {
      check();
      if (us >= 2000) await sleep(us / 1000 / hw.speed());
      else if (performance.now() - lastYield > 12) {
        await yieldNow();
        lastYield = performance.now();
      }
      check();
    },
    millis: () => Math.floor(hw.now()),
    micros: () => Math.floor(hw.now() * 1000),
    pulseIn: async (p, state = 1, timeout = 1000000) => {
      check();
      const us = hw.pulseIn(pinOf(p), state, timeout);
      await sleep(Math.min(us || timeout, 50000) / 1000 / hw.speed());
      check();
      return us;
    },
    tone: (p, f, d) => hw.tone(pinOf(p), Number(f) || 0, d),
    noTone: (p) => hw.noTone(pinOf(p)),
    map: (x, a, b, c, d) => Math.trunc(((x - a) * (d - c)) / (b - a) + c),
    constrain: (x, a, b) => Math.min(b, Math.max(a, x)),
    min: Math.min,
    max: Math.max,
    abs: Math.abs,
    sq: (x) => x * x,
    sqrt: Math.sqrt,
    pow: Math.pow,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    random: (a, b) => {
      if (b === undefined) [a, b] = [0, a];
      return Math.floor(a + Math.random() * (b - a));
    },
    randomSeed: () => {},
    bitRead: (v, b) => (v >> b) & 1,
    bitSet: (v, b) => v | (1 << b),
    bitClear: (v, b) => v & ~(1 << b),
    bitWrite: (v, b, x) => (x ? v | (1 << b) : v & ~(1 << b)),
    lowByte: (v) => v & 0xff,
    highByte: (v) => (v >> 8) & 0xff,
    isDigit: (c) => /[0-9]/.test(String(c)),
    __int: (v) => (typeof v === 'string' ? v : typeof v === 'boolean' ? +v : Math.trunc(v)),
    __arr: (dims, mk) => {
      const build = (k) => Array.from({ length: Math.max(0, Math.floor(dims[k])) }, () => (k + 1 < dims.length ? build(k + 1) : mk()));
      return build(0);
    },
    __tick: async () => {
      check();
      if (++ticks % 500 === 0 || performance.now() - lastYield > 12) {
        await yieldNow();
        lastYield = performance.now();
        check();
      }
    },
  };
  // Métodos de String de Arduino
  if (!String.prototype.toInt) {
    Object.defineProperty(String.prototype, 'toInt', { value() { return parseInt(this, 10) || 0; } });
    Object.defineProperty(String.prototype, 'toFloat', { value() { return parseFloat(this) || 0; } });
    Object.defineProperty(String.prototype, 'equals', { value(o) { return String(this) === String(o); } });
  }

  const names = Object.keys(api);
  const body = `"use strict"; ${hoisted}\n${js}\nreturn { setup: typeof setup === 'function' ? setup : null, loop: typeof loop === 'function' ? loop : null };`;
  let fn;
  try {
    fn = new AsyncFunction(...names, body);
  } catch (err) {
    // acorn da la línea exacta del error de sintaxis
    let line = null;
    try {
      acornParse(body, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    } catch (e2) {
      if (e2.loc) line = Math.max(1, e2.loc.line - 1);
    }
    throw new ArduinoError(explainSyntax(err, code), line);
  }

  return {
    async run(onError) {
      try {
        const prog = await fn(...names.map((k) => api[k]));
        if (!prog.setup && !prog.loop) throw new ArduinoError('El programa no tiene las funciones setup() ni loop().');
        if (prog.setup) await prog.setup();
        while (!stopped) {
          if (prog.loop) await prog.loop();
          else await sleep(50);
          ticks = 0;
          if (performance.now() - lastYield > 8) {
            await yieldNow();
            lastYield = performance.now();
          }
        }
      } catch (err) {
        if (err !== STOP) onError?.(translateRuntimeError(err));
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    },
    stop() {
      stopped = true;
    },
    serialInput(text) {
      for (const ch of text) serialBuf.push(ch);
    },
  };
}

function explainSyntax(err) {
  return 'Error de sintaxis: ' + (err.message || err).replace('Unexpected token', 'símbolo inesperado').replace('missing ) after argument list', 'falta un ")"');
}

function translateRuntimeError(err) {
  if (err instanceof ArduinoError) return err;
  const msg = String(err?.message || err);
  const m = /<anonymous>:(\d+)/.exec(err?.stack || '');
  const line = m ? Math.max(1, +m[1] - HEADER_LINES - 1) : null;
  let nice = msg;
  const nd = /^(\w+) is not defined$/.exec(msg);
  if (nd) nice = `"${nd[1]}" no está definido (¿falta declararlo o es una función que el simulador aún no soporta?)`;
  const nf = /^(.+) is not a function$/.exec(msg);
  if (nf) nice = `${nf[1]} no es una función`;
  return new ArduinoError(nice, line);
}
