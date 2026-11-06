// Prueba de extremo a extremo SIN red ni credenciales: el código de Vercel (lib/ y api/) habla con
// apps-script/Backend.gs, que aquí se ejecuta contra un libro de Google Sheets simulado en memoria.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.CLAVE_PANEL = 'clave123';
process.env.TOKEN_SECRET = 'secreto-de-prueba-largo';
process.env.CORREO_ADMIN = 'admin@bnh.test';
process.env.APPS_SCRIPT_URL = 'https://script.google.com/macros/s/PRUEBA/exec';
process.env.API_SECRET = 'api-secreta';

/* ---------- Google Sheets simulado ---------- */
const H_T = ['ID_Ticket', 'Fecha', 'Cliente', 'Contacto', 'Teléfono', 'Correo', 'Estado', 'Región', 'Equipo', 'Serial',
  'Descripción', 'Prioridad', 'Técnico asignado', 'Correo técnico', 'Estatus', 'Fecha límite SLA', 'Fecha de atencion',
  'Observaciones', 'Garantia', 'Fecha cierre', 'Atencion en sitio', 'Fecha de la visita'];
const libro = {
  TICKETS: [H_T.slice()],
  TECNICOS: [['Nombre', 'Región', 'Correo', 'Activo'],
    ['María Soto', 'Central', 'maria@bnh.test', 'SI'], ['Pedro Oriente', 'Oriente', 'pedro@bnh.test', 'SI'],
    ['Luis Occ', 'Occidente', '', 'SI']],
  ESTADOS: [['Estado', 'Región'], ['Distrito Capital', 'Central'], ['Miranda', 'Central'], ['Zulia', 'Occidente'], ['Anzoátegui', 'Oriente']],
  'DATA CLIENTE': [['', '', '', '', '', '', 'Cliente', '', 'Teléfono', 'Correo'],
    ['', '', '', '', '', '', 'JOSE RAUL CARPIO SALAZAR', '', '0414-1234567', 'jose@x.com'],
    ['', '', '', '', '', '', 'CLINICA LA TRINIDAD', '', '', ''],
    ['', '', '', '', '', '', 'CLINICA EL AVILA', '', '', '']],
  Sales: [['', 'Status', 'Customer', 'Serial', '', 'Short Description', 'City'],
    ['', 'ACTIVE', 'JOSE RAUL CARPIO SALAZAR', 'SN1', '', 'Ecógrafo X', 'Caracas'],
    ['', 'DECOMMISSIONED', 'JOSE RAUL CARPIO SALAZAR', 'SN2', '', 'Monitor viejo', 'Caracas'],
    ['', 'ACTIVE', 'CLINICA LA TRINIDAD', 'SN3', '', 'Rayos X', 'Miranda'],
    ['', 'ACTIVE', 'CLINICA EL AVILA', 'SN4', '', 'Rayos X', 'Miranda']]
};
const ancho = a => Math.max(...a.map(r => r.length));
const norm = a => a.map(r => { const x = r.slice(); while (x.length < ancho(a)) x.push(''); return x; });
const vis = v => v instanceof Date ? v.toISOString() : String(v);
function hojaFalsa(nombre) {
  const a = libro[nombre];
  const rango = (r, c, nr, nc) => ({
    getValues: () => norm(a).slice(r - 1, r - 1 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || 1))),
    getDisplayValues: () => norm(a).slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc).map(vis)),
    setValue(v) { while (a.length < r) a.push([]); while (a[r - 1].length < c) a[r - 1].push(''); a[r - 1][c - 1] = v; return this; },
    setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; }
  });
  return { getDataRange: () => ({ getValues: () => norm(a) }), getLastRow: () => a.length, getLastColumn: () => ancho(a),
    getRange: rango, appendRow: r => a.push(r) };
}
const correos = [];
const propiedades = { API_SECRET: 'api-secreta' };
const contexto = vm.createContext({
  JSON, Date, parseInt, String, Number, Object, Array, Error,
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => libro[n] ? hojaFalsa(n) : null }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => propiedades[k] || null }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ getContent: () => t, setMimeType() { return this; } }) },
  MailApp: { sendEmail: o => correos.push(o), getRemainingDailyQuota: () => 100 }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Backend.gs'), 'utf8'), contexto);
global.fetch = async (url, opts) => {
  assert.strictEqual(url, process.env.APPS_SCRIPT_URL);
  assert.strictEqual(opts.method, 'POST');
  const out = contexto.doPost({ postData: { contents: opts.body } });
  return { text: async () => out.getContent() };
};

const U = require('../lib/util');
const core = require('../lib/core');
core.fijarBase('https://tickets.example.com/');
const P = core.PUBLICAS;
const T = i => libro.TICKETS[i + 1];                       // i-ésimo ticket (0 = primero)
const ok = (c, m) => { assert(c, m); console.log('  ✓ ' + m); };

(async () => {
  console.log('Fechas');
  const d0 = new Date(Date.UTC(2026, 10, 5, 22, 30)); // 18:30 en Caracas
  ok(U.fechaHora(d0) === '05/11/2026 18:30', 'fechaHora usa hora de Caracas');
  ok(U.aFecha_('05/11/2026 18:30').getTime() === d0.getTime(), 'aFecha_ lee texto dd/MM/yyyy HH:mm');
  ok(U.iso(d0) === '2026-11-05', 'formato yyyy-MM-dd');

  console.log('Puente de Apps Script');
  const puente = require('../lib/puente');
  const rt = puente.desdeTexto(puente.aTexto({ f: d0, n: 1, s: 'x' }));
  ok(rt.f instanceof Date && rt.f.getTime() === d0.getTime(), 'las fechas viajan sin cambiar');
  process.env.API_SECRET = 'otra';
  let fallo = '';
  try { await P.getFormConfig(); } catch (e) { fallo = e.message; }
  const r0 = await P.getFormConfig().catch(e => ({ ok: false, error: e.message }));
  ok(/No autorizado/.test(fallo || r0.error || ''), 'clave del puente incorrecta: rechazado');
  process.env.API_SECRET = 'api-secreta';

  console.log('Búsqueda confidencial');
  ok((await P.buscarClientes('clinica')).items.length === 0, 'una palabra ambigua no devuelve nada');
  ok((await P.buscarClientes('clinica trinidad')).items[0] === 'CLINICA LA TRINIDAD', 'coincidencia única de 2 palabras');
  ok((await P.buscarClientes('jose carpio')).items[0] === 'JOSE RAUL CARPIO SALAZAR', 'JOSE CARPIO = JOSE RAUL CARPIO SALAZAR');
  const sel = await P.seleccionarCliente('JOSE RAUL CARPIO SALAZAR');
  ok(sel.ok && sel.equipos.length === 1 && sel.equipos[0].serial === 'SN1', 'equipos sin DECOMMISSIONED y con serial');
  ok(sel.estado === 'Distrito Capital', 'Caracas -> Distrito Capital');
  ok(sel.tel.tiene && /^••••••4567$/.test(sel.tel.mascara) && sel.correo.mascara === 'j•••@x.com', 'teléfono y correo enmascarados');
  ok(!JSON.stringify(sel).includes('1234567') && !JSON.stringify(sel).includes('jose@x.com'), 'no se filtran datos de contacto');

  console.log('Crear ticket');
  const base = { cliente: 'JOSE RAUL CARPIO SALAZAR', refCliente: 'JOSE RAUL CARPIO SALAZAR', contacto: 'Jose', telefono: '', correo: '',
    estado: 'Distrito Capital', equipo: 'Ecógrafo X', serial: 'SN1', urgencia: 'P2', descripcion: 'No enciende' };
  const r1 = await P.crearTicket(base);
  ok(r1.ok && r1.id === 'TK-0001' && r1.region === 'Central' && r1.tecnico === 'María Soto', 'ID, región Central y técnico María Soto');
  ok(T(0)[4] === '04141234567' && T(0)[5] === 'jose@x.com', 'teléfono y correo completados desde DATA CLIENTE');
  ok(T(0)[1] instanceof Date && T(0)[15] instanceof Date && T(0)[15] - T(0)[1] === 120 * 36e5, 'fechas reales y límite SLA de 120 h');
  ok(correos.length === 2 && correos[0].to === 'jose@x.com' && correos[1].to === 'maria@bnh.test', 'correo al cliente y al técnico');
  ok(correos[1].htmlBody.includes('https://tickets.example.com/tecnico?id=TK-0001&t='), 'botón Abrir Ticket con el enlace de Vercel');
  const r2 = await P.crearTicket({ ...base, estado: 'Zulia', descripcion: '=HYPERLINK("x")' });
  ok(r2.ok && r2.id === 'TK-0002' && r2.tecnico === 'Luis Occ' && correos.length === 3, 'Occidente (técnico sin correo): solo correo al cliente');
  ok(T(1)[10] === "'=HYPERLINK(\"x\")", 'un texto que empieza con = no se vuelve fórmula');
  ok(!(await P.crearTicket({ ...base, correo: 'mal', telefono: '1' })).ok, 'rechaza correo inválido');
  ok(!(await P.crearTicket({ ...base, urgencia: 'P9' })).ok, 'rechaza urgencia inválida');
  const par = await Promise.all([P.crearTicket({ ...base, estado: 'Anzoátegui' }), P.crearTicket({ ...base, estado: 'Anzoátegui' })]);
  ok(par[0].ok && par[1].ok && par[0].id !== par[1].id && par[0].tecnico === 'Pedro Oriente', 'dos reportes a la vez no repiten número');
  ok(libro.TICKETS.length === 5, 'cuatro tickets en la hoja');

  console.log('Enlace del técnico');
  const tk = core._t.token_('TK-0001');
  ok(tk.length === 32 && core._t.tokenValido_('TK-0001', tk) && !core._t.tokenValido_('TK-0002', tk), 'token firmado por ticket');
  ok(!(await P.getTicketTecnico('TK-0001', 'x'.repeat(32))).ok, 'token falso rechazado');
  const g = await P.getTicketTecnico('TK-0001', tk);
  ok(g.ok && g.cliente === 'JOSE RAUL CARPIO SALAZAR' && g.fechaAtencion === '', 'abre el ticket');
  let s = await P.guardarTicketTecnico('TK-0001', tk, { fechaAtencion: '2026-11-05', obs: '', garantia: '', sitio: '', fechaVisita: '', fechaCierre: '' });
  ok(s.ok && s.estatus === 'En reparación', 'con fecha de atención pasa a En reparación');
  s = await P.guardarTicketTecnico('TK-0001', tk, { fechaAtencion: '2026-11-05', obs: '', garantia: '', fechaCierre: '2026-11-06' });
  ok(!s.ok && /Observaciones/.test(s.error), 'no cierra sin observaciones');
  s = await P.guardarTicketTecnico('TK-0001', tk, { fechaAtencion: '2026-11-05', obs: 'Fuente dañada, reemplazada', garantia: 'Sí', fechaCierre: '2026-11-06' });
  ok(s.ok && s.estatus === 'Resuelto', 'cierra y pasa a Resuelto');
  const g2 = await P.getTicketTecnico('TK-0001', tk);
  ok(g2.fechaAtencion === '2026-11-05' && g2.fechaCierre === '2026-11-06' && g2.garantia === 'Sí', 'los datos guardados se leen igual');
  ok(!(await P.guardarTicketTecnico('TK-0001', tk, { garantia: 'Quizás' })).ok, 'garantía inválida rechazada');

  console.log('Panel y dashboard');
  ok(!(await P.panelLogin('mala')).ok && (await P.panelLogin('clave123')).ok, 'clave del panel');
  const pd = await P.getPanelData('clave123');
  ok(pd.ok && pd.tickets.length === 4 && /^TK-000[34]$/.test(pd.tickets[0].id), 'panel lista los tickets (más nuevo primero)');
  ok(/^\d\d\/\d\d\/\d{4} \d\d:\d\d$/.test(pd.tickets[0].fecha), 'fechas del panel como texto');
  const a = await P.actualizarTicket('clave123', 'TK-0002', 'En reparación', 'María Soto', 'Reasignado');
  ok(a.ok && T(1)[12] === 'María Soto' && /Reasignado/.test(T(1)[17]), 'reasigna y agrega nota');
  ok(correos[correos.length - 1].to === 'maria@bnh.test', 'avisa al nuevo técnico');
  T(2)[1] = new Date(Date.now() - 5 * 864e5);
  const dd = await P.getDashboardData('clave123');
  ok(dd.ok && dd.tickets.every(t => typeof t.fecha === 'number') && dd.tickets[0].respDias === 0, 'dashboard: fechas en milisegundos y días de respuesta');
  ok(JSON.stringify(dd).indexOf('Invalid') < 0, 'sin fechas inválidas');

  console.log('Alertas');
  const antes = correos.length;
  T(2)[14] = 'Asignado'; T(2)[16] = '';          // TK-0003: 5 días sin respuesta
  const al = await core.procesarAlertas_();
  ok(al.casos === 1 && al.enviadas === 1 && correos.length === antes + 1, 'envía alerta de caso con más de 72 h');
  ok(libro.TICKETS[0].indexOf('Última alerta') >= 0 && T(2)[libro.TICKETS[0].indexOf('Última alerta')] instanceof Date, 'crea la columna Última alerta y la llena');
  const al2 = await core.procesarAlertas_();
  ok(al2.enviadas === 0 && al2.omitidas === 1, 'no repite el aviso antes de 24 h');

  console.log('Ruta /api/rpc');
  const rpc = require('../api/rpc');
  const llamar = async (cuerpo, metodo) => {
    const out = {}; const res = { setHeader() {}, status(c) { out.c = c; return this; }, json(j) { out.j = j; return this; } };
    await rpc({ method: metodo || 'POST', headers: { host: 'x.vercel.app' }, body: cuerpo }, res); return out;
  };
  let o = await llamar({ fn: 'getFormConfig', args: [] });
  ok(o.c === 200 && o.j.ok && o.j.estados.length === 4, 'getFormConfig responde');
  o = await llamar({ fn: 'procesarAlertas_', args: [] });
  ok(o.c === 404, 'no expone funciones internas');
  o = await llamar({ fn: 'constructor', args: [] });
  ok(o.c === 404, 'no expone propiedades heredadas');
  o = await llamar({}, 'GET');
  ok(o.c === 405, 'solo acepta POST');
  console.log('\nTodo correcto.');
})().catch(e => { console.error('\nFALLÓ:', e); process.exit(1); });
