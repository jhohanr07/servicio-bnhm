// Punto de entrada único para las páginas: POST /api/rpc  { fn: 'nombre', args: [...] }
const core = require('../lib/core');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const fn = core.PUBLICAS[b.fn];
    if (!Object.prototype.hasOwnProperty.call(core.PUBLICAS, b.fn) || typeof fn !== 'function') {
      return res.status(404).json({ ok: false, error: 'Función no encontrada.' });
    }
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    core.fijarBase(proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host));
    const r = await fn.apply(null, Array.isArray(b.args) ? b.args : []);
    return res.status(200).json(r);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || 'Error del servidor.' });
  }
};
