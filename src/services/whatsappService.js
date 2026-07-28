/**
 * WhatsApp Business API messages to shop owners.
 *
 * MOCK: logs to console and always "delivers".
 * REAL: set WHATSAPP_MODE=real and implement sendWhatsapp() against your
 *       provider (Interakt / AiSensy / Wati). Their REST APIs are all
 *       "POST a template name + params to a phone number", so the signature
 *       below should not need to change.
 *
 * Scope note: this is the OUTBOUND half only — the notifications a shop owner
 * receives. The inbound conversational bot (walking a less tech-savvy owner
 * through the feedback questions via quick replies, then posting the answers to
 * a webhook) is deliberately not built here: it needs a live provider account to
 * develop against, and the token-authenticated web form is the primary channel.
 * When that is added, it should reuse config/assessmentQuestions and post to the
 * same submit-feedback controller with submittedVia:'whatsapp'.
 */

const MODE = process.env.WHATSAPP_MODE || 'mock';

async function sendWhatsapp(phone, message, { template = null, params = {} } = {}) {
  if (MODE === 'real') {
    // ── REAL INTEGRATION GOES HERE ─────────────────────────────
    // e.g. await axios.post(`${WATI_BASE}/api/v1/sendTemplateMessage`, {...})
    throw new Error('WHATSAPP_MODE=real but no provider implemented in whatsappService.js');
  }
  console.log(`🟢 [MOCK WHATSAPP] to ${phone}${template ? ` (template: ${template})` : ''}: ${message}`);
  return { delivered: true, provider: 'mock' };
}

module.exports = { sendWhatsapp, MODE };
