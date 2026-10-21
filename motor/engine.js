'use strict';

// El azar deterministico vive en `azar.js`: lo comparten el motor y la mesa de la
// asamblea, y tenerlo aqui obligaba a un ciclo de `require` entre los dos.
const { hashSeed, mulberry32 } = require('./azar');
const { mesaDelDia, MIENTEN, tribusPara } = require('./mesa');
// Las opciones que apuntan a ALGUIEN y no a una tribu, y a quien valen. Se
// declaran juntas para que no se pueda anadir una sin decir a quien se le aplica:
// una opcion que nombra persona y no sabe elegirla se tragaria el voto en
// silencio, que es el fallo de punteria que ya se pago una vez con las tribus.
const NOMBRAN_PERSONA = new Set(['ungir', 'emparejar', 'levantar']);
const VALE_PERSONA = {
  ungir:     q => q.role !== 'lider',
  levantar:  q => q.health < 62,
  emparejar: (q, t, gente) => !q.pareja
               && t.notables.map(i => gente[i])
                    .some(o => o && o.diedTick === null && o !== q && !o.pareja && o.sexo !== q.sexo),
};

// LAS OPCIONES DE LA ASAMBLEA, EN UN SOLO SITIO.
//
// Estaban escritas a mano en SEIS: las dos de aqui -la que se publica como
// asamblea del dia y la del azar cuando no vota nadie-, `MENU_DIVINO` en
// editor.js, `menu-divino.js`, `loQueHace()` en servidor/src/asamblea.js y el
// `MENU` de worker.js, que es el que decide si un voto recibido es legal.
//
// Seis copias que tienen que cuadrar a mano acaban descuadradas: es la regla 1
// de la skill de grabados aplicada a otra cosa. Y la sexta es la peligrosa: si
// el worker valida contra una lista distinta de la que se publica, se puede
// colar un voto por algo que no estaba en la mesa.
//
// Aqui no se amplia el menu: se unifica. Las seis listas decian exactamente esto
// y siguen diciendo exactamente esto, asi que el mundo no se mueve -la huella lo
// comprueba-. Ampliarlo es el paso siguiente y va aparte a proposito.
// Las opciones VIVAS: las del banco cuyo efecto esta escrito. Sale de `mesa.js`
// para que siga habiendo una sola lista -era el fallo de las seis copias- y para
// que encender una opcion nueva sea poner `hecho` en un sitio y nada mas.
const OPCIONES_ASAMBLEA = require('./mesa').BANCO.filter(o => o.hecho).map(o => o.id);

// QUIEN GANA LA ASAMBLEA. UNA SOLA FUNCION, y es la regla 1 del proyecto: esto se
// decide en DOS sitios -el servidor al cerrar el dia, en `cerrarDia`, y el motor
// al reproducir la era- y cuadrarlo a mano acaba descuadrado. Acabo de
// descuadrarse, de hecho, y llevaba asi desde que existen los dos:
//
//   empate entre opciones   servidor: alfabetico   motor: AL AZAR
//   tribu objetivo          servidor: la MAS VOTADA  motor: la PRIMERA del array
//
// En produccion no se notaba porque el servidor decide y guarda una sola fila por
// dia, asi que el motor solo aplica lo ya decidido. Pero el producto promete que
// CUALQUIERA puede reproducir la era, y quien la reproduzca partiendo de los
// votos en bruto usa la regla del motor: con un empate obtendria otro mundo.
//
// Los dos desempates son ALFABETICOS a proposito y no por azar: tienen que poder
// calcularse sin el hilo de azar de la era, que quien reproduce desde fuera no
// tiene por que estar siguiendo.
//
// `votos` son { opcion, tribu?, persona?, n? }. Devuelve tambien `dioses` para
// que nadie lo vuelva a sumar por su cuenta con otro criterio.
function decidirAsamblea(votos) {
  const masVotado = (pares) => Object.keys(pares)
    .sort((a, b) => pares[b] - pares[a] || String(a).localeCompare(String(b)))[0] || null;
  const cuenta = (filtro, campo) => {
    const por = {};
    for (const v of votos) {
      if (!v[campo] || !filtro(v)) continue;
      por[v[campo]] = (por[v[campo]] || 0) + (v.n || 1);
    }
    return por;
  };
  const porOpcion = {};
  for (const v of votos) porOpcion[v.opcion] = (porOpcion[v.opcion] || 0) + (v.n || 1);
  const dioses = Object.values(porOpcion).reduce((a, b) => a + b, 0);
  if (!dioses) return { opcion: null, tribu: null, persona: null, dioses: 0 };
  const top = Math.max(...Object.values(porOpcion));
  const opcion = Object.keys(porOpcion).filter(k => porOpcion[k] === top).sort()[0];
  const tribu = masVotado(cuenta(v => v.opcion === opcion, 'tribu'));
  // LA PERSONA SE CUENTA DENTRO DE LA TRIBU QUE YA GANO, no en toda la votacion.
  // Una persona pertenece a una tribu: contarla aparte podria dar un nombre de
  // una tribu distinta de la elegida, y entonces el motor no encontraria a nadie
  // y la peticion se perderia en silencio.
  const persona = masVotado(cuenta(v => v.opcion === opcion && v.tribu === tribu, 'persona'));
  return { opcion, tribu, persona, dioses };
}

const TRAITS = ['ambicioso','cobarde','devoto','cruel','generoso','astuto','leal','iracundo','enfermizo','carismatico'];
const AMBITIONS = ['gobernar','vengarse','sobrevivir','ser_recordado','enriquecerse','proteger_a_alguien'];
const ROLES = ['lider','chaman','guerrero','artesano','anciano','ninguno'];
// Que oficio pide que rasgo. El orden importa: se cubren de arriba abajo, asi
// que si solo queda una persona libre se lleva el oficio mas necesario.
const OFICIOS = [['chaman', 'devoto'], ['guerrero', 'cruel'],
                 ['artesano', 'astuto'], ['anciano', 'leal']];
// Si la tribu tiene vivo a alguien de ese oficio. Un oficio sin nadie que lo
// ocupe deja de aportar, que es lo que convierte la muerte de un notable en
// una noticia con consecuencia y no en una linea de sucesos.
// La cuesta del armamento. Vale 1 con el almacen lleno y `ARMAS_FLOJO` vacio,
// y el suelo es el mismo 0,6 que tenia el interruptor de antes: lo que cambia no
// es cuanto pega una tribu bien armada, sino que ahora quedarse sin material se
// nota.
const armasDe = (t, C) => C.ARMAS_FLOJO + (1 - C.ARMAS_FLOJO)
  * Math.min(1, (t.materials / Math.max(1, t.population)) / C.MAT_STORAGE);

// LA COSECHA QUE CUENTA HOY. El anio del mundo sortea la suya cada
// TICKS_PER_YEAR; los dioses pueden poner la suya encima, con su propio plazo.
// Un solo sitio decide cual vale, porque si lo deciden dos acaban discrepando.
//
// El fallo concreto que obliga a esto: `lluvia` y `sequia` escribian derechas en
// `t.shock`, que se resortea al empezar el anio del MUNDO -24 ticks-, mientras
// que la asamblea vota cada edicion -6-. O sea que el mismo voto duraba cuatro
// dias si caia el primer dia del anio y uno solo si caia el ultimo: cuatro veces
// mas valor, decidido por un calendario que el lector no ve y que nadie le
// cuenta. Son los dos relojes de siempre, los mismos de INTERVENTION_EVERY.
const cosechaDe = (t, tick) => (tick < t.cosechaHasta ? t.cosechaDivina : t.shock);

// LA VEDA ES COMPARTIDA POR LLUVIA Y SEQUIA, a proposito: los dioses reescriben
// la cosecha de una tribu una vez cada COSECHA_ESPERA_DIAS, suba o baje. Antes
// solo la tenia la sequia, asi que `lluvia` se podia repetir todos los dias y se
// apilaba sobre si misma. Medido sobre 60 semillas, era la opcion que mas vida
// daba a una tribu de todo el banco -+47 dias- y la sequia, con veda, la tercera
// que mas mataba. Una palanca y su espejo no son espejos si una tiene freno.
const puedeCosecha = (t, tick, C) =>
  tick - (t.ultimaCosecha || -999) >= C.COSECHA_ESPERA_DIAS * C.TICKS_POR_EDICION;

const ponCosecha = (t, tick, C, valor) => {
  t.ultimaCosecha = tick;
  // Se toma la PEOR de las dos si el don es malo y la MEJOR si es bueno, que es
  // lo que hacian los Math.min y Math.max que habia en las dos ramas. Sin esto,
  // una sequia sobre un anio ya malo -que rodo 0,45- lo dejaba en 0,65: la
  // maldicion MEJORABA la cosecha.
  t.cosechaDivina = valor < 1 ? Math.min(t.shock, valor) : Math.max(t.shock, valor);
  t.cosechaHasta = tick + C.COSECHA_DIVINA_DIAS * C.TICKS_POR_EDICION;
};

// A QUIEN LE TOCA UN OFICIO VACANTE, EN UN SOLO SITIO.
//
// Se elige DOS veces en la vida de una tribu: al fundarla y cada vez que uno
// queda vacante. Se elegia distinto en cada sitio, y por eso existe esto.
//
// AL FUNDAR se repartian TRES de los cinco -lider, chaman, guerrero- por puro
// prestigio, sin mirar el rasgo; artesano y anciano nacian vacantes y esperaban
// a que el relleno los cubriera. Medido sobre 30 semillas y 25.500 dias-tribu:
// el chaman tardaba 6 dias de mediana en cubrirse y el artesano 29, que es la
// diferencia entre nacer puesto y no nacer.
//
// Y el reparto de fundacion se saltaba la regla que hace que el cargo signifique
// algo: el oficio va a quien TIENE EL RASGO, y solo si no hay nadie, al de mas
// prestigio. Un chaman fundador podia no ser devoto, y entonces el periodico no
// puede contar por que le toco a ese.
//
// NO EMITE EL SUCESO: lo emite quien llama. Al fundar no ha ascendido nadie
// -simplemente son lo que son- y cuatro `ascenso` por tribu el dia 0 serian
// cuatro noticias de algo que no ha pasado.
function cubrirOficios(t, people, has) {
  const puestos = [];
  for (const [oficio, rasgo] of OFICIOS) {
    if (t.notables.some(i => people[i] && people[i].role === oficio)) continue;
    const libres = t.notables.map(i => people[i])
      .filter(x => x && x.diedTick === null && x.role === 'ninguno');
    if (!libres.length) continue;
    const conRasgo = libres.filter(x => has(x, rasgo));
    const pool = conRasgo.length ? conRasgo : libres;
    const elegido = pool.sort((x, y) => y.prestige - x.prestige)[0];
    elegido.role = oficio;
    puestos.push([elegido, oficio]);
  }
  return puestos;
}

function tieneOficio(t, people, ...roles) {
  return t.notables.some(i => {
    const p = people[i];
    return p && p.diedTick === null && roles.indexOf(p.role) >= 0;
  });
}
// Catalogo unico de tipos de evento. Antes habia apanos: el fin de una hambruna
// viajaba como 'comercio' y un rencor como 'alianza'.
// Para buscar una obra por su nombre sin recorrer el arbol cada vez.
const POR_NOMBRE = {};

const TIPOS_EVENTO = ['nacimiento','muerte','ascenso','traicion','juramento','rencor','pareja',
  'alianza','batalla','guerra_declarada','guerra_terminada','hambruna','fin_hambruna',
  'migracion','descubrimiento','cisma','acaparamiento','trama','intervencion_divina',
  // El fin de una tribu y el fin del mundo. Antes ninguno de los dos existia
  // como suceso: la tribu que se acababa dejaba de publicar sin despedirse, y
  // el fin de era se emitia como un `guerra_terminada` con una bandera, que es
  // pedirle prestado el tipo a otra cosa.
  'fin_de_tribu','fin_de_era',
  // Una obra arrasada. No es un `descubrimiento` al reves: lo aprendido no se
  // olvida -siguen sabiendo hacer murallas- y lo que se ha perdido es la
  // muralla. Sin este tipo, "arrasaron el molino" no se podia escribir.
  'obra_perdida'];

const PHONEMES = [
  ['ka','ru','to','mi','sha','en','tal','sur','nei','vo','ham','ris','ked','ol','pan','yur'],
  ['bel','dra','nor','vak','thu','ira','gorm','ald','sen','vyr','oth','mar','kel','dun','esk','ryn'],
  ['oyo','ma','ze','lu','nda','ki','tuk','abe','sio','won','jem','ura','nka','deo','yal','shi'],
];
const TRIBE_NAMES = ['Karuto','Belnor','Oyoma'];
// CUARENTA Y OCHO Y NO DOCE. Con doce, `warSeq % 12` daba la vuelta y dos
// guerras distintas de la misma era compartian nombre: "Se acabo la Guerra de la
// Sal" no decia cual. Medido sobre 80 eras: mediana de 8 guerras, pero p90 de 21
// y maximo de 25, asi que 30 de cada 80 eras desbordaban el repertorio y el 20%
// de las guerras colisionaba. No es cosmetico: emparejar declaracion con final
// POR NOMBRE es lo natural, y engenio a dos mediciones nuestras haciendonos
// contar como "sin final publicado" guerras cuyo final si se habia publicado.
//
// El indice arranca en 1 (`++warSeq`), asi que las once primeras guerras de cada
// era conservan su nombre: solo cambia de la duodecima en adelante, que es justo
// donde empezaba el problema.
//
// Los nombres salen de lo que el mundo TIENE -sus seis terrenos, el grano, el
// hambre, el arbol de tecnologias, la gente que se va- y no de decorado: no hay
// espadas, ni tambores, ni tormentas. Las tres que ya existian y tiran de
// licencia poetica -Cuervos, Nieves, Piedra Negra- se quedan: un nombre propio
// no afirma que haya cuervos, igual que "Guerra de los Cien Anios" no afirma
// que durase cien.
const WAR_NAMES = ['de las Cenizas','de la Sal','de los Cuervos','del Río Seco',
  'de las Lanzas Rotas','del Hambre Larga','de los Tres Inviernos','de la Piedra Negra',
  'de los Huesos Blancos','del Vado','de las Nieves','de la Sed',
  'del Monte Alto','de la Vega Quemada','de los Pastos Secos','del Bosque Cerrado',
  'de la Costa Larga','del Río Turbio','de las Dos Cosechas','del Grano Podrido',
  'de la Última Siembra','de las Manos Vacías','de los Que No Volvieron','del Reparto',
  'de la Linde','de las Piedras Movidas','del Fuego Apagado','de los Perros',
  'de las Flechas Perdidas','del Muro Caído','de los Nombres Borrados','de la Palabra Rota',
  'del Juramento','de los Hermanos','de la Sangre Vieja','del Hambre Corta',
  'de la Siega','de la Ceniza Fría','del Barro','de la Piel Curtida',
  'del Arco Largo','del Silencio','de los Sin Tierra','de la Tierra Seca',
  'de los Que Se Fueron','de la Cosecha Perdida','del Paso Estrecho','de los Dos Ríos'];


// ---------- Árbol tecnológico (secuencial, 26 hitos) ----------
// y=rendimiento agrícola  m=fuerza militar  s=almacenaje  c=cohesión  r=ritmo de avance
// y = cosecha, m = fuerza en ataque, s = almacen, c = cohesion, r = ritmo de
// investigacion, d = DEFENSA (solo cuenta para quien es atacado).
//
// El eje `d` existe porque sin el una muralla y un arco eran el mismo numero:
// los dos entraban en `m` y solo cambiaba el tamanio. El motor no sabia
// distinguir "pego mas fuerte" de "me pegan peor", y por tanto el periodico
// tampoco podia contarlo. A las dos fortificaciones se les pasa el valor de `m`
// a `d`: un muro no sirve para atacar. Todo lo que no declara `d` vale 1.
// `obra: 1` marca los hitos que son un EDIFICIO y no un saber. El motor no lee
// esta marca -no cambia una sola cuenta-: existe para que la prensa pueda
// escribir "levantaron la muralla" en vez de "dan con la muralla", que es lo
// que decia hasta ahora y suena a que a alguien se le ocurrio un muro.
//
// Va aqui y no en la prensa a proposito: si maniana se anade un edificio al
// arbol, se marca en el mismo sitio donde se declara, y no hay una segunda
// lista en otro fichero que se olvide de actualizar.
const TECHS = [
  // `pide` son las dependencias REALES. Lo secuencial se queda secuencial -no
  // se hace bronce sin cobre ni un caniazo sin polvora- y lo demas se abre. Cuatro
  // raices sin dependencias: desde el primer dia hay eleccion.
  { n:'el dominio del fuego',        y:1.04, m:1.00, s:1.00, c:0.00, r:1.00, pide:[] },
  { n:'la cestería',                 y:1.02, m:1.00, s:1.10, c:0.00, r:1.00, pide:[] },
  { n:'la lanza de piedra',          y:1.00, m:1.10, s:1.00, c:0.00, r:1.00, pide:[] },
  { n:'la doma del perro',           y:1.03, m:1.05, s:1.00, c:0.01, r:1.00, pide:[] },

  { n:'el curtido de pieles',        y:1.02, m:1.03, s:1.00, c:0.01, r:1.00, pide:['el dominio del fuego'] },
  { n:'la cerámica',                 y:1.02, m:1.00, s:1.25, c:0.00, r:1.00, pide:['el dominio del fuego'] },
  // La pintura, pronto: es lo primero que hace alguien con las manos libres y
  // el fuego encendido. Da cohesion, que es lo que hace un arte.
  { n:'la pintura',                  y:1.00, m:1.00, s:1.00, c:0.06, r:1.02, pide:['el dominio del fuego'] },
  { n:'el arco',                     y:1.03, m:1.14, s:1.00, c:0.00, r:1.00, pide:['la lanza de piedra'] },
  { n:'la agricultura de secano',    y:1.10, m:1.00, s:1.00, c:0.00, r:1.00, pide:['la cestería'] },
  { n:'la rueda',                    y:1.05, m:1.00, s:1.05, c:0.00, r:1.06, pide:['la cestería'] },

  { n:'la ganadería',                y:1.10, m:1.00, s:1.10, c:0.00, r:1.00, pide:['la doma del perro','la agricultura de secano'] },
  // EL GRANERO. La unica obra con castigo por estar en ruinas: las demas, caidas,
  // dejan el mundo como si nunca hubieran estado, y esta lo deja PEOR. Tiene
  // sentido y es lo que la hace interesante: un muro derribado es un muro que no
  // tienes, pero un granero derrumbado es el grano en el suelo. Mientras no lo
  // levanten otra vez, la reserva les cabe a la mitad.
  { n:'el granero',                  y:1.00, m:1.00, s:1.30, c:0.02, r:1.00, obra:1, roto:0.5,
    pide:['la cestería','la agricultura de secano'] },
  { n:'la escritura',                y:1.02, m:1.00, s:1.00, c:0.05, r:1.15, pide:['la cerámica'] },
  { n:'la fundición del cobre',      y:1.03, m:1.12, s:1.00, c:0.00, r:1.03, pide:['la cerámica','el dominio del fuego'] },
  { n:'la muralla',                  y:1.00, m:1.00, s:1.10, c:0.03, r:1.00, d:1.35, obra:1, pide:['la cerámica'] },
  { n:'el arado',                    y:1.12, m:1.00, s:1.00, c:0.00, r:1.00, pide:['la rueda','la agricultura de secano'] },
  { n:'la vela y la navegación',     y:1.06, m:1.05, s:1.05, c:0.00, r:1.05, pide:['la rueda','el curtido de pieles'] },

  // La escultura, en medio: hace falta herramienta de metal para sacarla.
  { n:'la escultura',                y:1.00, m:1.00, s:1.00, c:0.07, r:1.02, pide:['la fundición del cobre'] },
  { n:'el bronce',                   y:1.02, m:1.20, s:1.00, c:0.00, r:1.03, pide:['la fundición del cobre'] },
  { n:'el riego',                    y:1.15, m:1.00, s:1.05, c:0.00, r:1.00, pide:['el arado'] },
  { n:'el calendario',               y:1.08, m:1.00, s:1.00, c:0.02, r:1.05, pide:['la escritura'] },
  { n:'el papel',                    y:1.00, m:1.00, s:1.00, c:0.03, r:1.12, pide:['la escritura'] },
  { n:'el molino',                   y:1.14, m:1.00, s:1.05, c:0.00, r:1.00, obra:1, pide:['la rueda','el arado'] },

  { n:'el hierro',                   y:1.05, m:1.25, s:1.00, c:0.00, r:1.03, pide:['el bronce'] },
  { n:'la moneda',                   y:1.05, m:1.00, s:1.10, c:0.06, r:1.08, pide:['la escritura','el bronce'] },
  // La catedral: la unica obra que habla de los dioses, en un mundo donde las
  // tribus tardan una semana en sospechar que existen. Cuesta, tarda y se puede
  // perder, como toda obra.
  { n:'la catedral',                 y:1.00, m:1.00, s:1.05, c:0.12, r:1.00, obra:1, pide:['la muralla','la escritura','la moneda'] },
  { n:'la imprenta',                 y:1.02, m:1.00, s:1.00, c:0.08, r:1.20, pide:['el papel','la moneda'] },
  { n:'la pólvora',                  y:1.00, m:1.80, s:1.00, c:0.00, r:1.05, pide:['el papel','el hierro'] },
  { n:'el cañón',                    y:1.00, m:1.40, s:1.00, c:0.00, r:1.03, pide:['la pólvora','el hierro'] },
  { n:'la fortificación moderna',    y:1.02, m:1.00, s:1.10, c:0.04, r:1.00, d:1.60, obra:1, pide:['la muralla','el cañón'] },
];
for (const T of TECHS) POR_NOMBRE[T.n] = T;

// ---------- Terreno ----------
// f = rendimiento de alimento, m = rendimiento de materiales
const CELL_TYPES = [
  { t:'vega',   f:1.60, m:0.20, peso:16 },
  { t:'río',    f:1.20, m:0.35, peso:14 },
  { t:'costa',  f:1.40, m:0.20, peso:10 },
  { t:'pastos', f:1.00, m:0.60, peso:18 },
  { t:'bosque', f:0.50, m:1.20, peso:20 },
  { t:'monte',  f:0.20, m:1.60, peso:22 },
];
function rollCell(rng) {
  const tot = CELL_TYPES.reduce((a, c) => a + c.peso, 0);
  let r = rng() * tot;
  for (const c of CELL_TYPES) { r -= c.peso; if (r <= 0) return c; }
  return CELL_TYPES[CELL_TYPES.length - 1];
}

// ---------- Config por defecto (punto de partida, se barre) ----------
const BASE = {
  TICKS_PER_YEAR: 24,
  // Cada cuantos ticks sale un pliego. Estaba pegado a TICKS_PER_YEAR y no son
  // lo mismo: uno es cuanto dura un anio del MUNDO y el otro cada cuanto se
  // PUBLICA. Con 24 el periodico cuenta un anio entero por edicion, que es lo
  // que hace invisibles las estaciones -`season` oscila un +-22% dentro del
  // anio y la edicion las promedia-. Con 6, cada pliego es una estacion.
  TICKS_POR_EDICION: 24,
  YEARS: 150,
  N_TRIBES: 3,
  NOTABLES_TARGET: 6,
  // El suelo para una tribu pequenia. No son seis: una tribu de 14 con seis
  // notables seria media tribu con nombre. Son los que hacen falta para que
  // haya a quien nombrar y quien mande.
  NOTABLES_MINIMO: 2,

  START_POP: 120,
  // Por debajo de esto una tribu se da por acabada: publica su despedida y las
  // demas se enteran. Estaba escrito a mano en los dos sitios que lo usan y
  // fuera de BASE, asi que ni el afinador ni la certificacion lo habian visto
  // nunca. Es el 10% de START_POP, aunque eso es reconstruccion: no habia nada
  // escrito sobre por que 12.
  //
  // Medido sobre 200 semillas, manda mas de lo que su tamanio sugiere. Hasta
  // 12 la era dura lo mismo (63/63/62 anios) y lo unico que cambia es cuantas
  // tribus quedan vivas (6/5/4); por encima el mundo se hunde deprisa (20 ->
  // 56 anios, 30 -> 29). Bajarlo da mas material de periodico -111 sucesos
  // gordos con 8 contra 98 con 12- pero sale caro: sobreviven mas tribus y las
  // guerras se van a 17 cuando la banda del §5 es 5-13. Certificando:
  // 4 -> 0.9193, 8 -> 0.9278, 12 -> 0.9979, 16 -> 0.9313.
  //
  // Ese pico es en parte circular y conviene no olvidarlo: las otras 51
  // palancas se afinaron dando por fijo el 12. Compararlo de verdad pide
  // reafinar entero con cada umbral.
  TRIBU_MINIMA: 12,
  START_FOOD: 300,
  START_TERRITORY: 10,

  BASE_YIELD: 0.62,        // comida por habitante por tick
  RATION: 0.55,            // consumo por habitante por tick // por punto de tech
  CARRY_PER_CELL: 22,      // hab. sostenibles por celda
  STORAGE_MULT: 3.0,

  BIRTH_RATE: 0.014,
  DEATH_RATE: 0.009,
  FAMINE_DEATH: 0.05,
  FAMINE_COHESION: 3.5,

  COHESION_RECOVER: 0.35,
  COHESION_INEQ: 0.02,     // penalización por dispersión de prestigio
  SCHISM_THRESHOLD: 20, MAX_TRIBUS: 6, SCHISM_CELLS: 0.34,
  SCHISM_LOSS: 0.32,

  TECH_RATE: 0.010, TECH_MAT_COST: 3.0,
  // Lo que aporta cada oficio. Van como FALTA y no como bono en el caso del
  // saber: si el sabio diese un empujon, las eras terminarian por madurez aun
  // mas a menudo, y esa metrica ya se sale por arriba. Que el saber se frene
  // cuando no queda quien lo cargue dice lo mismo y ademas empuja la metrica
  // hacia su rango.
  SABIO_FALTA: 0.70,        // ritmo de descubrimiento SIN chaman ni artesano
  GUERRERO_BONO: 1.12,      // fuerza en batalla con un guerrero vivo
  // EL CONSEJO: CUANTO PESA EL RASGO DE UN NOTABLE QUE NO MANDA.
  //
  // Hasta ahora el programa de una tribu salia de los dos rasgos y la ambicion
  // de UNA persona. Seis notables con nombre, doce rasgos entre todos, y once
  // no contaban para nada: `iracundo` no hacia absolutamente nada a quien no
  // mandaba, y `devoto` solo le abria la puerta del oficio de chaman. Una tribu
  // de seis la gobernaban dos rasgos.
  //
  // Ahora los demas empujan tambien, a esta fraccion. NO es un promedio: el rey
  // sigue pesando uno y cada uno de los suyos una parte, asi que quien manda
  // sigue mandando y el resto se nota. Un rey belicoso con cuatro cobardes
  // alrededor pelea menos que el mismo rey solo, que es lo que tiene que pasar.
  //
  // EL RIESGO QUE SE TEMIA ERA APLANAR: sumar seis personas en vez de una acerca
  // las tribus entre si, y `valeParaElRey` ya avisa de que "dos reyes iguales
  // sacan tribus iguales, que es lo contrario de lo que esto tiene que dar".
  // Medido sobre la dispersion del reparto de brazos entre tribus de la misma
  // era, 24 semillas: 0,0726 sin consejo contra 0,0620 / 0,0661 / 0,0700 /
  // 0,0663 con 0,10 / 0,20 / 0,35 / 0,60. No hay tendencia. Ese miedo no se
  // confirma, y conviene que quede escrito para no volver a pagarlo.
  //
  // EL QUE SI APARECE ES OTRO, Y ES EL QUE FIJA EL NUMERO: el consejo acorta los
  // reinados. Reyes por era, 200 semillas del clima que decide la nota:
  //
  //     sin consejo  10,68        0,10 -> 11,50        0,20 -> 12,65
  //                               0,15 -> 11,76
  //
  // La banda de ese criterio cierra en 12, asi que con 0,20 el motor deja de
  // estar certificado. Sube monotono y no es ruido: un consejo empuja `pelear`,
  // hay mas guerra, y caen mas reyes.
  //
  // Se queda en 0,10, que saca 11 de 11 y deja holgura bajo el techo en vez de
  // apoyarse en el. 0,15 tambien puntua 1,0000, pero a 11,76 esta a un 2% del
  // borde y ahi los valores vecinos ya entran y salen solos.
  //
  // Y NO se eligio mirando la nota y dibujando la banda alrededor, que es contra
  // lo que avisa la cabecera de `certify.js`: las bandas son las de siempre y lo
  // unico que se ha movido es este numero.
  CONSEJO: 0.10,
  // El anciano NO toca la cohesion. Se probo y es la palanca mas sensible del
  // modelo: +0.25 sobre un COHESION_RECOVER de 0.35 dejaba los cismas en 0.04
  // de 5.78, y sin cismas no hay tribus nuevas, ni guerras, ni batallas. Ya con
  // 0.05 los cismas caian de 5.89 a 3.87. Un oficio no puede colgarse de ahi.
  //
  // Lo que hace es acordarse: mientras vive alguien que trato con los vecinos,
  // la tribu los menosprecia menos. Es la misma idea contada por donde el
  // modelo si la aguanta, y ataca la metrica peor puntuada de todas.
  ANCIANO_MEMORIA: 0.45,    // cuanto se reduce el menosprecio con un anciano vivo
  // La fragilidad: el umbral por debajo del cual un notable empieza a poder
  // morirse de puro deteriorado, y cuanto pesa cada punto que le falta. 62 es el
  // mismo numero que usa el hambre; la pendiente vale 0,010 en salud 30, que es
  // lo que valia el escalon al que sustituye.
  FRAGIL: 62, FRAGIL_PENDIENTE: 0.0003125,
  MAT_YIELD: 0.35, EXPAND_EFFORT: 900, WARRIOR_UPKEEP: 1.0, ALLOC_STEP: 0.04,
  ARM_COST: 0.06, MAT_STORAGE: 12,
  // El suelo de la cuesta del armamento: lo que pega una tribu sin nada que
  // repartir. Es el 0,6 que ya tenia el interruptor que habia antes aqui.
  ARMAS_FLOJO: 0.6,
  TECH_DIFFUSION: 0.020,  // prestigio mínimo para intentar algo    // multiplicador si ambicioso/cruel/astuto   // por punto de bond negativo con el líder

  // CUANTO PESA EL REY A LA HORA DE ATACAR. Exponente sobre su `pelear`, que vale
  // 1 en un rey del monton: con 0 esto queda exactamente como estaba y con 1
  // multiplica la probabilidad por sus ganas. Es la misma disciplina que AUDACIA.
  REY_BELICOSO: 1,
  WAR_THRESHOLD: -60,    // vuelve hacia 0
  TERRITORY_PRESSURE: 0.9, // hostilidad por presión demográfica
  BATTLE_LETHALITY: 0.09,
  BATTLE_NOTABLE_DEATH: 0.22,
  // LO QUE LE REBAJA EL DADO AL REY TENER JEFE DE GUERRA VIVO. Ver el porque en
  // la batalla, donde se aplica. El numero se eligio midiendo sobre TRES juegos
  // de 200 semillas, mirando "Reyes por era", que es el criterio que tenia
  // atascado todo lo demas pegado a su techo de 12:
  //
  //     escudo     cert-*        otra-*        tres-*
  //     1,00 (el de antes)  11,75 11/11   10,87 11/11   12,06 10/11
  //     0,60                11,33 11/11   10,79 11/11   10,95 11/11
  //     0,40                10,83 11/11   10,12 11/11   10,92 11/11
  //
  // Con 1,00 el juego `tres-*` ya suspendia ANTES de tocar nada. Con 0,60 los
  // tres quedan en once de once y sobra alrededor de un punto de holgura. Se
  // coge 0,60 y no 0,40 porque es el que arregla lo que estaba roto sin alejar
  // mas de lo necesario al rey del campo: sigue yendo, y sigue cayendo.
  REY_TRAS_EL_GUERRERO: 0.60,

  FIDELITY_DECAY: 9,       // puntos por tick de retraso
  RUMOR_THRESHOLD: 60,      // cuánto se degrada la estimación con el tiempo

  AGE_DEATH_START: 55,
  AGE_DEATH_SLOPE: 0.0011,
  HEALTH_DECAY: 0.022,

  DESGASTE_ANIOS: 14, DESGASTE_RENCOR: 0.20, DESGASTE_GOLPE: 0.55,
  MUNDO_HOLGURA: 1.18, MUNDO_MIN: 24, MUNDO_AJUSTE: 0.10,
  // La cadencia de la asamblea YA NO ES UNA CONSTANTE APARTE. Era
  // `INTERVENTION_EVERY: 24` y tenia que coincidir a mano con
  // TICKS_POR_EDICION; mientras los dos valieron 24 nadie lo noto, y al pasar a
  // un pliego por estacion se desincronizaron en silencio: los dioses votaban
  // todos los dias y el mundo solo escuchaba uno de cada cuatro. Medido: 10 de
  // 40 votos contados.
  //
  // La asamblea ES la asamblea de la edicion -un pliego, una votacion, un dia
  // real-, asi que se deriva y no se configura. Dos constantes que tienen que
  // cuadrar a mano acaban descuadradas.
  INTERVENTION_POWER: 1.8,
  // Cuando los dioses PIDEN algo, pega de verdad. Antes una plaga era
  // `population *= 0.975`: un 2,5% que desaparecia como numero, sin un muerto
  // con nombre y sin un solo suceso. Medido sobre 200 semillas, la tribu
  // apestada tenia 0,154 muertes por anio contra 0,159 las demas: ruido. El
  // periodico solo cuenta SUCESOS, asi que un efecto que no emite ninguno es
  // invisible por construccion, por mucho que se suba la potencia.
  PLAGA_MORTANDAD: 0.08,   // fraccion de la tribu que se lleva
  PLAGA_NOTABLE: 0.18,     // prob. de que se lleve a CADA notable, lider incluido
  SEQUIA_SHOCK: 0.65,      // que queda de la cosecha del anio
  SEQUIA_GRANERO: 0.50,    // que queda del granero
  // Cuanto dura una cosecha regalada, EN DIAS DE LECTURA. De ahi salen los
  // ticks, porque es un plazo del periodico y no del calendario agricola del
  // mundo: escrito en ticks habria que cuadrarlo a mano con TICKS_POR_EDICION.
  //
  // CUATRO, y el numero no es un gusto: es lo que duraba antes de verdad. Antes
  // no habia plazo -se escribia en `t.shock` y moria en el sorteo del anio del
  // mundo-, asi que parecia durar "entre uno y cuatro dias segun donde cayera" y
  // puse dos, la media. Falso, y la certificacion lo canto: la era bajo dioses
  // crueles se fue de 82 dias a 173. La veda son 48 ticks, que son EXACTAMENTE
  // dos anios del mundo, asi que en cuanto la primera sequia caia en un cambio
  // de anio todas las siguientes caian igual y duraban los cuatro dias enteros.
  // Los relojes encajaban por casualidad. Medido con COSECHA_DIVINA_DIAS a 2, 3,
  // 4 y 6: con 4 la era cruel vuelve a 88 dias, que es donde estaba.
  COSECHA_DIVINA_DIAS: 4,
  // La veda, compartida por lluvia y sequia. Ocho dias son los 48 ticks que
  // tenia la sequia cuando una edicion eran seis ticks: el freno no cambia, lo
  // que cambia es que ahora tambien frena a la lluvia.
  COSECHA_ESPERA_DIAS: 8,
  LLUVIA_COSECHA: 1.35,    // el anio da mas de lo normal: el espejo de la sequia

  WORLD_CELLS: 60,          // tierra finita -> competencia real
  PRESTIGE_TENURE: 0.06,    // por tick siendo lider con comida
  PRESTIGE_WIN: 9,
  PRESTIGE_DISCOVERY: 6,
  PRESTIGE_DECAY: 0.025,
  PRESTIGE_FAMINE: 9,
  SCARCITY_HOSTILITY: 1.4,  // hostilidad por falta de tierra libre
  GRIEVANCE_DECAY: 0.004,
  // Cuanto tarda en levantarse una obra, en ticks -seis son una edicion, o sea
  // una estacion-. Doce = medio anio del mundo: bastante para que el periodico
  // pueda contar que se empieza y que se termina, y poco para que no sea una
  // promesa eterna.
  // Tope de cosas que una tribu puede tener abiertas a la vez. Tres: con uno no
  // hay paralelo y con cinco el arbol se termina en nada.
  LINEAS_TOPE: 3,
  OBRA_TICKS: 12,
  // Lo que cuesta levantar y lo que cuesta mantener, POR HABITANTE y por tick.
  // Los dos van por habitante porque el tope del almacen tambien -poblacion por
  // MAT_STORAGE-: un coste fijo se volveria calderilla en cuanto la tribu crece.
  // Barridos juntos por un factor comun sobre 15 eras, mirando a la vez el
  // llenado del almacen y la nota del mundo mudo. Con los tres al doble el
  // almacen baja al 24% pero la era se va a 355 dias y la nota a 0,9353: el
  // saber se frena tanto que el mundo deja de madurar. Con estos, el almacen
  // pasa del 99% al 56% de llenado y del 72% al 22% de tribus pegadas al tope,
  // los hitos bajan de 18,0 a 16,6 y la nota no se mueve.
  OBRA_MATERIAL: 0.045,        // mientras se levanta
  OBRA_MANTENIMIENTO: 0.024,   // por cada obra en pie, para siempre
  // Y lo que cuesta tener a gente estudiando, por linea abierta y habitante.
  SABER_MATERIAL: 0.017,
  // Lo que da una revelacion QUE NO HA PEDIDO NADIE, por habitante. La pedida no
  // usa esto: llena el almacen entero, que es el espejo del incendio. Ver la rama.
  REVELACION_MATERIAL: 4.0,
  // Probabilidad de que una batalla perdida en casa se lleve por delante una
  // obra en pie. Lo que se puede perder importa.
  OBRA_RUINA: 0.35,
  DEFEAT_COHESION: 7, GREED_TAKE: 0.30, GREED_HATE: 9, GREED_COHESION: 1.6, DEED_COST: 0.9, DEED_SUCCESS: 0.60, REVENGE_SUCCESS: 0.45,
  WARD_SACRIFICE: 0.55,
  HEIR_P: 0.55, HEIR_PRESTIGE: 18,
  VOW_BOND: 40, PAREJA_P: 0.010,
  COUP_BASE: 0.45,
  BOND_DRIFT_P: 0.30, BOND_DRIFT: 6,
  WAR_END_QUIET: 36, WAR_END_REL: -30, WAR_INTENSITY: 9, TRUCE: 120, PEACE_REL: 30,
  PLOT_STEPS: [0.35, 0.65, 0.90],
  ACT_REVENGE: 80, ACT_COUP: 110, ACT_GREED: 420, ACT_DEED: 260,
  CONTACT_P: 0.05,
  BELIEF_DRIFT: 0.06,
  CONTEMPT_BIAS: 0.004,
  // Cuanto pesa lo que una tribu CREE a la hora de acometer. Con 0 no se
  // calcula nada y manda solo la hostilidad, que es como estuvo hasta ahora:
  // `estPop` -la estimacion de la fuerza del vecino- se leia una sola vez en
  // todo el motor y solo para alimentar un contador. Una tribu subestimaba a
  // su vecina y no hacia absolutamente nada distinto, asi que la mentira que
  // sembraba un dios era decorado y el criterio que la mide era un termometro
  // desconectado de la habitacion.
  AUDACIA: 2,
  SHOCK_P: 0.10,            // prob. de mala cosecha por año
  SHOCK_MIN: 0.45,          // multiplicador de rendimiento en mal año
  SHOCK_MAX: 0.75,
  CROWD_BIRTH: 1.0,         // fuerza del freno logistico
  STRESS_DEATH: 0.05,       // mortalidad extra por reservas bajas
  FAMINE_TRIGGER: 0.35,     // severidad minima para que sea EVENTO
  PRESTIGE_BASE: 0.030,      // experiencia: todos los notables suben algo
  PRESTIGE_MEANREV: 0.0020,  // reversion a la media (evita 100 eterno)
  BATTLE_CHANCE: 0.010,
  WAR_EXHAUSTION: 16,        // relaciones que se recuperan tras sangrar
  WAR_COOLDOWN: 12,          // ticks sin poder volver a atacar
};


// ---------- Validacion de configuracion ----------
// El fallo mas caro de este motor fue una constante que no existia: se convertia
// en NaN y el bloque entero dejaba de hacer nada, en silencio, durante horas.
function validarConfig(C) {
  const malas = [];
  for (const k in C) {
    const v = C[k];
    if (typeof v === 'number' && !Number.isFinite(v)) malas.push(k + '=' + v);
  }
  for (const k in BASE) {
    if (typeof BASE[k] === 'number' && C[k] === undefined) malas.push(k + ' ausente');
  }
  if (malas.length) throw new Error('Configuracion invalida: ' + malas.join(', '));
  if (C.POP_EQ_RATIO !== undefined && (C.POP_EQ_RATIO <= 0 || C.POP_EQ_RATIO > 2))
    throw new Error('POP_EQ_RATIO fuera de rango: ' + C.POP_EQ_RATIO);
  if (C.BIRTH_RATE <= C.DEATH_RATE)
    throw new Error('BIRTH_RATE debe superar a DEATH_RATE');
  return C;
}

// ---------- Utilidades ----------
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function makeName(rng, tribeIdx, used) {
  const ph = PHONEMES[tribeIdx];
  for (let intento = 0; intento < 60; intento++) {
    const n = 2 + Math.floor(rng() * 2);
    let s = '';
    for (let i = 0; i < n; i++) s += pick(rng, ph);
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (used && used.has(s)) continue;
    if (used && used.has(s)) continue;          // unicidad dentro de la era
    if (used) used.add(s);
    return s;
  }
  let s = 'Sin' + (used ? used.size : 0);
  if (used) used.add(s);
  return s;
}

let PID = 0;
function makePerson(rng, tribeIdx, tribeId, tick, C, age0, used, parent) {
  const t1 = pick(rng, TRAITS);
  let t2 = pick(rng, TRAITS);
  while (t2 === t1) t2 = pick(rng, TRAITS);
  return {
    id: 'p' + (++PID),
    tribeId, tribeIdx,
    name: makeName(rng, tribeIdx, used),
    sexo: rng() < 0.5 ? 'f' : 'm',
    parentName: parent ? parent.name : null,
    madreName: null,
    pareja: null,
    bornTick: tick - Math.floor((age0 || 0) * C.TICKS_PER_YEAR),
    diedTick: null,
    causeOfDeath: null,
    role: 'ninguno',
    traits: [t1, t2],
    ambition: pick(rng, AMBITIONS),
    prestige: 15 + rng() * 25,
    health: 78 + rng() * 22,
    bonds: {},
    peakPrestige: 0,
    everLeader: false,
    leaderTicks: 0,
    wealth: 0, grudge: null, ward: null, deeds: 0, kills: 0, pressure: 0,
  };
}

function has(p, t) { return p.traits.indexOf(t) >= 0; }

// ---------- Simulación de una era ----------
function vow(rng, C, people, tribe, victim, killer, ev, tick) {
  // quien queria al muerto pasa a odiar al asesino: cadena de venganzas
  for (const pid of tribe.notables) {
    const w = people[pid];
    if (!w || w.diedTick !== null || w.id === killer.id) continue;
    const loved = (w.bonds[victim.id] || 0) > C.VOW_BOND || w.ward === victim.id;
    if (!loved) continue;
    w.bonds[killer.id] = -100;
    w.ambition = 'vengarse';
    w.grudge = killer.id;
    ev(tick, 'traicion', 2, [tribe.id], [w.id, killer.id], { juramento: 1 }, [tribe.id]);
  }
}

function runEra(seedStr, cfg, acciones) {
  const C = validarConfig(Object.assign({}, BASE, cfg || {}));
  const rng = mulberry32(hashSeed(seedStr));
  PID = 0;
  const usedNames = new Set();

  const TOTAL_TICKS = C.YEARS * C.TICKS_PER_YEAR;

  const tribes = [];
  const people = {};
  let tribeSeq = 0;
  function nuevaTribu(nombre, idxFonemas) {
    return {
      id: 'T' + (tribeSeq++), idx: idxFonemas, name: nombre,
      alive: true, population: 0, food: 0,
      cohesion: 55, inFamine: false, famineTicks: 0, lastFamine: -999, shock: 1,
      lastLeaderDead: null, lastHoarder: null, hoardTick: -999,
      ultimaCosecha: -999, cosechaDivina: 1, cosechaHasta: -999,
      cells: [], materials: 20,
      alloc: { campo: 0.70, obras: 0.15, expansion: 0.10, guerreros: 0.05 },
      effort: 0,
      get territory() { return this.cells.length; },
      tech: 0, known: 0, mulY: 1, mulM: 1, mulS: 1, mulC: 0, mulR: 1, mulD: 1,
      // LO QUE SE SABE y LO QUE SE ESTA APRENDIENDO. Antes `known` era un
      // contador y `TECHS[known]` el siguiente: una escalera. Ahora el arbol es
      // un grafo, asi que hace falta el CONJUNTO de lo sabido -para saber que
      // dependencias estan cubiertas- y la lista de lo que hay abierto.
      sabidas: {}, lineas: [],
      // LO QUE ESTA EN PIE, aparte de lo que se sabe. Los `mul*` de arriba son
      // SABER y no se pierden nunca; una obra si, y por eso no puede vivir ahi
      // dentro: restarla luego dividiendo dejaria deriva de coma flotante y un
      // mundo que no se reproduce igual. Se guarda que hay levantado y el efecto
      // se calcula cada vez.
      obras: {}, enObra: {},
      // Y LO QUE ESTA EN RUINAS. Distinto de "no tenerla": una obra que declara
      // `roto` sigue pesando mientras esta caida, y deja de pesar cuando la
      // vuelven a levantar.
      rotas: {},
      notables: [], relations: {}, warCooldown: {}, beliefs: {},
      knownEvents: {}, pendingKnowledge: [],
      madre: null, fundador: null, era: seedStr, reclama: null,
    };
  }
  const nombresTribu = new Set();
  for (let i = 0; i < C.N_TRIBES; i++) {
    // cada era estrena fundadoras: nada de lista fija
    let nb;
    do { nb = makeName(rng, i, null); } while (nombresTribu.has(nb));
    nombresTribu.add(nb);
    const t = nuevaTribu(nb, i);
    Object.assign(t, {
      alive: true,
      population: C.START_POP * (0.85 + rng() * 0.3),
      food: C.START_FOOD,
      cohesion: 62 + rng() * 18,
    });
    tribes.push(t);
  }
  const freeCells = [];
  for (let i = 0; i < Math.round(C.WORLD_CELLS) - C.N_TRIBES * C.START_TERRITORY; i++) freeCells.push(rollCell(rng));
  for (const t of tribes) for (let i = 0; i < C.START_TERRITORY; i++) t.cells.push(rollCell(rng));

  for (const a of tribes) for (const b of tribes) {
    if (a !== b) {
      a.relations[b.id] = -10 + rng() * 20;
      a.beliefs[b.id] = { estPop: b.population * (0.7 + rng() * 0.6), estHostility: 0, lastContact: 0 };
    }
  }
  for (const t of tribes) {
    for (let k = 0; k < C.NOTABLES_TARGET; k++) {
      const p = makePerson(rng, t.idx, t.id, 0, C, 18 + rng() * 25, usedNames);
      people[p.id] = p; t.notables.push(p.id);
    }
    // ROLES INICIALES. Manda el de mas prestigio, y los otros CUATRO oficios se
    // reparten con la misma regla que se usara el resto de la era: ver
    // `cubrirOficios`. Antes se repartian tres a dedo y por prestigio, asi que
    // la tribu nacia sin artesano ni anciano y el cargo no decia nada de quien
    // lo llevaba.
    const sorted = t.notables.slice().sort((a, b) => people[b].prestige - people[a].prestige);
    people[sorted[0]].role = 'lider'; people[sorted[0]].everLeader = true;
    people[sorted[0]].prestige += 20;
    cubrirOficios(t, people, has);
    for (const id of t.notables) for (const other of t.notables) {
      if (id !== other) people[id].bonds[other] = -25 + rng() * 60;
    }
  }

  const events = [];
  // Foto del mundo al cierre de cada dia. Es OBSERVACION PURA: no se lee en
  // ninguna decision de la simulacion, solo se escribe. Por eso no altera el
  // comportamiento y `comparar.js` sigue dando 20/20 aunque exista.
  //
  // Existe porque runEra solo devolvia el estado FINAL de las tribus, y el
  // periodico del dia 18 no puede contar la poblacion del dia 80: seria
  // anacronico. Sin esto, el redactor no puede citar una sola cifra de contexto.
  const historia = [];
  // El ultimo pliego de cada tribu. `historia` solo guarda a los vivos y solo
  // al cerrar cada anio completo, asi que quien se muere -o el mundo entero-
  // se queda sin foto y no puede publicar su despedida.
  const finales = [];
  const wars = [];
  const acts = (acciones || []).slice();
  const efectos = [];
  const asambleas = [];
  let warSeq = 0;
  const metrics = {
    treacheries: 0, schisms: 0, battles: 0, famines: 0, discoveries: 0,
    notableDeaths: 0, fullArcs: 0, falseInfoWars: 0, falseInfoDisasters: 0,
    extinctions: 0, mag3: 0, endTick: TOTAL_TICKS, dominanceYear: null,
    peakGini: 0,
  };

  function ev(tick, type, mag, tribeIds, actors, payload, visibility) {
    const e = { id: 'e' + events.length, tick, type, mag, tribes: tribeIds, actors, payload, visibility };
    events.push(e);
    if (mag === 3) metrics.mag3++;
    // propagación de conocimiento
    for (const t of tribes) {
      if (!t.alive) continue;
      if (visibility.indexOf(t.id) >= 0) {
        t.knownEvents[e.id] = { fidelity: 100, learned: tick, distorted: false };
      } else {
        const hostile = tribeIds.some(x => (t.relations[x] || 0) < -30);
        const delay = 1 + Math.floor(rng() * 4) + (hostile ? 2 : 0);
        t.pendingKnowledge.push({ e, arrive: tick + delay, mag });
      }
    }
    return e;
  }

  // La foto de una tribu en un momento dado. Estaba escrita a mano dentro del
  // bucle del anio, asi que solo se podia tomar ahi; ahora tambien se toma
  // cuando una tribu se acaba y cuando se acaba el mundo, que son justo los dos
  // dias en los que hay algo que contar y no habia con que contarlo.
  function fotoDe(t, tick) {
    return {
      id: t.id, nombre: t.name,
      poblacion: Math.round(t.population),
      comida: Math.round(t.food),
      // Reserva en TICKS, que es lo que mide RATION (consumo por tick).
      // No son dias: 24 ticks son un anio, asi que un tick es medio mes.
      // El periodico lo convierte a meses antes de publicarlo.
      reserva: Math.round(t.food / Math.max(1, t.population * C.RATION)),
      cohesion: Math.round(t.cohesion),
      territorio: t.territory,
      materiales: Math.round(t.materials),
      tecnologias: t.known,
      enGuerra: wars.some(w => w.open && (w.a === t.id || w.b === t.id)),
      notables: t.notables.map(i => people[i]).filter(p => p && p.diedTick === null)
        .map(p => ({
          id: p.id, nombre: p.name, rol: p.role,
          prestigio: Math.round(p.prestige),
          salud: Math.round(p.health),
          anios: Math.floor((tick - p.bornTick) / C.TICKS_PER_YEAR),
          muertes: p.kills, obras: p.deeds, riqueza: Math.round(p.wealth),
        })),
    };
  }

  // El fin del mundo. Lo ven todas las tribus a la vez -no hay nadie a quien
  // le llegue tarde-, y cada una que siga en pie se lleva su foto final para
  // poder sacar su ultimo pliego.
  function cerrarEra(tick, causa, extra) {
    // `dia` es el numero de EDICION y `anios` la edad del mundo. Coinciden
    // mientras se publique una vez al anio y dejan de coincidir en cuanto no.
    const dia = Math.floor(tick / C.TICKS_POR_EDICION);
    const anios = Math.floor(tick / C.TICKS_PER_YEAR);
    const vivas = tribes.filter(t => t.alive);
    ev(tick, 'fin_de_era', 3, vivas.map(t => t.id), [],
       Object.assign({ causa, anios, quedan: vivas.length }, extra || {}),
       tribes.map(x => x.id));
    for (const t of vivas) {
      finales.push({ dia, tick, tribuId: t.id, nombre: t.name,
                     causa: 'fin_de_era', causaEra: causa, anios,
                     foto: fotoDe(t, tick) });
    }
  }

  // Matar a alguien con nombre. Habia ocho sitios repitiendo esta contabilidad
  // y ninguno la hacia igual -unos limpian la pareja, otros no; unos apuntan al
  // lider muerto para que deje heredero, otros no-, asi que lo nuevo pasa por
  // aqui. Los ocho viejos siguen como estaban a proposito: tocarlos seria
  // mezclar un refactor con un cambio de mundo, y cada uno mueve la huella.
  function matar(t, p, tick, causa, mag) {
    p.diedTick = tick; p.causeOfDeath = causa;
    // El lider muerto se apunta: de ahi sale que su sucesor pueda ser su hijo.
    if (p.role === 'lider') t.lastLeaderDead = p;
    if (p.pareja && people[p.pareja]) people[p.pareja].pareja = null;
    metrics.notableDeaths++;
    if (p.everLeader && p.peakPrestige >= 80 && p.leaderTicks >= 240) metrics.fullArcs++;
    t.notables = t.notables.filter(x => x !== p.id);
    // Visible SOLO para su tribu: las demas se enteran de oidas, y de ahi sale
    // que puedan contarlo mal y que se les tache en rojo tres dias despues.
    ev(tick, 'muerte', mag, [t.id], [p.id], { causa }, [t.id]);
  }

  function protect(t, victim, killer, tick) {
    const prot = t.notables.map(x => people[x])
      .find(x => x && x.diedTick === null && x.ward === victim.id && (!killer || x.id !== killer.id));
    if (!prot) return false;
    if (rng() > C.WARD_SACRIFICE) return false;
    prot.diedTick = tick; prot.causeOfDeath = 'sacrificio';
    metrics.notableDeaths++;
    t.notables = t.notables.filter(x => x !== prot.id);
    ev(tick, 'muerte', 3, [t.id], [prot.id, killer ? killer.id : null, victim.id],
       { sacrificio: 1, en_batalla: killer ? 0 : 1 }, [t.id]);
    if (killer) vow(rng, C, people, t, prot, killer, ev, tick);
    return true;
  }

  // EL EFECTO DE LO QUE ESTA EN PIE. Los `mul*` de la tribu son saber y no
  // cambian nunca hacia abajo; esto se suma encima y aparece y desaparece con
  // las obras. Se calcula cada vez en vez de acumularse: una obra que se pierde
  // tiene que dejar el mundo EXACTAMENTE como si nunca hubiera estado, y eso
  // dividiendo multiplicadores no se consigue.
  function porObras(t, eje) {
    let m = eje === 'c' ? 0 : 1;
    for (const n in t.obras) {
      if (!t.obras[n]) continue;
      const T = POR_NOMBRE[n];
      if (!T) continue;
      if (eje === 'c') m += (T.c || 0); else m *= (T[eje] || 1);
    }
    // Y LO QUE ESTA EN RUINAS. Una obra caida normalmente solo quita lo que
    // daba; la que declara `roto` ademas CASTIGA, y sigue castigando hasta que
    // la vuelven a levantar. Hoy solo el granero: el grano en el suelo es peor
    // que no tener donde meterlo, porque ya lo habias metido.
    if (eje === 's') {
      for (const n in t.rotas) {
        const T = POR_NOMBRE[n];
        if (T && T.roto) m *= T.roto;
      }
    }
    return m;
  }
  const mY = t => t.mulY * porObras(t, 'y');
  const mM = t => t.mulM * porObras(t, 'm');
  const mS = t => t.mulS * porObras(t, 's');
  const mC = t => t.mulC + porObras(t, 'c');
  const mR = t => t.mulR * porObras(t, 'r');
  const mD = t => t.mulD * porObras(t, 'd');

  // Que puede empezar una tribu ahora mismo: lo que no sabe, no tiene abierto, y
  // cuyas dependencias estan todas cubiertas.
  function disponibles(t) {
    return TECHS.filter(T => t.lineas.indexOf(T.n) < 0
      && (T.pide || []).every(d => t.sabidas[d])
      // Una obra esta disponible mientras NO este en pie ni levantandose, aunque
      // ya la sepan hacer: eso es rehacerla. Lo demas, una sola vez.
      //
      // El comentario de `aprender` decia desde el principio que "una obra
      // arrasada se puede rehacer" y era falso: este filtro miraba `sabidas` y no
      // se la ofrecia nunca. Medido antes de arreglarlo: 86 obras arrasadas en 60
      // eras, 0 vueltas a levantar.
      && (T.obra ? (!t.obras[T.n] && !t.enObra[T.n]) : !t.sabidas[T.n]));
  }

  // "Que aprenda algo" -la gran obra, la difusion entre vecinos-: se elige uno
  // de los disponibles. Antes no habia eleccion posible porque solo habia un
  // siguiente.
  function aprenderAlgo(t, tick, byWhom, extra) {
    const libres = disponibles(t);
    if (!libres.length) return false;
    // Tambien aqui manda el rey: de lo que se le pega de un vecino, la tribu se
    // queda con lo que le sirve. Sortearlo era lo mismo que sortear la linea.
    const rsv = t.food / Math.max(1, t.population * C.RATION);
    return aprender(t, eligeHito(t, libres, programaDelRey(t), rsv < 3).n, tick, byWhom, extra);
  }

  // `extra` marca el suceso -hoy solo `{ divino: 1 }`-. Sin el, un hito ensenado
  // por los dioses y una obra rehecha por ellos salen en el pliego
  // indistinguibles de los que la tribu consiguio sola, y el lector no ve que
  // su voto hizo nada. Que es justo el fallo que se acaba de arreglar en el
  // objetivo de la intervencion.
  function aprender(t, nombre, tick, byWhom, extra) {
    const T = POR_NOMBRE[nombre];
    if (!T) return false;
    // Dos cosas distintas que la primera version confundio, y la confusion
    // habria salido impresa:
    //
    //   PODER levantarla   la obra no esta en pie ni levantandose. Vale aunque ya
    //                      sepan hacerla, y por eso la hija de una escision
    //                      -que hereda el saber y ninguna obra, ver el cisma-
    //                      puede levantar la suya.
    //   REHACERLA          ademas, a ESTA tribu se le cayo: esta en `rotas`.
    //
    // Con la condicion antigua, la hija de una escision publicaba que "vuelve a
    // levantar" un granero que no habia tenido nunca.
    const puedeObra = !!(T.obra && !t.obras[nombre] && !t.enObra[nombre]);
    if (t.sabidas[nombre] && !puedeObra) return false;
    const rehace = !!(T.obra && t.rotas[nombre]);
    t.sabidas[nombre] = true;
    t.known = Object.keys(t.sabidas).length;
    t.tech = t.known * (100 / TECHS.length);
    // UN EDIFICIO NO SE SABE, SE LEVANTA. Los hitos marcados `obra` no dan su
    // efecto al aprenderlos: arrancan una construccion que tarda OBRA_TICKS y
    // que puede quedarse a medias si la tribu se acaba. El saber si se queda -el
    // hito cuenta como conocido- y por eso una obra arrasada se puede rehacer.
    if (T.obra) {
      t.enObra[T.n] = C.OBRA_TICKS;
      // QUIEN SE PONE A LA OBRA. Va en el suceso porque si no la tribu pierde
      // una linea de estudio y el lector no tiene por donde enterarse de por
      // que. El nombre y no el id, como `por` en `obra_perdida`: la prensa no
      // resuelve identificadores.
      const maestro = t.notables.map(i => people[i])
        .find(q => q && q.diedTick === null && q.role === 'artesano');
      const datos = { nombre: T.n, indice: t.known, obra: 1,
                      fase: rehace ? 'rehace' : 'empieza' };
      if (maestro) datos.maestro = maestro.name;
      ev(tick, 'descubrimiento', t.known >= TECHS.length ? 3 : 2, [t.id],
         byWhom ? [byWhom] : [],
         Object.assign(datos, extra), [t.id]);
      return true;
    }
    t.mulY *= T.y; t.mulM *= T.m; t.mulS *= T.s; t.mulC += T.c; t.mulR *= T.r;
    t.mulD *= (T.d || 1);
    ev(tick, 'descubrimiento', t.known >= TECHS.length ? 3 : 2, [t.id],
       byWhom ? [byWhom] : [],
       Object.assign({ nombre: T.n, indice: t.known }, extra), [t.id]);
    return true;
  }

  // ------------------------------------------------------------------
  // EL PROGRAMA DEL REY
  //
  // Antes la tribu repartia el trabajo con una tabla fija igual para todas y
  // elegia que investigar AL AZAR entre lo disponible. O sea que el rey era un
  // nombre: daba igual quien mandara, y dos tribus con la misma edad hacian lo
  // mismo. El periodico no podia contar una decision porque no habia ninguna.
  //
  // Ahora hay cuatro prioridades -comer, hacer, crecer y pelear- y de ellas
  // salen LAS TRES DECISIONES: donde se pone a la gente, que se manda estudiar y
  // cuanto se empuja hacia fuera. Un solo programa, tres consecuencias.
  //
  // Salen de tres sitios, y ese orden importa:
  //   1. QUIEN MANDA   sus dos rasgos y su ambicion
  //   2. QUE TIENE     las losetas: en vega se siembra, en monte se pica piedra
  //   3. CON QUIEN     los oficios de sus notables
  //
  // El terreno va DESPUES del rey y multiplicando, no sumando, porque manda mas:
  // un rey que quiere comer en un monte pelado no come. Lo que hay decide lo que
  // se puede querer.
  const POR_RASGO = {
    ambicioso:   { crecer: 0.5, pelear: 0.3 },
    cobarde:     { pelear: -0.4, hacer: 0.3 },   // no pelea: se encierra a levantar
    devoto:      { hacer: 0.4 },
    cruel:       { pelear: 0.6, comer: -0.2 },
    generoso:    { comer: 0.5, pelear: -0.2 },
    astuto:      { hacer: 0.5 },
    leal:        { comer: 0.2, hacer: 0.2 },
    iracundo:    { pelear: 0.5, crecer: 0.2 },
    enfermizo:   { comer: 0.4, crecer: -0.3 },
    carismatico: { crecer: 0.4 },
  };
  const POR_AMBICION = {
    gobernar:           { pelear: 0.3, crecer: 0.3 },
    vengarse:           { pelear: 0.7 },
    sobrevivir:         { comer: 0.6, pelear: -0.2 },
    ser_recordado:      { hacer: 0.6 },
    enriquecerse:       { hacer: 0.4, crecer: 0.3 },
    proteger_a_alguien: { comer: 0.3, hacer: 0.2 },
  };
  // CADA OFICIO EMPUJA SU PROPIO EJE. Son cuatro prioridades y cuatro oficios, y
  // hasta hoy uno de los ejes no lo reclamaba nadie mientras dos oficios se
  // repartian el mismo:
  //
  //     anciano  comer 0,15     artesano  hacer 0,25     guerrero  pelear 0,25
  //     chaman   hacer 0,15   <- el eje del artesano, con menos peso
  //     crecer   de nadie
  //
  // O sea que el chaman era un artesano flojo: la regla 1 -un dibujo, no dos que
  // se parecen- aplicada a las personas. Dos oficios que hacen lo mismo con
  // distinto numero no son dos oficios.
  //
  // SE LE DA `crecer`, QUE ERA EL QUE ESTABA LIBRE, y encaja con lo que la
  // prensa ya dice de el: el que se queda con lo de los dioses, el que se ocupa
  // de lo que nadie sabe explicar. Un pueblo con alguien que le da sentido a lo
  // que viene empuja hacia fuera, y `crecer` es exactamente eso — el reparto de
  // brazos a expansion.
  //
  // EL PESO NO SE TOCA: sigue siendo 0,15, el mismo que tenia. Lo unico que
  // cambia es el eje, que es lo que se queria cambiar.
  //
  // Y NO CABIA HASTA HOY. Se intento antes del escudo del rey y suspendia con
  // cualquier peso: `crecer` manda brazos a expansion, mas tierra, mas contacto,
  // mas guerra, y "Reyes por era" estaba pegado a su techo de 12. Medido con los
  // dos cambios puestos, sobre tres juegos de 200 semillas:
  //
  //     hacer 0,15 (antes)   11,33 11/11   10,72 11/11   10,92 11/11
  //     crecer 0,15          10,55 11/11   11,91 11/11   11,08 11/11
  //     crecer 0,25          12,09 10/11   11,31 11/11   12,51 10/11
  //
  // 0,25 sigue sin caber. 0,15 si. El orden importaba: sin sacar antes al rey de
  // la primera linea, este cambio no era posible.
  const POR_OFICIO = { guerrero: { pelear: 0.25 }, artesano: { hacer: 0.25 },
                       chaman: { crecer: 0.15 }, anciano: { comer: 0.15 } };

  function programaDelRey(t) {
    const p = { comer: 1, hacer: 1, crecer: 1, pelear: 1 };
    const suma = (tabla, peso = 1) => {
      if (!tabla) return;
      for (const k in tabla) p[k] += tabla[k] * peso;
    };
    const rey = t.notables.map(i => people[i]).find(x => x && x.role === 'lider' && x.diedTick === null);
    if (rey) {
      for (const r of rey.traits) suma(POR_RASGO[r]);
      suma(POR_AMBICION[rey.ambition]);
    }
    // Con quien cuenta. Un rey sin guerreros no hace la guerra aunque quiera.
    // Y QUIENES SON, no solo que oficio llevan: los rasgos de los demas
    // notables pesan `CONSEJO` cada uno. Ver su comentario arriba. La ambicion
    // NO entra: la de quien no manda ya tiene su sitio -es lo que empuja un
    // golpe de estado- y meterla aqui seria cobrarla dos veces.
    for (const i of t.notables) {
      const q = people[i];
      if (!q || q.diedTick !== null) continue;
      suma(POR_OFICIO[q.role]);
      if (q !== rey) for (const r of q.traits) suma(POR_RASGO[r], C.CONSEJO);
    }
    // Y lo que tiene debajo de los pies. `vocacion` va de 0 -todo monte- a 1
    // -toda vega-, y sale de las mismas `f` y `m` con las que se produce, asi que
    // no es una etiqueta nueva: es el terreno leido.
    let sf = 0, sm = 0;
    for (const c of t.cells) { sf += c.f; sm += c.m; }
    const vocacion = (sf + sm) > 0 ? sf / (sf + sm) : 0.5;
    p.comer *= 0.60 + vocacion;
    p.hacer *= 1.60 - vocacion;
    for (const k in p) p[k] = Math.max(0.05, p[k]);
    return p;
  }

  // LO QUE UN HITO LE VALE A ESTE REY. El hito trae sus ejes -y comida, m fuerza,
  // s almacen, c cohesion, r ritmo, d defensa- y el rey trae lo que quiere. No
  // hay tabla de "esta tecnologia es militar": se lee de los mismos numeros con
  // los que el motor la aplica, asi que si manana se retoca un hito, su atractivo
  // se retoca solo.
  function valeParaElRey(T, p, t, hambre) {
    // EL SUELO BAJO Y EL CUADRADO NO SON ADORNO. Con el suelo alto y sin elevar,
    // el mejor hito pesaba solo el doble que el peor, y como el arbol ofrece una
    // MEDIANA DE 3 HITOS A LA VEZ, eso movia la eleccion muy poco. Medido, sobre
    // las veces en que habia un arma disponible y el rey podia cogerla o no:
    //
    //   suelo 0,35  sin elevar   rey belicoso 45,3%   rey pacifico 36,5%
    //   suelo 0,10  al cuadrado  rey belicoso 53,2%   rey pacifico 39,9%   <- este
    //   suelo 0,06  al cubo      rey belicoso 58,2%   rey pacifico 40,0%
    //
    // Se queda el del medio: el rey se nota y sigue sin ser un automata. Al cubo
    // el mejor hito pesa veinte veces mas que el peor y dos reyes iguales sacan
    // tribus iguales, que es lo contrario de lo que esto tiene que dar.
    let v = 0.10 + 3 * (
        p.comer  * ((T.y - 1) * 5 + (T.s - 1) * 2.5)
      + p.hacer  * ((T.r - 1) * 5 + (T.c || 0) * 4)
      + p.pelear * ((T.m - 1) * 4 + ((T.d || 1) - 1) * 4)
      + p.crecer * ((T.y - 1) * 2 + (T.m - 1) * 2));
    // Lo suyo, caido. Una tribu con el granero desfondado no se pone a inventar
    // la vela: lo levanta. Es lo unico que pesa mas que el programa del rey.
    if (T.obra && t.rotas[T.n]) v += 3 + (T.roto ? 3 : 0);
    // Y con la reserva en las ultimas no se discute: se busca comida.
    if (hambre && T.y > 1) v += 2.5 * (T.y - 1) * 10;
    return Math.pow(Math.max(0.02, v), 2);
  }

  // Elige uno, con peso. NO el mejor: el mejor siempre haria que dos reyes
  // iguales sacaran tribus iguales, y la variedad entre tribus es justo lo que
  // esto tiene que dar. El rey inclina la balanza, no escribe el futuro.
  function eligeHito(t, libres, p, hambre) {
    let total = 0;
    const pesos = libres.map(T => { const v = valeParaElRey(T, p, t, hambre); total += v; return v; });
    let r = rng() * total;
    for (let i = 0; i < libres.length; i++) { r -= pesos[i]; if (r <= 0) return libres[i]; }
    return libres[libres.length - 1];
  }

  function aliveTribes() { return tribes.filter(t => t.alive && t.population >= C.TRIBU_MINIMA); }

  for (let tick = 0; tick < TOTAL_TICKS; tick++) {
    for (const ac of acts.filter(x => x.tick === tick)) {
      // Viva. Una tribu extinta no se entera de nada: no se le puede susurrar,
      // ni revelarle una trama, ni sembrarle una mentira. Sin el `alive` se
      // colaba una accion divina sobre una tribu muerta, y en el caso de la
      // mentira eso reventaba -`T.beliefs[otra.id]` no existe si la otra nacio
      // despues de que esta muriera, porque las creencias solo se cruzan entre
      // vivas-. Salio al endurecer a los dioses: al morir mas tribus y antes,
      // una semilla de cada trescientas llegaba a ese cruce.
      const T = tribes.find(x => (x.name === ac.tribu || x.id === ac.tribu) && x.alive);
      if (ac.tipo === 'susurrar' && T) avisar(T, tick);
      if (ac.tipo === 'revelar' && T) destapar(T, tick);
      if (ac.tipo === 'mentira' && T) sembrarDuda(T, tick, ac.sobre_id);
    }
    // LAS TRES QUE YA EXISTIAN Y NADIE PODIA PEDIR. Estaban escritas dentro del
    // bucle de acciones, asi que solo se disparaban con una accion suelta -las
    // que usan las herramientas de prueba- y NO desde un voto. Ahora son
    // funciones y las llaman los dos caminos, que es la regla 1: si el dios y el
    // guion hacen "lo mismo", tiene que ser la misma funcion y no dos parecidas.
    function avisar(T, tick) {
      const tramador = T.notables.map(i => people[i]).find(p => p && p.grudge);
      if (!tramador) return false;
      const objetivo = people[tramador.grudge];
      tramador.pressure = 0; tramador.grudge = null;
      if (objetivo) objetivo.bonds[tramador.id] = -100;
      ev(tick, 'trama', 3, [T.id], [tramador.id, objetivo ? objetivo.id : null],
         { frustrada: 1, divino: 1 }, [T.id]);
      efectos.push({ tick, accion: 'susurrar', a: objetivo ? objetivo.name : '?', sobre: tramador.name });
      return true;
    }
    function destapar(T, tick) {
      const tramador = T.notables.map(i => people[i]).find(p => p && p.pressure > 20);
      if (!tramador) return false;
      for (const q of T.notables) if (q !== tramador.id) people[q].bonds[tramador.id] -= 45;
      T.cohesion -= 8;
      ev(tick, 'trama', 3, [T.id], [tramador.id], { revelada: 1, divino: 1 }, [T.id]);
      efectos.push({ tick, accion: 'revelar', quien: tramador.name });
      return true;
    }
    function sembrarDuda(T, tick, sobreId) {
      const otra = tribes.find(x => x.alive && x !== T && x.id === (sobreId || x.id));
      if (!otra || !T.beliefs[otra.id]) return false;
      T.beliefs[otra.id].estPop = otra.population * 0.35;   // los crees debiles
      T.relations[otra.id] = clamp((T.relations[otra.id] || 0) - 55, -100, 100);
      ev(tick, 'alianza', 3, [T.id, otra.id], [], { mentira_sembrada: 1, divino: 1 }, [T.id]);
      efectos.push({ tick, accion: 'mentira', quien: T.name, sobre: otra.name });
      return true;
    }

    const nuevas = [];

    // --- MUNDO ELASTICO ---
    // La tierra crece o mengua con la POBLACION TOTAL, no con el numero de tribus.
    // Asi un cisma reparte la presion existente en vez de fabricarla.
    if (tick % 6 === 0) {
      const vivos = tribes.filter(t => t.alive);
      const pobTotal = vivos.reduce((a, t) => a + t.population, 0);
      const ocupadas = vivos.reduce((a, t) => a + t.cells.length, 0);
      const eq = C.POP_EQ_RATIO || 0.9;                  // sin esto salia NaN
      const deseado = Math.max(C.MUNDO_MIN,
        Math.round(pobTotal / (C.CARRY_PER_CELL * eq) * C.MUNDO_HOLGURA));
      const actual = ocupadas + freeCells.length;
      const paso = Math.max(1, Math.round(Math.abs(deseado - actual) * C.MUNDO_AJUSTE));
      if (deseado > actual) { for (let k = 0; k < paso; k++) freeCells.push(rollCell(rng)); }
      else if (deseado < actual) { for (let k = 0; k < paso && freeCells.length > 0; k++) freeCells.pop(); }
    }

    const year = tick / C.TICKS_PER_YEAR;
    const season = 1 + 0.22 * Math.sin((tick % C.TICKS_PER_YEAR) / C.TICKS_PER_YEAR * Math.PI * 2);

    for (const t of tribes.slice()) {
      if (!t.alive) continue;

      // --- 0. La obra en curso ---
      // Va lo primero: una obra que se termina este tick cuenta ya para la
      // cosecha de este tick. Lo contrario -terminarla al final- haria que el
      // molino no diera nada el dia que se inaugura, que es justo el dia que el
      // periodico lo cuenta.
      for (const n of Object.keys(t.enObra)) {
        // UNA OBRA CUESTA MATERIAL CADA TICK, no solo tiempo. Antes se pagaba
        // una vez al empezarla -`techCost`, en `aprender`- y los doce ticks
        // siguientes salian gratis, asi que levantar no vaciaba nada. Si el
        // almacen no da, la obra NO AVANZA: el tiempo se estira, que es lo que
        // le pasa de verdad a una obra sin material con que seguir.
        const jornal = t.population * C.OBRA_MATERIAL;
        if (t.materials < jornal) continue;
        t.materials -= jornal;
        if (--t.enObra[n] <= 0) {
          delete t.enObra[n];
          t.obras[n] = true;
          delete t.rotas[n];        // levantada otra vez: se acabo el castigo
          ev(tick, 'descubrimiento', 3, [t.id], [],
             { nombre: n, obra: 1, fase: 'termina' }, [t.id]);
        }
      }

      // --- 1/2. Producción y consumo ---
      const carry = t.territory * C.CARRY_PER_CELL;
      if (tick % C.TICKS_PER_YEAR === 0) {
        t.shock = (rng() < C.SHOCK_P)
          ? C.SHOCK_MIN + rng() * (C.SHOCK_MAX - C.SHOCK_MIN)
          : 1;
      }

      // --- Reparto adaptativo del trabajo ---
      const rsv = t.food / Math.max(1, t.population * C.RATION);
      const atWar = wars.some(w => w.open && (w.a === t.id || w.b === t.id));
      // DONDE SE PONE A LA GENTE. Sale del programa del rey, con un suelo para que
      // ninguna tarea se quede en cero: una tribu que no siembra nada se muere en
      // dos anios y eso no es una decision, es un suicidio.
      //
      // Con un rey neutro -sin rasgos que tiren, terreno equilibrado- esto da
      // campo 0,54 obras 0,20 expansion 0,13 guerreros 0,13, que es practicamente
      // la tabla fija que habia antes. El punto de partida no se mueve; lo que se
      // mueve es que ahora cada rey lo separa de ahi.
      const prog = programaDelRey(t);
      const sp = prog.comer + prog.hacer + prog.crecer + prog.pelear;
      const want = {
        campo:     0.25 + 0.60 * (prog.comer / sp),
        obras:     0.05 + 0.40 * (prog.hacer / sp),
        expansion: 0.02 + 0.30 * (prog.crecer / sp),
        guerreros: 0.02 + 0.30 * (prog.pelear / sp),
      };
      // Y encima, lo que no se elige. El hambre y la guerra mandan sobre
      // cualquier programa: un rey guerrero con la reserva vacia siembra igual.
      if (rsv < 2) { want.campo = 0.80; want.obras = 0.08; want.expansion = 0.04; want.guerreros = 0.08; }
      if (atWar)   { want.guerreros = 0.32; want.campo = Math.min(want.campo, 0.50); want.obras = 0.12; want.expansion = 0.06; }
      if (freeCells.length === 0) { want.expansion = 0; want.obras += 0.06; }
      const sum = want.campo + want.obras + want.expansion + want.guerreros;
      for (const k in want) want[k] /= sum;
      for (const k in t.alloc) t.alloc[k] += clamp(want[k] - t.alloc[k], -C.ALLOC_STEP, C.ALLOC_STEP);

      // --- Producción: los mejores terrenos se trabajan primero ---
      const wFood = t.population * t.alloc.campo;
      const wMat  = t.population * t.alloc.obras;
      const cap = C.CARRY_PER_CELL;
      let prod = 0, left = wFood;
      for (const c of t.cells.slice().sort((x, y) => y.f - x.f)) {
        const on = Math.min(left, cap); if (on <= 0) break;
        prod += on * C.BASE_YIELD * c.f; left -= on;
      }
      prod *= mY(t) * season * cosechaDe(t, tick);
      let mats = 0; left = wMat;
      for (const c of t.cells.slice().sort((x, y) => y.m - x.m)) {
        const on = Math.min(left, cap); if (on <= 0) break;
        mats += on * C.MAT_YIELD * c.m; left -= on;
      }
      t.materials += mats;
      t.materials -= t.population * t.alloc.guerreros * C.ARM_COST;   // armar y reponer

      // EL SUMIDERO QUE FALTABA. Lo construido cuesta mantenerlo en pie, y el
      // coste va POR HABITANTE igual que el tope del almacen -poblacion por
      // MAT_STORAGE-, para que la proporcion no cambie cuando la tribu crece.
      //
      // Sin esto los materiales no tenian donde irse. Medido: entraban 4,09 por
      // tick, se gastaban 0,32 en armamento y se TIRABA el 92,3%, con el 72% de
      // las tribus pegadas al tope. Un almacen siempre lleno deja sin efecto
      // todo lo que le de o le quite: `revelacion` medía 0,0% sobre 24 semillas
      // y `armasDe` -la cuesta del armamento- valia 1,0 siempre, o sea que era
      // una cuesta sin cuesta. Es la deuda de TRASPASO.md §7, con numero.
      const enPie = Object.keys(t.obras).filter(n => t.obras[n]);
      const mantener = enPie.length * t.population * C.OBRA_MANTENIMIENTO;
      if (t.materials >= mantener) {
        t.materials -= mantener;
      } else if (enPie.length) {
        // No llega: se cae LO MAS VIEJO. Se elige el primero de la lista -el que
        // lleva mas tiempo en pie- y no al azar, para no gastar `rng` en esto:
        // cada llamada al azar recoloca el mundo entero y esto pasa a menudo.
        t.materials = 0;
        const cae = enPie[0];
        delete t.obras[cae];
        t.rotas[cae] = true;              // en ruinas hasta que la levanten otra vez
        // `abandono` lo separa de las otras dos ruinas -la que tira una batalla y
        // la que tiran los dioses-. Sin esa marca el pliego publicaria "se la han
        // tirado abajo" de algo que no tiro nadie, que es mentira escrita.
        ev(tick, 'obra_perdida', 3, [t.id], [], { obra: cae, abandono: 1 }, [t.id]);
      }
      t.materials = clamp(t.materials, 0, t.population * C.MAT_STORAGE);
      const cons = t.population * C.RATION * (1 + t.alloc.guerreros * (C.WARRIOR_UPKEEP - 1) + t.alloc.guerreros * 0.25);
      t.food += prod - cons;
      const storage = t.population * C.STORAGE_MULT * mS(t);
      if (t.food > storage) t.food = storage;

      // --- 3. Hambruna / demografía ---
      if (t.food < 0) {
        const severity = Math.min(1, -t.food / Math.max(1, t.population * C.RATION));
        const dead = t.population * C.FAMINE_DEATH * severity;
        t.population -= dead;
        t.cohesion -= C.FAMINE_COHESION * severity;
        t.food = 0;
        t.famineTicks++;
        if (!t.inFamine && t.famineTicks >= 2 && severity > C.FAMINE_TRIGGER && tick - t.lastFamine > C.TICKS_PER_YEAR) {
          t.inFamine = true; t.lastFamine = tick;
          metrics.famines++;
          ev(tick, 'hambruna', severity > 0.6 ? 3 : 2, [t.id], [], { dead: Math.round(dead) }, [t.id]);
          const ldr = t.notables.map(i => people[i]).find(p => p.role === 'lider');
          if (ldr) ldr.prestige = clamp(ldr.prestige - C.PRESTIGE_FAMINE * severity, 0, 100);
        }
      } else {
        t.cohesion += C.COHESION_RECOVER + mC(t);
        t.famineTicks = 0;
        if (t.inFamine) { t.inFamine = false; ev(tick, 'fin_hambruna', 1, [t.id], [], {}, [t.id]); }
      }

      const reserve = t.food / Math.max(1, t.population * C.RATION); // ticks de reserva
      const crowdBrake = clamp(1 - C.CROWD_BIRTH * (t.population / Math.max(1, carry)), 0, 1);
      const foodBrake = clamp(reserve / 2, 0, 1);
      const stress = reserve < 1 ? (1 - reserve) : 0;
      t.population += t.population * (
        C.BIRTH_RATE * crowdBrake * (0.35 + 0.65 * foodBrake)
        - C.DEATH_RATE * (1 + stress * C.STRESS_DEATH / C.DEATH_RATE)
      );

      // --- 4. Salud y muerte de notables ---
      for (const pid of t.notables.slice()) {
        const p = people[pid];
        if (p.diedTick !== null) continue;
        const age = (tick - p.bornTick) / C.TICKS_PER_YEAR;
        p.health -= C.HEALTH_DECAY * (has(p, 'enfermizo') ? 1.9 : 1);
        let pd = 0;
        if (age > C.AGE_DEATH_START) pd = (age - C.AGE_DEATH_START) * C.AGE_DEATH_SLOPE;
        // LA FRAGILIDAD ES UNA RAMPA, NO UN ACANTILADO. Esto era
        // `if (p.health < 30) pd += 0.010` y estaba MUERTO: la salud arranca
        // entre 78 y 100, cae 0,032 por tick, y una era tipica dura ~1.278
        // ticks, asi que aterriza entre 37 y 59. La era se acababa antes de que
        // nadie llegase a 30. Medido: 2 personas de 2.686.
        //
        // No era un numero mal puesto: era un escalon colocado mas abajo de
        // donde el mundo llega nunca. Se sustituye por una rampa desde 62, que
        // es el umbral de fragilidad QUE EL MOTOR YA USA dos lineas mas abajo
        // para el hambre — asi hay un solo umbral y no dos.
        //
        // Y la pendiente no se elige a ojo: 0,0003125 hace que la rampa valga
        // exactamente 0,010 en salud 30, o sea el mismo numero que valia el
        // escalon justo donde estaba. Misma intencion, alcanzable.
        if (p.health < C.FRAGIL) pd += (C.FRAGIL - p.health) * C.FRAGIL_PENDIENTE;
        const hambre = p.health < 62 && t.lastHoarder && t.lastHoarder !== pid && tick - t.hoardTick < 180;
        if (hambre && rng() < 0.020) {
          p.diedTick = tick; p.causeOfDeath = 'hambre';
          if (p.role === 'lider') t.lastLeaderDead = p;
          if (p.pareja && people[p.pareja]) people[p.pareja].pareja = null;
          metrics.notableDeaths++;
          t.notables = t.notables.filter(x => x !== pid);
          const culpable = people[t.lastHoarder];
          ev(tick, 'muerte', 3, [t.id], [p.id, t.lastHoarder], { hambre: 1 }, [t.id]);
          if (culpable && culpable.diedTick === null) vow(rng, C, people, t, p, culpable, ev, tick);
          continue;
        }
        if (rng() < pd) {
          p.diedTick = tick; p.causeOfDeath = 'edad';
          if (p.role === 'lider') t.lastLeaderDead = p;
          if (p.pareja && people[p.pareja]) people[p.pareja].pareja = null;
          metrics.notableDeaths++;
          if (p.everLeader && p.peakPrestige >= 80 && p.leaderTicks >= 240) metrics.fullArcs++;
          ev(tick, 'muerte', p.role === 'lider' ? 3 : 2, [t.id], [p.id], { age: Math.round(age) }, [t.id]);
          t.notables = t.notables.filter(x => x !== pid);
        }
        p.peakPrestige = Math.max(p.peakPrestige, p.prestige);
      }

      // --- Reposición de notables ---
      // El cupo completo pide una tribu holgada; pero una tribu de 14 seguia
      // VIVA (`TRIBU_MINIMA` son 12) y publicando periodico sin poder nombrar a
      // nadie nunca. Entre 12 y 25 habia una franja muerta: 2.125 de 38.048
      // ediciones -el 5,6%- las firmaba una tribu sin una sola persona con
      // nombre, con rachas de hasta 41 ediciones seguidas. El "quien es quien"
      // salia entero tachado y no podia haber ni una noticia de persona.
      const cupo = t.population > 25 ? C.NOTABLES_TARGET : C.NOTABLES_MINIMO;
      while (t.notables.length < cupo && t.population >= C.TRIBU_MINIMA) {
        const difunto = t.lastLeaderDead;
        const heredero = difunto && rng() < C.HEIR_P;
        const np = makePerson(rng, t.idx, t.id, tick, C, 16 + rng() * 8, usedNames,
                              heredero ? difunto : null);
        if (heredero) {
          np.prestige = clamp(np.prestige + C.HEIR_PRESTIGE, 0, 100);
          const otro = difunto.pareja ? people[difunto.pareja] : null;
          if (difunto.sexo === 'f') { np.madreName = difunto.name; np.parentName = otro ? otro.name : null; }
          else { np.parentName = difunto.name; np.madreName = otro ? otro.name : null; }
          t.lastLeaderDead = null;
        }
        people[np.id] = np; t.notables.push(np.id);
        for (const other of t.notables) if (other !== np.id) {
          np.bonds[other] = -20 + rng() * 50;
          people[other].bonds[np.id] = -20 + rng() * 50;
        }
        ev(tick, 'ascenso', heredero ? 2 : 1, [t.id], [np.id], { heredero: heredero ? 1 : 0 }, [t.id]);
      }

      // --- 4b. Dinámica de prestigio ---
      for (const pid of t.notables) {
        const p = people[pid];
        if (p.diedTick !== null) continue;
        let g = C.PRESTIGE_BASE - C.PRESTIGE_DECAY - p.prestige * C.PRESTIGE_MEANREV;
        if (p.role === 'lider') p.leaderTicks++;
        if (p.role === 'lider') {
          // Mandar desgasta: los primeros anios dan prestigio, los siguientes lo quitan.
          // Sin esto el lider se vuelve intocable y no hay golpes de estado.
          const anios = p.leaderTicks / C.TICKS_PER_YEAR;
          const factor = 1 - anios / C.DESGASTE_ANIOS;
          g += C.PRESTIGE_TENURE * factor * (t.food > 0 ? 1 : 0.4);
        }
        // LLEVAR UN OFICIO DA PRESTIGIO, Y DA LO MISMO CUAL. Esto decia
        // `chaman || guerrero` y dejaba fuera a artesano y anciano, que se
        // aniadieron a ROLES despues: como a lider se llega por prestigio -la
        // sucesion coge al notable con mas, y el golpe de estado se decide por
        // la diferencia-, los dos eran callejones sin salida para ascender.
        // Medido sobre 40 eras, prestigio mediano por oficio:
        //
        //             chaman  guerrero  artesano  anciano  ninguno
        //   antes       48,5     48,9      42,7     36,3     28,1
        //   ahora       48,1     48,8      48,3     46,9     28,9
        //
        // SE ESCRIBE POR LO QUE NO ES -ni lider ni sin oficio- y no con la lista
        // de los cuatro, PORQUE LA LISTA ES LO QUE SE DESCUADRO: el oficio nuevo
        // entro en ROLES y nadie se acordo de esta linea, y siguio compilando.
        // El lider no entra aqui porque tiene su propia clausula de desgaste
        // justo arriba, que le da y le quita segun lo que lleve mandando.
        //
        // Y NO SE INVENTA UNA CONSTANTE NUEVA: es el mismo 0,45 que ya cobraban
        // los otros dos. Se probo tambien con 0,25 -"el trabajo menos visible
        // cobra menos"- y a 40 semillas los numeros no lo sostienen: artesano
        // salia MAS alto que con 0,45. Un numero que la medida no distingue es
        // un numero inventado.
        if (p.role !== 'lider' && p.role !== 'ninguno') g += C.PRESTIGE_TENURE * 0.45;
        if (has(p, 'carismatico')) g += C.PRESTIGE_TENURE * 0.55;
        if (has(p, 'ambicioso')) g += C.PRESTIGE_TENURE * 0.35;
        if (has(p, 'generoso') && t.food > t.population * 1.5) g += C.PRESTIGE_TENURE * 0.4;
        if (has(p, 'cobarde')) g -= C.PRESTIGE_DECAY * 0.8;
        p.prestige = clamp(p.prestige + g, 0, 100);
      }

      // --- 4b2. Deriva de vínculos: las relaciones se polarizan con los años ---
      if (t.notables.length > 1 && rng() < C.BOND_DRIFT_P) {
        const x = pick(rng, t.notables), y = pick(rng, t.notables);
        if (x !== y) {
          const d = (rng() < 0.5 ? -1 : 1) * C.BOND_DRIFT;
          people[x].bonds[y] = clamp((people[x].bonds[y] || 0) + d, -100, 100);
          people[y].bonds[x] = clamp((people[y].bonds[x] || 0) + d * 0.7, -100, 100);
        }
      }

      // --- 4b2b. El poder cansa a los de abajo ---
      {
        const ldr = t.notables.map(i => people[i]).find(x => x && x.role === 'lider');
        if (ldr && ldr.leaderTicks > C.TICKS_PER_YEAR * 3 && rng() < 0.25) {
          const anios = ldr.leaderTicks / C.TICKS_PER_YEAR;
          for (const q of t.notables) {
            if (q === ldr.id) continue;
            people[q].bonds[ldr.id] = clamp((people[q].bonds[ldr.id] || 0)
              - C.DESGASTE_RENCOR * (anios / 10), -100, 100);
          }
        }
      }

      // --- 4b3. Parejas ---
      if (rng() < C.PAREJA_P && t.notables.length > 2) {
        const libres = t.notables.map(i => people[i])
          .filter(x => x && x.diedTick === null && !x.pareja);
        for (const a of libres) {
          const b = libres.find(y => y !== a && !y.pareja && y.sexo !== a.sexo
                                 && (a.bonds[y.id] || 0) > 20);
          if (b) {
            a.pareja = b.id; b.pareja = a.id;
            a.bonds[b.id] = 85; b.bonds[a.id] = 85;
            ev(tick, 'pareja', 2, [t.id], [a.id, b.id], { pareja: 1 }, [t.id]);
            break;
          }
        }
      }

      // --- 4c. Ambiciones con mecánica ---
      for (const pid of t.notables.slice()) {
        const p = people[pid];
        if (!p || p.diedTick !== null) continue;

        if (p.ambition === 'enriquecerse' && t.food > t.population * 0.5 && (p.pressure += 1) >= C.ACT_GREED) {
          p.pressure = 0;
          const take = t.population * C.GREED_TAKE;
          t.food -= take; p.wealth += take;
          p.prestige = clamp(p.prestige + 2, 0, 100);
          t.cohesion -= C.GREED_COHESION;
          for (const q of t.notables) if (q !== pid) people[q].bonds[pid] = (people[q].bonds[pid] || 0) - C.GREED_HATE;
          const pobres = t.notables.filter(x => x !== pid && people[x].diedTick === null)
            .sort((x, y) => people[x].prestige - people[y].prestige);
          const victima = pobres[0] || null;
          if (victima) { people[victima].health -= 14; t.lastHoarder = pid; t.hoardTick = tick; }
          ev(tick, 'acaparamiento', 2, [t.id], [pid], { acaparamiento: Math.round(take),
             victima: victima || '' }, [t.id]);
        }

        if (p.ambition === 'ser_recordado' && p.deeds < 1 && p.prestige > 50 && (p.pressure += 1) >= C.ACT_DEED) {
          p.pressure = 0;
          const cost = t.population * C.DEED_COST;
          if (t.food > cost) {
            t.food -= cost;
            if (rng() < C.DEED_SUCCESS) {
              aprenderAlgo(t, tick, p.id); p.deeds++; p.prestige = clamp(p.prestige + 12, 0, 100);
              ev(tick, 'descubrimiento', 3, [t.id], [pid], { gran_obra: 1 }, [t.id]);
            } else {
              p.prestige = clamp(p.prestige - 12, 0, 100); t.cohesion -= 4;
              ev(tick, 'descubrimiento', 3, [t.id], [pid], { gran_obra: 0 }, [t.id]);
            }
          }
        }

        if (p.ambition === 'proteger_a_alguien' && !p.ward) {
          const cands = t.notables.filter(x => x !== pid && people[x].diedTick === null);
          if (cands.length) {
            p.ward = cands[Math.floor(rng() * cands.length)];
            p.bonds[p.ward] = 90;
            ev(tick, 'alianza', 2, [t.id], [pid, p.ward], { juramento_proteccion: 1 }, [t.id]);
          }
        }

        if (p.ambition === 'vengarse') {
          if (!p.grudge) {
            const enemies = t.notables.filter(x => x !== pid && people[x].diedTick === null)
              .sort((a, b) => (p.bonds[a] || 0) - (p.bonds[b] || 0));
            if (enemies.length && (p.bonds[enemies[0]] || 0) < -30) {
              p.grudge = enemies[0];
              ev(tick, 'rencor', 2, [t.id], [pid, p.grudge], { rencor: 1 }, [t.id]);
            }
          } else {
            const tgt = people[p.grudge];
            if (!tgt || tgt.diedTick !== null) { p.grudge = null; }
            else {
              const antes = p.pressure;
              p.pressure += 1 + Math.max(0, -(p.bonds[p.grudge] || 0)) / 50;
              for (let si = 0; si < C.PLOT_STEPS.length; si++) {
                const um = C.ACT_REVENGE * C.PLOT_STEPS[si];
                if (antes < um && p.pressure >= um)
                  ev(tick, 'trama', 2, [t.id], [p.id, p.grudge], { fase: si, tipo: 'venganza' }, []);
              }
            }
            if (p.pressure >= C.ACT_REVENGE) {
              p.pressure = 0;
              if (protect(t, tgt, p, tick)) {
                // el protector muere en su lugar
              } else if (rng() < C.REVENGE_SUCCESS) {
                tgt.diedTick = tick; tgt.causeOfDeath = 'asesinato';
                p.kills++; metrics.notableDeaths++; metrics.treacheries++;
                if (tgt.role === 'lider') { p.role = 'lider'; p.everLeader = true; }
                t.notables = t.notables.filter(x => x !== tgt.id);
                t.cohesion -= 6;
                ev(tick, 'traicion', 3, [t.id], [p.id, tgt.id], { venganza: 1, exito: 1 }, [t.id]);
                vow(rng, C, people, t, tgt, p, ev, tick);
              } else {
                p.diedTick = tick; p.causeOfDeath = 'ejecucion';
                metrics.notableDeaths++;
                t.notables = t.notables.filter(x => x !== pid);
                ev(tick, 'traicion', 2, [t.id], [p.id, tgt.id], { venganza: 1, exito: 0 }, [t.id]);
              }
              p.grudge = null;
            }
          }
        }
      }

      // --- 5. Ambiciones / traición ---
      const leader = t.notables.map(i => people[i]).find(p => p.role === 'lider');
      if (!leader && t.notables.length) {
        const best = t.notables.map(i => people[i]).sort((a, b) => b.prestige - a.prestige)[0];
        best.role = 'lider'; best.everLeader = true; best.prestige += 12;
        ev(tick, 'ascenso', 2, [t.id], [best.id], { role: 'lider' }, [t.id]);
      }

      // --- 5b. Los oficios vacantes ---
      //
      // Los oficios se repartian UNA vez, al fundar la tribu, y no se volvian a
      // cubrir: el lider se sucede, pero el chaman y el guerrero se morian y no
      // los sustituia nadie. En una era completa salian 19 lideres, 3 chamanes,
      // 2 guerreros y 34 personas sin oficio; `artesano` y `anciano` estaban
      // declarados en ROLES y no se asignaban jamas.
      //
      // El oficio va a quien tiene el rasgo, y si no hay nadie con el rasgo, a
      // quien mas prestigio tenga sin oficio. Asi el cargo dice algo de la
      // persona y el periodico puede contar por que le toco a ese.
      // La eleccion es la misma que al fundar y vive en `cubrirOficios`. Aqui SI
      // hay noticia: alguien ha ascendido.
      for (const [elegido, oficio] of cubrirOficios(t, people, has)) {
        ev(tick, 'ascenso', 1, [t.id], [elegido.id], { role: oficio }, [t.id]);
      }
      if (leader) {
        for (const pid of t.notables) {
          const p = people[pid];
          if (p === leader || p.diedTick !== null) continue;
          if (p.ambition !== 'gobernar') continue;
          // la ambicion se acumula: un rival fuerte y odiado ACABARA moviendose
          const aniosMando = leader.leaderTicks / C.TICKS_PER_YEAR;
          let rate = (p.prestige - leader.prestige + 25) / 25
                   + aniosMando * C.DESGASTE_GOLPE;   // llevar mucho mandando es peligroso
          if (has(p, 'ambicioso') || has(p, 'cruel') || has(p, 'astuto')) rate *= 1.6;
          if (has(p, 'cobarde') || has(p, 'leal')) rate *= 0.3;
          const bond = p.bonds[leader.id] || 0;
          if (bond < 0) rate += (-bond) / 40;
          if (t.cohesion < 40) rate *= 1.6;
          if (rate <= 0) continue;
          const antesC = p.pressure;
          p.pressure += rate;
          for (let si = 0; si < C.PLOT_STEPS.length; si++) {
            const um = C.ACT_COUP * C.PLOT_STEPS[si];
            if (antesC < um && p.pressure >= um)
              ev(tick, 'trama', 2, [t.id], [p.id, leader.id], { fase: si, tipo: 'golpe' }, []);
          }
          if (p.pressure >= C.ACT_COUP) {
            p.pressure = 0;
            metrics.treacheries++;
            const success = !protect(t, leader, p, tick)
              && rng() < clamp(C.COUP_BASE + (p.prestige - leader.prestige) / 160, 0.15, 0.85);
            if (success) {
              leader.diedTick = tick; leader.causeOfDeath = 'traicion';
              if (leader.everLeader && leader.peakPrestige >= 80 && leader.leaderTicks >= 240) metrics.fullArcs++;
              t.notables = t.notables.filter(x => x !== leader.id);
              p.role = 'lider'; p.everLeader = true; p.prestige += 15;
              t.cohesion -= 9;
              ev(tick, 'traicion', 3, [t.id], [p.id, leader.id], { exito: 1 }, [t.id]);
              p.kills++;
              vow(rng, C, people, t, leader, p, ev, tick);
            } else {
              p.diedTick = tick; p.causeOfDeath = 'ejecucion';
              t.notables = t.notables.filter(x => x !== p.id);
              leader.prestige += 6; t.cohesion -= 4;
              ev(tick, 'traicion', 2, [t.id], [p.id, leader.id], { exito: 0 }, [t.id]);
            }
            break;
          }
        }
      }

      // --- 6. Cohesión / cisma ---
      const pres = t.notables.map(i => people[i].prestige);
      if (pres.length > 1) {
        const mean = pres.reduce((a, b) => a + b, 0) / pres.length;
        const sd = Math.sqrt(pres.reduce((a, b) => a + (b - mean) ** 2, 0) / pres.length);
        t.cohesion -= sd * C.COHESION_INEQ;
      }
      t.cohesion = clamp(t.cohesion, 0, 100);
      if (t.cohesion < C.SCHISM_THRESHOLD && t.population > 40) {
        metrics.schisms++;
        const lost = t.population * C.SCHISM_LOSS;
        t.population -= lost;
        t.cohesion = 48;
        const lider = t.notables.map(i => people[i]).find(x => x && x.role === 'lider');
        // el fundador es el que peor se lleva con quien manda
        const disidentes = t.notables.map(i => people[i])
          .filter(x => x && x.diedTick === null && x !== lider)
          .sort((a, b) => (a.bonds[lider ? lider.id : ''] || 0) - (b.bonds[lider ? lider.id : ''] || 0));
        const fundador = disidentes[0] || null;

        if (fundador && tribes.filter(x => x.alive).length < C.MAX_TRIBUS && t.cells.length > 2) {
          // DOS TRIBUS NO PUEDEN LLAMARSE IGUAL EN LA MISMA ERA.
          //
          // Una escision toma el nombre de su fundador, que es una PERSONA. Ese
          // nombre es unico entre PERSONAS y nada mas: nada impedia que
          // coincidiera con el de una tribu que ya existe. Medido sobre 300 eras
          // y 61.918 dias: pasaba en el 0,67% de las eras, con una ventana de
          // unos trece dias con las dos vivas a la vez.
          //
          // Lo que rompia: `alive.find(t => t.name === ...)` coge LA PRIMERA, o
          // sea que los dioses apuntaban a una y le caia a la otra; y el cierre
          // de padrinazgos, que va por (era, nombre), cerraba los de las dos.
          //
          // EL SORTEO VA EN UN HILO APARTE, como el de la mesa y por el mismo
          // motivo: con el `rng` principal, buscar otro nombre consumiria tiradas
          // y recolocaria TODO lo que viene despues -cada nacimiento y cada
          // muerte de la era-. Con hilo propio, lo unico que cambia es el nombre.
          //
          // Y EL CAMINO LIMPIO NO GASTA NI UNA TIRADA: si el nombre esta libre
          // -que es el 99,3% de las veces- esto es una consulta a un conjunto y
          // el mundo sale identico. Por eso este arreglo no mueve la huella.
          let nombreNuevo = fundador.name;
          if (nombresTribu.has(nombreNuevo)) {
            const rAlt = mulberry32(hashSeed(seedStr + '|cisma|' + fundador.id));
            do { nombreNuevo = makeName(rAlt, t.idx, null); } while (nombresTribu.has(nombreNuevo));
          }
          nombresTribu.add(nombreNuevo);
          const nt = nuevaTribu(nombreNuevo, t.idx);        // hereda la fonetica: son los mismos
          nt.era = seedStr;
          nt.madre = t.id; nt.fundador = fundador.id;
          nt.population = lost;
          nt.food = t.food * C.SCHISM_LOSS; t.food -= nt.food;
          nt.materials = t.materials * C.SCHISM_LOSS; t.materials -= nt.materials;
          nt.tech = t.tech; nt.known = t.known;
          // Se llevan lo que saben, no lo que hay levantado: las obras se
          // quedan donde estan. Una escision empieza sabiendo hacer murallas y
          // sin ninguna muralla, que es lo que tiene marcharse.
          nt.obras = {}; nt.enObra = {}; nt.rotas = {};
          nt.sabidas = Object.assign({}, t.sabidas); nt.lineas = [];
          nt.mulY = t.mulY; nt.mulM = t.mulM; nt.mulS = t.mulS; nt.mulC = t.mulC; nt.mulR = t.mulR;
          nt.mulD = t.mulD;
          const nCel = Math.max(1, Math.round(t.cells.length * C.SCHISM_CELLS));
          for (let k = 0; k < nCel && t.cells.length > 1; k++) nt.cells.push(t.cells.pop());

          // se llevan a los suyos: los que tampoco tragan al lider
          const seVan = disidentes.slice(0, 2);
          for (const d of seVan) { t.notables = t.notables.filter(x => x !== d.id); nt.notables.push(d.id); d.tribeId = nt.id; }
          fundador.role = 'lider'; fundador.everLeader = true; fundador.prestige = clamp(fundador.prestige + 15, 0, 100);

          // nace odiando a la madre
          for (const o of tribes) {
            if (!o.alive) continue;
            const enemiga = o.id === t.id;
            nt.relations[o.id] = enemiga ? -75 : ((t.relations[o.id] || 0) * 0.5);
            o.relations[nt.id] = enemiga ? -75 : ((o.relations[t.id] || 0) * 0.5);
            nt.beliefs[o.id] = { estPop: o.population * (0.8 + rng() * 0.4), estHostility: 0, lastContact: tick };
            o.beliefs[nt.id] = { estPop: nt.population * (0.8 + rng() * 0.4), estHostility: 0, lastContact: tick };
          }
          nuevas.push(nt);
          metrics.nuevasTribus = (metrics.nuevasTribus || 0) + 1;
          ev(tick, 'cisma', 3, [t.id], [fundador.id],
             { perdidos: Math.round(lost), funda: nt.name, celdas: nCel }, tribes.map(x => x.id));
        } else {
          if (t.cells.length > 2) { const l2 = t.cells.pop(); freeCells.push(l2); }
          ev(tick, 'cisma', 3, [t.id], [], { perdidos: Math.round(lost) }, [t.id]);
        }
      }

      // --- 9. Tecnología ---
      // --- Lo que se esta aprendiendo, que ahora puede ser mas de una cosa ---
      //
      // CUANTAS LINEAS: una base, mas una por cada notable con oficio de saber,
      // con tope. Atado a la GENTE y no a un numero suelto, para que "puso a
      // varios a estudiar" sea literalmente lo que pasa aqui dentro y el
      // periodico pueda contarlo sin inventar. Si la tribu se queda sin sabios,
      // las lineas abiertas siguen, pero no se abren mas.
      // EL ARTESANO SE VA A LA OBRA. Mientras hay algo levantandose no esta en el
      // taller, y eso cuesta una LINEA DE ESTUDIO: `capacidad` sale de cuantos
      // sabios hay disponibles, asi que la tribu lleva una cosa menos entre manos.
      // Levantar cuesta materiales, tiempo y una cabeza, y es la unica de las
      // tres que el pliego puede poner en un titular, porque tiene nombre.
      //
      // PERO SIGUE CONTANDO PARA `SABIO_FALTA`: `capacidad` es cuantas cosas se
      // pueden llevar a la vez -y el que esta en el andamio no lleva ninguna-
      // mientras que SABIO_FALTA pregunta si queda ALGUIEN que sepa, y el
      // artesano sigue vivo y sigue sabiendo. Quitarlo de los dos sitios seria
      // castigar dos veces por lo mismo.
      //
      // QUE NO SE CONFUNDA CON UNA PALANCA: medido sobre 54 tribus, el caso en
      // que la distincion cambia algo -artesano en la obra siendo el unico
      // entendido vivo- salio CERO veces. Se deja porque es lo correcto cuando
      // pase, no porque hoy mueva un numero. Lo que cuesta la obra de verdad es
      // la linea de estudio, y eso si se mide: 1,60 lineas abiertas con obra en
      // curso contra 2,69 sin ella.
      const levantando = Object.keys(t.enObra).length > 0;
      const entendidos = t.notables.map(i => people[i])
        .filter(p => p && p.diedTick === null && (p.role === 'chaman' || p.role === 'artesano'));
      const sabios = entendidos.filter(p => p.role !== 'artesano' || !levantando);
      const capacidad = Math.min(C.LINEAS_TOPE, 1 + sabios.length);
      // QUE SE MANDA ESTUDIAR. Antes se sacaba al azar de lo disponible, asi que
      // la tribu de un rey guerrero investigaba la ceramica con la misma
      // probabilidad que el arco. Ahora pesa el programa del rey -que ya trae
      // dentro el terreno y los oficios- y pesa mas que nada lo suyo caido.
      const hambre = rsv < 3;
      while (t.lineas.length < capacidad) {
        const libres = disponibles(t);
        if (!libres.length) break;
        t.lineas.push(eligeHito(t, libres, prog, hambre).n);
      }

      // INVESTIGAR CUESTA CADA TICK, no solo al rematar. Antes abrir una linea
      // era gratis y el material se cobraba entero al terminar el hito, asi que
      // una tribu podia tener tres lineas abiertas medio anio sin gastar nada.
      // Ahora cada linea abierta come material mientras esta abierta -por
      // habitante, como todo lo demas-, y si el almacen no da, LAS LINEAS NO
      // AVANZAN: el saber se para, no se pierde. Es la otra mitad de "cuesta
      // materiales y tiempo".
      //
      // Junto con el mantenimiento de las obras, esto es lo que le da fondo al
      // almacen. Solo con las obras el almacen seguia al 99% -medido-, porque el
      // ingreso de la cantera le sacaba casi el doble a todos los gastos juntos.
      const jornalSaber = t.lineas.length * t.population * C.SABER_MATERIAL;
      const puedeEstudiar = t.materials >= jornalSaber;
      if (puedeEstudiar) t.materials -= jornalSaber;

      const techCost = C.TECH_MAT_COST * (1 + t.known * 0.55);
      //
      // EL RITMO SE REPARTE ENTRE LAS LINEAS, no se multiplica. Es la decision
      // de diseno que sostiene todo esto: el paralelo da VARIEDAD, no VELOCIDAD.
      // Dos tribus de la misma edad ya no saben lo mismo -una navega, la otra
      // escribe- pero el mundo no se acelera.
      //
      // La primera version rodaba una tirada por linea y el mundo se vino
      // abajo: la era pasaba de 57 anios a 24, el arbol se terminaba antes de
      // que diera tiempo a una guerra y certify caia de 0.9977 a 0.4812.
      // Bajar TECH_RATE lo compensaba a medias -las hambrunas no volvian- y
      // eso era la senial de que el arreglo no era el numero, era el reparto.
      const ritmo = C.TECH_RATE * (1 + t.population * t.alloc.obras / 120) * mR(t)
                    * (entendidos.length ? 1 : C.SABIO_FALTA)
                    / Math.max(1, t.lineas.length);
      for (const n of t.lineas.slice()) {
        if (!puedeEstudiar) break;          // sin material no se estudia hoy
        if (t.materials <= techCost) break;
        if (rng() >= ritmo) continue;
        t.materials -= techCost;
        t.lineas = t.lineas.filter(x => x !== n);
        const sabio = sabios[0];
        if (aprender(t, n, tick, sabio ? sabio.id : null)) {
          metrics.discoveries++;
          if (sabio) sabio.prestige = clamp(sabio.prestige + C.PRESTIGE_DISCOVERY, 0, 100);
        }
      }
      for (const o of tribes) {
        if (o === t || !o.alive) continue;
        if ((t.relations[o.id] || 0) > 40 && o.known > t.known && rng() < C.TECH_DIFFUSION) aprenderAlgo(t, tick, null);
      }

      // --- Expansión ---
      t.effort += t.population * t.alloc.expansion;
      if (t.effort >= C.EXPAND_EFFORT && freeCells.length > 0 && t.food > 0) {
        t.effort -= C.EXPAND_EFFORT;
        const idx = Math.floor(rng() * freeCells.length);
        const got = freeCells.splice(idx, 1)[0];
        t.cells.push(got);
        ev(tick, 'migracion', 2, [t.id], [], { terreno: got.t }, [t.id]);
      }
    }

    // --- 10. Llegada de conocimiento retrasado ---
    for (const t of tribes) {
      if (!t.alive) continue;
      const still = [];
      for (const pk of t.pendingKnowledge) {
        if (pk.arrive <= tick) {
          const delay = tick - pk.e.tick;
          const fid = clamp(100 - delay * C.FIDELITY_DECAY - (3 - pk.mag) * 8, 5, 100);
          t.knownEvents[pk.e.id] = { fidelity: fid, learned: tick, distorted: fid < C.RUMOR_THRESHOLD };
        } else still.push(pk);
      }
      t.pendingKnowledge = still;
    }

    // --- 7. Relaciones y creencias ---
    const alive = aliveTribes();
    for (const a of alive) for (const b of alive) {
      if (a === b) continue;
      const bel = a.beliefs[b.id];
      if (!bel) continue;
      // la estimación se degrada hacia la realidad solo si hay contacto
      // sin relaciones no hay informacion: al enemigo se le deja de ver
      const rel = a.relations[b.id] || 0;
      const contact = rel > -25 && rng() < C.CONTACT_P;
      if (contact) {
        bel.estPop += (b.population - bel.estPop) * 0.45;
        bel.lastContact = tick;
      } else {
        // la estimacion envejece: deriva aleatoria + sesgo de menosprecio
        // Sin trato, la estimacion envejece y se tuerce a la baja. Un anciano
        // frena ese menosprecio: el que se acuerda de como eran.
        const menosprecio = C.CONTEMPT_BIAS
          * (tieneOficio(a, people, 'anciano') ? C.ANCIANO_MEMORIA : 1);
        bel.estPop *= (1 + (rng() - 0.5) * C.BELIEF_DRIFT - menosprecio);
      }
      const used2 = alive.reduce((s2, x) => s2 + x.territory, 0);
      const freeLand = freeCells.length;
      const mundoTotal = used2 + freeCells.length;      // tamaño REAL del mundo hoy
      const scarcity = clamp((used2 / Math.max(1, mundoTotal) - 0.5) / 0.5, 0, 1);
      const fill = a.population / Math.max(1, a.territory * C.CARRY_PER_CELL);
      const landHunger = (fill > 0.60 && freeLand < 1.5) ? 1 : 0;
      let d = 0;
      d -= landHunger * C.TERRITORY_PRESSURE * 0.10;
      d -= scarcity * C.SCARCITY_HOSTILITY * 0.10;
      const ldrA = a.notables.map(i => people[i]).find(p => p.role === 'lider');
      if (ldrA && ldrA.ambition === 'vengarse') d -= 0.05;
      if (ldrA && has(ldrA, 'iracundo')) d -= 0.03;
      d += (0 - (a.relations[b.id] || 0)) * C.GRIEVANCE_DECAY;
      a.relations[b.id] = clamp((a.relations[b.id] || 0) + d, -100, 100);
    }

    // --- 8. Guerra y batalla ---
    for (const a of alive) {
      // LAS GANAS DEL REY. Decidir que se estudia y donde va la gente y NO decidir
      // si se ataca dejaba al rey a medias: echarse encima del vecino es la
      // decision mas suya de las tres. `pelear` vale 1 en un rey neutro, asi que
      // esto no mueve nada en un mundo de reyes del monton; lo que mueve es que
      // uno vengativo se lanza y uno que quiere que la gente coma aguanta.
      //
      // Se calcula una vez por tribu y no una por pareja: no usa `rng`, asi que
      // sacarlo del bucle no cambia el mundo, solo lo hace cinco veces mas barato.
      const ganas = Math.pow(programaDelRey(a).pelear, C.REY_BELICOSO);
      for (const b of alive) {
        if (a === b) continue;
        if ((a.relations[b.id] || 0) > C.WAR_THRESHOLD) continue;
        if ((a.warCooldown[b.id] || 0) > tick) continue;
        const pair = w => (w.a === a.id && w.b === b.id) || (w.a === b.id && w.b === a.id);
        const openWar = wars.find(w => w.open && pair(w));
        if (!openWar) {
          const lastWar = wars.filter(pair).sort((x, y) => (y.end || 0) - (x.end || 0))[0];
          if (lastWar && tick - (lastWar.end || 0) < C.TRUCE) continue; // tregua
        }
        const bel = a.beliefs[b.id];
        if (!bel) continue;

        // LO QUE CREE QUIEN ATACA.
        //
        // Es el mismo calculo que decide la batalla, pero con `bel.estPop` en
        // lugar de la poblacion real de b: la estimacion es lo unico que `a`
        // puede saber. Del resto -guerreros, tecnologia, cohesion- se usan los
        // valores verdaderos, que es una simplificacion: lo que el motor modela
        // como incierto es cuanta gente tiene el vecino, no todo lo demas.
        //
        // Aqui es donde una decision de los dioses acaba en un final concreto:
        // la mentira sembrada pone estPop al 35% y la tribu acomete creyendo
        // que gana. Y el menosprecio que va acumulandose sin trato -CONTEMPT_
        // BIAS- hace que atacar por mal calculo sea la norma, no la excepcion.
        const fCreeSuya = a.population * Math.max(0.05, a.alloc.guerreros)
          * mM(a) * (1 + a.cohesion / 200);
        const fCreeAjena = Math.max(1, bel.estPop) * Math.max(0.05, b.alloc.guerreros)
          * mM(b) * mD(b) * (1 + b.cohesion / 200);
        const creeGanar = fCreeSuya / (fCreeSuya + fCreeAjena);
        // Con AUDACIA 0 esto vale 1 y la probabilidad queda exactamente como
        // estaba, que es lo que permite comprobar que el resto no ha cambiado.
        const audacia = C.AUDACIA ? Math.pow(creeGanar / 0.5, C.AUDACIA) : 1;
        if (rng() > C.BATTLE_CHANCE * (openWar ? C.WAR_INTENSITY : 1) * audacia * ganas) continue;

        const believedWeaker = bel.estPop < b.population * 0.75;
        // Quien lleva la guerra cuenta. Si los dos lo tienen se anula, que es lo
        // normal; lo que se nota es el hueco cuando a uno se le acaba de morir.
        // EL ARMAMENTO YA NO ES UN INTERRUPTOR, Y ESO ERA TODA LA DEUDA DE LOS
        // MATERIALES. Antes: `a.materials > a.population * 0.5 ? 1 : 0.6`.
        //
        // Medido sobre 5.606 dias-tribu: la mediana es 11,94 de material por
        // cabeza contra un tope de almacen de 12 —estan clavadas en el techo— y
        // el 100% esta por encima de ese 0,5. O sea que la rama del 0,6 NO SE
        // EJECUTABA NUNCA y el 96% de lo que una tribu puede acumular era peso
        // muerto. Es lo que `TRASPASO.md` §7 llamaba "los materiales sobran: no
        // tienen sumidero real", con numero.
        //
        // Y explicaba `incendio`, que quema el 70%: dejaba la tribu en 3,58 por
        // cabeza, siete veces el umbral, asi que no cambiaba nada. Medido: cero
        // en las cuatro columnas del mundo con la `fuerza` mas alta del banco.
        //
        // Ahora es una cuesta, y su tope es EL TOPE DEL ALMACEN: no hay una
        // constante nueva que inventarse, porque el numero que dice cuanto cabe
        // ya existe. Una tribu llena pega como pegaba; una quemada, no.
        const ga = tieneOficio(a, people, 'guerrero') ? C.GUERRERO_BONO : 1;
        const gb = tieneOficio(b, people, 'guerrero') ? C.GUERRERO_BONO : 1;
        const fa = a.population * Math.max(0.05, a.alloc.guerreros) * armasDe(a, C) * mM(a) * ga * (1 + a.cohesion / 200);
        // Solo aqui entra mulD. Si entrase en `fa`, una muralla volveria a ser
        // un arco: un numero que sirve igual para las dos cosas.
        const fb = b.population * Math.max(0.05, b.alloc.guerreros) * mM(b) * mD(b) * gb * (1 + b.cohesion / 200);
        const pWin = fa / (fa + fb);
        const aWins = rng() < pWin;
        metrics.battles++;
        let war = openWar;
        if (!war) {
          war = { id: 'w' + (++warSeq), a: a.id, b: b.id, open: true,
                  name: 'Guerra ' + WAR_NAMES[warSeq % WAR_NAMES.length],
                  start: tick, last: tick, n: 0, winsA: 0, winsB: 0, dead: 0 };
          wars.push(war);
          ev(tick, 'guerra_declarada', 3, [a.id, b.id], [], { guerra: war.name }, [a.id, b.id]);
        }
        war.n++; war.last = tick;
        const la = a.population * C.BATTLE_LETHALITY * (aWins ? 0.5 : 1.3);
        const lb = b.population * C.BATTLE_LETHALITY * (aWins ? 1.3 : 0.5);
        a.population -= la; b.population -= lb;
        const win = aWins ? a : b, lose = aWins ? b : a;
        // Perder la batalla no es perder la tierra si hay con que pararlos. Solo
        // vale para quien se defiende: al que va a atacar y pierde, el muro que
        // dejo en casa no le sirve de nada.
        //
        // Es lo que hace que una muralla se NOTE, y no solo se calcule: da un
        // suceso que antes no existia -"nos han ganado y no han entrado"- y por
        // tanto un titular que el periodico no podia escribir.
        let muroAguanta = false;
        const defB = mD(b);
        if (lose === b && defB > 1 && rng() < 1 - 1 / defB) muroAguanta = true;
        // LO QUE SE PUEDE PERDER. Quien defiende y pierde puede ver arrasada
        // una obra en pie. No pierde el saber -sigue sabiendo hacerla- asi que
        // puede volver a levantarla, y eso es lo que la hace un edificio y no un
        // hecho. Si el muro aguanta no se arrasa nada: para eso esta.
        if (lose === b && !muroAguanta) {
          const enPie = Object.keys(lose.obras).filter(n => lose.obras[n]);
          if (enPie.length && rng() < C.OBRA_RUINA) {
            const cual = enPie[Math.floor(rng() * enPie.length)];
            delete lose.obras[cual];
            lose.rotas[cual] = true;   // en ruinas hasta que la levanten otra vez
            ev(tick, 'obra_perdida', 3, [lose.id], [], { obra: cual, por: win.name }, [lose.id, win.id]);
          }
        }
        let taken = null;
        if (lose.cells.length > 2 && !muroAguanta) {
          lose.cells.sort((x, y) => (y.f + y.m) - (x.f + x.m));
          taken = lose.cells.shift();
          win.cells.push(taken);
          ev(tick, 'migracion', 3, [win.id, lose.id], [], { conquista: 1, terreno: taken.t }, [win.id, lose.id]);
        }
        const winT = aWins ? a : b;
        for (const pid of winT.notables) {
          const p = people[pid];
          if (p.role === 'guerrero' || p.role === 'lider') p.prestige = clamp(p.prestige + C.PRESTIGE_WIN, 0, 100);
        }
        (aWins ? b : a).cohesion -= C.DEFEAT_COHESION;
        a.warCooldown[b.id] = tick + C.WAR_COOLDOWN;
        b.warCooldown[a.id] = tick + C.WAR_COOLDOWN;
        const exh = C.WAR_EXHAUSTION;
        a.relations[b.id] = clamp(a.relations[b.id] + (aWins ? -8 : exh), -100, 100);
        b.relations[a.id] = clamp((b.relations[a.id] || 0) + (aWins ? exh * 0.6 : -14), -100, 100);
        for (const t of [a, b]) {
          // EL REY VA DETRAS DEL GUERRERO, Y ESE ES EL OFICIO DEL GUERRERO.
          //
          // Hasta ahora el rey y el guerrero tiraban EL MISMO dado en cada
          // batalla, asi que tener jefe de guerra no le servia de nada al que
          // manda. Y la batalla resulto ser lo que mas reyes mata con diferencia:
          // medido sobre 120 eras mudas, de los que llegaron a mandar se llevo
          // por delante al 43,2% -la edad al 30,2% y las tres intrigas juntas,
          // traicion, asesinato y ejecucion, al 23%-. Con 25,3 batallas por era
          // y un dado de 0,22, un rey que reina un rato no llega a viejo.
          //
          // SE MIRA UNA VEZ, ANTES DE REPARTIR MUERTES, y no dentro del bucle:
          // si se mirara dentro, que el rey quede protegido dependeria de si al
          // guerrero le toco morir antes o despues en el orden de la lista, que
          // es un orden sin significado. Lo que se quiere decir es "entraste en
          // esta batalla con jefe de guerra", y eso se sabe al empezar.
          //
          // No es inmunidad: es un escudo. Un rey puede caer igual, y de hecho
          // cae —lo que cambia es que ahora perder al guerrero se paga con la
          // vida del que manda, que es lo que convierte ese oficio en un oficio.
          const conGuerrero = tieneOficio(t, people, 'guerrero');
          for (const pid of t.notables.slice()) {
            const p = people[pid];
            if (p.role !== 'guerrero' && p.role !== 'lider') continue;
            const escudo = (p.role === 'lider' && conGuerrero) ? C.REY_TRAS_EL_GUERRERO : 1;
            if (rng() < C.BATTLE_NOTABLE_DEATH * escudo * ((t === a) === aWins ? 0.5 : 1)) {
              if (protect(t, p, null, tick)) continue;
              p.diedTick = tick; p.causeOfDeath = 'batalla';
              metrics.notableDeaths++;
              if (p.everLeader && p.peakPrestige >= 80 && p.leaderTicks >= 240) metrics.fullArcs++;
              t.notables = t.notables.filter(x => x !== pid);
              ev(tick, 'muerte', 3, [t.id], [p.id], { causa: 'batalla' }, [t.id]);
            }
          }
        }
        if (believedWeaker) {
          metrics.falseInfoWars++;
          if (!aWins) metrics.falseInfoDisasters++;
        }
        war.dead += Math.round(la + lb);
        if ((aWins ? a.id : b.id) === war.a) war.winsA++; else war.winsB++;
        ev(tick, 'batalla', 2, [a.id, b.id], [],
           { ganador: aWins ? a.id : b.id, guerra: war.name, n: war.n,
             // Quien atacaba y quien tenia que aguantar. Sin esto el periodico
             // no puede distinguir "hemos ido a por ellos" de "han venido".
             atacante: a.id, defensor: b.id,
             muro: muroAguanta ? 1 : 0 }, [a.id, b.id]);
        break;
      }
    }

    // --- 11. La asamblea del día ---
    // Deciden los dioses. Si nadie vota, decide el mundo con la semilla publica.
    if (tick % C.TICKS_POR_EDICION === 0 && alive.length) {
      // el menu se genera cada dia con las tribus que existen HOY.
      // `dia` se cuenta en EDICIONES, no en anios: iba con TICKS_PER_YEAR y con
      // el reloj estacional etiquetaba la asamblea de la edicion 5 como el dia
      // 1. Es el mismo par de relojes confundidos, en la linea de al lado.
      // LA MESA DE HOY. Ya no son las seis de siempre: salen cinco de un banco de
      // dieciocho, y cuales sale lo deciden el dia y el estado del mundo. Se arma
      // ANTES de contar los votos, con el mundo tal como esta al abrir, que es lo
      // que la hace calculable por cualquiera.
      //
      // El sorteo NO usa `rng`: `mesa.js` se siembra del dia aparte. Si usara el
      // hilo de la era, cambiar la receta de la mesa recolocaria el mundo entero.
      const dia = Math.floor(tick / C.TICKS_POR_EDICION);
      const mundoMesa = {
        tribus: tribes, gente: people, guerras: wars,
        libres: freeCells.length,
        // NO se manda el numero de hitos para que la mesa compare por su cuenta:
        // "le falta algun hito" no es lo mismo que "hay algo que ENSENIARLE".
        // `disponibles` filtra ademas por las lineas que la tribu tiene abiertas
        // y por las dependencias cubiertas, y con la version de contar, `ensenar`
        // salia a la mesa y no hacia nada un tercio de las veces -medido: 66% de
        // acierto-. Se manda la funcion de verdad, que es la unica que sabe.
        puedeAprender: t => disponibles(t).length > 0,
      };
      const mesa = mesaDelDia(seedStr, dia, mundoMesa);
      asambleas.push({ tick, dia, opciones: mesa.slice(),
        tribus: alive.map(t => ({ id: t.id, nombre: t.name, habitantes: Math.round(t.population) })) });
      // Un voto por algo que HOY no estaba en la mesa no cuenta. El worker ya lo
      // rechaza al recibirlo, pero el motor no puede fiarse de eso: reproducir la
      // era tiene que dar lo mismo aunque las acciones vengan de otro sitio.
      const votos = acts.filter(x => x.tipo === 'voto' && x.tick === tick
                                  && mesa.indexOf(x.opcion) >= 0);
      // La decision sale de `decidirAsamblea`, la misma que usa el servidor.
      const fallo = decidirAsamblea(votos);
      const dioses = fallo.dioses;
      // Y si no vota nadie, decide la semilla ENTRE LO QUE HABIA EN LA MESA, no
      // entre las dieciocho: el mundo no puede hacer lo que no se podia pedir.
      const MENU = mesa;
      let opcion, objetivo = null;
      if (dioses > 0) {
        opcion = fallo.opcion;
        // OJO SI SE COMPARA CON UNA ERA VIEJA: aqui se gastaba una tirada de `rng`
        // para desempatar opciones. Al pasar al desempate alfabetico esa tirada
        // desaparece, asi que el hilo de azar se desplaza en toda era con votos y
        // el mundo cambia. Es deliberado y se recongelo la huella.
        if (fallo.tribu) objetivo = alive.find(t => t.name === fallo.tribu || t.id === fallo.tribu) || null;
      } else {
        opcion = MENU[Math.floor(rng() * MENU.length)];
        // LA SEMILLA NO MIENTE. Si el sorteo ciego cae en una opcion que siembra
        // una creencia falsa, se calla. El porque -y lo que costaba no hacerlo:
        // la era muda se partia por la mitad- esta escrito en mesa.js, junto a
        // la marca. `silencio` es fija, asi que siempre esta sobre la mesa.
        if (MIENTEN.has(opcion)) opcion = 'silencio';
      }
      // El objetivo NUNCA se elige al azar cuando los dioses pidieron uno concreto.
      let anulado = 0;
      // La tribu que ganó la votación ya no existe: se anula. `fallo.tribu` es la
      // misma que se busco arriba, asi que no hay dos criterios que descuadrar.
      if (dioses > 0 && fallo.tribu && !objetivo) anulado = 1;
      // EL OBJETIVO SE SORTEA ENTRE QUIENES LA OPCION PUEDE TOCAR, no entre todas
      // las vivas. Sorteando entre todas, una opcion que esta en la mesa porque
      // la condicion se cumple en la tribu de al lado caia sobre una que no la
      // cumple y no pasaba nada: `avisar` pegaba el 12% de las veces y `obra` el
      // 15% -medido sobre 25 eras votandolas todos los dias-. El lector votaba,
      // el mundo no se movia y el pliego no tenia nada que contar.
      //
      // La lista sale del MISMO predicado que puso la opcion en la mesa
      // (`tribusPara`, en mesa.js), asi que no hay dos condiciones que puedan
      // descuadrarse. Una opcion sin condicion devuelve todas las vivas, y para
      // esas no cambia nada: mismo sorteo sobre la misma lista.
      if (!objetivo && !anulado) {
        const puede = tribusPara(opcion, mundoMesa);
        // Vacia no deberia poder estar -la opcion no habria salido a la mesa-,
        // pero si lo estuviera, romper la era entera por esto seria peor.
        const donde = puede.length ? puede : alive;
        objetivo = donde[Math.floor(rng() * donde.length)];
      }
      if (anulado) {
        const pedida = fallo.tribu;
        ev(tick, 'intervencion_divina', 2, [], [],
           { opcion, dioses, anulado: 1, pedida }, alive.map(t => t.id));
      } else {
      // LA PERSONA NOMBRADA. Tres opciones apuntan a alguien con nombre y no a
      // una tribu. El motor hace aqui lo que le toca y nada mas: si los dioses
      // nombraron a alguien, se lo aplica; si no, elige entre quienes valen.
      //
      // LO QUE EL MOTOR NO HACE, Y ES A PROPOSITO: comprobar si esa persona
      // habia salido publicada. Esa regla -"los dioses solo nombran lo que ya se
      // ha publicado"- se responde con el registro de `ediciones` en D1, que el
      // motor no tiene ni debe tener. Vive en el servidor, que arma la mesa y
      // valida el voto. Ver docs/ASAMBLEA.md §6.
      //
      // La reproducibilidad se conserva igual: el objetivo elegido se guarda en
      // `intervenciones`, y reproducir la era es volver a aplicarlo.
      let quien = null;
      if (objetivo && NOMBRAN_PERSONA.has(opcion)) {
        const suyos = objetivo.notables.map(i => people[i])
          .filter(q => q && q.diedTick === null);
        // La persona sale de `decidirAsamblea`, la misma que decide opcion y
        // tribu. Antes se cogia la PRIMERA del array con `find`, que es la misma
        // clase de fallo que tenia la tribu: la mayoria no contaba para nada.
        const ped = fallo.persona;
        if (ped) quien = suyos.find(q => q.name === ped || q.id === ped) || null;
        if (!quien) {
          const valen = suyos.filter(q => VALE_PERSONA[opcion](q, objetivo, people));
          if (valen.length) quien = valen[Math.floor(rng() * valen.length)];
        }
      }
      const P = C.INTERVENTION_POWER;
      // LO QUE LA TRIBU NOTA. La fe no puede salir de contar apariciones: una
      // plaga que se lleva al lider y una revelacion que deja veinte de material
      // en el almacen valen lo mismo contadas y no se parecen en nada vividas.
      // Asi que se MIDE lo que cambio -que fraccion de su gente, de su granero,
      // de su animo y de la cosecha del anio se movio hoy, mas los muertos con
      // nombre, que es lo que de verdad convence-. Sale del ESTADO y no del
      // nombre de la opcion, asi que una sequia sobre una tierra ya seca, que
      // casi no hace nada, pesa poco: como debe.
      //
      // El motor no decide nada con esto. Es una observacion que viaja en el
      // suceso para que la prensa sepa si aquello fue un mal anio o un prodigio.
      const antes = { pop: objetivo.population, comida: objetivo.food,
                      animo: objetivo.cohesion, cosecha: cosechaDe(objetivo, tick),
                      // LOS MATERIALES ENTRAN AHORA, y es un hueco que ya estaba:
                      // `fuerza` decia medir "que fraccion de su gente, de su
                      // granero, de su animo y de la cosecha se movio hoy" y el
                      // almacen de materiales es un stock igual que el granero.
                      // Sin el, `revelacion` -que deja veinte- daba fuerza casi
                      // cero, y `incendio` la daba EXACTA cero: el mundo cambiaba
                      // y el pliego no tenia por donde contarlo. Medido: 100% de
                      // los incendios con fuerza 0 antes de esto.
                      material: objetivo.materials };
      let conNombre = 0;
      let salvado = null;
      // Una peticion de los dioses es una catastrofe; el azar de la semilla, no.
      // Cuando nadie vota, el mundo sigue como siempre: seria injusto arrasar
      // una tribu por un sorteo que nadie pidio, y ademas dejaria el mundo a
      // merced del ruido en las eras sin lectores.
      const pedido = dioses > 0;
      if (opcion === 'lluvia') {
        // El granero primero. No siempre sirve -esta lleno el 78% de las veces
        // que llueve, porque tiene tope y la lluvia se tiraba-, pero cuando la
        // tribu esta seca es justo lo que hace falta, y ahi se absorbe entero.
        objetivo.food += objetivo.population * 0.8 * P;
        // Y sobre todo: la COSECHA. Es el espejo de la sequia. Sin esto la
        // lluvia era un no-op cuatro de cada cinco veces: el unico efecto era
        // rellenar un granero que ya estaba a tope.
        //
        // Va por `ponCosecha`, con plazo propio y con la MISMA VEDA que la
        // sequia. Antes escribia derecha en `t.shock` y sin freno ninguno: se
        // podia llover sobre la misma tribu todos los dias, apilandose, y encima
        // duraba lo que quedase del anio del mundo. Las dos mitades de por que
        // eso estaba mal estan contadas arriba, en `cosechaDe` y `puedeCosecha`.
        if (pedido && puedeCosecha(objetivo, tick, C))
          ponCosecha(objetivo, tick, C, C.LLUVIA_COSECHA);
      }
      else if (opcion === 'sequia') {
        // Una tierra ya arrasada no se puede volver a arrasar al anio
        // siguiente: no queda granero que vaciar ni cosecha que perder. Sin
        // esto la sequia es lo unico del juego que se acumula sobre si misma
        // -golpea el flujo, no un stock- y unos dioses constantes acaban el
        // mundo en cuatro anios sin que nada pueda pararlo.
        // La veda ya no es suya: la comparte con la lluvia, que es su espejo, y
        // vale en los dos sentidos. Tampoco es suya la cuenta de los ticks, que
        // ahora sale de `puedeCosecha`.
        if (pedido && puedeCosecha(objetivo, tick, C)) {
          // Sequia de verdad: el granero casi a cero y la cosecha perdida. No se
          // inventa mecanica nueva: con eso, la hambruna que ya existe se dispara
          // sola, mata, hunde la cohesion y emite su propio suceso.
          ponCosecha(objetivo, tick, C, C.SEQUIA_SHOCK);
          objetivo.food *= C.SEQUIA_GRANERO;
        } else {
          objetivo.food = Math.max(0, objetivo.food - objetivo.population * 1.2 * P);
        }
      }
      else if (opcion === 'plaga') {
        if (pedido) {
          objetivo.population *= (1 - C.PLAGA_MORTANDAD);
          objetivo.cohesion -= 3 * P;
          // Y se lleva gente CON NOMBRE, el lider incluido. Esto es lo que
          // convierte el voto en noticia: sin un muerto con nombre no hay
          // pieza, y sin pieza el lector no ve que su voto hizo nada.
          for (const pid of objetivo.notables.slice()) {
            const q = people[pid];
            if (!q || q.diedTick !== null) continue;
            if (rng() >= C.PLAGA_NOTABLE) continue;
            if (protect(objetivo, q, null, tick)) continue;
            matar(objetivo, q, tick, 'plaga', 3);
            conNombre++;
          }
        } else {
          objetivo.population *= (1 - 0.014 * P);
          objetivo.cohesion -= 3 * P;
        }
      }
      else if (opcion === 'milagro') { objetivo.cohesion += 6 * P; objetivo.food += objetivo.population * 0.4 * P; }
      else if (opcion === 'revelacion') {
        // EL ESPEJO EXACTO DE `incendio`, y por eso se escribe como su contrario:
        // el incendio multiplica el almacen por 0,3 y la revelacion LO LLENA.
        //
        // Sumar una cantidad no funcionaba, y se probaron dos. `+20 * P` -o sea
        // +10 fijos- daba 0,0% medido, porque diez sobre un tope de poblacion por
        // doce es el uno por ciento. Ponerlo por habitante -+2 por cabeza, unos
        // 131 de media- tampoco: a los doce dias la diferencia contra el mundo
        // callado era 0,18 por habitante, sin un hito ni una obra de mas. Un don
        // que cabe dentro de la holgura del almacen se lo traga la holgura.
        //
        // Llenarlo no tiene ese problema porque no es una cantidad: es un estado,
        // y se ve desde fuera. El tamanio sale solo con la tribu, igual que el
        // tope, y no hay una tercera constante que cuadrar a mano.
        const tope = objetivo.population * C.MAT_STORAGE;
        objetivo.materials = pedido ? tope
          : Math.min(tope, objetivo.materials + objetivo.population * C.REVELACION_MATERIAL * P);
        objetivo.cohesion += 2 * P;
      }
      // Las tres del banco que ya existian y no se podian pedir. Llaman a las
      // mismas funciones que la accion suelta: no hay una segunda version.
      else if (opcion === 'duda') sembrarDuda(objetivo, tick, null);
      // --- LA PRIMERA TANDA DE LAS DISENIADAS: las que apuntan a UNA tribu ----
      // Las cuatro llaman a lo que el motor ya sabe hacer. Ninguna escribe una
      // segunda version de nada: `ensenar` pasa por `aprenderAlgo`, `tierra` por
      // el mismo reparto de losetas que la expansion, `obra` remata por donde
      // remata el contador de `enObra`, y `ojos` es `sembrarDuda` del reves.
      // Dos mecanicas que tienen que cuadrar a mano acaban descuadradas.
      // SIN PUERTA DE `pedido`, Y LO PROBE AL REVES. Las otras -lluvia, sequia,
      // plaga- pegan fuerte solo si alguien lo pidio, y aqui el argumento parecia
      // aun mejor: regalar un hito es permanente, o sea justo lo que no deberia
      // decidir un sorteo que nadie pidio. Lo mismo dice el parrafo de arriba.
      //
      // Medido sobre las 200 semillas de ajuste, la puerta SALE PEOR:
      //
      //                        nota    mandato    madurez   dias de era
      //   sin puerta          0,9955   19,04       86%         203
      //   con puerta          0,9894   17,79       78%         269
      //
      // Arregla las dos que yo decia y hunde la que ya estaba al filo: la era
      // vuelve a durar, con mas era hay mas cismas, con mas cismas hay mas
      // lideres nuevos, y el mandato mediano se va de 19,04 a 17,79. El
      // argumento era bueno y la medicion dice que no. Queda escrito para que
      // nadie lo vuelva a intentar creyendo que es una mejora obvia.
      else if (opcion === 'ensenar') aprenderAlgo(objetivo, tick, null, { divino: 1 });
      else if (opcion === 'tierra') {
        // La loseta sale del monton libre, como la expansion. Si no queda tierra
        // no se inventa: el mundo elastico decide cuanta hay y los dioses no lo
        // mandan. Se coge por el hilo de la era -`rng`- porque CUAL loseta toca
        // es parte del mundo, igual que en la expansion.
        if (freeCells.length > 0) {
          const got = freeCells.splice(Math.floor(rng() * freeCells.length), 1)[0];
          objetivo.cells.push(got);
          ev(tick, 'migracion', 3, [objetivo.id], [], { terreno: got.t, divino: 1 }, [objetivo.id]);
        }
      }
      else if (opcion === 'obra') {
        // Primero rematar lo empezado, que es lo que el lector pidio: "levantar
        // la obra". Solo si no hay nada a medias se vuelve a empezar una caida,
        // y eso pasa por `aprender`, que es quien sabe poner `enObra` y contar
        // si es la primera vez o la rehace.
        const aMedias = Object.keys(objetivo.enObra)[0];
        if (aMedias) {
          delete objetivo.enObra[aMedias];
          objetivo.obras[aMedias] = true;
          delete objetivo.rotas[aMedias];
          ev(tick, 'descubrimiento', 3, [objetivo.id], [],
             { nombre: aMedias, obra: 1, fase: 'termina', divino: 1 }, [objetivo.id]);
        } else {
          const caida = Object.keys(objetivo.rotas)[0];
          if (caida) aprender(objetivo, caida, tick, null, { divino: 1 });
        }
      }
      else if (opcion === 'ojos') {
        // El reverso exacto de `duda`: se corrige la creencia MAS equivocada, no
        // una cualquiera, porque es la que explica un ataque suicida. No toca la
        // relacion: abrir los ojos no es hacer las paces, y confundir las dos
        // cosas dejaria `paz` sin trabajo.
        let peor = null, err = 0;
        for (const id in objetivo.beliefs) {
          const o = tribes.find(x => x.id === id && x.alive);
          if (!o) continue;
          const e = Math.abs(objetivo.beliefs[id].estPop - o.population) / Math.max(1, o.population);
          if (e > err) { err = e; peor = o; }
        }
        if (peor) {
          objetivo.beliefs[peor.id].estPop = peor.population;
          objetivo.beliefs[peor.id].lastContact = tick;
          ev(tick, 'alianza', 3, [objetivo.id, peor.id], [], { ojos_abiertos: 1, divino: 1 }, [objetivo.id]);
          efectos.push({ tick, accion: 'ojos', quien: objetivo.name, sobre: peor.name });
        }
      }
      else if (opcion === 'avisar') avisar(objetivo, tick);
      else if (opcion === 'destapar') destapar(objetivo, tick);
      // --- LAS SEIS MALAS ----------------------------------------------------
      // El banco estaba en trece buenas contra cuatro malas, y en un mundo sin
      // votos solo dos de esas cuatro cuentan. Estas seis son el contrapeso.
      //
      // TODAS SIGUEN LA REGLA DE ARRIBA: el sorteo ciego EMPUJA, la peticion
      // EJECUTA. Es lo que ya hacen lluvia, sequia y plaga, y aqui cae solo:
      // hundir el animo por debajo del umbral dispara el cisma que el motor ya
      // tiene, y darle un mordisco solo lo acerca. La version floja no es media
      // catastrofe inventada: es el mismo empujon, mas corto.
      else if (opcion === 'derribar') {
        // Una obra en pie se viene abajo; si no hay ninguna, se retrasa la que
        // esten levantando. Media obra derribada no significa nada, asi que la
        // version floja del sorteo es SOLO el retraso.
        const enPie = Object.keys(objetivo.obras).filter(n => objetivo.obras[n]);
        if (pedido && enPie.length) {
          const cual = enPie[Math.floor(rng() * enPie.length)];
          delete objetivo.obras[cual];
          objetivo.rotas[cual] = true;
          ev(tick, 'obra_perdida', 3, [objetivo.id], [],
             { obra: cual, divino: 1 }, [objetivo.id]);
        } else {
          const enCurso = Object.keys(objetivo.enObra)[0];
          if (enCurso) objetivo.enObra[enCurso] += Math.ceil(C.OBRA_TICKS / 2);
        }
      }
      else if (opcion === 'quitartierra') {
        // La loseta vuelve al monton libre: no desaparece del mundo, cambia de
        // mano. Pedida se llevan la MEJOR -como hace la conquista, que ordena y
        // coge la primera-; por sorteo, la peor.
        if (objetivo.cells.length > 2) {
          objetivo.cells.sort((x, y) => (y.f + y.m) - (x.f + x.m));
          const ida = pedido ? objetivo.cells.shift() : objetivo.cells.pop();
          freeCells.push(ida);
          ev(tick, 'migracion', 3, [objetivo.id], [],
             { terreno: ida.t, perdida: 1, divino: 1 }, [objetivo.id]);
        }
      }
      else if (opcion === 'azuzar') {
        // El reverso exacto de `avisar`. No se inventa el rencor: se le da a
        // quien peor se lleva con el que manda, que es a quien se lo habria dado
        // el motor por su cuenta si la ambicion le hubiera salido "vengarse".
        const gente = objetivo.notables.map(i => people[i]).filter(q => q && q.diedTick === null);
        const lider = gente.find(q => q.role === 'lider');
        const cand = gente.filter(q => q !== lider && !q.grudge)
          .sort((x, y) => (x.bonds[lider ? lider.id : ''] || 0) - (y.bonds[lider ? lider.id : ''] || 0))[0];
        if (lider && cand) {
          if (pedido) {
            cand.grudge = lider.id;
            cand.pressure = Math.max(cand.pressure, 12);
            ev(tick, 'rencor', 3, [objetivo.id], [cand.id, lider.id],
               { rencor: 1, divino: 1 }, [objetivo.id]);
          } else {
            cand.bonds[lider.id] = clamp((cand.bonds[lider.id] || 0) - 12, -100, 100);
          }
        }
      }
      else if (opcion === 'discordia') {
        // AQUI ESTA EL CISMA PROVOCADO, y por eso no hay una opcion `cisma`
        // aparte: el motor escinde una tribu cuando `cohesion < SCHISM_THRESHOLD`
        // y tiene gente de sobra. Pedida, el animo baja hasta ahi y el cisma se
        // dispara SOLO, con su reparto de gente, comida, materiales y tierra, y
        // su suceso. Por sorteo es un mordisco que solo lo acerca.
        objetivo.cohesion = pedido
          ? Math.min(objetivo.cohesion, C.SCHISM_THRESHOLD - 1)
          : Math.max(0, objetivo.cohesion - 8);
      }
      else if (opcion === 'enemistar') {
        // Y AQUI LA GUERRA, por lo mismo: el motor no tiene "declarar la guerra".
        // Una tribu acomete cuando la relacion baja de WAR_THRESHOLD y le salen
        // las cuentas. Pedida, la relacion con el peor vecino se va por debajo
        // del umbral en los dos sentidos -enemistar a uno solo seria que el otro
        // no se entera-. Por sorteo, un empujon.
        //
        // NO es `duda` otra vez: `duda` miente sobre el tamanio del vecino y por
        // eso el sorteo ciego la calla. Esto no miente, solo estropea el trato.
        let peor = null, val = 101;
        for (const o of alive) {
          if (o === objetivo) continue;
          const v = objetivo.relations[o.id] || 0;
          if (v < val) { val = v; peor = o; }
        }
        if (peor) {
          const nuevo = pedido ? C.WAR_THRESHOLD - 5 : val - 15;
          objetivo.relations[peor.id] = clamp(Math.min(val, nuevo), -100, 100);
          peor.relations[objetivo.id] = clamp(Math.min(peor.relations[objetivo.id] || 0, nuevo), -100, 100);
          // El suceso es imprescindible: las relaciones no entran en `fuerza`,
          // asi que sin esto la intervencion sale con fuerza 0 y el pliego no
          // tiene por donde contarla. Mismo tipo que `duda` y `ojos`, que son
          // las otras dos que tocan lo que una tribu piensa de otra.
          ev(tick, 'alianza', 3, [objetivo.id, peor.id], [],
             { enemistados: 1, divino: 1 }, [objetivo.id]);
        }
      }
      else if (opcion === 'levantar') {
        // DEVOLVERLE LA SALUD A ALGUIEN, y hasta hoy no queria decir nada: el
        // umbral de morirse de deteriorado estaba muerto -ver la rampa de
        // fragilidad-. Arreglado aquel, esto quita de verdad la probabilidad de
        // muerte, y ademas saca a la persona del alcance del hambre, que es el
        // otro camino que usa el mismo 62.
        //
        // Se cuenta en `conNombre`, que es lo que el motor ya usa para los
        // muertos CON NOMBRE y lo que hace que `fuerza` no salga en cero. Un
        // salvado con nombre es lo mismo del reves, asi que no hace falta un
        // tipo de suceso nuevo ni un grabado nuevo.
        if (quien) {
          quien.health = clamp(quien.health + (pedido ? 40 : 12), 0, 100);
          if (pedido) { salvado = quien; conNombre++; }
        }
      }
      else if (opcion === 'ungir') {
        // Subirle el prestigio a alguien con nombre. No se inventa una via de
        // ascenso: la sucesion YA mira el prestigio, asi que ungir es ponerle a
        // alguien el numero que hace que le toque cuando toque. El ascenso, si
        // llega, lo emite el motor por su cuenta y con su suceso de siempre.
        if (quien) {
          const antesP = quien.prestige;
          quien.prestige = clamp(quien.prestige + (pedido ? 35 : 10), 0, 100);
          quien.deeds++;
          ev(tick, 'ascenso', 3, [objetivo.id], [quien.id],
             { role: quien.role, heredero: 0, ungido: 1, divino: 1,
               prestigio: Math.round(quien.prestige - antesP) }, [objetivo.id]);
        }
      }
      else if (opcion === 'emparejar') {
        // Juntar a dos con nombre. Mismo campo y mismo suceso que el
        // emparejamiento natural: `p.pareja` y `pareja`.
        if (quien) {
          const otro = objetivo.notables.map(i => people[i])
            .filter(q => q && q.diedTick === null && q !== quien && !q.pareja
                      && q.sexo !== quien.sexo)[0];
          if (otro) {
            quien.pareja = otro.id; otro.pareja = quien.id;
            ev(tick, 'pareja', 3, [objetivo.id], [quien.id, otro.id],
               { divino: 1 }, [objetivo.id]);
          }
        }
      }
      else if (opcion === 'paz') {
        // EL ESPEJO EXACTO DE `enemistar`, y por eso se escribe igual: se busca
        // al vecino con el que peor esta y se le sube la relacion a los dos
        // lados. Hacerlo en uno solo seria que el otro no se entera.
        //
        // Y AQUI ESTA "IMPONER LA PAZ", que el diseno pedia como opcion aparte.
        // No hace falta: una guerra se cierra sola en cuanto `rel > WAR_END_REL`
        // -ver el cierre de campanias-, con su suceso `guerra_terminada`, su
        // bonificacion de PEACE_REL y la tregua de TRUCE que impide reabrirla.
        // O sea que imponer la paz ES sellarla, con el listón mas alto. Una
        // palanca y dos umbrales, como `discordia` con el cisma.
        let peor = null, val = 101;
        for (const o of alive) {
          if (o === objetivo) continue;
          const v = objetivo.relations[o.id] || 0;
          if (v < val) { val = v; peor = o; }
        }
        if (peor) {
          // Pedida se pasa de WAR_END_REL con margen, que es lo que cierra la
          // guerra si la hay. Por sorteo, un acercamiento.
          const nuevo = pedido ? C.WAR_END_REL + 20 : val + 15;
          objetivo.relations[peor.id] = clamp(Math.max(val, nuevo), -100, 100);
          peor.relations[objetivo.id] = clamp(Math.max(peor.relations[objetivo.id] || 0, nuevo), -100, 100);
          // Suceso propio por lo mismo que `enemistar`: las relaciones no entran
          // en `fuerza`, asi que sin esto la intervencion sale en cero y el
          // pliego no tiene por donde contarla.
          ev(tick, 'alianza', 3, [objetivo.id, peor.id], [],
             { paz_sellada: 1, divino: 1 }, [objetivo.id]);
        }
      }
      else if (opcion === 'incendio') {
        // Lo unico que le quita materiales a una tribu hoy es gastarlos. El
        // reverso de `revelacion`, que da veinte.
        objetivo.materials *= pedido ? 0.3 : 0.85;
      }
      // El silencio no hace nada, y esa es su gracia: los dioses hablaron y
      // dijeron que no. No es lo mismo que no votar, y por eso esta en el banco.
      else if (opcion === 'silencio') { /* a proposito, nada */ }
      else {
        // NINGUNA OTRA OPCION PUEDE CAER AQUI. Si cae, la mesa ha ofrecido algo que el
        // motor no sabe hacer y el voto se habria tragado en silencio, que es el
        // fallo que no se ve: el lector vota, no pasa nada, y el pliego no puede
        // contar nada. `mesa.js` solo ofrece las que llevan `hecho`, y esto es el
        // cinturon por si alguien anade una al banco y olvida implementarla.
        throw new Error(`la asamblea ha elegido "${opcion}", que el motor no sabe ejecutar. ` +
          `O se implementa su efecto, o se le quita el "hecho" en mesa.js.`);
      }
      // Cuatro fracciones del mismo tipo -cuanto de lo que la tribu tiene se
      // movio- y un solo peso a mano: el del muerto con nombre. Se redondea a
      // milesimas porque el numero viaja en el suceso y entra en la huella: sin
      // redondear, un flotante distinto en la ultima cifra seria un mundo
      // distinto.
      const fuerza = Math.round(1000 * (
          Math.abs(objetivo.population - antes.pop) / Math.max(1, antes.pop)
        + Math.abs(objetivo.food - antes.comida) / Math.max(1, antes.pop)
        + Math.abs(objetivo.cohesion - antes.animo) / 100
        + Math.abs(cosechaDe(objetivo, tick) - antes.cosecha)
        + Math.abs(objetivo.materials - antes.material) / Math.max(1, antes.pop)
        + conNombre * 0.5)) / 1000;
      ev(tick, 'intervencion_divina', dioses > 0 ? 3 : 2, [objetivo.id],
         salvado ? [salvado.id] : [],
         { opcion, dioses, silencio: dioses === 0 ? 1 : 0, fuerza }, alive.map(t => t.id));
      }
    }

    for (const nt of nuevas) tribes.push(nt);
    if (nuevas.length) {
      // toda tribu viva debe conocer a toda tribu viva, tambien a las nacidas hoy
      for (const a of tribes) { if (!a.alive) continue;
        for (const b of tribes) { if (!b.alive || a === b) continue;
          if (a.relations[b.id] === undefined) a.relations[b.id] = -10 + rng() * 20;
          if (!a.beliefs[b.id]) a.beliefs[b.id] =
            { estPop: b.population * (0.8 + rng() * 0.4), estHostility: 0, lastContact: tick };
        } }
    }

    // --- Cierre de campañas ---
    for (const w of wars) {
      if (!w.open) continue;
      const ta = tribes.find(x => x.id === w.a), tb = tribes.find(x => x.id === w.b);
      const rel = Math.max(ta.relations[w.b] || 0, tb.relations[w.a] || 0);
      const dead = !ta.alive || !tb.alive;
      if (dead || tick - w.last > C.WAR_END_QUIET || rel > C.WAR_END_REL) {
        w.open = false; w.end = tick;
        ta.relations[w.b] = clamp((ta.relations[w.b] || 0) + C.PEACE_REL, -100, 100);
        tb.relations[w.a] = clamp((tb.relations[w.a] || 0) + C.PEACE_REL, -100, 100);
        const winner = w.winsA === w.winsB ? null : (w.winsA > w.winsB ? w.a : w.b);
        ev(tick, 'guerra_terminada', 3, [w.a, w.b], [],
           { guerra: w.name, batallas: w.n, muertos: w.dead, anios: Math.round((tick - w.start) / C.TICKS_PER_YEAR),
             vencedor: winner || '', aniquilacion: dead ? 1 : 0 }, [w.a, w.b]);
      }
    }

    // --- Extinción y dominancia ---
    for (const t of tribes) {
      if (t.alive && t.population < C.TRIBU_MINIMA) {
        // La foto se toma ANTES de darla por muerta: es la unica que va a
        // tener, y sin ella no puede sacar su ultimo pliego.
        const causa = t.inFamine ? 'hambre'
          : wars.some(w => w.open && (w.a === t.id || w.b === t.id)) ? 'guerra'
          : 'se_apago';
        finales.push({ dia: Math.floor(tick / C.TICKS_POR_EDICION), tick,
                       tribuId: t.id, nombre: t.name, causa,
                       anios: Math.floor(tick / C.TICKS_PER_YEAR),
                       foto: fotoDe(t, tick) });
        // Dos sucesos y no uno. `muerte {extincion}` es como se enteran LOS
        // DEMAS -"se acabo Toneien: ya no queda nadie"-; `fin_de_tribu` es lo
        // que le permite a ella despedirse, que antes no podia: se quedaba sin
        // publicar de un dia para otro y nadie lo contaba desde dentro.
        //
        // Y se emiten ANTES de marcarla muerta: `ev` salta a las tribus muertas
        // al repartir el conocimiento, asi que si se emitiera despues la propia
        // tribu no se enteraria de su final y no podria publicarlo.
        ev(tick, 'fin_de_tribu', 3, [t.id], [], { causa, anios: Math.floor(tick / C.TICKS_PER_YEAR) }, [t.id]);
        ev(tick, 'muerte', 3, [t.id], [], { extincion: 1 }, tribes.map(x => x.id));
        t.alive = false; metrics.extinctions++;
      }
    }
    // --- Foto del dia ---
    if (tick % C.TICKS_POR_EDICION === C.TICKS_POR_EDICION - 1) {
      historia.push({
        dia: Math.floor(tick / C.TICKS_POR_EDICION),
        tribus: tribes.filter(t => t.alive).map(t => fotoDe(t, tick)),
      });
    }

    const maduro = tribes.find(t => t.alive && t.known >= TECHS.length);
    if (maduro) {
      cerrarEra(tick, 'madurez', { tribu: maduro.name });
      metrics.endTick = tick; metrics.maturity = true;
      break;
    }
    const al2 = aliveTribes();
    const total = al2.reduce((s, t) => s + t.population, 0);
    if (al2.length) {
      const share = Math.max(...al2.map(t => t.population)) / total;
      if (share > 0.70 && metrics.dominanceYear === null) metrics.dominanceYear = year;
    }
    if (al2.length <= 1) {
      // Antes esto era un `break` a secas: el mundo se acababa por conquista y
      // no se emitia nada. Ni el periodico se enteraba.
      cerrarEra(tick, 'ultima_tribu', { tribu: al2.length ? al2[0].name : null });
      metrics.endTick = tick; break;
    }
  }

  metrics.wars = wars.length;
  metrics.endYear = metrics.endTick / C.TICKS_PER_YEAR;
  metrics.survivors = aliveTribes().length;
  metrics.eventsPerYear = events.length / Math.max(1, metrics.endYear);
  metrics.mag3PerYear = metrics.mag3 / Math.max(1, metrics.endYear);
  return { metrics, events, tribes, people, wars, efectos, asambleas, historia, finales };
}

//  y  se exportan porque la mesa de la asamblea necesita
// UN HILO DE AZAR PROPIO, sembrado del dia. Tiene que ser el mismo generador que
// usa el mundo -no otro que se le parezca, regla 1- pero con otra semilla.
// LO QUE PUBLICA `/api/certificado`, TRADUCIDO A LO QUE COME `runEra`.
//
// VIVE AQUI Y NO EN EL SERVIDOR porque lo llaman los dos: `mundo.js` para
// reproducir la era, y CUALQUIERA DE FUERA que se baje el motor y quiera
// comprobarla. El servidor es cerrado; esto tiene que estar en la parte abierta
// o el forastero tendria que reescribirlo, y entonces habria dos traducciones
// que cuadrar a mano.
//
// Y NO ES UNA TRADUCCION TRIVIAL, que es lo que la hace peligrosa. Tiene dos
// cosas que se escriben mal a la primera:
//
//   1. La fila guarda el DIA y el motor abre la asamblea en el TICK. Van
//      `dia * ticksPorEdicion`, no el dia tal cual.
//   2. LAS FILAS DE CERO DIOSES NO SE PASAN. Se guardan -que no votara nadie es
//      parte del registro publico- pero no fueron un voto. Aqui hubo un `|| 1`
//      que convertia "no voto nadie" en "voto un dios": el motor tomaba la rama
//      de dioses>0, subia el suceso a magnitud 3 y el periodico abria con "Un
//      dios hablo: silencio" un dia en que no habia hablado ninguno. Y caia
//      justo en los primeros dias de una era, que es cuando menos lectores hay.
//
// Escribir esto a ojo en un README daria una era DISTINTA de la publicada, y el
// forastero acusaria al sitio de estar tocado. Por eso es una funcion.
function accionesDeCertificado(filas, ticksPorEdicion) {
  return (filas || [])
    .filter(f => (f.dioses || 0) > 0)
    .map(f => ({
      tipo: 'voto', tick: f.dia * ticksPorEdicion,
      opcion: f.opcion, tribu: f.tribu || undefined,
      // Sin esto el motor no puede saber a quien nombraron, y `levantar`,
      // `ungir` y `emparejar` elegian persona al azar aunque los dioses la
      // hubieran votado.
      persona: f.persona || undefined,
      n: f.dioses,
    }));
}

module.exports = { TIPOS_EVENTO, validarConfig, runEra, BASE, TRIBE_NAMES, TECHS,
  OPCIONES_ASAMBLEA, decidirAsamblea, hashSeed, mulberry32, accionesDeCertificado };
