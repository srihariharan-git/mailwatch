import { GoogleGenAI } from '@google/genai';

export async function summarizeEmail(config, alert) {
  if (!config.geminiApiKey) return { ok: false, error: 'GEMINI_API_KEY not configured' };

  const genAI = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const prompt = [
    'Summarize this email in plain text in under 80 words. Focus on what the sender wants or asks from the reader. Do not use markdown.',
    `From: ${alert.from}`,
    `Subject: ${alert.subject}`,
    '',
    '--- email body ---',
    alert.snippet || '(no text body)',
  ].join('\n');

  const res = await genAI.models.generateContent({
    model: config.geminiModel,
    contents: prompt,
  });

  const text = extractText(res);
  if (!text) return { ok: false, error: 'Gemini returned no text' };
  return { ok: true, summary: text };
}

function extractText(res) {
  if (typeof res?.text === 'string' && res.text.length) return res.text;
  const parts = res?.candidates?.[0]?.content?.parts || [];
  const joined = parts.map((p) => p.text || '').join('').trim();
  return joined || null;
}