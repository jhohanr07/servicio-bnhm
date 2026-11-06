// Acceso a las hojas del libro a través del puente de Apps Script.
const puente = require('./puente');

// Encabezados en memoria unos minutos: casi nunca cambian y evitan viajes de ida y vuelta
const TTL_ENC = 5 * 60 * 1000;
const encCache = {};

async function encabezados(nombre) {
  const c = encCache[nombre];
  if (c && Date.now() < c.hasta) return c.h;
  const h = (await puente.llamar('encabezados', { hoja: nombre })).valores;
  encCache[nombre] = { h, hasta: Date.now() + TTL_ENC };
  return h;
}

// Filas como objetos { _fila, <encabezado>: valor }. Las fechas llegan como Date.
async function leer(nombre) {
  const v = (await puente.llamar('hoja', { hoja: nombre })).valores;
  if (!v.length) throw new Error('Falta la hoja "' + nombre + '" o está vacía.');
  const h = v[0].map(x => String(x).trim());
  encCache[nombre] = { h, hasta: Date.now() + TTL_ENC };
  return v.slice(1).map((r, i) => {
    const o = { _fila: i + 2 };
    h.forEach((k, j) => { o[k] = r[j] === undefined ? '' : r[j]; });
    return o;
  }).filter(o => String(o[h[0]]).trim() !== '');
}

// Texto visible desde la fila 2, columnas c1..c2 (números de columna: A=1)
async function columnas(nombre, c1, c2) {
  return (await puente.llamar('columnas', { hoja: nombre, c1, c2 })).valores;
}

async function colDe(nombre, columna) {
  const h = await encabezados(nombre);
  const i = h.indexOf(columna);
  if (i < 0) throw new Error('Falta la columna "' + columna + '" en la hoja ' + nombre + '.');
  return i + 1;
}

// Agrega la columna al final del encabezado si la hoja no la tiene; devuelve su número
async function asegurarColumna(nombre, columna) {
  const h = await encabezados(nombre);
  const i = h.indexOf(columna);
  if (i >= 0) return i + 1;
  const n = h.length + 1;
  await celdas(nombre, [{ fila: 1, col: n, valor: columna }]);
  delete encCache[nombre];
  return n;
}

// autoId = { columna, prefijo, digitos }: el puente calcula el siguiente número bajo bloqueo
async function agregarFila(nombre, obj, autoId) {
  const r = await puente.llamar('agregar', { hoja: nombre, obj, autoId });
  return r.id;
}

// cambios = [{ fila, col, valor }]
async function celdas(nombre, cambios) {
  if (!cambios.length) return;
  await puente.llamar('celdas', { hoja: nombre, cambios });
}

module.exports = { leer, columnas, colDe, asegurarColumna, agregarFila, celdas, encabezados };
