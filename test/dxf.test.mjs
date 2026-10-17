import { entitiesToDXF, dxfToEntities } from '../src/sketch.js';
import { buildRegions } from '../src/geometry.js';
const ents = [{t:'rect',x:0,y:0,w:40,h:20},{t:'circle',x:10,y:10,r:3},{t:'slot',x1:20,y1:10,x2:32,y2:10,r:3},{t:'ngon',x:5,y:5,r:2,n:6,a:90}];
const dxf = entitiesToDXF(ents);
const back = dxfToEntities(dxf);
console.log('roundtrip', back.map(e=>e.t+(e.pts?':'+e.pts.length:'')).join(' '));
const regions = buildRegions(back, 32);
console.log('regions', regions.length, 'holes', regions[0].holes.length);
// LWPOLYLINE with bulge (rounded corner) as AutoCAD writes it
const lw = ['0','SECTION','2','ENTITIES','0','LWPOLYLINE','8','0','90','4','70','1','10','0','20','0','42','0','10','10','20','0','42','1','10','10','20','10','42','0','10','0','20','10','0','ENDSEC','0','EOF'].join('\r\n');
const r = dxfToEntities(lw); console.log('lwpoly', r.length, r[0].t, r[0].pts.length);
