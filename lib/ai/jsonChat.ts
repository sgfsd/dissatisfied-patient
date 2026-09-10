import { config } from '../config';
import { AiError } from './errors';
import { parseLooseJson } from './json';
import { getProvider, type ChatMessage } from './provider';

export interface JsonChatOpts {
  model?: string;
  system: string;
  user: string;
  /** Ремарка в user-сообщении, чтобы модель точно ответила JSON (некоторые модели требуют). */
  json: true;
  temperature?: number;
  maxTokens?: number;
  requestId?: string;
  /** Запасной user-текст для повтора, если первый ответ не распарсился. */
  retryOnInvalid?: boolean;
}

/**
 * Один строгий JSON-вызов модели. Кидает AiError('invalid_json') при битом ответе.
 * Для «оценщика» запрашивается temperature 0; на моделях без поддержки
 * параметра (gpt-5-семейство) провайдер его пропускает — см. provider.chat().
 */
export async function jsonChat<T>(opts: JsonChatOpts): Promise<T> {
  const provider = getProvider();
  const userPayload = opts.json ? `${opts.user}\n\nОтветь строго одним JSON-объектом без markdown и без текста до/после.` : opts.user;
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: userPayload },
  ];

  let lastError: unknown;
  for (let attempt = 0; attempt < (opts.retryOnInvalid ? 2 : 1); attempt++) {
    const result = await provider.chat({
      model: opts.model ?? config.chatModel,
      messages,
      temperature: opts.temperature ?? 0,
      json: true,
      maxTokens: opts.maxTokens ?? 1600,
      requestId: opts.requestId,
    });
    try {
      return parseLooseJson<T>(result.content);
    } catch (e) {
      lastError = e;
      if (opts.retryOnInvalid) {
        messages.push({ role: 'assistant', content: result.content });
        messages.push({
          role: 'user',
          content: 'Твой предыдущий ответ не является валидным JSON по требуемой схеме. Верни исправленный JSON строго по схеме.',
        });
      }
    }
  }
  throw lastError ?? new AiError('invalid_json', 'JSON-вызов не удался');
}
