'use strict';
// Compara el motor actual contra la referencia congelada por snapshot.js.
// Si no querias cambiar comportamiento, esto debe dar 20/20.

const fs = require('fs');
const { runEra } = require('./engine');
const { serializarEra, RUTA } = require('./snapshot');
const cfg = require('./best-config.json');

if (!fs.existsSync(RUTA)) {
  console.error(`No hay referencia en ${RUTA}.\nCongelala antes de tocar el motor:  node snapshot.js`);
  process.exit(1);
}
const ref = JSON.parse(fs.readFileSync(RUTA, 'utf8'));

let iguales = 0, distintas = 0;
const fallos = [];
for (const sd in ref) {
  const b = serializarEra(runEra(sd, cfg));
  const a = ref[sd].eventos;
  if (a.length === b.length && a.every((x, i) => x === b[i])) { iguales++; continue; }
  distintas++;
  const i = a.findIndex((x, k) => x !== b[k]);
  fallos.push({ semilla: sd, refN: a.length, nuevoN: b.length,
    primeraDif: i < 0 ? '(solo longitud)' : { ref: a[i], nuevo: b[i] } });
}
console.log(`iguales ${iguales}/${iguales + distintas}`);
if (fallos.length) console.log(JSON.stringify(fallos.slice(0, 3), null, 1));
process.exit(fallos.length ? 1 : 0);
