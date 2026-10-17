import * as THREE from 'three';
import { initManifold } from '../src/csg.js';
import { getGeometry, bakeGeometry, nodeMatrix, csgCombine, massProps } from '../src/geometry.js';
import { ADDITION } from '../src/csg.js';
await initManifold();
const ctx = { seg: 48, meshStore: new Map() };
const N = (type, params, extra={}) => ({ id:'x', type, params, pos:[0,0,0], rot:[0,0,0], scl:[1,1,1], ...extra });
const plate = N('extrude', {profiles:[{t:'rect',x:-50,y:-30,w:100,h:60},{t:'circle',x:-35,y:-15,r:5},{t:'circle',x:35,y:-15,r:5},{t:'circle',x:-35,y:15,r:5},{t:'circle',x:35,y:15,r:5},{t:'slot',x1:-15,y1:0,x2:15,y2:0,r:6}], depth:8, dir:1, extra:0},{rot:[-90,0,0], pos:[0,0,60]});
const boss = N('tube', {ro:14, ri:8, h:30},{pos:[0,23,35]});
const gp = bakeGeometry(getGeometry(plate, ctx), nodeMatrix(plate));
const gb = bakeGeometry(getGeometry(boss, ctx), nodeMatrix(boss));
for (let k=0;k<3;k++){ const t=performance.now(); const r = csgCombine([gp, gb], ADDITION); console.log('manifold union', (performance.now()-t).toFixed(1)+'ms', massProps(r, new THREE.Matrix4()).volume.toFixed(1), 'tris', r.attributes.position.count/3); }
// stress: many holes
const profiles=[{t:'rect',x:-100,y:-100,w:200,h:200}]; for(let i=0;i<10;i++)for(let j=0;j<10;j++) profiles.push({t:'circle',x:-90+i*20,y:-90+j*20,r:4});
let t=performance.now(); const big = getGeometry(N('extrude',{profiles,depth:5,dir:1}),ctx); console.log('100 holes extrude', (performance.now()-t).toFixed(0)+'ms', big.attributes.position.count/3);
const s = N('sphere',{r:60},{pos:[0,0,0]});
t=performance.now(); const r2=csgCombine([bakeGeometry(big,new THREE.Matrix4()), bakeGeometry(getGeometry(s,ctx), new THREE.Matrix4())], ADDITION); console.log('plate+sphere', (performance.now()-t).toFixed(0)+'ms', r2.attributes.position.count/3);
