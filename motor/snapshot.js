'use strict';
// Congela N eras de referencia. Esta es la red de seguridad del motor:
// antes de tocar engine.js se corre esto, y despues `node comparar.js`.
// Un refactor que no pretende cambiar comportamiento debe dar 20/20.

const fs = require('fs');
const path = require('path');
const { runEra } = require('./engine');

const RUTA = path.join(__dirname, 'referencia.json');

// Serializacion de una era a lineas comparables.
// Vive aqui y la usa tambien comparar.js: si cada uno serializara por su cuenta,
// una diferencia entre los dos daria fallos fantasma imposibles de rastrear.
function serializarEra(r) {
  return r.events.filter(e => e.mag >= 2).map(e => [
    e.tick, e.type,
    (e.actors || []).map(a => r.people[a] ? r.people[a].name : '').join('+'),
    e.tribes.map(t => { const x = r.tribes.find(y => y.id === t); return x ? x.name : t; }).join('+'),
    JSON.stringify(e.payload),
  ].join('|'));
}

function semillasReferencia(n) {
  const s = [];
  for (let i = 0; i < n; i++) s.push('ref-' + i);
  return s;
}

function congelar(cfg, n) {
  const ref = {};
  for (const sd of semillasReferencia(n)) {
    ref[sd] = { eventos: serializarEra(runEra(sd, cfg)) };
  }
  return ref;
}

module.exports = { serializarEra, semillasReferencia, congelar, RUTA };

if (require.main === module) {
  const n = parseInt(process.argv[2] || '20', 10);
  const cfg = require('./best-config.json');
  const ref = congelar(cfg, n);
  fs.writeFileSync(RUTA, JSON.stringify(ref));
  const total = Object.values(ref).reduce((a, e) => a + e.eventos.length, 0);
  console.log(`Congeladas ${n} eras (${total} eventos de magnitud >= 2) en ${RUTA}`);
  console.log('Haz tus cambios y luego:  node comparar.js');
}
