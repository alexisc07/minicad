// Empaqueta MiniCAD en un único archivo HTML que se abre con doble clic
// (sin servidor ni instalación).
import { build } from 'esbuild';
import { writeFileSync, statSync } from 'node:fs';

const dev = process.argv.includes('--dev');

const res = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: !dev,
  format: 'iife',
  target: ['chrome100', 'edge100', 'firefox100'],
  write: false,
  outdir: 'out',
  legalComments: 'none',
  loader: { '.wasm': 'binary' },
  external: ['node:*'],
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
});

let js = '', css = '';
for (const f of res.outputFiles) {
  if (f.path.endsWith('.js')) js = f.text;
  if (f.path.endsWith('.css')) css = f.text;
}

const safeJs = js.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiniCAD 3D</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%232563eb' stroke-width='2' stroke-linejoin='round'%3E%3Cpath d='M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5'/%3E%3C/svg%3E">
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${safeJs}</script>
</body>
</html>
`;
writeFileSync('MiniCAD.html', html);
const kb = (statSync('MiniCAD.html').size / 1024).toFixed(0);
console.log(`MiniCAD.html generado (${kb} KB)`);
