'use strict';
// La huella del mundo: que motor y que configuracion producen esta era.
//
// POR QUE EXISTE
// El mundo no se guarda, se RECALCULA: cada dia el worker ejecuta la era entera
// desde el tick 0 con `runEra(semilla, cfg, intervenciones)`. Eso significa que
// tocar `engine.js` o `best-config.json` a mitad de era no cambia el futuro:
// reescribe el pasado. Manianna la simulacion sale distinta de la que se
// publico, y pasan dos cosas malas a la vez:
//
//   - Se cae el §2. Cualquiera con la semilla y las intervenciones reproduce la
//     era y le sale OTRA historia. La verificabilidad es el proyecto entero.
//   - Se cae el periodico. Los pliegos publicados quedan guardados en D1, pero
//     los nuevos vendrian de un mundo distinto: alguien que murio el anio 12
//     podria reaparecer vivo el 40.
//
// El riesgo no es decidir tocar el motor: es tocarlo sin darse cuenta, meses
// despues, en una sesion en la que nadie recuerda esto. Por eso hay una red.
//
// SE HUELLEA EL COMPORTAMIENTO, NO EL TEXTO
// Se ejecutan unos mundos canarios fijos -semillas constantes, sin
// intervenciones- y se resumen en un hash. Un comentario nuevo o un refactor
// que no cambia el mundo dan la MISMA huella, que es justo lo que se quiere: la
// red no salta por tocar el codigo, salta por cambiar la historia.
//
// POR QUE SEIS MUNDOS Y NO UNO
// Con uno solo la red tiene un punto ciego: un cambio en codigo que ESE mundo
// no recorre no la mueve. Y los mundos son muy distintos entre si -uno que
// muere a los 5 anios no llega ni a abrir el arbol de tecnologias-. Las seis
// semillas estan elegidas midiendo 400 candidatas, no a ojo, y cubren
// regimenes distintos a proposito:
//
//   canario-108  75 anios, 881 sucesos, 35 guerras, 73 batallas, tech 100.
//                El caballo de tiro: el unico que hace falta para tocar los
//                19 tipos de suceso, y el que mas codigo de guerra recorre.
//   canario-85   58 anios pero 1 sola batalla y 4 tribus. Un mundo largo y
//                PACIFICO: hambruna, comercio y tecnologia sin guerra encima,
//                que en los guerreros queda tapado por el ruido.
//   canario-286  53 anios y final por conquista (`ultima_tribu`). El otro
//                camino de final: sin el, solo se vigila la madurez.
//   canario-41   12 tribus (+9 por cisma) y 9 extinciones. Nacer y morir
//                tribus, que es el codigo que mas estado mueve.
//   canario-308  5 anios y tech 4. El mundo que se muere temprano: solo
//                recorre el arranque, donde los demas pasan de largo.
//   canario-voz-241  el unico con DIOSES. Los otros cinco corren sin
//                intervenciones, asi que no pisan ni una linea de lo que pasa
//                cuando alguien vota: se pudo endurecer la plaga y la sequia
//                enteras -matar notables con nombre, arrasar la cosecha- sin
//                que la huella se moviera un digito. Una red que no ve la
//                mitad del motor no es una red. Este vota casi todos los dias
//                rotando el menu, y su era da 82 anios, 11 muertos por plaga
//                y 3 hambrunas.
//
// Los seis juntos tocan los 19 tipos de suceso. Para verlo:
// `node motor/huella.js --detalle`.
//
// QUE ENTRA EN EL HASH
// Todos los sucesos con su payload -no solo los publicables: uno de magnitud 1
// que cambia ya indica que el mundo es otro- y la foto final de cada tribu, que
// tapa el hueco de un cambio que altere cifras sin generar ni un suceso
// distinto.
//
// La foto final va REDONDEADA a cuatro decimales, y no es cosmetica. node y
// workerd no dan bit a bit lo mismo en coma flotante: medido sobre los canarios
// de entonces -cinco, antes de anadir el de los dioses-, los 2254 sucesos salen
// identicos en los dos, pero algunos numeros de
// tribus ya muertas se separan en el ultimo digito (71.12329553035576 contra
// ...73). Hasheando el flotante crudo, la huella cambiaria entre correr el
// motor en local y correrlo en Cloudflare, y el cortacircuitos saltaria sin que
// nadie hubiera tocado nada: una alarma falsa en una red asi es peor que no
// tenerla, porque la primera vez se revisa y la segunda se desactiva. Cuatro
// decimales dejan nueve ordenes de magnitud de margen sobre ese ruido.
//
// Cuesta del orden de un segundo. El cierre del dia ya reproduce una era
// entera, asi que esto no mueve la aguja frente al limite de 15 minutos del
// cron.

const { runEra, BASE } = require('./engine');
const cfg = require('./best-config.json');

// Fijas y arbitrarias. NO SE CAMBIAN: cambiarlas mueve la huella sin que el
// mundo haya cambiado, y bloquearia todas las eras vivas por nada. Tocar esta
// lista es tocar el motor, con las mismas reglas: se hace entre eras.
const SEMILLAS_CANARIAS = [
  'canario-108',   // largo y guerrero; los 19 tipos de suceso
  'canario-85',    // largo y pacifico
  'canario-286',   // final por conquista
  'canario-41',    // fertil: cismas y extinciones
  'canario-308',   // corto: se muere en el arranque
  'canario-voz-241', // CON DIOSES: la unica que pisa el camino de las votaciones
];

// Los votos del mundo canario que si tiene dioses. Fijos como la semilla: son
// parte de la huella y cambiarlos la mueve sin que el mundo haya cambiado.
//
// EL TICK SALE DE LA CONFIG, no de un 24 escrito a mano como estaba.
//
// Con el 24 fijo, la huella era CIEGA a `TICKS_POR_EDICION`: salia identica con
// el reloj anual y con el estacional. Y no es un detalle cosmetico, porque
// `mundo.js` traduce cada edicion con `tick: dia * TICKS_POR_EDICION`: cambiar
// el reloj mueve el voto de la edicion 5 del tick 120 al tick 30, o sea a otro
// momento del mundo por completo. El cortacircuitos existe para negarse a
// publicar cuando el motor produce un mundo distinto, y este cambio se le
// colaba entero.
//
// Ahora el canario vota donde votarian los dioses de verdad con el reloj que
// haya puesto, que es lo unico que hace que la huella signifique algo.
const MENU_CANARIO = ['plaga', 'sequia', 'lluvia', 'milagro', 'revelacion', 'silencio'];
function vozDivina(config = cfg) {
  const porEdicion = config.TICKS_POR_EDICION || BASE.TICKS_POR_EDICION || BASE.TICKS_PER_YEAR;
  const a = [];
  for (let d = 0; d < 120; d++) {
    if (d % 5 === 4) continue;                       // un dia de cada cinco, nadie vota
    a.push({ tipo: 'voto', tick: d * porEdicion,
             opcion: MENU_CANARIO[d % MENU_CANARIO.length], n: 3 + (d % 9) });
  }
  return a;
}
const CON_VOTOS = 'canario-voz-241';

function fnv(inicial) {
  let h = inicial >>> 0;
  return {
    come(s) {
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    },
    get valor() { return (h >>> 0).toString(16).padStart(8, '0'); },
  };
}

// La huella de un solo mundo canario.
function huellaDeMundo(semilla, config = cfg) {
  const r = runEra(semilla, config, semilla === CON_VOTOS ? vozDivina(config) : []);
  const h = fnv(2166136261);
  for (const e of r.events) {
    h.come(e.tick + '|' + e.type + '|' + e.mag + '|' + JSON.stringify(e.payload) + '|');
  }
  // La foto final. Un cambio puede alterar cifras sin cambiar ni un suceso.
  // Redondeada: ver arriba, node y workerd no coinciden en el ultimo digito.
  const n4 = x => (typeof x === 'number' ? x.toFixed(4) : String(x));
  for (const t of r.tribes) {
    h.come(`~${t.name}:${t.alive ? 1 : 0}:${n4(t.population)}:${n4(t.tech)}:${n4(t.cohesion)}`);
  }
  h.come('#' + r.metrics.endTick + '#' + r.events.length + '#' + r.tribes.length);
  return h.valor;
}

// La huella del motor: los seis mundos en un solo valor, que es lo que se
// guarda en la fila de la era.
// EL VALOR ESPERADO, ESCRITO EN EL REPOSITORIO
// La huella se calculaba pero no se comparaba con nada: `node huella.js`
// imprimia ocho caracteres y solo servia si alguien recordaba de memoria cuales
// tenian que ser. Y `referencia.json` -lo que usa `comparar.js`- esta en el
// .gitignore porque son 650 KB de eventos derivados, asi que quien clona el
// repositorio no tiene NADA contra lo que verificar: si congela la referencia
// el primer dia, la congela sobre el motor que tenga, y comparar solo le
// protege de sus propios cambios a partir de ahi.
//
// Estos ocho caracteres son el contrato portatil. Se cambian A MANO y solo
// cuando el cambio de mundo es deliberado, y el commit que los cambia es el que
// tiene que explicar por que.
//
// 20969236 -> 385e9540 EL 20 DE SEPTIEMBRE, y es el ultimo movimiento antes del
// dia 0. Artesano y anciano pasan a cobrar prestigio por llevar el oficio, que
// es lo que les faltaba para poder llegar a lider: la sucesion coge al notable
// con mas prestigio y el golpe de estado se decide por la diferencia, asi que
// vivir trece puntos por debajo era un callejon sin salida. Ver el comentario
// de la linea en `engine.js`, con los numeros medidos.
//
// LO QUE SE COMPROBO ANTES DE CONGELARLO, porque mover el mundo a once dias del
// estreno no se hace a ojo:
//   certify 200 cert    1,0000, once de once
//   las direcciones     los diez climas siguen haciendo lo suyo (la puerta
//                       nueva de `certify.js`, escrita ANTES de este cambio
//                       justo para poder contestar a esto)
//   juzgarRetroceso     los dioses pesan lo mismo que la ultima vez
const HUELLA_ESPERADA = '385e9540';

// EL CENTINELA. Los seis mundos canarios cuestan 800 ms y el Worker tiene un
// presupuesto de CPU de unos 1.200: el cortacircuitos se comia tres cuartas
// partes del cierre diario y lo hacia fallar cuatro noches de cada cinco.
// Medido contra Cloudflare, no supuesto; esta en docs/CPU.md.
//
// Asi que el cierre no recalcula los seis: recalcula UNO. Se elige
// `canario-voz-241` por dos razones: es el unico que lleva votos, o sea el
// unico que ejercita la rama divina -que es donde mas se toca-, y es de los
// baratos: 92 ms contra los 800 de los seis.
//
// Lo que se pierde: un cambio de motor que no afecte a este mundo pasaria el
// cierre. Lo que lo cubre: la puerta `--verificar`, que sigue comprobando los
// seis, y la integracion continua, que la corre en cada push. La garantia no
// desaparece, cambia de sitio: del tiempo de ejecucion al de compilacion, que
// es donde cuesta cero y donde de verdad se puede saber.
const CENTINELA = 'canario-voz-241';
// 4c345770 -> 9432dd09 el 20 de septiembre, por el mismo cambio de prestigio.
const CENTINELA_ESPERADO = '9432dd09';

function centinela(config = cfg) {
  return huellaDeMundo(CENTINELA, config);
}

function huellaDelMundo(config = cfg) {
  const h = fnv(2166136261);
  for (const s of SEMILLAS_CANARIAS) h.come(s + '=' + huellaDeMundo(s, config) + ';');
  return h.valor;
}

module.exports = { huellaDelMundo, huellaDeMundo, SEMILLAS_CANARIAS, HUELLA_ESPERADA,
                   centinela, CENTINELA, CENTINELA_ESPERADO };

if (require.main === module) {
  if (process.argv.includes('--detalle')) {
    const tipos = new Set();
    for (const s of SEMILLAS_CANARIAS) {
      const t0 = Date.now();
      const r = runEra(s, cfg, s === CON_VOTOS ? vozDivina() : []);
      r.events.forEach(e => tipos.add(e.type));
      const fin = r.events.find(e => e.type === 'fin_de_era');
      console.log(`${s.padEnd(13)} ${huellaDeMundo(s)}  ` +
        `${String(Math.round(r.metrics.endYear)).padStart(2)} anios  ` +
        `${String(r.events.length).padStart(3)} sucesos  ` +
        `${String(r.tribes.length).padStart(2)} tribus  ` +
        `${(fin ? fin.payload.causa : 'sin fin').padEnd(12)} ` +
        `${Date.now() - t0} ms`);
    }
    console.log(`\ntipos de suceso cubiertos: ${tipos.size}`);
  }
  const ahora = huellaDelMundo();
  // `--verificar` es lo que se ejecuta para responder "este motor es el
  // certificado?". Sale con codigo 1 si no, para que sirva en un gancho o en
  // integracion continua sin que nadie tenga que leer la salida.
  if (process.argv.includes('--verificar')) {
    const cent = centinela();
    if (cent !== CENTINELA_ESPERADO) {
      console.error(
        `EL CENTINELA NO CUADRA\n` +
        `  esperado  ${CENTINELA_ESPERADO}\n` +
        `  ahora     ${cent}\n\n` +
        `Es el mundo que el cierre diario recalcula cada noche (${CENTINELA}).\n` +
        `Si cambias el motor a proposito, pon el valor nuevo en CENTINELA_ESPERADO\n` +
        `ademas de en HUELLA_ESPERADA: si no, el cierre se parara en produccion.`);
      process.exit(1);
    }
    if (ahora === HUELLA_ESPERADA) {
      console.log(`huella ${ahora}  OK   centinela ${cent}  OK`);
    } else {
      console.error(
        `HUELLA DISTINTA\n` +
        `  esperada  ${HUELLA_ESPERADA}\n` +
        `  ahora     ${ahora}\n\n` +
        `El motor o best-config.json producen un mundo distinto del certificado.\n` +
        `Si NO querias cambiar el mundo, algo se ha colado: 'node comparar.js'\n` +
        `dice que suceso es el primero que cambia.\n` +
        `Si SI querias, pon ${ahora} en HUELLA_ESPERADA (motor/huella.js) y\n` +
        `explica el cambio en el commit. Vuelve a congelar la referencia local\n` +
        `con 'node snapshot.js'.`);
      process.exit(1);
    }
  } else {
    console.log(ahora);
  }
}
