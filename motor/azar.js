'use strict';
// EL AZAR DETERMINISTA, EN UN SOLO SITIO.
//
// Vivia dentro de `engine.js` y lo usa tambien `mesa.js`, que necesita un hilo
// propio sembrado del dia. Requerir el motor desde la mesa y la mesa desde el
// motor es un ciclo, y Node lo resuelve a medias: el segundo en cargarse recibe
// los `exports` del primero A MEDIO LLENAR, asi que `hashSeed` podia salir
// `undefined` segun el orden de los `require`. No es un fallo que avise: es un
// fallo que aparece el dia que alguien cambia un import de sitio.
//
// Asi que las dos funciones viven aqui y las dos las piden de aqui. Un solo
// generador para todo el proyecto, que ademas es la regla 1: dos hilos de azar
// "equivalentes" acabarian no siendolo.
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
module.exports = { hashSeed, mulberry32 };
