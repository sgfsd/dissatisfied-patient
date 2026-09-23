import fs from 'node:fs';
import path from 'node:path';
import { isStoredSecret, protectSecret, unprotectSecret, type StoredSecret } from './secretStore';

/* Конфигурация приложения. Серверная часть — в браузер не попадает. */

const DEFAULT_BASE_URL = 'https://api.proxyapi.ru/v1';
const SETTINGS_FILE = 'settings.json';

/* Откуда берётся ключ провайдера (по убыванию приоритета):
   1. data/settings.json — ключ, введённый при установке (консоль start.cmd)
      или в кабинете преподавателя. Хранится зашифрованным под учётную
      запись Windows (DPAPI, см. lib/secretStore.ts), открытым текстом — нет;
   2. process.env / .env.local / .env — только для разработки и тестов.
   Переменная окружения сильнее файла — как в dotenv и в самом Next.js:
   так работает «DATA_DIR=data-smoke npx next start» из README.
   Ключ живёт только на этом компьютере: ни в git, ни в архив проекта, ни в
   браузер он не попадает. В интерфейс отдаётся лишь маска ключа. */

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Значение строки .env: кавычки снимаются, комментарий « # …» после значения — отбрасывается. */
function envLineValue(raw: string): string {
  const value = raw.trim();
  const quoted = value.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
  if (quoted) return quoted[2];
  return value.replace(/\s+#.*$/, '').trim();
}

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['.env.local', '.env']) {
    try {
      const raw = stripBom(fs.readFileSync(path.join(process.cwd(), f), 'utf8'));
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
        if (m && !(m[1] in out)) out[m[1]] = envLineValue(m[2]);
      }
    } catch {
      /* файла нет — используем process.env */
    }
  }
  return out;
}

const env: Record<string, string | undefined> = { ...readEnvFile(), ...process.env };

/** Целое из окружения: мусор и пустота дают значение по умолчанию, а не NaN. */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const dataDir = path.resolve(process.cwd(), env.DATA_DIR || 'data');

/* ---------- Подключение к провайдеру: читается лениво ---------- */

export type ProviderSettings = { apiKey: string; baseUrl: string };

/** Формат data/settings.json. apiKey — старый открытый вид, переводится в key при чтении. */
type SettingsFile = { key?: StoredSecret; apiKey?: string; baseUrl?: string };

const settingsPath = () => path.join(dataDir, SETTINGS_FILE);

function readSettingsFile(): SettingsFile {
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(settingsPath(), 'utf8'))) as SettingsFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettingsFile(file: SettingsFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Provider URLs are server-side trust boundaries, not arbitrary user input. */
export function validateProviderUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error('Некорректный адрес провайдера'); }
  if (parsed.protocol !== 'https:') throw new Error('Адрес провайдера должен использовать HTTPS');
  const hostname = parsed.hostname.toLowerCase();
  const allowed = (env.AI_ALLOWED_HOSTS || 'api.proxyapi.ru')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(hostname)) throw new Error('Этот адрес провайдера не разрешён администратором');
  if (parsed.username || parsed.password || parsed.port) throw new Error('Адрес провайдера не должен содержать учётные данные или порт');
  return normalized;
}

type ProviderState = ProviderSettings & {
  source: 'saved' | 'env' | 'none';
  /** Как ключ лежит на диске, если он из data/settings.json. */
  protection: StoredSecret['scheme'] | null;
};

let cache: ProviderState | null = null;

function provider(): ProviderState {
  if (cache) return cache;
  const saved = readSettingsFile();
  let apiKey = '';
  let protection: ProviderState['protection'] = null;
  if (isStoredSecret(saved.key)) {
    try {
      apiKey = unprotectSecret(saved.key).trim();
      protection = saved.key.scheme;
    } catch {
      console.warn(
        '[config] Сохранённый ключ не расшифровывается: он введён под другой учётной записью Windows ' +
          'или на другом компьютере. Введите ключ заново (start.cmd или кабинет преподавателя).',
      );
    }
  } else if (typeof saved.apiKey === 'string' && saved.apiKey.trim()) {
    // Старый формат с открытым ключом — сразу перешифровываем.
    apiKey = saved.apiKey.trim();
    const key = protectSecret(apiKey);
    writeSettingsFile({ key, baseUrl: saved.baseUrl });
    protection = key.scheme;
  }
  const envKey = (env.AI_API_KEY ?? '').trim();
  cache = {
    apiKey: apiKey || envKey,
    baseUrl: validateProviderUrl(saved.baseUrl ?? env.AI_BASE_URL ?? DEFAULT_BASE_URL),
    source: apiKey ? 'saved' : envKey ? 'env' : 'none',
    protection: apiKey ? protection : null,
  };
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
  /* Разделение ролей между моделями:
     — синтез диалога (сценарист и «живой» собеседник) — Qwen3 Next 80B A3B
       Instruct: держит роль, не скатывается в канцелярит, дёшев на объёме;
     — разбор и анализ — MiniMax-01: длинный контекст под полную транскрипцию
       с карточкой кейса и устойчивая работа по рубрике;
     — голос остаётся за OpenAI: TTS и распознавание у остальных отсутствуют. */
  chatModel: env.AI_CHAT_MODEL || 'qwen/qwen3-next-80b-a3b-instruct',
  evalModel: env.AI_EVAL_MODEL || 'minimax/minimax-01',
  ttsModel: env.AI_TTS_MODEL || 'openai/gpt-4o-mini-tts',
  sttModel: env.AI_STT_MODEL || 'openai/gpt-4o-mini-transcribe',
  port: intEnv('PORT', 3000, 1, 65535),
  exchanges: intEnv('DIALOG_EXCHANGES', 3, 1, 4),
  /** Ответов врача в длинной консультации «регистратура → выписка». */
  longExchanges: intEnv('LONG_EXCHANGES', 12, 6, 20),
  /* Лимит платных обращений на нового студента. Одна короткая сцена — это
     примерно 1 генерация + 2 реплики + до 3 распознаваний + 1 разбор ≈ 7 единиц,
     полный приём — около 25. Преподаватель меняет лимит поштучно в кабинете. */
  defaultRequestQuota: intEnv('DEFAULT_REQUEST_QUOTA', 200, 0, 1_000_000),
  /** Потолок одной голосовой записи, секунды. Уходит клиенту в данных сессии. */
  recordMaxSeconds: intEnv('RECORD_MAX_SECONDS', 45, 10, 120),
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

/* ---------- Сохранение ключа, введённого при установке или в кабинете ---------- */

/** Сохранить ключ: на Windows — зашифрованным под текущую учётную запись. */
export function saveProviderSettings(next: ProviderSettings): void {
  const apiKey = next.apiKey.trim();
  const baseUrl = validateProviderUrl(next.baseUrl || DEFAULT_BASE_URL);
  const key = protectSecret(apiKey);
  writeSettingsFile({ key, baseUrl });
  cache = { apiKey, baseUrl, source: 'saved', protection: key.scheme };
}

/** Забыть сохранённый ключ (переменные окружения и .env при этом не трогаются). */
export function clearProviderSettings(): void {
  try {
    fs.rmSync(settingsPath());
  } catch {
    /* файла и так нет */
  }
  cache = null;
}

/** Откуда взят текущий ключ — чтобы честно сказать это в интерфейсе. */
export function providerSettingsSource(): { source: ProviderState['source']; protection: ProviderState['protection'] } {
  const { source, protection } = provider();
  return { source, protection };
}

/** Маска ключа для интерфейса: «sk-…abcd». Полный ключ наружу не отдаётся. */
export function maskKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
