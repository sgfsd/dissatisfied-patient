import { AiError } from './errors';

/** Вытащить JSON из текста модели: переживает markdown-ограждения и случайный текст вокруг. */
export function parseLooseJson<T = unknown>(content: string): T {
  let text = content.trim();
  // Снять ```json ... ``` и ``` ... ```
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1)) as T;
      } catch {
        /* падаем в ошибку ниже */
      }
    }
    throw new AiError('invalid_json', `Модель вернула не-JSON ответ: ${content.slice(0, 300)}`);
  }
}

/**
 * Валидация минимальной формы ответа. Возвращает понятное описание ошибки
 * для повторного запроса или логирования.
 */
export function describeShapeError(value: unknown, path: string, expected: string): string | null {
  return `${path}: ожидалось ${expected}, получено ${value === null ? 'null' : typeof value}`;
}

export function asString(v: unknown, path: string, allowEmpty = false): string {
  if (typeof v !== 'string') throw new AiError('invalid_json', describeShapeError(v, path, 'строка') ?? '');
  if (!allowEmpty && !v.trim()) throw new AiError('invalid_json', `${path}: пустая строка`);
  return v.trim();
}

export function asNumber(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || Number.isNaN(v) || v < min || v > max)
    throw new AiError('invalid_json', `${path}: ожидалось число от ${min} до ${max}, получено ${JSON.stringify(v)}`);
  return v;
}

export function asStringArray(v: unknown, path: string, allowEmpty = true): string[] {
  if (!Array.isArray(v)) throw new AiError('invalid_json', describeShapeError(v, path, 'массив строк') ?? '');
  const out = v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter((s) => allowEmpty || s.length > 0);
  return out;
}

export function asEnum<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw new AiError('invalid_json', `${path}: ожидалось одно из ${allowed.join(' | ')}, получено ${JSON.stringify(v)}`);
  return v as T;
}
