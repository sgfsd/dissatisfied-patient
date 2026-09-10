import { config } from '../config';
import { AiError } from './errors';

/* ============================================================
   Провайдерный слой. ТЗ (раздел 8): все обращения к AI идут
   через интерфейс AiProvider, бизнес-логика провайдера не знает.
   Сейчас единственная реализация — OpenAI-совместимая (proxyapi.ru);
   добавление другого провайдера = новая реализация + реестр.
   ============================================================ */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  /** 0 — детерминированный режим (оценщик), выше — креатив (генератор).
      Модели gpt-5/o-семейства температуру не принимают (у них только дефолт) —
      для них параметр не отправляется вовсе. */
  temperature?: number;
  json?: boolean; // форсировать JSON-режим (response_format)
  maxTokens?: number;
  requestId?: string;
}

export interface ChatResult {
  content: string;
  finishReason: string;
}

export interface TtsRequest {
  model?: string;
  text: string;
  voice: string;
  /** Пациент моложе/старше, тембр и т.п. — только если модель это умеет. */
  instructions?: string;
}

export interface SttRequest {
  model?: string;
  audio: Buffer;
  mime: string;
  language?: string;
}

export interface AiProvider {
  chat(opts: ChatOptions): Promise<ChatResult>;
  tts(opts: TtsRequest): Promise<Buffer>;
  stt(opts: SttRequest): Promise<string>;
  models(): Promise<string[]>;
}

/* ---------- OpenAI-совместимая реализация ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statusToError(status: number, bodyText: string): AiError {
  if (status === 429) return new AiError('rate_limited', `Rate limited: ${bodyText.slice(0, 200)}`, status);
  if (status === 401 || status === 403)
    return new AiError('bad_request', `Неверный ключ API или доступ запрещён (${status})`, status);
  if (status >= 500) return new AiError('provider_unreachable', `Провайдер: ${status} ${bodyText.slice(0, 200)}`, status);
  if (status === 400) return new AiError('bad_request', `Bad request: ${bodyText.slice(0, 200)}`, status);
  return new AiError('unknown', `HTTP ${status}: ${bodyText.slice(0, 200)}`, status);
}

export class OpenAICompatibleProvider implements AiProvider {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    /** Проверка ключа на экране настроек не должна ждать две минуты. */
    private timeoutMs = 120_000
  ) {}

  private async raw(path: string, init: RequestInit = {}, buf = false): Promise<{ res: Response; data: Buffer | string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers || {}) },
      });
      if (buf) return { res, data: Buffer.from(await res.arrayBuffer()) };
      return { res, data: await res.text() };
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') throw new AiError('timeout', 'Таймаут обращения к AI-провайдеру');
      throw new AiError('provider_unreachable', `Не удалось соединиться с провайдером: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const attempts = [0, 800].slice(0, 1); // пока без авто-ретраев: оценка должна быть детерминированной
    let lastError: unknown;
    for (const delay of attempts) {
      if (delay) await sleep(delay);
      try {
        // Новое поколение (gpt-5, o-серия, ChatGPT-…): только max_completion_tokens
        // и без temperature; классические модели — max_tokens + temperature.
        const newGen = /^(gpt-5([.-]|$)|o[1-9](-|$)|chatgpt-)/i.test(opts.model);
        const body: Record<string, unknown> = {
          model: opts.model,
          messages: opts.messages,
          stream: false,
        };
        if (!newGen) body.temperature = opts.temperature ?? 0;
        if (opts.maxTokens) body[newGen ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens;
        if (opts.json) {
          body.response_format = { type: 'json_object' };
          // для json_object некоторые модели требуют слово "json" в сообщениях — добавим в последнее user-сообщение
        }
        const { res, data } = await this.raw('/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = String(data);
          const err = statusToError(res.status, text);
          if ((err.code === 'provider_unreachable' || err.code === 'rate_limited') && delay) {
            lastError = err;
            continue;
          }
          throw err;
        }
        const json = JSON.parse(String(data)) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
        };
        const content = json.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) throw new AiError('refusal', 'Модель вернула пустой ответ');
        return { content, finishReason: json.choices?.[0]?.finish_reason ?? '' };
      } catch (e) {
        lastError = e;
        throw e;
      }
    }
    throw lastError ?? new AiError('unknown', 'Chat failed');
  }

  async tts(opts: TtsRequest): Promise<Buffer> {
    const { res, data } = await this.raw(
      '/audio/speech',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model ?? 'gpt-4o-mini-tts',
          voice: opts.voice,
          input: opts.text,
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        }),
      },
      true
    );
    if (!res.ok) throw statusToError(res.status, String(data).slice(0, 300));
    return Buffer.from(data as Buffer);
  }

  async stt(opts: SttRequest): Promise<string> {
    const boundary = `----VeraBoundary${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];
    const field = (name: string, value: string) =>
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8')
      );
    field('model', opts.model ?? 'gpt-4o-mini-transcribe');
    const ext = opts.mime.includes('webm') ? 'webm' : opts.mime.includes('ogg') ? 'ogg' : opts.mime.includes('m4a') ? 'm4a' : 'mp3';
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="record.${ext}"\r\nContent-Type: ${opts.mime}\r\n\r\n`,
        'utf8'
      )
    );
    parts.push(opts.audio);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const { res, data } = await this.raw(
      '/audio/transcriptions',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts),
      }
    );
    if (!res.ok) throw statusToError(res.status, String(data).slice(0, 300));
    const parsed = JSON.parse(String(data)) as { text?: string };
    const text = (parsed.text ?? '').trim();
    if (!text) throw new AiError('refusal', 'Распознавание вернуло пустой текст');
    return text;
  }

  async models(): Promise<string[]> {
    const { res, data } = await this.raw('/models');
    if (!res.ok) throw statusToError(res.status, String(data).slice(0, 200));
    const parsed = JSON.parse(String(data)) as { data?: { id: string }[] };
    return (parsed.data ?? []).map((m) => m.id);
  }
}

/* ---------- Реестр ---------- */

let current: AiProvider | null = null;
let currentKey = '';
let currentBaseUrl = '';

/* Ключ и адрес можно поменять на ходу (экран настроек), поэтому провайдер
   пересобирается, как только они разошлись с текущим экземпляром. */
export function getProvider(): AiProvider {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  if (!apiKey) {
    throw new AiError('bad_request', 'API-ключ не задан — откройте «Подключение» и вставьте ключ');
  }
  if (!current || currentKey !== apiKey || currentBaseUrl !== baseUrl) {
    current = new OpenAICompatibleProvider(baseUrl, apiKey);
    currentKey = apiKey;
    currentBaseUrl = baseUrl;
  }
  return current;
}

/** Проверка произвольного ключа без сохранения — для экрана настроек. */
export async function probeCredentials(baseUrl: string, apiKey: string, timeoutMs = 15_000): Promise<string[]> {
  return new OpenAICompatibleProvider(baseUrl, apiKey, fetch, timeoutMs).models();
}

/** Для тестов/регресса: подменить реализацию. */
export function setProviderForTesting(p: AiProvider) {
  current = p;
}
