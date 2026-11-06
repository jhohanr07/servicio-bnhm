// Utilidades de fecha y texto. Venezuela usa UTC-4 todo el año (sin horario de verano).
const OFFSET_MS = 4 * 36e5;
const pad = n => String(n).padStart(2, '0');

// Date con los componentes UTC igual a la hora de pared de Caracas
const pared = d => new Date(d.getTime() - OFFSET_MS);

function fechaHora(d) {
  const w = pared(d);
  return pad(w.getUTCDate()) + '/' + pad(w.getUTCMonth() + 1) + '/' + w.getUTCFullYear() +
    ' ' + pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes());
}
function soloFecha(d) { return fechaHora(d).slice(0, 10); }
function iso(d) {
  const w = pared(d);
  return w.getUTCFullYear() + '-' + pad(w.getUTCMonth() + 1) + '-' + pad(w.getUTCDate());
}
// 'yyyy-MM-dd' [+ hora] en hora de Caracas -> Date
function desdeISO(y, m, d, hh, mm) {
  return new Date(Date.UTC(+y, +m - 1, +d, +(hh || 0), +(mm || 0)) + OFFSET_MS);
}
// Número de serie de Google Sheets (hora de pared de la hoja) -> Date
function desdeSerie(n) { return new Date(Math.round((n - 25569) * 864e5) + OFFSET_MS); }

// Siempre texto: nunca se envía un Date al navegador
function fmt_(d) {
  if (d instanceof Date) return isNaN(d.getTime()) ? '' : fechaHora(d);
  return d === null || d === undefined ? '' : String(d);
}

// Fecha de una celda como Date: acepta fechas reales y texto dd/MM/yyyy [HH:mm]
function aFecha_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(v || '').trim());
  if (!m) return null;
  return desdeISO(m[3], m[2], m[1], m[4], m[5]);
}
const ms_ = v => { const d = aFecha_(v); return d ? d.getTime() : null; };
// Número de día calendario en la zona horaria de la empresa
const diaN_ = d => { const w = pared(d); return Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) / 864e5; };

// Valor de fecha para escribir en la hoja (el puente la guarda como fecha real); '' si no hay fecha
const celdaFecha_ = d => d instanceof Date && !isNaN(d.getTime()) ? d : '';

const h_ = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const dormir = ms => new Promise(r => setTimeout(r, ms));

module.exports = { fmt_, aFecha_, ms_, diaN_, celdaFecha_, h_, dormir, fechaHora, soloFecha, iso, desdeISO, desdeSerie };
