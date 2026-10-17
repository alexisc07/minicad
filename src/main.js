import './style.css';
import { App } from './app.js';
import { initManifold } from './csg.js';
import wasmBinary from 'manifold-3d/manifold.wasm';

// La librería CSG usa una opción obsoleta de three-mesh-bvh que avisa en cada operación
const warn = console.warn.bind(console);
console.warn = (...a) => {
  if (typeof a[0] === 'string' && a[0].includes('maxLeafSize')) return;
  warn(...a);
};

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await initManifold(wasmBinary);
    window.minicad = new App(document.getElementById('app'));
  } catch (err) {
    console.error(err);
    document.getElementById('app').innerHTML =
      '<div style="padding:40px;font-family:system-ui">No se pudo iniciar MiniCAD. Tu navegador necesita WebGL (usa Edge o Chrome actualizados).<br><br><code>' +
      String(err && err.message) + '</code></div>';
  }
});
