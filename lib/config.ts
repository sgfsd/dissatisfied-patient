import fs from 'node:fs';
import path from 'node:path';

/* Конфигурация приложения. Серверная часть — в браузер не попадает. */

const DEFAULT_BASE_URL = 'https://api.proxyapi.ru/openai/v1';
const SETTINGS_FILE = 'settings.json';

/* Откуда берётся подключение к провайдеру (по убыванию приоритета):
   1. data/settings.json — то, что пользователь ввёл в интерфейсе (экран настройки);
   2. .env.local / .env  — для тех, кто предпочитает править файлы руками;
   3. process.env        — переменные окружения процесса.
   Все три источника живут только на сервере: ни ключ, ни адрес провайдера
   никогда не уходят в браузер. В интерфейс отдаётся лишь маска ключа. */

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = stripBom(fs.readFileSync(path.join(process.cwd(), f), 'utf8'));
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
    } catch {
      /* файла нет — используем process.env */
    }
  }
  return out;
}

const env = { ...process.env, ...readEnvFile() };

const dataDir = path.resolve(process.cwd(), env.DATA_DIR || 'data');

/* ---------- Подключение к провайдеру: читается лениво ---------- */

export type ProviderSettings = { apiKey: string; baseUrl: string };

const settingsPath = () => path.join(dataDir, SETTINGS_FILE);

function readSettingsFile(): Partial<ProviderSettings> {
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(settingsPath(), 'utf8'))) as Partial<ProviderSettings>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

let cache: ProviderSettings | null = null;

function provider(): ProviderSettings {
  if (!cache) {
    const saved = readSettingsFile();
    cache = {
      apiKey: (saved.apiKey ?? env.AI_API_KEY ?? '').trim(),
      baseUrl: normalizeBaseUrl(saved.baseUrl ?? env.AI_BASE_URL ?? DEFAULT_BASE_URL) || DEFAULT_BASE_URL,
    };
  }
  return cache;
}

/** Ключ и адрес читаются на каждом обращении — их можно поменять на ходу из UI. */
export const config = {
  get baseUrl() {
    return provider().baseUrl;
  },
  get apiKey() {
    return provider().apiKey;
  },
  chatModel: env.AI_CHAT_MODEL || 'gpt-4o-mini',
  evalModel: env.AI_EVAL_MODEL || 'gpt-4o-mini',
  ttsModel: env.AI_TTS_MODEL || 'gpt-4o-mini-tts',
  sttModel: env.AI_STT_MODEL || 'gpt-4o-mini-transcribe',
  port: Number(env.PORT || 3000),
  exchanges: Math.min(4, Math.max(1, Number(env.DIALOG_EXCHANGES || 3))),
  recordMaxSeconds: Number(env.RECORD_MAX_SECONDS || 60),
  dataDir,
  ttsCacheDir: path.join(dataDir, 'tts'),
  uploadsDir: path.join(dataDir, 'uploads'),
};

/** Гарантирует наличие ключа и доступность папок данных. */
export function ensureReady() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.ttsCacheDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
}

export function providerConfigured(): boolean {
  return Boolean(config.apiKey) && Boolean(config.baseUrl);
}

/* ---------- Сохранение настроек, введённых в интерфейсе ---------- */

export function saveProviderSettings(next: ProviderSettings): void {
  const payload: ProviderSettings = {
    apiKey: next.apiKey.trim(),
    baseUrl: normalizeBaseUrl(next.baseUrl) || DEFAULT_BASE_URL,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  cache = payload;
}

/** Забыть ключ, введённый через интерфейс (файлы .env при этом не трогаются). */
export function clearProviderSettings(): void {
  try {
    fs.rmSync(settingsPath());
  } catch {
    /* файла и так нет */
  }
  cache = null;
}

/** Откуда взято текущее подключение — чтобы честно сказать это в интерфейсе. */
export function providerSettingsSource(): 'ui' | 'env' | 'none' {
  if (readSettingsFile().apiKey) return 'ui';
  if ((env.AI_API_KEY || '').trim()) return 'env';
  return 'none';
}

/** Маска ключа для интерфейса: «sk-…fz0r». Полный ключ наружу не отдаётся. */
export function maskKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
