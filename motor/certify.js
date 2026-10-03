'use strict';
// Criterios de aceptacion del motor.
//
// La puntuacion es MULTIPLICATIVA a proposito. Con una puntuacion de restas, una
// configuracion sin guerras ni traiciones ganaba porque no incurria en ningun
// exceso: el optimizador prefiere el mundo muerto. Aqui un cero en cualquier
// metrica anula el resultado entero. No vuelvas a las restas (TRASPASO.md §4).
//
// AVISO: esta es una REIMPLEMENTACION. El certify.js original se perdio y su
// formula exacta no se conoce, asi que las puntuaciones que salen de aqui NO son
// comparables con el 0,78 / 0,61 que cita TRASPASO.md §4. Los RANGOS si son los
// de la tabla del §5, que se conservo.

const { runEra, BASE: BASE_MOTOR } = require('./engine');

// LOS DIEZ CRITERIOS, RE-DERIVADOS DESDE INTENCION. Y uno nuevo, que son once.
//
// Lo que habia antes eran conteos POR ERA anclados a la tabla de TRASPASO.md §5,
// y dos de las diez bandas eran invencion mia centradas en valores que el motor
// ya no producia. Con una era que va de 7 a 69 anios segun lo que se vote, un
// conteo por era mezcla RITMO con DURACION: 20 batallas pueden ser un mundo
// tranquilo y largo o uno violento y corto, y el numero no distingue.
//
// Asi que se mide por DIA DE LECTURA. La unidad del producto no es la era: es la
// edicion. Un lector abre un periodico al dia.
//
//   1 edicion = 1 dia de lectura = 1 estacion      4 ediciones = 1 anio del mundo
//
// Y se agrega por MEDIANA entre las semillas, no por media: una media la levanta
// una era larguisima que casi nadie va a leer. Lo que importa es la era TIPICA,
// que es la que le toca a quien entre un dia cualquiera.
//
// LA PREGUNTA DE CADA CRITERIO ES SIEMPRE LA MISMA: cada cuanto deberia ver esto
// alguien que abre el periodico todas las maniianas. Las bandas de abajo se
// escribieron respondiendo a eso y ANTES de medir nada. Lo digo porque la
// tentacion de esta tarea es exactamente la contraria -mirar el valor y dibujar
// la banda alrededor-, y eso convierte el examen en un espejo.
//
// Tres formas de agregar, porque no todo es un conteo:
//   ritmo       veces por 100 dias de lectura, mediana entre semillas
//   duracion    dias de lectura, mediana
//   proporcion  fraccion de semillas, no tiene sentido por dia
const CRITERIOS = [
  // Alguien con nombre traiciona a los suyos: la trama personal recurrente, y lo
  // que impide que el lector se fie de nadie. Una cada una a cuatro semanas.
  { k: 'treacheries', como: 'ritmo', nombre: 'Traiciones',       lo: 3.5, hi: 14 },

  // Una tribu se parte y nace una cabecera nueva. Es EL suceso estructural:
  // cambia el mapa y cambia quien publica. Uno cada uno a cuatro meses.
  { k: 'schisms',     como: 'ritmo', nombre: 'Cismas',           lo: 0.8, hi: 3.5 },

  // Una declaracion abre un arco de semanas. No deberia haber un mes entero sin
  // ninguna guerra ni ninguna gestandose. Una cada dos a siete semanas.
  { k: 'wars',        como: 'ritmo', nombre: 'Guerras',          lo: 2,   hi: 7 },

  // No se fija aparte: SE DERIVA de la de guerras. Una guerra de una sola batalla
  // no es una guerra que se pueda seguir; entre tres y seis batallas por guerra.
  // O sea de 3x2 a 6x7.
  { k: 'battles',     como: 'ritmo', nombre: 'Batallas',         lo: 6,   hi: 40 },

  // El grano es la mitad del titulo. El hambre es la presion de fondo, no una
  // rareza; pero una hambruna por semana es un mundo que no funciona. Una cada
  // tres semanas a cuatro meses.
  { k: 'famines',     como: 'ritmo', nombre: 'Hambrunas',        lo: 0.8, hi: 5 },

  // Un notable que sube, manda y cae ENTERO delante del lector. Es la columna de
  // personajes: varios a lo largo de los ocho meses, ni uno ni veinte.
  { k: 'fullArcs',    como: 'ritmo', nombre: 'Lideres con arco completo', lo: 1, hi: 5 },

  // ESTE ES EL PRODUCTO. Alguien ataca fiandose de lo que se publico y le sale
  // mal. Si no pasa con regularidad, el periodico es decorado. Tiene que verse,
  // y no puede ser la norma: si lo fuera, nadie se creeria nada y tampoco habria
  // juego. (Cuenta embestidas, no guerras: ver la nota al pie.)
  { k: 'falseInfoDisasters', como: 'ritmo', nombre: 'Ataques perdidos por mala info', lo: 1, hi: 5 },

  // El elenco tiene que renovarse. Demasiado lento es un museo; demasiado rapido
  // y no hay a quien seguir. Una cada dos a diez dias de lectura.
  { k: 'notableDeaths', como: 'ritmo', nombre: 'Muertes de notables', lo: 10, hi: 50 },

  // NO ES UN CONTEO. La pregunta es a cuantos reyes seguidos conoce un lector a
  // lo largo de una era: entre cuatro y doce por tribu. Menos de cuatro y la
  // sucesion deja de ser un tema del periodico; mas de doce y ningun rey da
  // tiempo a nada.
  //
  // Y ESO ES LO QUE SE MIDE AHORA, en vez de su traduccion a dias.
  //
  // Estaba escrito como "20 a 60 dias de lectura", que sale de dividir una era
  // de ~240 dias entre doce y entre cuatro. La cantidad decidida eran los REYES
  // POR ERA; los dias eran su traduccion con una era concreta debajo. Al meter
  // las seis opciones malas la era paso a durar 205 dias y la traduccion dejo de
  // valer: el mismo mundo, con los mismos cuatro a doce reyes por era, sacaba
  // 19,00 contra un suelo de 20 y suspendia.
  //
  // Esto NO es ensanchar la banda. La banda es la de siempre -cuatro a doce- y
  // ahora se mide en su unidad, que es invariante a lo que dure la era. Un
  // criterio que cambia de valor porque cambio otra cosa que no mide no estaba
  // midiendo lo que decia medir.
  //
  // LA BANDA MAS VIEJA era 6-11 anios y estaba fuera de rango a proposito, con
  // una nota que decia que ensancharla seria mover la porteria. Se deja escrito
  // el historial entero porque este criterio lleva tres formas distintas y
  // alguien tiene derecho a ver por que.
  { k: 'mandato',     como: 'porera', nombre: 'Reyes por era', lo: 4, hi: 12 },

  // El final bonito es "lo aprendieron todo", no "uno se comio a los demas". Los
  // dos tienen que poder pasar, y el primero tiene que ser el comun.
  //
  // EL TECHO SE SUBIO A 0,96 Y SE VOLVIO A BAJAR, y merece la pena contarlo
  // entero porque es el mejor ejemplo del proyecto de lo que NO hay que hacer y
  // de lo que si.
  //
  // El valor se habia ido al 92% contra un techo de 90 al encender `ensenar`, y
  // se subio el techo: mirar el valor y dibujar la banda alrededor, que es
  // exactamente lo que este fichero avisa de no hacer. El argumento era que el
  // mundo mudo es el caso idealizado y que ahi es normal que reine la paz.
  //
  // Luego se midieron los cinco climas y ese argumento resulto ser falso: el
  // mundo mudo NO es especialmente pacifico -`flojos` daba 93%, mas que el- y el
  // motor acaba las eras por madurez en torno al 90% bajo cualquier clima que no
  // castigue. El problema no era el techo, era que el banco tenia trece opciones
  // buenas contra cuatro malas.
  //
  // Puestas seis malas, el valor cayo al 64% solo. El techo volvio a 0,90 sin
  // perder nada. LA LECCION: cuando un criterio se sale, la banda es lo ultimo
  // que hay que tocar, y casi siempre esta diciendo algo verdadero del mundo.
  //
  // Y AQUI VA LO QUE SE MIDIO. La tabla anterior decia "mudos 92%" y se quedo
  // aqui despues de que el parrafo de arriba escribiera que el valor cayo al 64%
  // al meter las seis opciones malas: el comentario se contradecia consigo mismo
  // y la tabla mandaba a la conclusion contraria. Remedida el 18 de septiembre,
  // los DIEZ climas sobre las mismas 200 semillas de `cert`:
  //
  //     clima          madurez  dominancia  dias/era
  //     mudos             64%       72%        249
  //     generosos         71%       64%        255
  //     caprichosos       56%       78%        223
  //     flojos            59%       77%        239
  //     crueles           24%       91%         74
  //     sembradores        3%       98%         47
  //     saqueadores       22%       91%        190
  //     maestros          81%       56%        220
  //     cortesanos        67%       66%        293
  //     pacificadores     91%       38%        261
  //
  // "En torno al 90% bajo cualquier clima que no castigue" YA NO ES VERDAD, y no
  // por el banco de opciones: por el mundo. Hoy solo `pacificadores` -que es un
  // clima dedicado a que no haya guerras- llega ahi.
  //
  // Y "el arbol es el reloj de la era" es media verdad, tambien remedido sobre
  // esas 200 semillas mudas:
  //
  //     acaban por madurez        128  (64%)
  //     acaban por ultima tribu    71  (35,5%)
  //     llegan al tope de ticks     1
  //
  // O sea que la era acaba por el arbol CUANDO EL MUNDO SOBREVIVE, y un tercio
  // de las veces no sobrevive: en esas 71, la tribu mas sabia se queda en 12 de
  // 30. El reloj ya no es uno, son dos, y este criterio mide cual gano.
  //
  // Lo que sigue pendiente es lo mismo: rederivarlo desde intencion, como se hizo
  // con los once. Lo que ya no aplica es la presion que lo motivo -el valor
  // pegado al techo-, porque 0,64 esta en mitad de la banda.
  { k: 'madurez',     como: 'proporcion', nombre: 'Eras por madurez tecnica', lo: 0.55, hi: 0.90 },

  // EL CRITERIO NUEVO, Y HAY QUE PONERLO JUSTO AHORA. Medir por dia de lectura
  // abre un agujero que medir por era no tenia: un ritmo perfecto dentro de una
  // era de veinte dias pasa el examen y no es un producto. La promesa son ocho
  // meses y medio de lectura, asi que la duracion deja de ser un dato
  // descriptivo al pie del informe y pasa a ser criterio.
  { k: 'ediciones',   como: 'duracion', nombre: 'Dias de lectura por era', lo: 180, hi: 320 },
];

// Puntuacion de una metrica: 1 dentro del rango, decae hacia 0 fuera.
// Es exactamente 0 cuando la metrica es 0, que es lo que mata el mundo muerto.
function puntuarMetrica(v, lo, hi) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v < lo) return v / lo;
  if (v > hi) return hi / v;
  return 1;
}

// Media geometrica: un cero anula, y ningun exceso compensa una carencia.
function puntuar(medias) {
  const partes = CRITERIOS.map(c => ({
    ...c, valor: medias[c.k], score: puntuarMetrica(medias[c.k], c.lo, c.hi),
  }));
  const score = partes.some(p => p.score === 0)
    ? 0
    : Math.exp(partes.reduce((a, p) => a + Math.log(p.score), 0) / partes.length);
  return { score, partes, enRango: partes.filter(p => p.score === 1).length };
}

// Semillas: las de ajuste y las de certificacion NUNCA se solapan.
// Hubo sobreajuste medible (0,73 ajustando contra 0,61 en semillas nuevas):
// certifica siempre contra semillas que no se usaron para afinar (TRASPASO.md §4).
function semillas(prefijo, n) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(prefijo + '-' + i);
  return s;
}

// LOS CLIMAS DIVINOS. Esto medía un mundo MUDO -`runEra(sd, cfg)` sin acciones- y
// el mundo real tiene una asamblea cada dia. Certificar sin dioses certificaba
// un mundo que no va a existir.
//
// Pero certificar contra UN solo patron tampoco es la verdad: lo que hagan los
// dioses no se puede saber. Unos crueles -sequia y plaga siempre- dan un mundo
// violentisimo; unos generosos, uno placido. Asi que se certifica contra VARIOS
// climas y el motor tiene que aguantar en todos.
//
// El `mudos` se queda a proposito, y no por nostalgia: una era en la que nadie
// vote es un caso real -un dia flojo, un sitio sin visitas- y ademas es el
// control, el mundo sin la variable.
//
// EL MUNDO MUDO ES EL PATRON. Esta es la decision que ordena todo lo demas: lo
// que se certifica es el mundo SIN dioses. Ese tiene que estar equilibrado, dar
// juego y llegar a madurez tecnica, porque es el mundo que el motor produce por
// si solo.
//
// Los dioses existen para ROMPER ese equilibrio. Que con dioses caprichosos el
// mundo salga placido, o que unos crueles lo arrasen en siete anios, no es un
// fallo del motor: es que los dioses pesan, que es justo lo que se les pide. Un
// motor afinado para que el mundo aguante cualquier cosa que hagan los dioses
// seria un motor donde los dioses no importan.
//
// Los otros climas se miden y se enseniian, pero NO puntuan. Sirven para saber
// que hacen los dioses, no para decidir si el motor esta bien. Y cuando haya
// dioses de verdad, se medira lo que hacen y se corregira EN LA ERA SIGUIENTE,
// que para eso las eras se relevan.
//
// La unica exigencia sobre un clima con dioses es la contraria de la que se
// suponia al principio: que el castigo sostenido SI acabe con el mundo. Si no lo
// acabara, los dioses no pesarian.
//
// CADA CLIMA TIENE SU PROPIA EXPECTATIVA, y esto es lo que costo entender. La
// primera version puntuaba los cinco contra los mismos rangos y `crueles` daba
// CERO: sequia y plaga todos los dias matan el mundo en siete anios, sin una
// sola guerra. Eso no es un fallo del motor: es lo que se pidio expresamente
// -"no quiero que capes a los dioses; si mandan sequia muchas veces seguidas a
// una tribu, esa tribu acaba muerta"-. Un mundo arrasado por dioses crueles es
// el comportamiento CORRECTO, y puntuarlo con los rangos de un mundo vivo es
// medir con la regla equivocada.
//
// Asi que un clima declara que se espera de el:
//   vivo   el mundo tiene que aguantar y dar juego: los rangos de siempre.
//   muerto el mundo tiene que MORIRSE. Si no se muere, los dioses no pesan y
//          eso si seria un fallo.
const CLIMAS = [
  { n: 'mudos',       espera: 'patron', menu: [],                                              cada: 0 },
  { n: 'generosos',   espera: 'dioses', menu: ['lluvia', 'milagro', 'revelacion'],             cada: 1 },
  { n: 'caprichosos', espera: 'dioses', menu: ['lluvia', 'sequia', 'plaga', 'revelacion', 'milagro'], cada: 1 },
  // Dioses que se aburren: votan uno de cada tres dias. El sitio no va a tener
  // asamblea llena todos los dias de su vida.
  { n: 'flojos',      espera: 'dioses', menu: ['lluvia', 'sequia', 'milagro'],                 cada: 3 },
  // Y el castigo sostenido. No se le piden guerras ni cismas: se le pide que
  // acabe con el mundo, que es lo que un dios cruel debe poder hacer.
  { n: 'crueles',     espera: 'muerto', menu: ['sequia', 'plaga'],                             cada: 1 },

  // LOS CINCO DE ABAJO SE ANIADIERON PORQUE EL BANCO CRECIO Y LOS CLIMAS NO.
  // Los cinco de arriba se escribieron cuando la mesa tenia seis opciones fijas
  // y entre todos mueven CINCO de las veintidos: lluvia, sequia, plaga, milagro
  // y revelacion. Las otras diecisiete -todo lo que toca relaciones, creencias,
  // personas, obras y territorio- no las ejercitaba ningun clima, o sea que un
  // cambio en cualquiera de ellas pasaba la certificacion entera sin rozarla.
  //
  // Se agrupan por MECANISMO y no por signo, que es lo que hace que cada uno
  // tenga una expectativa que se pueda escribir: un clima que mezcle cosas que
  // tocan sitios distintos no permite decir que se espera de el.
  // ESTE ES EL SEGUNDO CLIMA DE MUERTE, y al medirlo cambio la lectura de un
  // fallo viejo. Mata el mundo en 45 dias contra los 87 de `crueles` -16,2 anios
  // contra 30,2- y pasa el juicio con holgura. O sea que la queja de siempre,
  // "los dioses no pesan lo bastante", nunca fue de los dioses: es que SEQUIA Y
  // PLAGA no pesan. Sembrar mentiras y enemistar si.
  //
  // Y las tres opciones que lo componen dan `fuerza` 0,000 las tres: lo mas
  // destructivo del banco es justo lo que la vara que decide si el pliego lo
  // cuenta no ve. Ver docs/LOS-SUCESOS.md §1.
  { n: 'sembradores',   espera: 'muerto', menu: ['duda', 'enemistar', 'discordia'],              cada: 1 },
  { n: 'saqueadores',   espera: 'dioses', menu: ['incendio', 'derribar', 'quitartierra'],        cada: 1 },
  { n: 'maestros',      espera: 'dioses', menu: ['ensenar', 'obra', 'tierra'],                   cada: 1 },
  { n: 'cortesanos',    espera: 'dioses', menu: ['ungir', 'azuzar', 'emparejar', 'levantar', 'destapar'], cada: 1 },
  { n: 'pacificadores', espera: 'dioses', menu: ['paz', 'ojos', 'avisar'],                       cada: 1 },
];

// Con los diez, las veintidos opciones vivas se ejercitan al menos en un clima.
// La comprobacion esta abajo, en `opcionesSinClima`, y es una invariante y no un
// comentario: si maniana entra una opcion nueva al banco y nadie le pone clima,
// la certificacion lo dice en vez de medir sin ella en silencio.

// QUE OPCIONES NO EJERCITA NINGUN CLIMA. Un banco que crece sin que crezcan los
// climas deja huecos que no se ven: la nota sigue saliendo, sobre un mundo donde
// esa opcion no se ha pedido nunca. Esto lo dice en voz alta.
function opcionesSinClima() {
  const { BANCO } = require('./mesa');
  const enClimas = new Set(CLIMAS.flatMap(c => c.menu));
  return BANCO.filter(o => o.hecho && !o.fija && !enClimas.has(o.id)).map(o => o.id);
}

// EL ALCANCE DE UN CLIMA: que fraccion de sus votos llega a aplicarse.
//
// `votosDe` recorre un menu fijo SIN mirar la mesa, y el motor solo cuenta un
// voto si la opcion estaba ese dia -medido en docs/EL-VOTO.md: el 22%-. Para
// zarandear el mundo eso vale, pero deja una trampa: un clima cuyo menu casi
// nunca sale a la mesa no zarandea nada Y NO SE NOTA. Mide, da un numero, y el
// numero es el del mundo mudo con otro nombre.
//
// La trampa es real y ya me la comi una vez con otra herramienta: votar una
// opcion el dia 40 daba 0,0% en las ocho que probe, y la causa no era que no
// hicieran nada, era que casi nunca estaban en la mesa ese dia.
//
// Asi que el alcance se puede mirar, y por opcion, no solo por clima: si una da
// 4% es que apenas se esta midiendo, y un cambio en ella pasaria la puerta.
function alcanceDe(clima, cfg, listaSemillas) {
  const votos = votosDe(clima, cfg);
  const porOpcion = {};
  for (const o of clima.menu) porOpcion[o] = { pedidos: 0, llegaron: 0 };
  for (const sd of listaSemillas) {
    const r = runEra(sd, cfg, votos);
    const porTick = new Map();
    for (const e of r.events) if (e.type === 'intervencion_divina') porTick.set(e.tick, e.payload);
    for (const v of votos) {
      const p = porTick.get(v.tick);
      if (!p) continue;                 // la era acabo antes de ese dia: no cuenta
      const o = porOpcion[v.opcion];
      o.pedidos++;
      if (p.dioses > 0 && p.opcion === v.opcion) o.llegaron++;
    }
  }
  const tot = Object.values(porOpcion).reduce((a, o) =>
    ({ pedidos: a.pedidos + o.pedidos, llegaron: a.llegaron + o.llegaron }), { pedidos: 0, llegaron: 0 });
  return { clima: clima.n, porOpcion, ...tot,
           alcance: tot.pedidos ? tot.llegaron / tot.pedidos : 0 };
}

// Cuando se espera un mundo muerto, lo que se comprueba es eso: que la era se
// acorte de verdad y que no acabe por madurez tecnica -nadie inventa nada
// mientras se muere de hambre-.
const ERA_MUERTA_MAX = 20;   // anios del mundo

// LO QUE PESABAN LOS DIOSES LA ULTIMA VEZ. ESCRITO EN EL REPOSITORIO.
//
// LA NOTA NO PUEDE VER ESTO, y no por descuido: sale del mundo MUDO, donde no
// vota nadie, asi que por construccion no ve un fallo en lo que hacen los
// dioses. El 15 de septiembre dos rebalanceos seguidos le quitaron a los dioses
// la mitad de su poder -la era bajo `crueles` paso de 82 a 173 dias con el
// primero y de 84 a 165 con el segundo- y LOS DOS dieron 1,0000 con once de once
// metricas en rango. El bloque de climas lo decia en texto, debajo, y nadie lo
// leia. El segundo se cazo de milagro.
//
// Asi que se congela, con el mismo ritual que HUELLA_ESPERADA: se cambia A MANO,
// solo cuando el cambio es deliberado, y el commit que lo cambia es el que tiene
// que explicar por que.
//
// SOLO LOS CLIMAS DE MUERTE, Y NO LOS DIEZ. "Peor" no significa nada para
// `generosos`: que un mundo con dioses generosos salga mas placido no es un
// fallo, es lo que se les pide. Para un clima al que se le pide que ACABE con el
// mundo si significa algo: tardar mas es perder fuerza. Esa es la unica
// direccion que se puede afirmar, y por eso la puerta se queda ahi.
//
// RECONGELADO el 18 de septiembre al repartir los oficios al fundar. Salto el
// aviso -crueles 29,31 -> 32,52 anios, un 10,9%, justo por encima del margen- y
// antes de recongelar se comprobo si era perdida de fuerza o era otro mundo. Se
// midio la misma cosa con DOS juegos de semillas y las dos versiones del codigo:
//
//                      crueles   sembradores
//   nuevo, cert-*        32,52      20,52
//   nuevo, otra-*        30,42      18,60
//   viejo, cert-*        30,64      17,55
//   viejo, otra-*        33,17      22,14     <- el codigo VIEJO, mas alto que el nuevo
//
// La direccion se da la vuelta al cambiar de semillas: el viejo tarda MAS que el
// nuevo en uno de los dos juegos. O sea que no hay retroceso, hay reparto.
//
// Y DE AHI SALE ALGO QUE CONVIENE DEJAR ESCRITO, porque el comentario de
// `PESO_MARGEN` dice que aqui "no hay ruido que absorber". Con las mismas
// semillas y el mismo motor es cierto: es una funcion pura. Pero esta puerta
// compara ENTRE VERSIONES del motor, y cualquier cambio del motor reordena los
// mundos: la dispersion que se ve arriba entre dos juegos de 200 semillas es de
// ~8%, contra un margen del 10%. O sea que el margen apenas pasa por encima del
// suelo de ruido, y un salto de esta talla hay que mirarlo con dos juegos antes
// de creerselo. Los dos que se cazaron de verdad fueron +48% y +96%, muy por
// encima de esto, asi que la puerta sigue valiendo para lo que se escribio.
const PESO_ESPERADO = {
  crueles:     { endYear: 32.52, maturity: 0.2000 },
  sembradores: { endYear: 20.52, maturity: 0.0550 },
};
// CON CUANTAS SEMILLAS SE CONGELARON. No es un adorno: estos numeros son una
// funcion de las semillas, y con otras salen otros. Medido, `crueles` da 29,31
// con 200 y 31,98 con 120 -un 9%, que se come casi entero el margen-, asi que
// comparar un `certify 60` local contra valores de 200 seria una puerta que
// salta sola y que se acaba ignorando. Fuera de este numero no se compara y se
// dice en voz alta, que es distinto de callarse.
const PESO_SEMILLAS = 200;
// Cuanto se tolera antes de llamarlo retroceso. Con las mismas semillas y el
// mismo motor esto es una FUNCION PURA -no hay ruido que absorber-, asi que el
// margen es solo para cambios pequenios y deliberados que no merezcan recongelar.
// Los dos que se colaron hoy fueron +48% y +96%: los caza de sobra.
//
// La madurez va en absoluto y no en relativo porque `sembradores` esta en 0,055
// y un 10% de eso son cinco milesimas: seria una puerta que salta sola.
const PESO_MARGEN = 0.10;

// ============================================================================
// LO QUE SE ESPERA DE CADA CLIMA, COMPARADO CON `mudos` EN LA MISMA CORRIDA.
//
// EL AGUJERO QUE TAPA. Los diez climas se corren, se calculan y se imprimen, y
// sobre SIETE de ellos no se afirmaba nada: `mudos` lo vigila la nota y
// `crueles` y `sembradores` sus numeros congelados, pero si maniana `paz`
// dejara de aplicarse, `pacificadores` seguiria saliendo por pantalla con otro
// numero y CI seguiria en verde. No es hipotetico: `levantar`, `ungir` y
// `emparejar` elegian persona AL AZAR hasta el 15 de septiembre -faltaba la
// columna `votos.persona`- y no lo cazo ninguna puerta, lo destapo leer el
// codigo.
//
// POR QUE CONTRA `mudos` Y NO CONTRA UN NUMERO CONGELADO. `PESO_ESPERADO`
// compara ENTRE VERSIONES del motor, y su propio comentario mide lo que eso
// cuesta: dos juegos de 200 semillas del mismo motor se separan ~8%, contra un
// margen del 10%. Siete puertas mas ahi encima serian alarmas falsas, y una
// alarma falsa es peor que ninguna porque la primera vez se revisa y la segunda
// se desactiva. Esto compara DOS BRAZOS DE LA MISMA CORRIDA: mismas semillas,
// mismo motor, misma ejecucion. Es una funcion pura contra otra funcion pura, y
// no hay nada que recongelar cuando el mundo se mueva a proposito.
//
// Y POR ESO VALE CON CUALQUIER `n`, al reves que `juzgarRetroceso`, que se calla
// si no son 200 semillas. Un cociente no depende del tamanio de la muestra como
// depende un valor absoluto. Comprobado a 20, 60 y 200: los tres pasan los
// tres cortes con holgura.
//
// SOLO TRES CLIMAS, Y ESO ES A PROPOSITO. Medido sobre 200 semillas `cert`, los
// cocientes contra `mudos` son:
//
//                dias  guerras  batallas  madurez     <- lo que se usa en negrita
//   pacificadores 1,05    0,70    **0,55**    1,42
//   saqueadores   0,76    0,55      0,40    **0,34**
//   maestros      0,88    1,24      1,49    **1,27**
//   ...............................................
//   generosos     1,02    1,02      1,04      1,11
//   caprichosos   0,89    0,89      0,70      0,88
//   flojos        0,96    0,84      0,79      0,92
//   cortesanos    1,18    1,12      1,12      1,05
//
// Los cuatro de abajo NO llevan direccion, y conviene decir por que en vez de
// inventarles una:
//
//   `flojos`      vota uno de cada tres dias y lo que se espera de el es "poco".
//                 Todos sus cocientes estan entre 0,79 y 0,99, que es justo lo
//                 que tiene que pasar. Afirmar una direccion aqui seria
//                 afirmar algo que el clima no promete.
//   `generosos`   su seniial es tecnologia -descubrimientos 1,14- y 1,11 de
//                 madurez. Un 11% esta demasiado cerca del 8% de dispersion
//                 entre versiones que ya esta medido arriba.
//   `caprichosos` batallas 0,70 es un margen de verdad y ESTABLE -0,76 a 60
//                 semillas-, pero no se le puede escribir la expectativa: lo que
//                 se espera de el es "ruido", y "el ruido aplaca el mundo" es un
//                 hallazgo, no una promesa que se pueda vigilar.
//   `cortesanos`  su mayor cociente es que la era dura un 18% MAS, que es
//                 contraintuitivo -una corte revuelta deberia acortarla- y por
//                 tanto no se entiende todavia. Vigilar algo que no se entiende
//                 es congelar un accidente.
//
// Cuatro puertas flojas habrian "cubierto los siete climas" en una tabla y no
// habrian cazado nada. Tres con margen cazan lo que pasa de verdad.
//
// ----------------------------------------------------------------------------
// LO QUE ESTA PUERTA NO CAZA, medido rompiendo el motor a proposito y no
// supuesto. Se neutralizo una opcion cada vez -que se ejecute y no haga nada,
// que es como se rompio de verdad: `levantar` y `ungir` se ejecutaban y elegian
// al azar- y se miro si saltaba:
//
//   `ensenar` neutralizado   SALTA. maestros baja de 1,27 a 1,09.
//   `incendio` neutralizado  SALTA, pero nombrando a `pacificadores`.
//   `paz` neutralizado       NO SALTA.
//   `derribar` neutralizado  NO SALTA.
//
// LAS DOS QUE NO SALTAN son el limite de forma de esta puerta: un clima tiene
// tres opciones y las otras dos siguen tirando. `pacificadores` sin `paz` sigue
// aplacando el mundo con `ojos`, y `saqueadores` sin `derribar` sigue
// despojando con `incendio` y `quitartierra`. Una puerta por CLIMA no puede ver
// una opcion suelta; eso lo ve una puerta por OPCION, que es otra y no esta.
// Queda dicho aqui para que nadie lea "tres direcciones en verde" como "las
// veintidos opciones llegan al mundo", que es lo que no dice.
//
// Y LA QUE SALTA NOMBRANDO A OTRO importa mas, porque es la regla del
// diagnostico falso. `mudos` NO es un mundo sin dioses: es un mundo donde nadie
// VOTA, y cuando nadie vota decide la semilla entre lo que habia en la mesa
// -esta escrito en `mesa.js`-. O sea que romper una opcion mueve TAMBIEN el
// brazo de referencia: al neutralizar `incendio`, las batallas de `mudos`
// cayeron de 6,8 a 5,41 y el cociente de `pacificadores` subio sin que a
// `pacificadores` le pasara nada.
//
// Por eso el aviso dice que algo se ha movido y NO dice de quien es la culpa.
// Una puerta que manda a arreglar lo que no esta roto es peor que no tenerla.
// ----------------------------------------------------------------------------
const DIRECCIONES = [
  // El clima de la paz tiene que dar menos batallas que un mundo sin dioses. Si
  // `paz`, `ojos` o `avisar` dejan de aplicarse, esto se va a 1,00 y salta.
  { clima: 'pacificadores', k: 'battles', signo: '<', corte: 0.75, medido: 0.55,
    que: 'menos batallas que un mundo donde nadie vota' },
  // El despojo impide que el mundo madure: quemar, derribar y quitar tierra
  // dejan a las tribus sin con que llegar al final del arbol.
  { clima: 'saqueadores', k: 'madurez', signo: '<', corte: 0.60, medido: 0.34,
    que: 'menos eras que acaban por madurez tecnica' },
  // Y ensenniar lo acelera. Se mira la madurez y no las batallas -que dan 1,49-
  // porque las batallas son el EFECTO de un mundo mas desarrollado, no lo que
  // el clima pide. Una puerta tiene que vigilar lo que se prometio.
  { clima: 'maestros', k: 'madurez', signo: '>', corte: 1.12, medido: 1.27,
    que: 'mas eras que acaban por madurez tecnica' },
];

function juzgarDireccion(por) {
  const fallos = [];
  const mudos = por.find(r => r.espera === 'patron');
  if (!mudos) return fallos;
  for (const d of DIRECCIONES) {
    const r = por.find(x => x.clima === d.clima);
    if (!r) { fallos.push(`ya no existe el clima \`${d.clima}\`: repasa DIRECCIONES`); continue; }
    const base = mudos.medias[d.k], suyo = r.medias[d.k];
    if (!base) { fallos.push(`\`${d.clima}\`: mudos da 0 en ${d.k} y no hay con que comparar`); continue; }
    const cociente = suyo / base;
    const pasa = d.signo === '<' ? cociente < d.corte : cociente > d.corte;
    if (!pasa) {
      fallos.push(`${d.clima}: ${d.que} — ${d.k} da ${cociente.toFixed(2)} veces el de mudos `
        + `(${suyo.toFixed(2)} contra ${base.toFixed(2)}); se exige ${d.signo} ${d.corte} `
        + `y la ultima medida dio ${d.medido}.`);
    }
  }
  return fallos;
}

// QUE HAN PERDIDO LOS DIOSES DESDE LA ULTIMA VEZ.
function juzgarRetroceso(por, n) {
  const fallos = [];
  if (n !== undefined && n !== PESO_SEMILLAS) return fallos;
  for (const r of por) {
    const antes = PESO_ESPERADO[r.clima];
    if (!antes || !r.extra) continue;
    if (r.extra.endYear > antes.endYear * (1 + PESO_MARGEN)) {
      fallos.push(`${r.clima}: la era dura ${r.extra.endYear.toFixed(1)} anios y antes duraba ` +
        `${antes.endYear.toFixed(1)}. Los dioses han perdido fuerza.`);
    }
    if (r.extra.maturity > antes.maturity + PESO_MARGEN) {
      fallos.push(`${r.clima}: ${Math.round(r.extra.maturity * 100)}% de las eras acaban por ` +
        `madurez tecnica y antes era el ${Math.round(antes.maturity * 100)}%.`);
    }
  }
  return fallos;
}
// El texto NO puede nombrar a `crueles`: desde que hay dos climas de muerte, el
// mismo mensaje salia diciendo "la era dura 20,1 anios con dioses crueles" debajo
// de la palabra `sembradores`. Quien llama ya antepone el nombre del clima.
function juzgarMuerto(extra) {
  const fallos = [];
  if (extra.endYear > ERA_MUERTA_MAX) {
    fallos.push(`la era dura ${extra.endYear.toFixed(1)} anios de castigo sostenido; ` +
                `se espera <= ${ERA_MUERTA_MAX}. Los dioses no pesan lo suficiente.`);
  }
  if (extra.maturity > 0.15) {
    fallos.push(`${Math.round(extra.maturity * 100)}% de las eras acaban por madurez ` +
                `tecnica bajo castigo sostenido; se espera <= 15%.`);
  }
  return fallos;
}

function votosDe(clima, cfg) {
  if (!clima.menu.length) return [];
  const porEdicion = cfg.TICKS_POR_EDICION || BASE_MOTOR.TICKS_POR_EDICION || BASE_MOTOR.TICKS_PER_YEAR;
  const a = [];
  // EL TURNO SE CUENTA POR VOTO EMITIDO, NO POR DIA, y esto era un fallo callado
  // de anios. Iba `clima.menu[d % clima.menu.length]` con el dia, mientras que
  // `cada` filtra los dias: si los dos numeros coinciden -y en `flojos` coinciden,
  // menu de 3 y `cada: 3`- entonces todo dia que pasa el filtro cumple
  // `d % 3 === 0` y SIEMPRE sale `menu[0]`. O sea que `flojos` llevaba desde que
  // existe votando lluvia y nada mas: `sequia` y `milagro` estaban escritas en su
  // menu y se pedian el 0% de las veces.
  //
  // Son los dos relojes de siempre -`cada` y el largo del menu- cuadrando a mano.
  // No lo vio nadie porque el clima daba un numero perfectamente creible. Lo caza
  // `--alcance`, que es para lo que se escribio.
  let turno = 0;
  for (let d = 0; d < 400; d++) {
    if (clima.cada > 1 && d % clima.cada !== 0) continue;
    a.push({ tipo: 'voto', tick: d * porEdicion,
             opcion: clima.menu[turno++ % clima.menu.length], n: 2 + (d % 6) });
  }
  return a;
}

// La mediana de verdad: con un numero par de muestras, el promedio de las dos
// centrales. Coger la de arriba y llamarlo mediana es un sesgo pequenio pero es
// un sesgo, y aqui se compara contra bandas estrechas.
function mediana(xs) {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// EL CLIMA POR DEFECTO ES EL PATRON, no `flojos`. Esto estaba mal y se ve al
// tirar del hilo de los rangos: `afinar.js` llama a `certificar(cfg, sems)` sin
// clima, asi que el afinador estaba optimizando el mundo con dioses flojos
// mientras la puerta juzga el mundo MUDO. Optimizar contra un examen distinto
// del que se corrige explica sin misterio por que tres afinados seguidos dieron
// de maravilla en las semillas de ajuste y peor en las de certificacion.
// CLIMAS[0] es `mudos`, que es el patron declarado veinte lineas mas arriba.
function medir(cfg, listaSemillas, clima = CLIMAS[0]) {
  const POR_EDICION = cfg.TICKS_POR_EDICION || BASE_MOTOR.TICKS_POR_EDICION || BASE_MOTOR.TICKS_PER_YEAR;
  // Una columna por criterio: cada fila es UNA ERA, y al final se toma la
  // mediana de la columna. Antes esto sumaba y dividia, que es la media, y la
  // media de una era de 7 anios con una de 69 no describe ninguna de las dos.
  const col = {};
  for (const c of CRITERIOS) col[c.k] = [];
  const extra = { maturity: 0, dominance: 0, endYear: 0, survivors: 0, embestidas: 0, ediciones: 0 };
  const acciones = votosDe(clima, cfg);
  for (const sd of listaSemillas) {
    const r = runEra(sd, cfg, acciones);
    // LOS DIAS DE LECTURA DE ESTA ERA. Se saca del reloj -no de `asambleas`- para
    // que el denominador no dependa de cuando decida el motor abrir asamblea.
    const dias = Math.max(1, Math.round(r.metrics.endTick / POR_EDICION));
    // El mandato de esta era, tambien en dias de lectura. Mediana DENTRO de la
    // era y luego mediana ENTRE eras: la mediana de todos los reyes del mundo
    // junta reinados de eras distintas y vuelve a mezclar ritmo con duracion.
    const reinados = [];
    for (const id in r.people) {
      const p = r.people[id];
      if (p.everLeader && p.leaderTicks > 0) reinados.push(p.leaderTicks / POR_EDICION);
    }
    for (const c of CRITERIOS) {
      if (c.como === 'ritmo') col[c.k].push(100 * (r.metrics[c.k] || 0) / dias);
      // Reyes por era = lo que dura la era entre lo que dura el rey tipico. Se
      // sigue usando la mediana DENTRO de la era -el rey tipico de esta era- y
      // luego la mediana ENTRE eras, que es lo que ya hacia; lo unico que cambia
      // es la unidad en la que se expresa.
      else if (c.k === 'mandato') {
        const m = mediana(reinados);
        col[c.k].push(m > 0 ? dias / m : 0);
      }
      else if (c.k === 'ediciones') col[c.k].push(dias);
    }
    if (r.metrics.maturity) extra.maturity++;
    if (r.metrics.dominanceYear !== null) extra.dominance++;
    extra.endYear += r.metrics.endYear;
    extra.survivors += r.metrics.survivors;
    extra.ediciones += dias;
    extra.embestidas += 100 * (r.metrics.falseInfoWars || 0) / dias;   // el denominador, para leer la otra
  }
  const n = listaSemillas.length;
  const valores = {};
  for (const c of CRITERIOS) {
    // La proporcion no tiene mediana que valga -cada era vale 0 o 1- asi que es
    // la fraccion de semillas, como siempre.
    valores[c.k] = c.como === 'proporcion' ? 0 : mediana(col[c.k]);
  }
  extra.maturity /= n; extra.dominance /= n; extra.endYear /= n;
  extra.survivors /= n; extra.embestidas /= n; extra.ediciones /= n;
  valores.madurez = extra.maturity;
  extra.mandato = valores.mandato;
  return { medias: valores, extra };
}

function certificar(cfg, listaSemillas, clima = CLIMAS[0]) {
  const { medias, extra } = medir(cfg, listaSemillas, clima);
  return { ...puntuar(medias), medias, extra, n: listaSemillas.length, clima: clima.n };
}

// EL MOTOR TIENE QUE AGUANTAR EN TODOS LOS CLIMAS, no de media. La nota es la
// PEOR de las cinco, no el promedio: un motor que va de maravilla con dioses
// generosos y se rompe con crueles no esta certificado, esta con suerte. El
// promedio dejaria pasar justo eso.
function certificarTodos(cfg, listaSemillas) {
  const por = CLIMAS.map(c => {
    const r = certificar(cfg, listaSemillas, c);
    r.espera = c.espera;
    r.fallosMuerte = c.espera === 'muerto' ? juzgarMuerto(r.extra) : [];
    return r;
  });
  // LA NOTA ES LA DEL PATRON, el mundo mudo. Los demas climas informan de lo que
  // hacen los dioses; no deciden si el motor esta bien.
  const patron = por.find(r => r.espera === 'patron');
  const muertos = por.filter(r => r.espera === 'muerto');
  const fallosMuerte = muertos.flatMap(r => r.fallosMuerte.map(f => r.clima + ': ' + f));
  return { por, peor: patron, score: patron.score, fallosMuerte,
           direcciones: juzgarDireccion(por),
           retrocesos: juzgarRetroceso(por, listaSemillas.length),
           pesoComparable: listaSemillas.length === PESO_SEMILLAS,
           n: listaSemillas.length };
}

// Cada criterio se imprime en SU unidad y la unidad se escribe al lado. Antes la
// tabla daba diez numeros sin decir de que eran, y uno de ellos -la madurez- iba
// multiplicado por cien a escondidas.
function unidad(c) {
  if (c.como === 'ritmo') return '/100 dias';
  if (c.como === 'proporcion') return '%';
  if (c.como === 'porera') return 'por era';
  return 'dias';
}
function comoSeVe(c, v) {
  return c.como === 'proporcion' ? (v * 100).toFixed(0) : v.toFixed(2);
}
function bandaSeVe(c) {
  const e = c.como === 'proporcion' ? 100 : 1;
  const f = x => (c.como === 'proporcion' ? String(Math.round(x * e)) : String(x));
  return f(c.lo) + '-' + f(c.hi);
}

function informe(res) {
  const L = [];
  L.push(`Certificacion sobre ${res.n} semillas: ${res.enRango} de ${CRITERIOS.length} metricas en rango`);
  L.push('');
  L.push('Mediana de la era TIPICA. El ritmo va por 100 dias de lectura:');
  L.push('1 edicion = 1 dia = 1 estacion, 4 ediciones = 1 anio del mundo.');
  L.push('');
  L.push('| Metrica                          |    Valor | Unidad    | Objetivo |  Score |');
  L.push('|----------------------------------|----------|-----------|----------|--------|');
  for (const p of res.partes) {
    L.push('| ' + p.nombre.padEnd(32) + ' | ' + comoSeVe(p, p.valor).padStart(8) +
           ' | ' + unidad(p).padEnd(9) + ' | ' + bandaSeVe(p).padStart(8) + ' | ' +
           p.score.toFixed(3).padStart(6) + ' |');
  }
  L.push('');
  L.push(`Puntuacion (media geometrica): ${res.score.toFixed(4)}`);
  L.push(`Fin por madurez tecnologica: ${(res.extra.maturity * 100).toFixed(0)}%  ` +
         `| con dominancia: ${(res.extra.dominance * 100).toFixed(0)}%`);
  // El total de embestidas contra un vecino mal calculado, para poder leer el
  // criterio: no es lo mismo perder 5 de 10 que perder 5 de 40.
  const malas = (res.partes.find(p => p.k === 'falseInfoDisasters') || {}).valor || 0;
  L.push(`Ataques contra un vecino mal calculado: ${res.extra.embestidas.toFixed(2)}/100 dias  ` +
         `| de ellos salen mal: ${malas.toFixed(2)}`);
  // Las medias se siguen enseniando AL PIE, que es donde deben estar: sirven para
  // leer, no para puntuar. Si la media y la mediana se separan mucho, es que hay
  // eras raras y conviene saberlo.
  L.push(`Media de era: ${res.extra.ediciones.toFixed(0)} dias (${res.extra.endYear.toFixed(1)} anios)  ` +
         `| mediana: ${(res.medias.ediciones || 0).toFixed(0)} dias  ` +
         `| supervivientes: ${res.extra.survivors.toFixed(2)}`);
  return L.join('\n');
}

module.exports = { CRITERIOS, puntuar, puntuarMetrica, medir, certificar, informe, semillas,
                   CLIMAS, votosDe, opcionesSinClima, alcanceDe,
                   PESO_ESPERADO, juzgarRetroceso, DIRECCIONES, juzgarDireccion };

if (require.main === module) {
  const n = parseInt(process.argv[2] || '200', 10);
  const prefijo = process.argv[3] || 'cert';
  const cfg = require('./best-config.json');
  const ss = semillas(prefijo, n);
  // Con `--clima nombre` se mira uno solo, para no esperar cinco cuando se esta
  // persiguiendo una metrica concreta.
  // `--alcance` no certifica: dice que fraccion de los votos de cada clima llega
  // de verdad al mundo. Un clima con alcance bajo no es una puerta, es un adorno.
  // Sin `return`: `motor/sintaxis.js` comprueba cada fichero como modulo ESM,
  // donde un return en el cuerpo es ilegal aunque CommonJS lo acepte. La puerta
  // lo canto a la primera.
  if (process.argv.includes('--alcance')) {
    console.log('\n  ALCANCE DE CADA CLIMA — que fraccion de sus votos se aplica');
    console.log('  (el resto cae al vacio: la opcion no estaba en la mesa ese dia)\n');
    for (const c of CLIMAS) {
      if (!c.menu.length) continue;
      const a = alcanceDe(c, cfg, ss);
      const det = c.menu.map(o => o + ' ' +
        Math.round(a.porOpcion[o].llegaron / Math.max(1, a.porOpcion[o].pedidos) * 100) + '%').join('  ');
      console.log('  ' + c.n.padEnd(14) + (Math.round(a.alcance * 100) + '%').padStart(5)
        + '  de ' + String(a.pedidos).padStart(6) + ' votos   ' + det);
    }
    const huerfanas = opcionesSinClima();
    console.log('\n  sin clima: ' + (huerfanas.length ? huerfanas.join(', ') : 'ninguna'));
    console.log('  Una opcion por debajo del 10% apenas se esta midiendo.\n');
  } else {
  const soloIdx = process.argv.indexOf('--clima');
  if (soloIdx > 0) {
    const c = CLIMAS.find(x => x.n === process.argv[soloIdx + 1]);
    if (!c) { console.error('climas: ' + CLIMAS.map(x => x.n).join(', ')); process.exit(1); }
    console.log(informe(certificar(cfg, ss, c)));
  } else {
    const t = certificarTodos(cfg, ss);
    console.log('');
    console.log('  clima         espera    nota     en rango  dias/era  guerras  batallas');
    console.log('                                                       (por 100 dias)');
    for (const r of t.por) {
      console.log('  ' + r.clima.padEnd(13) + r.espera.padEnd(9)
        + r.score.toFixed(4).padStart(7)
        + String(r.enRango + '/' + CRITERIOS.length).padStart(11)
        + (r.medias.ediciones || 0).toFixed(0).padStart(9)
        + (r.medias.wars || 0).toFixed(1).padStart(9)
        + (r.medias.battles || 0).toFixed(1).padStart(10));
    }
    console.log('');
    const huerfanas = opcionesSinClima();
    if (huerfanas.length) {
      console.log('  OPCIONES QUE NINGUN CLIMA EJERCITA: ' + huerfanas.join(', '));
      console.log('  Un cambio en ellas pasaria esta puerta sin rozarla.');
      console.log('');
    }
    console.log('  LA NOTA ES LA DEL PATRON (mundo mudo): ' + t.score.toFixed(4));
    console.log('  Los demas climas informan de lo que hacen los dioses; no');
    console.log('  deciden si el motor esta bien. Que los caprichosos aplaquen el');
    console.log('  mundo o que los crueles lo arrasen es que los dioses pesan.');
    if (t.fallosMuerte.length) {
      console.log('');
      console.log('  LOS DIOSES NO PESAN LO BASTANTE:');
      for (const f of t.fallosMuerte) console.log('    - ' + f);
    } else {
      console.log('  Y el castigo sostenido acaba con el mundo, como debe.');
    }
    // CADA CLIMA SIGUE HACIENDO LO SUYO. Va antes que la de abajo porque no
    // necesita 200 semillas: es un cociente dentro de esta misma corrida, asi
    // que dice la verdad con las que sea. Ver la cabecera de DIRECCIONES.
    console.log('');
    if (t.direcciones.length) {
      console.log('  UN CLIMA HA DEJADO DE HACER LO SUYO:');
      for (const f of t.direcciones) console.log('    - ' + f);
      console.log('  No lo ve la nota, que mide el mundo MUDO, ni la huella, que');
      console.log('  solo dice que el mundo ha cambiado.');
      console.log('  LA CULPA NO TIENE POR QUE SER DE ESE CLIMA: cuando nadie vota');
      console.log('  decide la semilla entre lo que habia en la mesa, asi que romper');
      console.log('  una opcion mueve tambien el brazo de referencia. Empieza por ver');
      console.log('  que opciones han dejado de llegar al mundo:');
      console.log('    node motor/certify.js 40 cert --alcance');
    } else {
      console.log('  Cada clima sigue haciendo lo suyo (' + DIRECCIONES.length
        + ' direcciones contra el mundo mudo).');
    }

    // LA PUERTA DE NO EMPEORAR. Va aparte del juicio de muerte de arriba: aquel
    // dice si los dioses pesan LO BASTANTE -y `crueles` lleva fallandolo desde
    // que existe-, y esta dice si pesan MENOS QUE AYER, que es otra pregunta y
    // la que de verdad se cuela.
    console.log('');
    if (!t.pesoComparable) {
      console.log(`  El peso de los dioses NO se compara: hace falta correrlo con `
        + `${PESO_SEMILLAS} semillas`);
      console.log(`  y se ha corrido con ${t.n}. Estos numeros son funcion de las semillas.`);
    } else if (t.retrocesos.length) {
      console.log('  LOS DIOSES HAN PERDIDO FUERZA DESDE LA ULTIMA VEZ:');
      for (const f of t.retrocesos) console.log('    - ' + f);
      console.log('  Si el cambio es DELIBERADO, pon los valores nuevos en PESO_ESPERADO');
      console.log('  (motor/certify.js) y explica en el commit por que. Si no lo es,');
      console.log('  acabas de quitarle a los dioses parte de su poder sin querer: la');
      console.log('  nota no lo ve, porque mide el mundo mudo.');
    } else {
      console.log('  Los dioses pesan lo mismo que la ultima vez.');
    }
    console.log('');
    console.log(informe(t.peor));
  }
  }
}
