/**
 * PUENTE ENTRE VERCEL Y EL GOOGLE SHEET  (BNH Medical – tickets de servicio técnico)
 *
 * Se pega en Extensiones > Apps Script del libro "Sistema_Tickets_Servicio_Tecnico".
 * Vercel lo llama por HTTPS con una clave secreta (propiedad del script API_SECRET);
 * así Vercel no necesita ninguna clave de cuenta de servicio de Google.
 * Este archivo solo lee y escribe hojas y envía correos: las reglas del sistema están en Vercel.
 */

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents, function (k, v) {
      return v && typeof v === 'object' && v.__d !== undefined ? new Date(v.__d) : v;
    });
    const real = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (!real || b.secret !== real) return salida_({ ok: false, error: 'No autorizado.' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    switch (b.op) {
      case 'hoja':        return salida_({ ok: true, valores: hoja_(ss, b.hoja).getDataRange().getValues() });
      case 'encabezados': return salida_({ ok: true, valores: encabezados_(hoja_(ss, b.hoja)) });
      case 'columnas':    return salida_({ ok: true, valores: columnas_(hoja_(ss, b.hoja), b.c1, b.c2) });
      case 'agregar':     return salida_(agregar_(hoja_(ss, b.hoja), b.obj, b.autoId));
      case 'celdas':      return salida_(celdas_(hoja_(ss, b.hoja), b.cambios));
      case 'correo':      return salida_(correo_(b));
      default:            return salida_({ ok: false, error: 'Operación desconocida.' });
    }
  } catch (err) {
    return salida_({ ok: false, error: String(err && err.message || err) });
  }
}

// Permite abrir la dirección en el navegador para comprobar que está publicada
function doGet() {
  return salida_({ ok: true, mensaje: 'Puente de tickets activo.' });
}

function salida_(obj) {
  const txt = JSON.stringify(obj, function (k, v) {
    const raw = this[k];
    return raw instanceof Date ? { __d: raw.getTime() } : v;
  });
  return ContentService.createTextOutput(txt).setMimeType(ContentService.MimeType.JSON);
}

function hoja_(ss, nombre) {
  const s = ss.getSheetByName(String(nombre));
  if (!s) throw new Error('Falta la hoja "' + nombre + '" en este libro.');
  return s;
}

function encabezados_(sh) {
  const n = sh.getLastColumn();
  return n < 1 ? [] : sh.getRange(1, 1, 1, n).getValues()[0].map(function (x) { return String(x).trim(); });
}

// Texto tal como se ve en la hoja, desde la fila 2, columnas c1..c2 (números de columna)
function columnas_(sh, c1, c2) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, c1, n, c2 - c1 + 1).getDisplayValues();
}

// Evita que un texto escrito por un cliente se interprete como fórmula
function limpiar_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

// obj por nombre de encabezado. autoId = {columna, prefijo, digitos}: el número se calcula
// aquí, con la hoja bloqueada, para que dos reportes simultáneos no repitan el ID.
function agregar_(sh, obj, autoId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const h = encabezados_(sh);
    let id = '';
    if (autoId) {
      const i = h.indexOf(autoId.columna);
      if (i < 0) throw new Error('Falta la columna "' + autoId.columna + '".');
      const n = sh.getLastRow() - 1;
      let max = 0;
      if (n > 0) {
        sh.getRange(2, i + 1, n, 1).getValues().forEach(function (r) {
          const x = parseInt(String(r[0]).replace(/\D/g, ''), 10);
          if (x > max) max = x;
        });
      }
      id = autoId.prefijo + ('0000000000' + (max + 1)).slice(-(autoId.digitos || 4));
      obj[autoId.columna] = id;
    }
    sh.appendRow(h.map(function (k) { return limpiar_(obj[k]); }));
    SpreadsheetApp.flush();
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

// cambios = [{ fila, col, valor }]
function celdas_(sh, cambios) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    (cambios || []).forEach(function (c) {
      const celda = sh.getRange(Number(c.fila), Number(c.col));
      celda.setValue(limpiar_(c.valor));
      if (Number(c.fila) === 1) celda.setFontWeight('bold').setBackground('#0f4c5c').setFontColor('#ffffff');
    });
    SpreadsheetApp.flush();
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function correo_(b) {
  if (!b.to) throw new Error('Falta el destinatario.');
  const o = { to: b.to, subject: b.subject, body: b.body || '' };
  if (b.htmlBody) o.htmlBody = b.htmlBody;
  if (b.cc) o.cc = b.cc;
  MailApp.sendEmail(o);
  return { ok: true };
}

/* ---- Ejecutar UNA VEZ desde el editor para dar los permisos y comprobar la clave ---- */
function probarPuente() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const faltan = ['TICKETS', 'TECNICOS', 'ESTADOS', 'DATA CLIENTE', 'Sales'].filter(function (n) { return !ss.getSheetByName(n); });
  MailApp.getRemainingDailyQuota();   // pide el permiso de correo
  const tieneClave = !!PropertiesService.getScriptProperties().getProperty('API_SECRET');
  Logger.log('Hojas que faltan: ' + (faltan.length ? faltan.join(', ') : 'ninguna') +
    ' | API_SECRET definida: ' + (tieneClave ? 'sí' : 'NO'));
}
