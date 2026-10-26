import { solve, elementCurrent } from '../src/elec/circuit.js';
const ok = (name, got, exp, tol=0.02) => console.log((Math.abs(got-exp) <= tol*Math.max(1,Math.abs(exp)) ? 'OK  ' : 'FAIL') + ' ' + name + ' = ' + got.toFixed(4) + ' (esperado ' + exp + ')');
// 1) 5V - 220R - LED rojo - GND  (nodos: 0 gnd, 1 = 5V, 2 = medio)
let els = [{k:'V',p:1,n:0,v:5,r:0.05},{k:'R',a:1,b:2,r:220},{k:'D',a:2,c:0,vf:1.8,rs:12}];
let v = solve(3, 0, els); ok('I LED (mA)', elementCurrent(els[2], v)*1000, (5-1.8)/(220+12+0.05)*1000);
// 2) divisor 10k/10k
els = [{k:'V',p:1,n:0,v:5,r:0.05},{k:'R',a:1,b:2,r:10000},{k:'R',a:2,b:0,r:10000}];
v = solve(3,0,els); ok('divisor', v[2], 2.5);
// 3) LED al revés: no conduce
els = [{k:'V',p:1,n:0,v:5,r:0.05},{k:'R',a:1,b:2,r:220},{k:'D',a:0,c:2,vf:1.8,rs:12}];
v = solve(3,0,els); ok('LED inverso', elementCurrent(els[2], v), 0);
// 4) NPN 2N2222: base 5V via 1k, colector: 9V - motor 8R, emisor GND. nodos: 0 gnd, 1 5V, 2 base, 3 9V, 4 colector
els = [{k:'V',p:1,n:0,v:5,r:0.05},{k:'R',a:1,b:2,r:1000},{k:'V',p:3,n:0,v:9,r:1.5},{k:'R',a:3,b:4,r:8},{k:'Q',b:2,c:4,e:0,vbe:0.65,beta:120}];
v = solve(5,0,els); // con 1 kΩ en la base, β·Ib (~510 mA) no basta para saturar un motor de ~1 A: zona activa
ok('Ic limitada por beta (mA)', elementCurrent(els[4],v)*1000, 120*(5-0.65)/(1000+25)*1000, 0.03); console.log('   modo', els[4].mode);
// 4b) mismo motor con TIP120 (Darlington, beta 1000): satura
els = [{k:'V',p:1,n:0,v:5,r:0.05},{k:'R',a:1,b:2,r:1000},{k:'V',p:3,n:0,v:9,r:1.5},{k:'R',a:3,b:4,r:8},{k:'Q',b:2,c:4,e:0,vbe:1.4,beta:1000}];
v = solve(5,0,els); ok('TIP120 saturado Vce', v[4], 0.15+0.3*elementCurrent(els[4],v), 0.05); console.log('   modo', els[4].mode, 'Ic(mA)', (elementCurrent(els[4],v)*1000).toFixed(0));
// 5) NPN activa: base con 100k → Ib ~ 43uA → Ic ~ 5.2mA
els = [{k:'V',p:1,n:0,v:5,r:0.05},{k:'R',a:1,b:2,r:100000},{k:'V',p:3,n:0,v:9,r:1.5},{k:'R',a:3,b:4,r:100},{k:'Q',b:2,c:4,e:0,vbe:0.65,beta:120}];
v = solve(5,0,els); ok('Ic activa (mA)', elementCurrent(els[4],v)*1000, 120*(5-0.65)/(100000+25)*1000, 0.05); console.log('   mode', els[4].mode);
// 6) circuito flotante sin referencia: no debe dar NaN
els = [{k:'R',a:1,b:2,r:100}]; v = solve(3,0,els); console.log(Number.isFinite(v[1]) ? 'OK   flotante finito' : 'FAIL flotante');
