'use strict';
// LA MESA DE LA ASAMBLEA: que se puede pedir HOY.
//
// El banco es grande y la mesa pequenia. Cada dia salen cinco opciones de las
// dieciocho, y rotan. Asi el lector elige entre pocas cosas -decide de verdad- y
// el menu de maniana no es el de hoy.
//
// TRES REGLAS QUE NO SE PUEDEN ROMPER, y las tres salen del trato con el lector:
//
// 1. LA MESA ES REPRODUCIBLE. Sale de la semilla y del dia, nunca de un sorteo
//    al servir la pagina. Si el menu no se puede recalcular, la era tampoco.
//
// 2. EL SORTEO VA EN UN HILO APARTE. El motor tiene un solo hilo de azar y cada
//    llamada lo avanza; sortear la mesa con EL significaria que cambiar maniana
//    la receta -un asiento mas, otro orden- recoloca toda la era, cada nacimiento
//    y cada muerte posterior. Con hilo propio no se desplaza nada, y ademas
//    cualquiera puede calcular el sorteo de un dia sin reproducir la era: le
//    basta la semilla y el dia.
//
//    OJO: AQUI DECIA "la receta se puede tocar sin mover el mundo, y la huella lo
//    demuestra", Y ES FALSO. Se comprobo el 15 de septiembre probando pesos en el
//    sorteo: la huella salto. El motivo esta a la vista en `engine.js` -cuando no
//    vota nadie, `opcion = MENU[...]` elige DE LA MESA, asi que otra mesa es otra
//    eleccion ciega y otro mundo-. Lo que el hilo aparte garantiza es que no se
//    desplace el AZAR, que es otra cosa y menor. Tocar la receta se recongela
//    como cualquier cambio de motor.
//
// 3. LA MESA LEE EL MUNDO. Unas opciones se pueden pedir siempre -siempre hay a
//    quien mandarle lluvia- y otras solo si hoy hay a quien aplicarselas. No es
//    una lista rotatoria: es una lectura del estado de hoy.
//
// Y una regla mas, que es de quien manda y no mia: LOS DIOSES SOLO NOMBRAN LO YA
// PUBLICADO. Una tribu siempre es publica -su nombre esta en la cabecera de su
// pliego-, asi que sequia o guerra van siempre dirigidas. Una PERSONA solo se
// puede nombrar si algun pliego la nombro; si la tribu callo que su rey agoniza,
// los dioses tampoco saben quien agoniza. Eso se comprueba contra el registro
// publicado, que vive en el servidor y no aqui: esta tabla solo declara QUE
// opciones nombran persona, con `nombra`.
const { hashSeed, mulberry32 } = require('./azar');

// Cuantas caben en una mesa. Silencio mas cuatro: con doce elegibles un dia
// corriente, cuatro asientos libres dan 495 mesas distintas.
const ASIENTOS = 5;

// --- Los predicados: cuando tiene sentido cada opcion -------------------------
// Reciben el mundo tal como esta al ABRIR la asamblea, antes de contar los votos.
const vivas = m => m.tribus.filter(t => t.alive);
const gente = (m, t) => t.notables.map(i => m.gente[i]).filter(p => p && p.diedTick === null);

// --- POR TRIBU, y el del mundo se deriva --------------------------------------
// ASI NO ESTABA, Y ERA UN FALLO. Los predicados eran de mundo -"hay una trama
// EN ALGUN SITIO"- y el efecto caia sobre una tribu sorteada entre TODAS las
// vivas. O sea que la opcion salia a la mesa porque la condicion se cumplia en
// la tribu de al lado, y luego pegaba en una que no la cumplia: no pasaba nada.
// Medido sobre 25 eras votando la misma opcion todos los dias:
//
//   avisar     elegida 1888 veces, pego 224     12%
//   obra       elegida  256 veces, pego  39     15%
//   destapar   elegida 2202 veces, pego 1709    78%
//
// Es el fallo que no se ve: el lector vota, no pasa nada, y el pliego no puede
// contar nada. El `throw` del motor no lo cazaba porque la opcion SI estaba
// implementada; lo que fallaba era a quien se le aplicaba.
//
// Asi que la condicion se escribe una sola vez y POR TRIBU. De ahi salen las dos
// cosas que hacen falta y que antes no cuadraban entre si: si la opcion puede
// estar en la mesa (`.some()`) y, cuando los dioses no nombran a nadie, ENTRE
// QUIENES se sortea el objetivo. Una sola fuente, como la regla 1 de los
// grabados: dos cosas que tienen que cuadrar a mano acaban descuadradas.
//
// Y `avisar` y `destapar` dejan de compartir predicado. Compartian `hayTrama`
// -"alguien con rencor O con presion"- pero `avisar` necesita a alguien con
// `grudge` y `destapar` a alguien con `pressure > 20`. De ahi parte de su
// diferencia de tasa.
const APLICA = {
  avisar:    (m, t) => gente(m, t).some(p => p.grudge),
  destapar:  (m, t) => gente(m, t).some(p => p.pressure > 20),
  // EL UMBRAL DE "ESTA FLOJO" NO ME LO INVENTO: es el que el motor ya usa.
  // Empece con `health < 35` y la opcion salia el 0% de los dias, porque la
  // salud de un notable vivo nunca baja de 47 -medido, 461 muestras: min 47,
  // mediana 79-. El motor tiene dos umbrales propios y solo uno es alcanzable:
  //
  //   health < 30   suma probabilidad de muerte   NUNCA SE CUMPLE: codigo muerto
  //   health < 62   dispara el rencor por acaparar        si, el 4,8% de las veces
  //
  // Se usa 62, que es el unico que significa algo hoy. Lo de `health < 30` es un
  // hallazgo aparte y no se toca aqui: arreglarlo cambia el mundo.
  levantar:  (m, t) => gente(m, t).some(p => p.health < 62),
  ungir:     (m, t) => gente(m, t).some(p => p.role !== 'lider'),
  // Dos sin pareja Y DE SEXOS DISTINTOS. Con "dos sin pareja" a secas la opcion
  // salia a la mesa en dias en que el efecto no podia aplicarse, que es el fallo
  // de punteria otra vez, un nivel mas abajo.
  emparejar: (m, t) => {
    const libres = gente(m, t).filter(p => !p.pareja);
    return libres.some(a => libres.some(b => b !== a && b.sexo !== a.sexo));
  },
  // `paz` cubre TAMBIEN lo que el diseno llamaba "imponer la paz", y no son dos
  // opciones por lo mismo que `cisma` no es distinta de `discordia`: una guerra
  // se cierra sola cuando `rel > WAR_END_REL`, asi que imponer la paz es subir
  // las relaciones, que es exactamente lo que hace sellarla. Una palanca, dos
  // umbrales. El banco pierde una entrada y gana coherencia.
  paz:       (m, t) => Object.values(t.relations || {}).some(v => v < -40)
                    || (m.guerras || []).some(w => w.open && (w.a === t.id || w.b === t.id)),
  // No "le falta algun hito" sino "hay algo que se le pueda enseniar HOY": lo
  // decide `disponibles` del motor, que ademas mira las lineas abiertas y las
  // dependencias. La funcion llega en el mundo en vez de reescribirse aqui.
  ensenar:   (m, t) => m.puedeAprender(t),
  obra:      (m, t) => !!(Object.keys(t.rotas || {}).length || Object.keys(t.enObra || {}).length),
  ojos:      (m, t) => creenciaFalsaDe(m, t),
  // --- LAS MALAS ---------------------------------------------------------
  // El banco tenia trece buenas contra cuatro malas, y de esas cuatro solo dos
  // cuentan en un mundo sin votos: `duda` la calla el sorteo ciego y `destapar`
  // es mala para un tramador, no para el mundo. Estas seis son el contrapeso, y
  // ninguna inventa mecanica: todas empujan una palanca que el motor ya tiene.
  //
  // DOS QUE NO ESTAN PORQUE SERIAN EL SEGUNDO DIBUJO DE OTRA:
  //
  //   "provocar un cisma" es `discordia`. El cisma se dispara solo cuando
  //   `cohesion < SCHISM_THRESHOLD`; hundir el animo ES provocarlo.
  //
  //   "declarar la guerra" es `enemistar`. No hay declaracion en el motor: la
  //   guerra nace cuando `relations` baja de `WAR_THRESHOLD`. Y no duplica a
  //   `duda`, porque `duda` MIENTE -y por eso el sorteo ciego la calla- mientras
  //   que enemistar no miente: los dioses pueden enemistar honestamente.
  derribar:  (m, t) => Object.keys(t.obras || {}).some(n => t.obras[n])
                    || Object.keys(t.enObra || {}).length > 0,
  quitartierra: (m, t) => (t.cells || []).length > 2,
  azuzar:    (m, t) => gente(m, t).some(p => p.role === 'lider')
                    && gente(m, t).some(p => p.role !== 'lider' && !p.grudge),
  discordia: (m, t) => t.cohesion > 0,
  enemistar: (m, t) => vivas(m).some(o => o !== t),
  incendio:  (m, t) => t.materials > 5,
  // Estas dos miran el mundo, no a la tribu: cualquiera puede recibir tierra
  // mientras quede, y cualquiera puede estar en la guerra que se cierre.
  tierra:    m => (m.libres || 0) > 0,
  duda:      m => vivas(m).length > 1,
};

// A quien se le puede aplicar hoy. El motor lo usa para sortear el objetivo
// cuando los dioses no nombran tribu; sin esto sortearia entre todas y acertaria
// por casualidad. Una opcion sin condicion vale para cualquiera.
function tribusPara(id, m) {
  const f = APLICA[id];
  if (!f) return vivas(m);
  const v = vivas(m);
  return f.length >= 2 ? v.filter(t => f(m, t)) : (f(m) ? v : []);
}

// Creer algo falso del vecino: mas de un 25% de error sobre su poblacion real.
function creenciaFalsaDe(m, t) {
  for (const id in (t.beliefs || {})) {
    const o = m.tribus.find(x => x.id === id);
    if (!o || !o.alive) continue;
    const b = t.beliefs[id];
    if (b && Math.abs(b.estPop - o.population) / Math.max(1, o.population) > 0.25) return true;
  }
  return false;
}
const de = id => m => tribusPara(id, m).length > 0;

// --- El banco -----------------------------------------------------------------
// `hecho` = el motor sabe ejecutarla HOY. Las que no lo llevan estan disenadas y
// medidas pero sin efecto escrito, asi que NO salen a la mesa: ofrecer algo que
// el motor no sabe hacer seria tragarse el voto en silencio -el lector vota, no
// pasa nada, y el pliego no puede contar nada-. Se van encendiendo de una en una,
// cada una con sus cinco puertas.
//
// `cuando` ausente = se puede pedir siempre.
//
// EL ASIENTO PREFERENTE NO FUNCIONABA, y se vio midiendo. La idea era que las
// opciones con condicion rara -alguien agonizando, una obra caida- tuvieran plaza
// fija cuando su condicion se cumpliera, porque ESO es la noticia. Pero una
// condicion rara de ver en una era no es rara de ver en un DIA: en cuanto se
// cumple, suele cumplirse muchos dias seguidos. Medido: con asiento preferente,
// `obra` salia el 100% de los dias y `levantar` el 74%. Acaparaban la mesa, que
// es justo la monotonia que habia que evitar.
//
// Lo que si funciona es sortear a secas entre lo elegible, sin memoria de dias
// anteriores -que es lo que mantiene la mesa calculable con solo la semilla y el
// dia-. Probe ademas darle peso doble a las opciones con condicion, por ser mas
// interesantes el dia que se pueden pedir, y salio PEOR en las dos cosas que
// importan:
//
//                mesas distintas   reparto
//   con peso 2         708          7% a 47%
//   sin pesos          750          5% a 38%
//
// Asi que no hay pesos. El mecanismo se quita entero en vez de dejarlo puesto a 1
// sugiriendo que hace falta.
const BANCO = [
  { id: 'lluvia',     hecho: true, signo: 'bueno', nombra: 'tribu' },
  { id: 'sequia',     hecho: true, signo: 'malo',  nombra: 'tribu' },
  { id: 'plaga',      hecho: true, signo: 'malo',  nombra: 'tribu' },
  { id: 'revelacion', hecho: true, signo: 'bueno', nombra: 'tribu' },
  { id: 'milagro',    hecho: true, signo: 'bueno', nombra: 'tribu' },
  { id: 'silencio',   hecho: true, signo: 'nada',  nombra: null, fija: true },

  // `miente` no es decoracion: ver MIENTEN, abajo.
  { id: 'duda',       hecho: true, signo: 'malo',  nombra: 'tribu',   cuando: de('duda'),
    miente: true },
  { id: 'avisar',     hecho: true, signo: 'bueno', nombra: 'tribu',   cuando: de('avisar') },
  { id: 'destapar',   hecho: true, signo: 'malo',  nombra: 'tribu',   cuando: de('destapar') },
  { id: 'levantar',   hecho: true, signo: 'bueno', nombra: 'persona', cuando: de('levantar') },
  { id: 'ungir',      hecho: true, signo: 'bueno', nombra: 'persona', cuando: de('ungir') },
  { id: 'paz',        hecho: true, signo: 'bueno', nombra: 'tribu', cuando: de('paz') },
  { id: 'ojos',       hecho: true, signo: 'bueno', nombra: 'tribu',   cuando: de('ojos') },
  { id: 'ensenar',    hecho: true, signo: 'bueno', nombra: 'tribu',   cuando: de('ensenar') },
  { id: 'tierra',     hecho: true, signo: 'bueno', nombra: 'tribu',   cuando: de('tierra') },
  // `obra` NO va marcada rara, aunque yo la marque al principio: medi el 14% de
  // "hay una obra caida" y el predicado cubre tambien "a medias", que es otro
  // 27%. Juntas son un tercio de los dias, y una opcion que sale un tercio de los
  // dias CON ASIENTO PREFERENTE sale todos los dias. Se vio en la primera prueba
  // de este fichero: `levantar` y `obra` ocupaban los dos asientos siempre.
  { id: 'obra',       hecho: true, signo: 'bueno', nombra: 'tribu',   cuando: de('obra') },
  { id: 'emparejar',  hecho: true, signo: 'bueno', nombra: 'persona', cuando: de('emparejar') },

  // Las seis malas. Todas `hecho` desde el primer dia: se disenaron y se
  // implementaron juntas, que es distinto de las nueve buenas -aquellas se
  // encendieron por tandas porque ya llevaban meses escritas en papel-.
  { id: 'derribar',     hecho: true, signo: 'malo', nombra: 'tribu', cuando: de('derribar') },
  { id: 'quitartierra', hecho: true, signo: 'malo', nombra: 'tribu', cuando: de('quitartierra') },
  { id: 'azuzar',       hecho: true, signo: 'malo', nombra: 'tribu', cuando: de('azuzar') },
  { id: 'discordia',    hecho: true, signo: 'malo', nombra: 'tribu', cuando: de('discordia') },
  { id: 'enemistar',    hecho: true, signo: 'malo', nombra: 'tribu', cuando: de('enemistar') },
  { id: 'incendio',     hecho: true, signo: 'malo', nombra: 'tribu', cuando: de('incendio') },
];
const POR_ID = {};
for (const o of BANCO) POR_ID[o.id] = o;

// Baraja con un hilo dado. Fisher-Yates: sin sesgo y con una sola pasada.
function barajar(lista, r) {
  const v = lista.slice();
  for (let i = v.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const x = v[i]; v[i] = v[j]; v[j] = x;
  }
  return v;
}

// Saca una al azar. Sin reemplazo lo hace quien llama, quitandola de la lista.
function sacar(lista, r) {
  return lista.length ? lista[Math.floor(r() * lista.length)] : null;
}

// LA MESA DE UN DIA. `mundo` es { tribus, gente, guerras, libres, hitos }.
function mesaDelDia(semilla, dia, mundo, asientos = ASIENTOS) {
  const r = mulberry32(hashSeed(String(semilla) + '|mesa|' + dia));
  const elegible = o => o.hecho && (!o.cuando || o.cuando(mundo, mundo.hitos));
  const puestas = [];
  const mete = o => { if (o && puestas.indexOf(o.id) < 0) puestas.push(o.id); };

  // 1. Las fijas. `silencio` es el "no" y tiene que poder decirse cualquier dia.
  for (const o of BANCO) if (o.fija) mete(o);

  // 2. Una buena y una mala, para que el lector tenga palanca en los dos
  //    sentidos cualquier dia. Sorteadas: si no, saldria siempre la misma.
  const resto = BANCO.filter(o => !o.fija && elegible(o));
  if (!puestas.some(id => POR_ID[id].signo === 'bueno')) mete(sacar(resto.filter(o => o.signo === 'bueno'), r));
  if (!puestas.some(id => POR_ID[id].signo === 'malo')) mete(sacar(resto.filter(o => o.signo === 'malo'), r));

  // 3. Los asientos que queden, sorteados a secas entre lo que falte. SIN PESOS:
  //    se probaron y salieron peor, y esta escrito arriba, junto al banco. El
  //    comentario decia "con peso" desde que se quitaron, que es como dejar una
  //    palanca dibujada donde no hay ninguna.
  const quedan = resto.filter(o => puestas.indexOf(o.id) < 0);
  while (puestas.length < asientos && quedan.length) {
    const o = sacar(quedan, r);
    if (!o) break;
    quedan.splice(quedan.indexOf(o), 1);
    mete(o);
  }
  return puestas.slice(0, asientos);
}

// LA SEMILLA NO MIENTE.
//
// Cuando no vota nadie decide la semilla, y decide entre lo que habia en la
// mesa. Con `duda` dentro, eso significaba que una era muda -la que certify toma
// por patron- se pasaba el 11% de los dias sembrando una creencia falsa sobre un
// vecino en la cabeza de alguien. No es una molestia: es la entrada exacta del
// mecanismo que hace atacar con mala informacion. Medido sobre 200 semillas
// `cert`:
//
//                                     nota    era media   fin por madurez
//   con `duda` en el sorteo ciego    0.7720    29,5 anios       19%
//   sin ella                         0.9734    60,7 anios       76%
//
// La era se partia por la mitad. Y no eran las tres opciones nuevas: quitando
// solo `duda` y dejando `avisar` y `destapar` la nota vuelve a 0.9734, asi que
// es ella sola.
//
// El arreglo podria ser un numero -bajarle la fuerza, sacarla del sorteo- pero
// hay una regla que lo dice mejor y que ademas es verdad: un dios que no ha
// hablado no puede estar mintiendo. Revelar algo por azar es arbitrario;
// mentir por azar es otra cosa. Asi que cuando el sorteo ciego cae en una
// opcion marcada `miente`, la semilla se calla.
//
// Sembrar la duda sigue siendo una opcion de pleno derecho: la piden los
// dioses, que para eso estan. Lo que no hace es pasar sola.
const MIENTEN = new Set(BANCO.filter(o => o.miente).map(o => o.id));

module.exports = { BANCO, APLICA, tribusPara, MIENTEN, POR_ID, ASIENTOS, mesaDelDia, barajar };

// --- Las reglas de la mesa, comprobables --------------------------------------
// No son la huella de nada: son invariantes. Si un dia dejan de cumplirse, la
// mesa esta mal aunque el sorteo sea perfectamente reproducible.
function reglas(mesas) {
  const fallos = [];
  // LO PRIMERO, una opcion que no esta en el banco. Iba la ultima y las demas
  // comprobaciones reventaban antes de llegar -`POR_ID[id]` es `undefined` y
  // `.signo` tira-, asi que el porton se caia en vez de avisar. Un porton que se
  // cae no dice nada: lo unico que se ve es una traza.
  const fuera = [...new Set(mesas.flat().filter(id => !POR_ID[id]))];
  if (fuera.length) {
    fallos.push(`opciones que no estan en el banco: ${fuera.join(', ')}`);
    return fallos;                       // sin banco no se puede juzgar lo demas
  }
  const fijas = BANCO.filter(o => o.fija).map(o => o.id);
  for (const f of fijas) {
    const sinEsa = mesas.filter(m => m.indexOf(f) < 0).length;
    if (sinEsa) fallos.push(`"${f}" es fija y falta en ${sinEsa} mesas de ${mesas.length}`);
  }
  const sinMala = mesas.filter(m => !m.some(id => POR_ID[id].signo === 'malo')).length;
  if (sinMala) fallos.push(`${sinMala} mesas sin una sola opcion mala: el lector se queda sin palanca`);
  const sinBuena = mesas.filter(m => !m.some(id => POR_ID[id].signo === 'bueno')).length;
  if (sinBuena) fallos.push(`${sinBuena} mesas sin una sola opcion buena`);
  const grandes = mesas.filter(m => m.length > ASIENTOS).length;
  if (grandes) fallos.push(`${grandes} mesas con mas de ${ASIENTOS} asientos`);
  const repes = mesas.filter(m => new Set(m).size !== m.length).length;
  if (repes) fallos.push(`${repes} mesas con una opcion repetida`);
  return fallos;
}

module.exports.reglas = reglas;

// --- Para mirarlo ------------------------------------------------------------
//   node motor/mesa.js
if (require.main === module) {
  const siempre = BANCO.filter(o => !o.cuando && !o.fija);
  const conCondicion = BANCO.filter(o => o.cuando);
  const fijas = BANCO.filter(o => o.fija);
  const pinta = o => '  ' + o.id.padEnd(12) + o.signo.padEnd(7)
    + (o.nombra ? 'nombra ' + o.nombra : 'sin objetivo');
  console.log(`EL BANCO: ${BANCO.length} opciones, y salen ${ASIENTOS} cada dia.\n`);
  console.log('FIJAS, todos los dias');       for (const o of fijas) console.log(pinta(o));
  console.log('\nSIEMPRE se pueden pedir');   for (const o of siempre) console.log(pinta(o));
  console.log('\nSOLO si hoy hay a quien');   for (const o of conCondicion) console.log(pinta(o));
  console.log('\nLos dioses solo nombran lo ya publicado: una tribu siempre se puede');
  console.log('nombrar, una persona solo si algun pliego la nombro. Lo comprueba el');
  console.log('servidor contra `ediciones`, no este fichero.');
}
