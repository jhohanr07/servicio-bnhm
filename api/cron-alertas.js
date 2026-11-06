// Revisión automática de casos sin respuesta. La ejecuta Vercel Cron (ver vercel.json).
const core = require('../lib/core');

module.exports = async (req, res) => {
  const secreto = process.env.CRON_SECRET;
  if (!secreto || req.headers.authorization !== 'Bearer ' + secreto) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  try {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    core.fijarBase(proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host));
    const r = await core.procesarAlertas_();
    console.log('Casos sin respuesta: ' + r.casos + '. Correos enviados: ' + r.enviadas + '.');
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
