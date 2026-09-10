// Диагностика возможностей AI-провайдера (proxyapi, OpenAI-совместимый).
// Запуск: node scripts/probe-provider.mjs
// Читает ключ из .env; ничего не требует из node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const BASE = env.AI_BASE_URL || 'https://api.proxyapi.ru/openai/v1';
const KEY = env.AI_API_KEY;
if (!KEY) { console.error('Нет AI_API_KEY в .env'); process.exit(1); }

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const line = (s = '') => console.log(s);

async function req(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (opts.buf) return { res, buf: Buffer.from(await res.arrayBuffer()) };
  return { res, body: await res.text() };
}

async function main() {
  line(`=== Провайдер: ${BASE} ===`);

  // 1. Модели
  line('\n[1] GET /models');
  try {
    const { res, body } = await req('/models');
    line(`  HTTP ${res.status}`);
    if (!res.ok) { line(body.slice(0, 500)); return; }
    const data = JSON.parse(body);
    const ids = (data.data || []).map(m => m.id).sort();
    line(`  Всего моделей: ${ids.length}`);
    const interesting = ids.filter(id => /gpt-4|gpt-4o|gpt-4\.1|o3|o4|mini|tts|whisper|audio|deepseek|qwen|claude|gemini|grok|kimi|llama|mistral|glm|doubao|spark/i.test(id));
    line(`  Кандидаты:\n    ${interesting.join('\n    ')}`);
  } catch (e) { line('  Ошибка запроса: ' + e.message); }

  // 2. Chat completions + JSON-режим
  async function chatTest(model) {
    line(`\n[2] Chat ${model} (JSON-режим)`);
    try {
      const { res, body } = await req('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Ответь строго JSON: {"ok": true, "word": "привет"}' }],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 60,
        }),
      });
      line(`  HTTP ${res.status}`);
      if (!res.ok) { line('  ' + body.slice(0, 300)); return null; }
      const j = JSON.parse(body);
      const content = j.choices?.[0]?.message?.content ?? '';
      line(`  Ответ: ${content.slice(0, 200)}`);
      return content;
    } catch (e) { line('  Ошибка: ' + e.message); return null; }
  }

  // 3. TTS
  async function ttsTest(model, voice) {
    line(`\n[3] TTS ${model} / ${voice} (русский)`);
    try {
      const { res, buf } = await req('/audio/speech', {
        method: 'POST',
        buf: true,
        body: JSON.stringify({
          model, voice,
          input: 'Здравствуйте! Я к вам записана ещё на два часа назад, а меня до сих пор никто не позвал. Вы понимаете, сколько я здесь стою?',
        }),
      });
      line(`  HTTP ${res.status}, bytes=${buf.length}`);
      if (!res.ok) { line('  ' + buf.toString('utf8').slice(0, 300)); return null; }
      const file = path.join(root, 'data', 'probe-tts.mp3');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      line(`  Сохранено: ${file}`);
      return file;
    } catch (e) { line('  Ошибка: ' + e.message); return null; }
  }

  // 4. STT (whisper) roundtrip — multipart собираем вручную (надёжнее для прокси)
  async function sttTest(file, model) {
    line(`\n[4] STT ${model} (roundtrip mp3)`);
    try {
      const buf = fs.readFileSync(file);
      const boundary = '----VeraProbeBoundary7MA4YWxk';
      const parts = [];
      const addField = (name, value) => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
      };
      addField('model', model);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`, 'utf8'));
      parts.push(buf);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
      const payload = Buffer.concat(parts);
      const { res, body } = await req('/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: payload,
      });
      line(`  HTTP ${res.status}`);
      if (!res.ok) { line('  ' + body.slice(0, 300)); return; }
      const j = JSON.parse(body);
      line(`  Распознано: ${(j.text || '').slice(0, 300)}`);
    } catch (e) { line('  Ошибка: ' + e.message); }
  }

  // Выбор моделей для теста делаем по данным /models: попробуем цепочку кандидатов, берём первую успешную
  let modelIds = [];
  try {
    const { body } = await req('/models');
    modelIds = (JSON.parse(body).data || []).map(m => m.id);
  } catch {}

  const pick = (re, preferred = []) =>
    [...preferred, ...modelIds].find(id => id && re.test(id)) || null;

  const chatCandidates = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4', 'deepseek-chat', 'qwen2.5:7b', 'claude-3-5-haiku-20241022'];
  const chatModel = chatCandidates.find(id => modelIds.includes(id));
  if (chatModel) { await chatTest(chatModel); } else { line('\n[2] Нет известной chat-модели — смотрю по списку выше.'); }

  const ttsCandidates = ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'];
  const ttsModel = ttsCandidates.find(id => modelIds.includes(id));
  let ttsFile = null;
  if (ttsModel) {
    for (const voice of ['onyx', 'alloy', 'nova']) {
      ttsFile = await ttsTest(ttsModel, voice);
      if (ttsFile) break;
    }
  } else line('\n[3] Нет известной TTS-модели в списке.');

  const sttCandidates = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];
  const sttModels = sttCandidates.filter(id => modelIds.includes(id));
  if (ttsFile) {
    if (!sttModels.length) line('\n[4] Нет известной STT-модели.');
    for (const m of sttModels) await sttTest(ttsFile, m);
  } else line(`\n[4] Пропуск STT: нет тестового аудио (модели: ${sttModels.join(', ') || '—'})`);

  line('\n=== Готово ===');
}

main().catch(e => { console.error(e); process.exit(1); });
