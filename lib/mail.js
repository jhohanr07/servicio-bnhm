// Envío de correos: lo hace el puente de Apps Script (MailApp), con la cuenta que lo implementó.
const puente = require('./puente');

// { to, subject, body (texto), htmlBody, cc }
async function enviar(o) {
  await puente.llamar('correo', { to: o.to, cc: o.cc, subject: o.subject, body: o.body, htmlBody: o.htmlBody });
}

module.exports = { enviar };
