# El motor de Grano y Sangre

Esto es el motor de [granoysangre.es](https://granoysangre.es) y nada mas: la simulacion que
produce el mundo, mas las herramientas para comprobar que es el que dice ser.

**Por que esta aqui.** Grano y Sangre no guarda el mundo: lo recalcula desde una
semilla publica y desde lo que votaron los lectores. Que eso se pueda comprobar
desde fuera es el proyecto entero, y no se puede comprobar sin el codigo que lo
produce. Asi que el codigo esta.

Este repositorio (https://github.com/Acertium/granoysangre-motor) **se genera** desde el repositorio de trabajo, que es privado.
No se aceptan cambios aqui: no llegarian al mundo. Lo que si vale es abrir un
aviso si algo no reproduce.

## Que NO esta aqui

La prensa, los grabados y las paginas. Con esto se reproduce **el mundo** —que
es lo que la era promete— pero no **el periodico**: si un pliego conto fielmente
lo que paso, eso no se puede comprobar desde aqui. Queda dicho para que nadie
crea que verifica mas de lo que verifica.

## Comprobar que este motor es el certificado

```
node motor/huella.js --verificar
```

Tiene que decir `huella 385e9540  OK   centinela 9432dd09  OK`.

No es el hash del texto de los ficheros: es el hash del COMPORTAMIENTO. Corre
seis mundos canarios y resume sus sucesos, asi que un comentario nuevo no lo
mueve y un cambio de reglas si. Es lo que hace falta aqui: la pregunta no es «es
el mismo fichero» sino «es el mismo mundo».

Y que el motor cumple sus propios criterios de aceptacion:

```
node motor/certify.js 200 cert
```

## Reproducir una era

La semilla y los votos de cada era se publican:

```
curl https://granoysangre.es/api/certificado?era=1
```

Devuelve `{ empezada, semilla, intervenciones }`. Con eso:

```js
const { runEra, accionesDeCertificado, BASE } = require('./motor/engine.js');
const cfg = require('./motor/best-config.json');

// curl https://granoysangre.es/api/certificado?era=1 > certificado.json
const cert = require('./certificado.json');

// La traduccion la hace el motor, NO tu. Las filas traen el DIA y el motor abre
// la asamblea en el TICK, y las filas de cero dioses no son votos: si eso se
// escribe a ojo sale una era distinta de la publicada. Es la misma funcion que
// llama el sitio para reproducirla.
const ticks = cfg.TICKS_POR_EDICION || BASE.TICKS_POR_EDICION;
const r = runEra(cert.semilla, cfg, accionesDeCertificado(cert.intervenciones, ticks));

console.log(r.tribes.length + ' tribus, ' + r.events.length + ' sucesos');
```

El mundo que sale de ahi es el mundo del que habla el periodico de esa era. Si
no sale el mismo, o la era esta tocada o este motor no es el suyo —y lo segundo
lo descarta la huella de arriba—.

## Que version sirve el sitio

```
curl https://granoysangre.es/api/estado
```

Trae una `version`: el hash del texto de los ficheros que viajan en el bundle
desplegado mas su configuracion. No es la huella del motor y no mide lo mismo
—aquella dice «es el mismo mundo», esta dice «es el mismo codigo»— pero sirve
para saber si el sitio esta sirviendo lo que dice servir.

## Licencia

MIT, en `LICENSE`, sobre exactamente estos ficheros. Todo lo demas de Grano y
Sangre queda reservado.
