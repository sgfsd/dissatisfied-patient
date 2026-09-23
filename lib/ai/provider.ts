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
  /** Темп речи, 0.25–4.0. Эмоция задаёт его вместе с инструкцией. */
  speed?: number;
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

/* Ответ 200 не гарантирует JSON: прокси и балансировщики при сбое отдают
   HTML-страницу. Такой ответ — сбой провайдера (его можно повторить),
   а не внутренняя ошибка сервиса. */
function parseProviderJson<T>(data: Buffer | string): T {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    throw new AiError('provider_unreachable', `Провайдер вернул не-JSON ответ: ${String(data).slice(0, 120)}`);
  }
}

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

  /**
   * Один обмен с моделью.
   *
   * Провайдер один, а моделей три семейства, и договариваются они по-разному:
   * gpt-5/o-серия не принимают temperature и требуют max_completion_tokens,
   * а часть моделей (в том числе некоторые сборки MiniMax и Qwen) отвечает
   * 400 на response_format. Поэтому режим JSON — «мягкое» требование: если
   * модель его не принимает, повторяем запрос без него и запоминаем это,
   * чтобы не платить штрафным вызовом на каждой реплике. Разбор ответа всё
   * равно устойчив к markdown-обёрткам (см. parseLooseJson).
   */
  private async chatOnce(opts: ChatOptions): Promise<ChatResult> {
    const newGen = /^(gpt-5([.-]|$)|o[1-9](-|$)|chatgpt-)/i.test(opts.model);
    const useJsonMode = opts.json && !OpenAICompatibleProvider.jsonModeUnsupported.has(opts.model);

    const body: Record<string, unknown> = { model: opts.model, messages: opts.messages, stream: false };
    if (!newGen) body.temperature = opts.temperature ?? 0;
    if (opts.maxTokens) body[newGen ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens;
    if (useJsonMode) body.response_format = { type: 'json_object' };

    const { res, data } = await this.raw('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = String(data);
      if (useJsonMode && res.status === 400 && /response_format|json_object|json mode/i.test(text)) {
        OpenAICompatibleProvider.jsonModeUnsupported.add(opts.model);
        return this.chatOnce(opts);
      }
      throw statusToError(res.status, text);
    }

    const json = parseProviderJson<{
      choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
      error?: { message?: string; code?: number | string };
    }>(data);
    // Агрегатор может ответить 200 с ошибкой апстрима в теле — например,
    // MiniMax не знает response_format и сообщает об этом именно так.
    if (json.error) {
      const message = String(json.error.message ?? '');
      if (useJsonMode && /response_format|json_object|json mode/i.test(message)) {
        OpenAICompatibleProvider.jsonModeUnsupported.add(opts.model);
        return this.chatOnce(opts);
      }
      throw statusToError(Number(json.error.code) || 502, message);
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (!content.trim()) {
      // Рассуждающие сборки иногда кладут весь ответ в reasoning_content,
      // оставляя content пустым — это не отказ модели, а формат ответа.
      const fallback = choice?.message?.reasoning_content ?? '';
      if (fallback.trim()) return { content: fallback, finishReason: choice?.finish_reason ?? '' };
      throw new AiError('refusal', 'Модель вернула пустой ответ');
    }
    return { content, finishReason: choice?.finish_reason ?? '' };
  }

  private static jsonModeUnsupported = new Set<string>();

  /**
   * Повтор при сетевых сбоях и перегрузке провайдера. Детерминизм оценки это
   * не ломает: при temperature 0 повтор даёт тот же ответ. Повтор нужен из-за
   * реальной картины на занятии — двадцать студентов бьются в провайдера
   * одновременно и ловят 429, а сцена не должна падать студенту в лицо.
   */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const RETRYABLE = new Set(['rate_limited', 'provider_unreachable', 'timeout']);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(600 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
      try {
        return await this.chatOnce(opts);
      } catch (e) {
        lastError = e;
        if (!(e instanceof AiError) || !RETRYABLE.has(e.code)) throw e;
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
          ...(opts.speed && opts.speed !== 1 ? { speed: Math.min(4, Math.max(0.25, opts.speed)) } : {}),
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
    const parsed = parseProviderJson<{ text?: string }>(data);
    const text = (parsed.text ?? '').trim();
    if (!text) throw new AiError('refusal', 'Распознавание вернуло пустой текст');
    return text;
  }

  async models(): Promise<string[]> {
    const { res, data } = await this.raw('/models');
    if (!res.ok) throw statusToError(res.status, String(data).slice(0, 200));
    const parsed = parseProviderJson<{ data?: { id: string }[] }>(data);
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
    throw new AiError(
      'bad_request',
      'Ключ AI-провайдера не настроен. Преподаватель задаёт его в кабинете: «Подключение AI».',
    );
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

/** Для тестов/регресса: подменить реализацию. Подмена держится, пока не
    сменятся ключ или адрес провайдера. */
export function setProviderForTesting(p: AiProvider) {
  current = p;
  currentKey = config.apiKey;
  currentBaseUrl = config.baseUrl;
}
