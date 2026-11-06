// Llamada al puente de Apps Script (apps-script/Backend.gs). Las fechas viajan como { __d: milisegundos }.
const TIEMPO_MAX_MS = 25000;

function url() {
  const u = process.env.APPS_SCRIPT_URL;
  if (!u) throw new Error('Falta la variable APPS_SCRIPT_URL (dirección /exec del puente de Apps Script).');
  return u;
}
function secreto() {
  const s = process.env.API_SECRET;
  if (!s) throw new Error('Falta la variable API_SECRET.');
  return s;
}

function aTexto(obj) {
  return JSON.stringify(obj, function (k, v) {
    const raw = this[k];
    return raw instanceof Date ? { __d: raw.getTime() } : v;
  });
}
function desdeTexto(txt) {
  return JSON.parse(txt, (k, v) => v && typeof v === 'object' && v.__d !== undefined ? new Date(v.__d) : v);
}

async function llamar(op, datos, intento) {
  intento = intento || 0;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIEMPO_MAX_MS);
  let r, txt;
  try {
    r = await fetch(url(), {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      // text/plain evita comprobaciones previas (CORS) que Apps Script no soporta
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: aTexto(Object.assign({ op, secret: secreto() }, datos || {}))
    });
    txt = await r.text();
  } catch (e) {
    if (intento < 1 && e.name !== 'AbortError') return llamar(op, datos, intento + 1);
    throw new Error(e.name === 'AbortError' ? 'El puente de Apps Script tardó demasiado.' : 'No se pudo conectar con el puente de Apps Script.');
  } finally { clearTimeout(t); }

  let j;
  try { j = desdeTexto(txt); } catch (e) {
    throw new Error('El puente de Apps Script no devolvió datos válidos. Revisa que esté implementado como "Cualquier persona" y que APPS_SCRIPT_URL termine en /exec.');
  }
  if (!j.ok) throw new Error(j.error || 'Error en el puente de Apps Script.');
  return j;
}

module.exports = { llamar, aTexto, desdeTexto };
