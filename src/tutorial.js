// Tutorial de inicio: guía paso a paso para modelar la primera pieza.
// Cada paso comprueba el estado de la aplicación y avanza solo al completarse.
import { buildRegions } from './geometry.js';
import { h, storageSet } from './util.js';
import { icon } from './icons.js';

const rb = (label) => [...document.querySelectorAll(`.rbtn[data-label="${label}"]`)];
const byText = (sel, text) => [...document.querySelectorAll(sel)].filter((b) => b.textContent.trim().startsWith(text));

function hasType(nodes, type) {
  return nodes.some((n) => n.type === type || (n.children && hasType(n.children, type)));
}

const STEPS = [
  {
    title: 'Bienvenido a MiniCAD',
    body: `<p>En unos 5 minutos vas a modelar tu primera pieza: una <b>placa de 80 × 50 × 10 mm</b> con esquinas redondeadas y un agujero.</p>
      <p>Es el flujo de trabajo de casi todos los programas CAD (SolidWorks, Fusion 360, Inventor, AutoCAD 3D):</p>
      <ol><li>Dibujar un <b>croquis</b> 2D sobre un plano.</li><li>Convertirlo en un sólido 3D con una <b>operación</b> (extruir, revolución…).</li><li>Medir, guardar y exportar.</li></ol>
      <p class="muted">Cada paso se marca solo cuando lo completas. También puedes pulsar <b>Siguiente</b>.</p>`,
    extra: (app, t) =>
      app.doc.nodes.length
        ? h('button', { class: 'wide', onclick: async () => { await app.newDoc(); t.focusViewport(); }, html: icon('new', 16) + ' Empezar con un modelo vacío' })
        : null,
  },
  {
    title: 'Muévete por la vista',
    body: `<ul><li><b>Arrastrar con el botón izquierdo</b>: girar.</li><li><b>Arrastrar con el botón derecho</b>: desplazar.</li><li><b>Rueda</b>: zoom hacia el cursor.</li></ul>
      <p>Las teclas <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> ponen las vistas Frontal, Superior, Derecha e Isométrica, y <kbd>F</kbd> ajusta todo a la pantalla.</p>
      <p class="muted">Prueba a girar la vista.</p>`,
    enter: (app, t) => (t.cam0 = app.viewer.camera.position.clone()),
    check: (app, t) => t.cam0 && app.viewer.camera.position.distanceTo(t.cam0) > 1,
  },
  {
    title: 'Crea un croquis',
    body: `<p>Un <b>croquis</b> es un dibujo 2D sobre un plano. Es la base de casi todas las piezas.</p>
      <p>Pulsa <b>Croquis</b> (o la tecla <kbd>K</kbd>) y elige <b>Planta (XZ)</b>, que es el plano del suelo.</p>
      <p class="muted">Más adelante podrás hacer clic directamente sobre la cara de un sólido para dibujar encima.</p>`,
    glow: () => [...rb('Croquis'), ...byText('.banner button', 'Planta')],
    check: (app) => app.mode === 'sketch',
  },
  {
    title: 'Dibuja un rectángulo',
    body: `<p>Elige <b>Rectángulo</b> (<kbd>R</kbd>) y haz clic en el <b>origen</b>, donde se cruzan los ejes rojo y verde. Un cuadrado naranja indica que el punto se ha ajustado.</p>
      <p>Ahora, sin hacer clic, <b>escribe <kbd>80x50</kbd> y pulsa Enter</b>. Así obtienes una medida exacta.</p>
      <p class="muted">Como en AutoCAD, también puedes escribir los puntos: <b>-40,-25</b> Enter para la primera esquina y <b>@80,50</b> Enter para la opuesta.</p>`,
    glow: (app) => (app.mode === 'sketch' ? rb('Rectángulo') : rb('Croquis')),
    check: (app) => app.mode === 'sketch' && app.sketcher.entities.some((e) => e.t === 'rect' || e.t === 'poly'),
  },
  {
    title: 'Redondea las esquinas',
    body: `<p>Elige <b>Empalme</b> (<kbd>F</kbd>). Escribe <kbd>8</kbd> y Enter para fijar el radio.</p>
      <p>Pasa el ratón por una esquina: verás en verde cómo quedará. Haz clic para aplicarlo.</p>
      <p class="muted">Para redondear todas a la vez: selecciona el rectángulo y pulsa <b>Redondear esquinas</b> en el panel derecho. <b>Chaflán</b> (<kbd>H</kbd>) corta la esquina en bisel.</p>`,
    glow: () => rb('Empalme'),
    check: (app) => app.mode === 'sketch' && app.sketcher.entities.some((e) => (e.t === 'rect' && e.rr > 0) || (e.t === 'poly' && e.pts.length > 4)),
  },
  {
    title: 'Haz un agujero',
    body: `<p>Elige <b>Círculo</b> (<kbd>C</kbd>), haz clic en el centro de la placa (el ajuste marca el punto central) y escribe <kbd>10</kbd> Enter para el radio.</p>
      <p>Un perfil dentro de otro se convierte en <b>agujero</b>: fíjate en que el relleno azul desaparece dentro del círculo.</p>`,
    glow: () => rb('Círculo'),
    check: (app) => {
      if (app.mode !== 'sketch') return false;
      try {
        return buildRegions(app.sketcher.entities, 32).some((r) => r.holes.length);
      } catch {
        return false;
      }
    },
  },
  {
    title: 'Cotas y medidas exactas',
    body: `<p>Las <b>cotas</b> muestran las medidas de cada entidad (actívalas o desactívalas con <kbd>D</kbd>).</p>
      <p>Elige <b>Seleccionar</b> (<kbd>S</kbd>) y haz clic en el círculo. En el panel derecho puedes escribir cualquier medida: radio, centro… Los campos aceptan operaciones como <b>50/2</b>.</p>
      <p class="muted">Desde ahí también tienes Simetría, Mover, Girar y Matriz para copiar entidades.</p>`,
    glow: () => rb('Seleccionar'),
    check: (app) => app.mode === 'sketch' && app.sketcher.selected >= 0,
  },
  {
    title: 'Extruye el croquis',
    body: `<p>Pulsa <b>Extruir</b>. Pon la <b>Profundidad</b> en <kbd>10</kbd> mm y confirma con <b>✓</b> (o Enter).</p>
      <p>La vista previa en verde muestra el sólido antes de crearlo. Para hacer agujeros en una pieza que ya existe, dibuja sobre su cara y elige <b>Corte</b>.</p>`,
    glow: () => [...rb('Extruir'), ...document.querySelectorAll('.form-head .okbtn')],
    check: (app) => app.mode !== 'sketch' && hasType(app.doc.nodes, 'extrude'),
  },
  {
    title: 'Revisa tu pieza',
    body: `<ul><li>Pulsa <kbd>4</kbd> para la vista isométrica.</li>
      <li>Haz clic en la pieza: en el panel derecho cambias su color y posición. <kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd> la mueven, giran o escalan.</li>
      <li>En la pestaña <b>Evaluar</b>, <b>Prop. físicas</b> te da el volumen y la masa, y <b>Medir</b> (<kbd>M</kbd>) mide distancias.</li>
      <li><b>Doble clic</b> en la pieza vuelve a abrir su croquis: los cambios se aplican al sólido.</li></ul>`,
    glow: () => byText('.tab', 'Evaluar'),
  },
  {
    title: '¡Guarda tu trabajo!',
    body: `<p><kbd>Ctrl</kbd>+<kbd>S</kbd> guarda el proyecto (<b>.mcad</b>). El botón <b>Exportar</b> de la barra superior crea <b>STL</b> para impresión 3D u <b>OBJ</b>. Dentro de un croquis puedes exportarlo a <b>DXF</b> para AutoCAD.</p>
      <p>Ya conoces el flujo básico. Siguientes ideas: prueba <b>Revolución</b> para piezas redondas, o abre el <b>modelo de ejemplo</b> para ver cómo está hecho.</p>
      <p class="muted">En la Ayuda (<kbd>F1</kbd>) tienes todos los atajos y la tabla de comandos de AutoCAD.</p>`,
    glow: () => [...document.querySelectorAll('.qa[title^="Exportar"], .qa[title^="Guardar"]')],
  },
];

export class Tutorial {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.glowing = [];
  }

  start(i = 0) {
    if (!this.card) {
      this.card = h('div', { class: 'tour floating' });
      this.app.el.viewport.append(this.card);
    }
    this.active = true;
    this.card.style.display = 'block';
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 300);
    this.go(i);
  }

  stop(finished = false) {
    this.active = false;
    clearInterval(this.timer);
    clearTimeout(this.advance);
    this.setGlow([]);
    if (this.card) this.card.style.display = 'none';
    if (finished) storageSet('minicad.tutorial', { done: true });
    this.focusViewport();
  }

  focusViewport() {
    this.app.viewer.renderer.domElement.focus({ preventScroll: true });
  }

  go(i) {
    clearTimeout(this.advance);
    this.i = Math.max(0, Math.min(STEPS.length - 1, i));
    this.completed = false;
    const s = STEPS[this.i];
    s.enter?.(this.app, this);
    this.render();
    this.poll();
  }

  render() {
    const s = STEPS[this.i];
    const last = this.i === STEPS.length - 1;
    const btn = (label, fn, cls = '') =>
      h('button', { class: cls, onclick: () => { fn(); this.focusViewport(); } }, label);
    this.done = h('div', { class: 'tour-done', html: icon('check', 16) + ' ¡Hecho!' });
    const parts = [
      h(
        'div',
        { class: 'tour-head' },
        h('span', { html: icon('school', 16) }),
        h('span', { class: 'tour-step' }, `Tutorial · paso ${this.i + 1} de ${STEPS.length}`),
        h('button', { class: 'ghost', title: 'Cerrar el tutorial', onclick: () => this.stop(), html: icon('x', 16) })
      ),
      h('div', { class: 'tour-bar' }, h('i', { style: { width: `${((this.i + 1) / STEPS.length) * 100}%` } })),
      h('h3', null, s.title),
      h('div', { class: 'tour-body', html: s.body }),
      s.extra?.(this.app, this),
      this.done,
      h(
        'div',
        { class: 'tour-foot' },
        this.i ? btn('Anterior', () => this.go(this.i - 1)) : null,
        h('span', { class: 'grow' }),
        last ? btn('Terminar', () => this.stop(true), 'primary') : btn('Siguiente', () => this.go(this.i + 1), 'primary')
      ),
    ];
    this.card.replaceChildren(...parts.filter(Boolean));
  }

  setGlow(els) {
    for (const e of this.glowing) if (!els.includes(e)) e.classList.remove('tour-glow');
    for (const e of els) e.classList.add('tour-glow');
    this.glowing = els;
  }

  poll() {
    if (!this.active) return;
    const s = STEPS[this.i];
    // La cinta se vuelve a dibujar a menudo: se resalta de nuevo en cada comprobación
    this.setGlow(this.completed ? [] : s.glow?.(this.app) || []);
    if (this.completed || !s.check) return;
    let ok = false;
    try {
      ok = !!s.check(this.app, this);
    } catch {
      ok = false;
    }
    if (!ok) return;
    this.completed = true;
    this.done.style.display = 'flex';
    this.setGlow([]);
    if (this.i < STEPS.length - 1) this.advance = setTimeout(() => this.go(this.i + 1), 1200);
  }
}
