/**
 * SISTEMA DE TICKETS DE SERVICIO TÉCNICO (BNH Medical)
 * Lógica del servidor. Hojas del libro: TICKETS, TECNICOS, ESTADOS, DATA CLIENTE, Sales.
 * Es la versión para Vercel del antiguo Code.gs; las reglas de negocio son las mismas.
 */
const crypto = require('crypto');
const S = require('./sheets');
const mail = require('./mail');
const { fmt_, aFecha_, ms_, diaN_, celdaFecha_, h_, dormir, desdeISO, iso } = require('./util');

const EMPRESA = 'BNH Medical';
const REGIONES = ['Central', 'Occidente', 'Oriente'];
const ESTATUS = ['Sin asignar', 'Asignado', 'En reparación', 'Esperando repuesto', 'Resuelto', 'Cerrado'];
const ESTATUS_ABIERTOS = ['Sin asignar', 'Asignado', 'En reparación', 'Esperando repuesto'];
// Un caso "sin respuesta" sigue en estos estatus y el técnico no ha puesto fecha de atención
const ESTATUS_SIN_RESPUESTA = ['Sin asignar', 'Asignado'];

// Alertas: horas corridas sin respuesta antes de avisar y cada cuánto se repite el aviso
const HORAS_SIN_RESPUESTA = 72;
const HORAS_REPETIR_ALERTA = 24;
const COL_ALERTA = 'Última alerta';

// Tiempo objetivo de resolución en horas corridas
const URGENCIAS = [
  { id: 'P1', texto: 'Crítica: equipo detenido o riesgo para pacientes', horas: 48 },
  { id: 'P2', texto: 'Alta: equipo principal fuera de servicio', horas: 120 },
  { id: 'P3', texto: 'Media: funciona con fallas o de forma intermitente', horas: 240 },
  { id: 'P4', texto: 'Baja: consulta, instalación o mantenimiento', horas: 336 }
];

const HOJA_CLIENTES = 'DATA CLIENTE';
const HOJA_SALES = 'Sales';
const STATUS_EXCLUIDOS = ['DECOMMISSIONED'];
const ALIAS_ESTADO = { 'VARGAS': 'La Guaira', 'CARACAS': 'Distrito Capital', 'DTTO CAPITAL': 'Distrito Capital', 'DISTRITO FEDERAL': 'Distrito Capital' };
const PALABRAS_VACIAS = ['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'CA', 'SA', 'SRL', 'CIA'];

/* ===================== UTILIDADES ===================== */

const prop = k => process.env[k] || '';
const esActivo_ = t => String(t['Activo']).trim().toUpperCase() === 'SI';
const limpio = v => String(v == null ? '' : v);

// Contexto de la petición (para armar el enlace del técnico)
let baseUrl = '';
function fijarBase(url) { baseUrl = String(url || '').replace(/\/+$/, ''); }
const urlApp_ = () => (prop('URL_APP') || baseUrl).replace(/\/+$/, '');

function secreto_() {
  const s = prop('TOKEN_SECRET');
  if (!s) throw new Error('Falta definir TOKEN_SECRET en las variables de entorno.');
  return s;
}
const token_ = id => crypto.createHmac('sha256', secreto_()).update(String(id)).digest('hex').slice(0, 32);
const tokenValido_ = (id, tk) => /^TK-\d+$/.test(String(id)) && String(tk) === token_(id);
const enlaceTecnico_ = id => urlApp_() + '/tecnico?id=' + encodeURIComponent(id) + '&t=' + token_(id);

async function validarClave_(clave) {
  const real = prop('CLAVE_PANEL');
  if (!real) throw new Error('Falta definir CLAVE_PANEL en las variables de entorno.');
  if (String(clave) !== real) {
    await dormir(1000);
    throw new Error('Clave incorrecta.');
  }
}

/* ===================== FORMULARIO DEL CLIENTE ===================== */

async function getFormConfig() {
  const estados = (await S.leer('ESTADOS')).map(e => String(e['Estado']))
    .sort((a, b) => a.localeCompare(b, 'es'));
  return { ok: true, estados, urgencias: URGENCIAS.map(u => ({ id: u.id, texto: u.texto })) };
}

async function crearTicket(d) {
  try {
    const campos = ['cliente', 'refCliente', 'contacto', 'telefono', 'correo', 'estado', 'equipo', 'serial', 'urgencia', 'descripcion'];
    const v = {};
    campos.forEach(k => { v[k] = String((d && d[k]) || '').trim().slice(0, 1500); });

    // Si el cliente dejó vacío teléfono o correo y están registrados, se usan los registrados
    if (v.refCliente && (!v.telefono || !v.correo)) {
      const reg = registro_(v.refCliente, await datos_());
      if (!v.telefono) v.telefono = reg.tel;
      if (!v.correo) v.correo = reg.correo;
    }
    ['cliente', 'contacto', 'telefono', 'correo', 'estado', 'equipo', 'urgencia', 'descripcion'].forEach(k => {
      if (!v[k]) throw new Error('Completa todos los campos obligatorios.');
    });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.correo)) throw new Error('El correo no es válido.');

    const urg = URGENCIAS.filter(u => u.id === v.urgencia)[0];
    if (!urg) throw new Error('Selecciona la urgencia.');

    const [estados, tickets, tecnicos] = await Promise.all([S.leer('ESTADOS'), S.leer('TICKETS'), S.leer('TECNICOS')]);
    const fe = estados.filter(e => e['Estado'] === v.estado)[0];
    if (!fe) throw new Error('El estado seleccionado no es válido.');
    const region = String(fe['Región']);

    // Asignación: técnico activo de la región con menos casos abiertos
    const abiertos = {};
    tickets.forEach(t => {
      if (ESTATUS_ABIERTOS.indexOf(t['Estatus']) >= 0) {
        const n = t['Técnico asignado'];
        abiertos[n] = (abiertos[n] || 0) + 1;
      }
    });
    const tec = tecnicos
      .filter(t => esActivo_(t) && t['Región'] === region)
      .sort((a, b) => (abiertos[a['Nombre']] || 0) - (abiertos[b['Nombre']] || 0))[0] || null;

    const ahora = new Date();
    const limite = new Date(ahora.getTime() + urg.horas * 3600000);

    // El puente asigna el siguiente número de ticket con la hoja bloqueada (sin repetidos)
    const id = await S.agregarFila('TICKETS', {
      'Fecha': ahora, 'Cliente': v.cliente, 'Contacto': v.contacto,
      'Teléfono': v.telefono, 'Correo': v.correo, 'Estado': v.estado, 'Región': region,
      'Equipo': v.equipo, 'Serial': v.serial, 'Descripción': v.descripcion,
      'Prioridad': urg.id, 'Técnico asignado': tec ? tec['Nombre'] : '',
      'Correo técnico': tec ? tec['Correo'] : '', 'Estatus': tec ? 'Asignado' : 'Sin asignar',
      'Fecha límite SLA': limite
    }, { columna: 'ID_Ticket', prefijo: 'TK-', digitos: 4 });

    await notificarNuevo_(id, v, region, urg, limite, tec);
    return { ok: true, id, region, tecnico: tec ? String(tec['Nombre']) : '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ===================== CORREOS Y ENLACE SEGURO DEL TÉCNICO ===================== */

const filaHtml = (k, v) => '<tr><td style="padding:6px 12px 6px 0;color:#5d7a85;vertical-align:top">' + k +
  '</td><td style="padding:6px 0"><b>' + h_(v) + '</b></td></tr>';

// c = {id, cliente, contacto, telefono, estado, region, equipo, serial, prioridad, urgTexto, limite, descripcion}
async function enviarTecnico_(c, tec) {
  const link = enlaceTecnico_(c.id);
  const html =
    '<div style="font-family:Arial,sans-serif;color:#0f3d4f;max-width:560px">' +
    '<div style="border-top:6px solid #00668a;padding-top:12px"><h2 style="margin:0 0 4px">Nuevo ticket ' + h_(c.id) + '</h2>' +
    '<p style="margin:0 0 12px;color:#5d7a85">Se te asignó un caso de servicio técnico.</p></div>' +
    '<table style="font-size:14px;border-collapse:collapse">' +
    filaHtml('Cliente', c.cliente) + filaHtml('Contacto', c.contacto + ' / ' + c.telefono) +
    filaHtml('Ubicación', c.estado + ' (Región ' + c.region + ')') +
    filaHtml('Equipo', c.equipo + (c.serial ? ' (serial ' + c.serial + ')' : '')) +
    filaHtml('Prioridad', c.prioridad + ' - ' + c.urgTexto) + filaHtml('Fecha límite', c.limite) + '</table>' +
    '<p style="margin:14px 0 4px;color:#5d7a85">Falla reportada:</p>' +
    '<div style="background:#e9f6f2;padding:10px 12px;border-radius:6px;white-space:pre-wrap">' + h_(c.descripcion) + '</div>' +
    '<p style="margin:22px 0"><a href="' + link + '" style="background:#00668a;color:#ffffff;text-decoration:none;' +
    'padding:12px 26px;border-radius:6px;font-weight:bold;display:inline-block">Abrir Ticket</a></p>' +
    '<p style="font-size:12px;color:#5d7a85">Si el botón no funciona, copia este enlace: ' + link + '</p></div>';
  const texto = 'Se te asignó el ticket ' + c.id + '.\nCliente: ' + c.cliente + '\nEquipo: ' + c.equipo +
    '\nPrioridad: ' + c.prioridad + '\n\n' + c.descripcion + '\n\nAbrir ticket: ' + link;
  await mail.enviar({
    to: tec['Correo'], subject: '[' + EMPRESA + '] Nuevo ticket ' + c.id + ' (' + c.prioridad + ')',
    body: texto, htmlBody: html
  });
}

async function notificarNuevo_(id, v, region, urg, limite, tec) {
  try {
    const resumen = 'Ticket: ' + id + '\nCliente: ' + v.cliente + '\nContacto: ' + v.contacto + ' / ' + v.telefono +
      '\nEstado: ' + v.estado + ' (Región ' + region + ')\nEquipo: ' + v.equipo +
      (v.serial ? ' (serial ' + v.serial + ')' : '') + '\nPrioridad: ' + urg.id + ' - ' + urg.texto +
      '\nFecha límite objetivo: ' + fmt_(limite) + '\n\nFalla reportada:\n' + v.descripcion;

    // 1) Cliente
    await mail.enviar({
      to: v.correo, subject: '[' + EMPRESA + '] Recibimos tu reporte ' + id,
      body: 'Hola ' + v.contacto + ',\n\nRecibimos tu reporte' +
        (tec ? ' y ya está asignado a nuestro equipo de la región ' + region : ' y en breve será asignado a un técnico') +
        '. Tu número de ticket es ' + id + '.\n\nDatos reportados:\n' + resumen
    });

    // 2) Técnico, con botón "Abrir Ticket"
    if (tec && tec['Correo']) {
      await enviarTecnico_({
        id, cliente: v.cliente, contacto: v.contacto, telefono: v.telefono, estado: v.estado,
        region, equipo: v.equipo, serial: v.serial, prioridad: urg.id, urgTexto: urg.texto,
        limite: fmt_(limite), descripcion: v.descripcion
      }, tec);
    }

    // 3) Admin si no hay técnico
    const admin = prop('CORREO_ADMIN');
    if (!tec && admin) {
      await mail.enviar({
        to: admin, subject: '[' + EMPRESA + '] Ticket ' + id + ' SIN TÉCNICO en ' + region,
        body: 'No hay técnico activo en la región ' + region + '. Asigna el caso desde el panel.\n\n' + resumen
      });
    }
  } catch (e) {
    console.error('Error enviando correos: ' + e.message);
  }
}

/* ===================== PANEL DEL TÉCNICO (enlace del correo) ===================== */

function fechaInput_(v) {
  const d = aFecha_(v);
  return d ? iso(d) : '';
}

function parseFecha_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('Fecha no válida.');
  return desdeISO(m[1], m[2], m[3]);
}

async function getTicketTecnico(id, tk) {
  try {
    if (!tokenValido_(id, tk)) throw new Error('Enlace no válido o vencido.');
    const t = (await S.leer('TICKETS')).filter(x => String(x['ID_Ticket']) === String(id))[0];
    if (!t) throw new Error('No se encontró el ticket.');
    return {
      ok: true,
      id: String(t['ID_Ticket']), cliente: String(t['Cliente']), contacto: String(t['Contacto']),
      telefono: String(t['Teléfono']), correo: String(t['Correo']), estado: String(t['Estado']),
      region: String(t['Región']), equipo: String(t['Equipo']), serial: String(t['Serial']),
      descripcion: String(t['Descripción']), prioridad: String(t['Prioridad']),
      tecnico: String(t['Técnico asignado']), estatus: String(t['Estatus']), limite: fmt_(t['Fecha límite SLA']),
      fechaAtencion: fechaInput_(t['Fecha de atencion']), obs: String(t['Observaciones'] || ''),
      sitio: String(t['Atencion en sitio'] || ''), fechaVisita: fechaInput_(t['Fecha de la visita']),
      garantia: String(t['Garantia'] || ''), fechaCierre: fechaInput_(t['Fecha cierre'])
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function guardarTicketTecnico(id, tk, d) {
  try {
    if (!tokenValido_(id, tk)) throw new Error('Enlace no válido o vencido.');
    d = d || {};
    const fAtencion = parseFecha_(d.fechaAtencion), fVisita = parseFecha_(d.fechaVisita), fCierre = parseFecha_(d.fechaCierre);
    const obs = String(d.obs || '').trim().slice(0, 4000);
    const sitio = String(d.sitio || '').trim().slice(0, 1500);
    const garantia = String(d.garantia || '').trim();
    if (garantia && ['Sí', 'No'].indexOf(garantia) < 0) throw new Error('Garantía no válida.');
    if (fCierre) {
      if (!obs) throw new Error('Para cerrar, relata en Observaciones el problema y la solución.');
      if (!garantia) throw new Error('Para cerrar, indica si entra por garantía.');
    }

    const t = (await S.leer('TICKETS')).filter(x => String(x['ID_Ticket']) === String(id))[0];
    if (!t) throw new Error('No se encontró el ticket.');
    const cambios = [];
    const poner = async (col, val) => cambios.push({ fila: t._fila, col: await S.colDe('TICKETS', col), valor: val });

    await poner('Fecha de atencion', celdaFecha_(fAtencion));
    await poner('Observaciones', obs);
    await poner('Atencion en sitio', sitio);
    await poner('Fecha de la visita', celdaFecha_(fVisita));
    await poner('Garantia', garantia);
    await poner('Fecha cierre', celdaFecha_(fCierre));

    // Estatus automático según lo que llene el técnico
    let est = String(t['Estatus']);
    if (fCierre) est = 'Resuelto';
    else if (est === 'Resuelto' || est === 'Cerrado') est = 'En reparación';
    else if (fAtencion && (est === 'Asignado' || est === 'Sin asignar')) est = 'En reparación';
    await poner('Estatus', est);

    await S.celdas('TICKETS', cambios);
    return { ok: true, estatus: est };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ===================== CLIENTES Y EQUIPOS (autocompletado) ===================== */

function norm_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
const tokens_ = s => norm_(s).split(' ').filter(t => t.length > 1 && PALABRAS_VACIAS.indexOf(t) < 0);

// Dos nombres se consideran el mismo si todas las palabras del más corto están en el más largo
// (JOSE CARPIO = JOSE RAUL CARPIO = JOSE RAUL CARPIO SALAZAR). Una sola palabra es ambigua.
function relacionado_(ta, tb) {
  if (!ta.length || !tb.length) return false;
  const corto = ta.length <= tb.length ? ta : tb;
  const largo = ta.length <= tb.length ? tb : ta;
  if (corto.length === 1 && largo.length > 1) return false;
  return corto.every(t => largo.indexOf(t) >= 0);
}

// Caché en memoria 30 minutos (por instancia del servidor)
let cacheDatos = null, cacheHasta = 0;
const TTL_CACHE = 30 * 60 * 1000;

function limpiarCache() { cacheDatos = null; cacheHasta = 0; }

// Lee las dos hojas una sola vez y las guarda en caché
async function datos_() {
  if (cacheDatos && Date.now() < cacheHasta) return cacheDatos;
  const d = { clientes: [], equipos: [] };
  // DATA CLIENTE: G = nombre, I = teléfono, J = correo
  (await S.columnas(HOJA_CLIENTES, 7, 10)).forEach(r => {
    const nombre = limpio(r[0]).trim();
    if (nombre) d.clientes.push([nombre, limpio(r[2]).trim(), limpio(r[3]).trim()]);
  });
  // Sales: B = status, C = customer, D = serial number, F = short description, G = city
  (await S.columnas(HOJA_SALES, 2, 7)).forEach(r => {
    const cliente = limpio(r[1]).trim();
    if (cliente) d.equipos.push([cliente, limpio(r[2]).trim(), limpio(r[4]).trim(), limpio(r[5]).trim(), limpio(r[0]).trim()]);
  });
  cacheDatos = d;
  cacheHasta = Date.now() + TTL_CACHE;
  return d;
}

async function calentarDatos() {
  try { await datos_(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

// Confidencial: nunca devuelve listas. Solo responde cuando lo escrito
// identifica a UN solo cliente (nombre exacto o coincidencia única con 2+ palabras).
async function buscarClientes(texto) {
  try {
    const qn = norm_(texto);
    const q = tokens_(texto);
    if (qn.length < 3 || !q.length) return { ok: true, items: [] };

    const d = await datos_();
    const vistos = {}, coinciden = [];
    d.clientes.map(c => c[0]).concat(d.equipos.map(e => e[0])).forEach(nombre => {
      const k = norm_(nombre);
      if (vistos[k]) return;
      vistos[k] = 1;
      const t = tokens_(nombre);
      if (q.every(qt => t.some(x => x === qt || x.indexOf(qt) === 0))) coinciden.push(nombre);
    });

    // 1) Nombre exacto
    const exacto = coinciden.filter(n => norm_(n) === qn);
    if (exacto.length === 1) return { ok: true, items: [exacto[0]] };
    // 2) Una sola coincidencia, con al menos 2 palabras escritas
    if (q.length >= 2 && coinciden.length === 1) return { ok: true, items: [coinciden[0]] };
    // 3) Si hay varias, no se muestra nada: se espera a que escriba más
    return { ok: true, items: [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function formatoTel_(t) {
  let dig = String(t || '').replace(/\D/g, '');
  if (dig.indexOf('58') === 0 && dig.length === 12) dig = dig.slice(2);
  if (/^4\d{9}$/.test(dig)) dig = '0' + dig;
  return /^0[24]\d{9}$/.test(dig) ? dig : String(t || '').trim();
}
function maskTel_(t) {
  const dig = String(t).replace(/\D/g, '');
  return dig.length > 4 ? '••••••' + dig.slice(-4) : '••••';
}
function maskCorreo_(c) {
  const i = String(c).indexOf('@');
  return i < 1 ? '•••' : c.charAt(0) + '•••' + c.slice(i);
}

function estadoCanonico_(ciudad, estados) {
  const k = norm_(ciudad);
  if (!k) return '';
  if (ALIAS_ESTADO[k]) return ALIAS_ESTADO[k];
  for (let i = 0; i < estados.length; i++) if (norm_(estados[i]) === k) return estados[i];
  return '';
}

// Si hay coincidencia exacta de nombre se usa solo esa; si no, la aproximada
function coincidencias_(lista, nombre) {
  const k = norm_(nombre), t = tokens_(nombre);
  const exactos = lista.filter(x => norm_(x[0]) === k);
  return exactos.length ? exactos : lista.filter(x => relacionado_(t, tokens_(x[0])));
}

function registro_(nombre, d) {
  const cl = coincidencias_(d.clientes, nombre);
  const tel = cl.map(x => x[1]).filter(String)[0] || '';
  const correo = cl.map(x => x[2]).filter(String)[0] || '';
  return { contacto: cl.length ? cl[0][0] : '', tel: formatoTel_(tel), correo };
}

// Devuelve datos del cliente elegido. Teléfono y correo van enmascarados: el formulario es
// público y no debe exponer datos de contacto de otros clientes.
async function seleccionarCliente(nombre) {
  try {
    nombre = String(nombre || '').trim();
    if (!nombre) throw new Error('Nombre vacío.');
    const d = await datos_();
    const reg = registro_(nombre, d);
    const estados = (await S.leer('ESTADOS')).map(e => String(e['Estado']));

    const vistos = {}, equipos = [], conteo = {};
    coincidencias_(d.equipos, nombre).forEach(e => {
      const serial = e[1], desc = e[2], status = e[4].toUpperCase();
      if (STATUS_EXCLUIDOS.indexOf(status) >= 0 || (!serial && !desc)) return;
      const clave = serial + '|' + desc;
      if (vistos[clave]) return;
      vistos[clave] = 1;
      const estado = estadoCanonico_(e[3], estados);
      if (estado) conteo[estado] = (conteo[estado] || 0) + 1;
      equipos.push({
        etiqueta: (desc || 'Equipo sin descripción') + (serial ? ' · S/N ' + serial : ''),
        equipo: desc || 'Equipo sin descripción',
        serial, estado
      });
    });
    equipos.sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'));

    const estadoDefecto = Object.keys(conteo).sort((a, b) => conteo[b] - conteo[a])[0] || '';
    return {
      ok: true,
      contacto: reg.contacto,
      tel: { tiene: !!reg.tel, mascara: reg.tel ? maskTel_(reg.tel) : '' },
      correo: { tiene: !!reg.correo, mascara: reg.correo ? maskCorreo_(reg.correo) : '' },
      estado: estadoDefecto,
      equipos: equipos.slice(0, 300)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ===================== PANEL ===================== */

async function panelLogin(clave) {
  try { await validarClave_(clave); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

async function getPanelData(clave) {
  try {
    await validarClave_(clave);
    const ahora = new Date();
    const tickets = (await S.leer('TICKETS')).reverse().map(t => {
      const abierto = ESTATUS_ABIERTOS.indexOf(t['Estatus']) >= 0;
      const lim = aFecha_(t['Fecha límite SLA']);
      return {
        id: String(t['ID_Ticket']),
        fecha: fmt_(t['Fecha']),
        cliente: String(t['Cliente']),
        contacto: String(t['Contacto']),
        telefono: String(t['Teléfono']),
        correo: String(t['Correo']),
        estado: String(t['Estado']),
        region: String(t['Región']),
        equipo: String(t['Equipo']),
        serial: String(t['Serial']),
        descripcion: String(t['Descripción']),
        prioridad: String(t['Prioridad']),
        tecnico: String(t['Técnico asignado']),
        estatus: String(t['Estatus']),
        limite: fmt_(t['Fecha límite SLA']),
        cierre: fmt_(t['Fecha cierre']),
        obs: String(t['Observaciones']),
        atencion: fmt_(t['Fecha de atencion']),
        sitio: String(t['Atencion en sitio'] || ''),
        visita: fmt_(t['Fecha de la visita']),
        garantia: String(t['Garantia'] || ''),
        vencido: abierto && !!lim && lim < ahora
      };
    });
    const tecnicos = (await S.leer('TECNICOS')).map(t => ({ nombre: String(t['Nombre']), region: String(t['Región']), activo: esActivo_(t) }));
    return { ok: true, tickets, tecnicos, estatus: ESTATUS, regiones: REGIONES };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function actualizarTicket(clave, id, estatus, tecnico, nota) {
  try {
    await validarClave_(clave);
    if (ESTATUS.indexOf(estatus) < 0) throw new Error('Estatus no válido.');

    let tec = null;
    if (tecnico) {
      tec = (await S.leer('TECNICOS')).filter(t => t['Nombre'] === tecnico)[0];
      if (!tec) throw new Error('El técnico no existe en la hoja TECNICOS.');
    }

    const t = (await S.leer('TICKETS')).filter(x => String(x['ID_Ticket']) === String(id))[0];
    if (!t) throw new Error('No se encontró el ticket ' + id + '.');
    const col = n => S.colDe('TICKETS', n);

    // Coherencia entre técnico y estatus
    if (tec && estatus === 'Sin asignar') estatus = 'Asignado';
    if (!tec && estatus === 'Asignado') estatus = 'Sin asignar';

    const cambios = [
      { fila: t._fila, col: await col('Técnico asignado'), valor: tec ? tec['Nombre'] : '' },
      { fila: t._fila, col: await col('Correo técnico'), valor: tec ? tec['Correo'] : '' },
      { fila: t._fila, col: await col('Estatus'), valor: estatus }
    ];

    const cerrado = estatus === 'Resuelto' || estatus === 'Cerrado';
    if (cerrado && !t['Fecha cierre']) cambios.push({ fila: t._fila, col: await col('Fecha cierre'), valor: celdaFecha_(new Date()) });
    if (!cerrado) cambios.push({ fila: t._fila, col: await col('Fecha cierre'), valor: '' });

    nota = String(nota || '').trim();
    if (nota) {
      const previo = String(t['Observaciones'] || '');
      const linea = '[' + fmt_(new Date()) + '] ' + nota;
      cambios.push({ fila: t._fila, col: await col('Observaciones'), valor: previo ? previo + '\n' + linea : linea });
    }
    await S.celdas('TICKETS', cambios);

    // Avisar al técnico si el caso cambió de responsable
    if (tec && tec['Correo'] && tec['Nombre'] !== t['Técnico asignado']) {
      try {
        const u = URGENCIAS.filter(x => x.id === t['Prioridad'])[0] || { texto: '' };
        await enviarTecnico_({
          id: String(t['ID_Ticket']), cliente: t['Cliente'], contacto: t['Contacto'], telefono: t['Teléfono'],
          estado: t['Estado'], region: t['Región'], equipo: t['Equipo'], serial: t['Serial'],
          prioridad: t['Prioridad'], urgTexto: u.texto, limite: fmt_(t['Fecha límite SLA']),
          descripcion: t['Descripción']
        }, tec);
      } catch (e) { console.error(e.message); }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ===================== DASHBOARD ===================== */

// Devuelve los tickets con fechas en milisegundos; las métricas se calculan en el navegador
// para que los filtros respondan sin volver al servidor.
async function getDashboardData(clave) {
  try {
    await validarClave_(clave);
    const tickets = (await S.leer('TICKETS')).map(t => {
      const fecha = aFecha_(t['Fecha']), atencion = aFecha_(t['Fecha de atencion']);
      return {
        id: String(t['ID_Ticket']),
        fecha: fecha ? fecha.getTime() : null,
        cliente: String(t['Cliente']),
        equipo: String(t['Equipo']),
        serial: String(t['Serial']),
        estado: String(t['Estado']),
        region: String(t['Región']),
        prioridad: String(t['Prioridad']),
        tecnico: String(t['Técnico asignado'] || ''),
        estatus: String(t['Estatus']),
        limite: ms_(t['Fecha límite SLA']),
        atencion: atencion ? atencion.getTime() : null,
        // Días calendario entre el reporte y la fecha de atención (0 = el mismo día)
        respDias: fecha && atencion ? Math.max(0, diaN_(atencion) - diaN_(fecha)) : null,
        cierre: ms_(t['Fecha cierre']),
        visita: ms_(t['Fecha de la visita']),
        garantia: String(t['Garantia'] || '').trim(),
        sitio: String(t['Atencion en sitio'] || '').trim(),
        alerta: ms_(t[COL_ALERTA])
      };
    });
    const tecnicos = (await S.leer('TECNICOS')).map(t => ({ nombre: String(t['Nombre']), region: String(t['Región']), activo: esActivo_(t) }));
    return {
      ok: true, ahora: Date.now(), tickets, tecnicos, regiones: REGIONES,
      abiertos: ESTATUS_ABIERTOS, sinRespuesta: ESTATUS_SIN_RESPUESTA,
      horasAlerta: HORAS_SIN_RESPUESTA, minutosRevision: parseInt(prop('ALERTAS_CADA_MINUTOS'), 10) || 1440,
      alertasActivas: true
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ===================== ALERTAS: CASOS SIN RESPUESTA ===================== */

// Botón "Enviar alertas ahora" del dashboard
async function enviarAlertasAhora(clave) {
  try {
    await validarClave_(clave);
    const r = await procesarAlertas_();
    return { ok: true, casos: r.casos, enviadas: r.enviadas, omitidas: r.omitidas, sinCorreo: r.sinCorreo };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Avisa por cada caso abierto sin fecha de atención que pasó HORAS_SIN_RESPUESTA desde el reporte.
// El aviso se repite cada HORAS_REPETIR_ALERTA horas mientras siga sin respuesta.
async function procesarAlertas_() {
  const r = { casos: 0, enviadas: 0, omitidas: 0, sinCorreo: 0 };
  const col = await S.asegurarColumna('TICKETS', COL_ALERTA);
  const ahora = new Date();
  const admin = prop('CORREO_ADMIN');
  const correos = {};
  (await S.leer('TECNICOS')).forEach(t => { correos[String(t['Nombre'])] = String(t['Correo'] || '').trim(); });

  for (const t of await S.leer('TICKETS')) {
    if (ESTATUS_SIN_RESPUESTA.indexOf(String(t['Estatus'])) < 0 || aFecha_(t['Fecha de atencion'])) continue;
    const fecha = aFecha_(t['Fecha']);
    if (!fecha) continue;
    const horas = (ahora.getTime() - fecha.getTime()) / 36e5;
    if (horas < HORAS_SIN_RESPUESTA) continue;
    r.casos++;

    const ultima = aFecha_(t[COL_ALERTA]);
    if (ultima && ahora.getTime() - ultima.getTime() < HORAS_REPETIR_ALERTA * 36e5) { r.omitidas++; continue; }

    const tecnico = String(t['Técnico asignado'] || '').trim();
    const correoTec = String(t['Correo técnico'] || '').trim() || correos[tecnico] || '';
    try {
      if (!(await enviarAlerta_(t, Math.floor(horas / 24), tecnico, correoTec, admin))) { r.sinCorreo++; continue; }
      await S.celdas('TICKETS', [{ fila: t._fila, col, valor: celdaFecha_(ahora) }]);
      r.enviadas++;
    } catch (e) {
      console.error('Alerta ' + t['ID_Ticket'] + ': ' + e.message);
    }
  }
  return r;
}

async function enviarAlerta_(t, dias, tecnico, correoTec, admin) {
  const id = String(t['ID_Ticket']);
  const asunto = '[' + EMPRESA + '] ALERTA: ticket ' + id + ' lleva ' + dias + ' días sin respuesta';
  const datos =
    '<table style="font-size:14px;border-collapse:collapse">' +
    filaHtml('Cliente', t['Cliente']) + filaHtml('Contacto', t['Contacto'] + ' / ' + t['Teléfono']) +
    filaHtml('Ubicación', t['Estado'] + ' (Región ' + t['Región'] + ')') +
    filaHtml('Equipo', t['Equipo'] + (t['Serial'] ? ' (serial ' + t['Serial'] + ')' : '')) +
    filaHtml('Prioridad', t['Prioridad']) + filaHtml('Reportado', fmt_(t['Fecha'])) +
    filaHtml('Fecha límite', fmt_(t['Fecha límite SLA'])) + '</table>' +
    '<p style="margin:14px 0 4px;color:#5d7a85">Falla reportada:</p>' +
    '<div style="background:#e9f6f2;padding:10px 12px;border-radius:6px;white-space:pre-wrap">' + h_(t['Descripción']) + '</div>';

  if (correoTec) {
    const link = enlaceTecnico_(id);
    const html =
      '<div style="font-family:Arial,sans-serif;color:#0f3d4f;max-width:560px">' +
      '<div style="border-top:6px solid #b3261e;padding-top:12px"><h2 style="margin:0 0 4px;color:#b3261e">Ticket ' + h_(id) +
      ': ' + dias + ' días sin respuesta</h2>' +
      '<p style="margin:0 0 12px;color:#5d7a85">El caso sigue sin fecha de atención. Atiéndelo o registra la fecha de atención en el ticket.</p></div>' +
      datos +
      '<p style="margin:22px 0"><a href="' + link + '" style="background:#00668a;color:#ffffff;text-decoration:none;' +
      'padding:12px 26px;border-radius:6px;font-weight:bold;display:inline-block">Abrir Ticket</a></p>' +
      '<p style="font-size:12px;color:#5d7a85">Si el botón no funciona, copia este enlace: ' + link + '</p></div>';
    await mail.enviar({
      to: correoTec, cc: admin || undefined, subject: asunto, htmlBody: html,
      body: 'El ticket ' + id + ' lleva ' + dias + ' días sin respuesta.\nCliente: ' + t['Cliente'] +
        '\nEquipo: ' + t['Equipo'] + '\nPrioridad: ' + t['Prioridad'] + '\n\nAbrir ticket: ' + link
    });
    return true;
  }
  if (admin) {
    await mail.enviar({
      to: admin, subject: asunto + (tecnico ? ' (el técnico no tiene correo)' : ' (SIN TÉCNICO)'),
      htmlBody: '<div style="font-family:Arial,sans-serif;color:#0f3d4f;max-width:560px">' +
        '<h2 style="margin:0 0 4px;color:#b3261e">Ticket ' + h_(id) + ': ' + dias + ' días sin respuesta</h2>' +
        '<p style="color:#5d7a85">' + (tecnico ? 'El técnico ' + h_(tecnico) + ' no tiene correo en la hoja TECNICOS.'
          : 'El caso no tiene técnico asignado. Asígnalo desde el panel.') + '</p>' + datos + '</div>',
      body: 'El ticket ' + id + ' lleva ' + dias + ' días sin respuesta y no hay a quién avisar. Cliente: ' + t['Cliente']
    });
    return true;
  }
  return false;
}

// Funciones que el navegador puede llamar (api/rpc.js)
const PUBLICAS = {
  getFormConfig, crearTicket, buscarClientes, seleccionarCliente, calentarDatos,
  getTicketTecnico, guardarTicketTecnico,
  panelLogin, getPanelData, actualizarTicket, getDashboardData, enviarAlertasAhora
};

module.exports = {
  PUBLICAS, fijarBase, procesarAlertas_, limpiarCache,
  // Expuestas para las pruebas
  _t: { norm_, tokens_, relacionado_, formatoTel_, token_, tokenValido_, enlaceTecnico_ }
};
