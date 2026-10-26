// Panel inferior: editor de código Arduino (con resaltado) y Monitor serie.
import { h } from '../util.js';
import { icon } from '../icons.js';

const KW_TYPES = /\b(void|int|long|float|double|bool|boolean|byte|char|short|word|unsigned|signed|const|static|volatile|String|Servo|size_t|u?int(8|16|32|64)_t)\b/;
const KW_CTRL = /\b(if|else|for|while|do|switch|case|break|continue|return|default|true|false|HIGH|LOW|INPUT|OUTPUT|INPUT_PULLUP|LED_BUILTIN|A[0-5])\b/;
const KW_FN = /\b(setup|loop|pinMode|digitalWrite|digitalRead|analogWrite|analogRead|delay|delayMicroseconds|millis|micros|pulseIn|tone|noTone|map|constrain|random|Serial|attach|write|read|print|println|begin|available)\b/;

function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function highlight(src) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(#\w+[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const t = m[0];
    let cls = '';
    if (m[1]) cls = 'c';
    else if (m[2]) cls = 's';
    else if (m[3]) cls = 'p';
    else if (m[4]) cls = 'n';
    else if (KW_TYPES.test(t) && KW_TYPES.exec(t)[0] === t) cls = 't';
    else if (KW_CTRL.test(t) && KW_CTRL.exec(t)[0] === t) cls = 'k';
    else if (KW_FN.test(t) && KW_FN.exec(t)[0] === t) cls = 'f';
    out += cls ? `<span class="hl-${cls}">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
  }
  return out + esc(src.slice(last)) + '\n';
}

export class CodePanel {
  constructor(elec, examples) {
    this.elec = elec;
    this.app = elec.app;
    this.examples = examples;
    this.tab = 'code';
    this.height = 260;
    this.build();
  }

  build() {
    const tabBtn = (id, ic, label) =>
      h('button', { class: 'ptab', 'data-tab': id, onclick: () => this.show(id), html: icon(ic, 15) + `<span>${label}</span>` });
    this.runBtn = h('button', { class: 'runbtn', onclick: () => this.elec.toggleSim() });
    this.status = h('span', { class: 'cp-status' });
    this.exSel = h(
      'select',
      { class: 'cp-ex', title: 'Proyectos de ejemplo', onchange: (e) => { const id = e.target.value; e.target.value = ''; if (id) this.elec.loadExample(id); } },
      h('option', { value: '' }, 'Ejemplos…'),
      this.examples.map((x) => h('option', { value: x.id }, x.label))
    );
    const head = h(
      'div',
      { class: 'cp-head' },
      tabBtn('code', 'code', 'Código'),
      tabBtn('serial', 'serial', 'Monitor serie'),
      h('span', { class: 'grow' }),
      this.status,
      this.exSel,
      this.runBtn,
      h('button', { class: 'cp-close', title: 'Ocultar panel', onclick: () => this.hide(), html: icon('x', 16) })
    );
    // Editor
    this.gutter = h('div', { class: 'cp-gutter' });
    this.pre = h('pre', { class: 'cp-hl', 'aria-hidden': 'true' });
    this.ta = h('textarea', { class: 'cp-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
    this.ta.addEventListener('input', () => this.onInput());
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('blur', () => this.app.commit('Editar código'));
    this.errBar = h('div', { class: 'cp-err' });
    this.errBar.addEventListener('click', () => this.gotoLine(this.errLine));
    this.codePane = h('div', { class: 'cp-pane code' }, h('div', { class: 'cp-editor' }, this.gutter, h('div', { class: 'cp-area' }, this.pre, this.ta)), this.errBar);
    // Monitor serie
    this.out = h('pre', { class: 'cp-serial' });
    this.input = h('input', { class: 'cp-in', placeholder: 'Escribe y pulsa Enter para enviar al Arduino…' });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.send();
    });
    this.autoscroll = h('input', { type: 'checkbox', checked: true });
    this.serialPane = h(
      'div',
      { class: 'cp-pane serial' },
      this.out,
      h(
        'div',
        { class: 'cp-sbar' },
        this.input,
        h('button', { onclick: () => this.send() }, 'Enviar'),
        h('label', null, this.autoscroll, ' Autodesplazar'),
        h('button', { onclick: () => this.clearSerial() }, 'Limpiar')
      )
    );
    this.grip = h('div', { class: 'cp-grip', title: 'Arrastra para cambiar la altura' });
    this.grip.addEventListener('pointerdown', (e) => this.startResize(e));
    this.el = h('div', { class: 'codepanel' }, this.grip, head, this.codePane, this.serialPane);
    this.el.style.display = 'none';
    // El panel ocupa espacio bajo el visor (no lo tapa)
    const vp = this.app.el.viewport;
    const col = h('div', { class: 'center-col' });
    vp.parentNode.insertBefore(col, vp);
    col.append(vp, this.el);
    this.serialText = '';
    this.setRunning(false);
    this.show('code', false);
  }

  // ------------------------------------------------------------ visibilidad
  get visible() {
    return this.el.style.display !== 'none';
  }

  open(tab = this.tab) {
    this.el.style.display = 'flex';
    this.el.style.height = this.height + 'px';
    this.show(tab);
    this.refreshCode();
  }

  hide() {
    this.el.style.display = 'none';
    this.app.renderRibbon();
  }

  toggle(tab) {
    if (this.visible && this.tab === tab) this.hide();
    else this.open(tab);
  }

  show(tab, focus = true) {
    this.tab = tab;
    for (const b of this.el.querySelectorAll('.ptab')) b.classList.toggle('on', b.dataset.tab === tab);
    this.codePane.style.display = tab === 'code' ? 'flex' : 'none';
    this.serialPane.style.display = tab === 'serial' ? 'flex' : 'none';
    if (tab === 'serial') this.out.scrollTop = this.out.scrollHeight;
    if (focus && tab === 'code' && this.visible) this.ta.focus({ preventScroll: true });
    if (this.app.elec) this.app.renderRibbon();
  }

  startResize(e) {
    const y0 = e.clientY, h0 = this.el.offsetHeight;
    const max = this.app.el.viewport.clientHeight + this.el.offsetHeight - 120;
    const move = (ev) => {
      this.height = Math.max(120, Math.min(max, h0 + (y0 - ev.clientY)));
      this.el.style.height = this.height + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------ editor
  // El editor escribe en doc.code en cada pulsación, así que cualquier
  // diferencia viene de fuera (deshacer, abrir archivo, ejemplo…)
  refreshCode() {
    const code = this.app.doc.code || '';
    if (this.ta.value !== code) {
      this.ta.value = code;
      this.ta.setSelectionRange(0, 0);
      this.ta.scrollTop = 0;
      this.clearError();
      this.render();
    } else if (!this.pre.innerHTML) this.render();
  }

  render() {
    const v = this.ta.value;
    this.pre.innerHTML = highlight(v);
    const lines = v.split('\n').length;
    if (this.gutter.childElementCount !== lines) {
      this.gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<div${i + 1 === this.errLine ? ' class="bad"' : ''}>${i + 1}</div>`).join('');
    }
    this.syncScroll();
  }

  syncScroll() {
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  onInput() {
    this.app.doc.code = this.ta.value;
    this.app.dirty = true;
    this.app.autosave();
    this.clearError();
    this.render();
  }

  onKey(e) {
    const ta = this.ta;
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    } else if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      let indent = /^\s*/.exec(line)[0];
      if (/\{\s*$/.test(line)) indent += '  ';
      document.execCommand('insertText', false, '\n' + indent);
    } else if (e.key === '}') {
      // Quita un nivel de sangría al cerrar llave
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      if (/^\s{2,}$/.test(line)) {
        e.preventDefault();
        ta.setSelectionRange(ta.selectionStart - 2, ta.selectionStart);
        document.execCommand('insertText', false, '}');
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.app.commit('Editar código');
      this.app.saveDoc();
    } else if ((e.ctrlKey && e.key === 'Enter') || e.key === 'F5') {
      e.preventDefault();
      this.elec.toggleSim();
    }
    e.stopPropagation();
  }

  gotoLine(line) {
    if (!line) return;
    this.open('code');
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + (lines[line - 1]?.length || 0));
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 18;
    this.ta.scrollTop = Math.max(0, (line - 4) * lh);
  }

  showError(err) {
    this.errLine = err.line || null;
    this.errBar.innerHTML = icon('warn', 15) + `<span>${err.line ? `Línea ${err.line}: ` : ''}${esc(err.message || String(err))}</span>`;
    this.errBar.style.display = 'flex';
    this.gutter.innerHTML = '';
    this.render();
    this.open('code');
  }

  clearError() {
    if (!this.errLine && this.errBar.style.display !== 'flex') return;
    this.errLine = null;
    this.errBar.style.display = 'none';
    this.gutter.innerHTML = '';
  }

  // ------------------------------------------------------------ monitor serie
  appendSerial(s) {
    this.serialText += s;
    if (this.serialText.length > 60000) this.serialText = this.serialText.slice(-40000);
    if (!this._pend) {
      this._pend = true;
      requestAnimationFrame(() => {
        this._pend = false;
        this.out.textContent = this.serialText;
        if (this.autoscroll.checked) this.out.scrollTop = this.out.scrollHeight;
      });
    }
  }

  clearSerial() {
    this.serialText = '';
    this.out.textContent = '';
  }

  send() {
    const t = this.input.value;
    if (!this.elec.sim.running || !this.elec.sim.runtime) {
      this.status.textContent = 'Inicia la simulación para enviar datos';
      return;
    }
    this.elec.sim.runtime.serialInput(t + '\n');
    this.appendSerial(`> ${t}\n`);
    this.input.value = '';
  }

  setRunning(on) {
    this.runBtn.innerHTML = on ? icon('stop', 15) + '<span>Detener</span>' : icon('play', 15) + '<span>Simular</span>';
    this.runBtn.classList.toggle('on', on);
    this.status.textContent = on ? 'Simulando…' : '';
    this.el.classList.toggle('running', on);
  }
}
