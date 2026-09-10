/* ============================================================
   Приближённый фонетико-виземный разбор русского текста.
   Назначение — «приблизительная» синхронизация рта с озвучкой
   (по ТЗ достаточна). Виземы распределяются пропорционально
   длительности аудио, а поверх накладывается модуляция реальной
   аудио-энергией (см. AvatarRig), что даёт ощущение «он правда
   говорит», а не «звук рядом с картинкой».
   ============================================================ */

export type VisemeId =
  | 'rest'   // нейтрально, чуть приоткрыт
  | 'closed' // б/п/м — губы сомкнуты
  | 'f'      // в/ф — нижняя губа к зубам
  | 'ee'     // и/ы/е — «улыбка», зубы видны
  | 'a'      // а/я — открытый
  | 'o'      // о/ё — округлый средний
  | 'u'      // у/ю — вытянутые губы
  | 'wide';  // с/з/ш/ж — зубы, губы растянуты

const CHAR_VISEME: Record<string, VisemeId> = {
  а: 'a', я: 'a', о: 'o', ё: 'o',
  у: 'u', ю: 'u', ы: 'ee', и: 'ee', е: 'ee', э: 'a',
  б: 'closed', п: 'closed', м: 'closed',
  в: 'f', ф: 'f',
  с: 'wide', з: 'wide', ц: 'wide', ш: 'wide', ж: 'wide', щ: 'wide', ч: 'wide',
  т: 'rest', д: 'rest', н: 'rest', л: 'rest', р: 'rest',
  к: 'rest', г: 'rest', х: 'rest', й: 'rest',
};

const PAUSE_CHARS = new Set([' ', '\t', '\n', ',', '.', '!', '?', ':', ';', '…', '—', '-', '(', ')', '«', '»', '"']);

export interface SpeechSegment {
  viseme: VisemeId;
  /** Относительное время начала в диапазоне [0, 1). */
  start: number;
  /** Относительная длительность в диапазоне (0, 1]. */
  dur: number;
}

/** Порядок визем и «шкала открытости» рта для анимации. */
export const VISEME_OPENNESS: Record<VisemeId, number> = {
  closed: 0.0,
  f: 0.18,
  rest: 0.28,
  ee: 0.32,
  wide: 0.42,
  u: 0.5,
  o: 0.62,
  a: 0.9,
};

export function isVowel(ch: string): boolean {
  return /[аеёиоуыэюя]/.test(ch.toLowerCase());
}

function charViseme(ch: string): VisemeId | null {
  return CHAR_VISEME[ch.toLowerCase()] ?? null;
}

interface WeightedItem {
  viseme: VisemeId | null; // null = пауза
  w: number;
}

/** Разбить текст на «сырые» элементы с весами (паузы весят меньше гласных). */
function weightItems(text: string): WeightedItem[] {
  const items: WeightedItem[] = [];
  for (const ch of text.toLowerCase()) {
    if (PAUSE_CHARS.has(ch)) {
      items.push({ viseme: null, w: 0.35 });
      continue;
    }
    if (!/[а-яёa-z]/.test(ch)) {
      items.push({ viseme: null, w: 0.2 });
      continue;
    }
    const v = charViseme(ch);
    if (v) {
      const w = isVowel(ch) ? 1.9 : 1.1;
      // слияние соседних одинаковых визем в один сегмент, чтобы рот не «дребезжал»
      const last = items[items.length - 1];
      if (last && last.viseme === v) last.w += w;
      else items.push({ viseme: v, w });
    }
  }
  return items;
}

/** Относительная временная шкала визем (без учёта реальных секунд). */
export function buildSpeechTimeline(text: string): SpeechSegment[] {
  const items = weightItems(text);
  const total = items.reduce((s, it) => s + it.w, 0) || 1;
  const out: SpeechSegment[] = [];
  let acc = 0;
  for (const it of items) {
    if (it.viseme) {
      const start = acc / total;
      const dur = it.w / total;
      out.push({ viseme: it.viseme, start, dur });
    }
    acc += it.w;
  }
  if (!out.length) out.push({ viseme: 'rest', start: 0, dur: 1 });
  return out;
}

export interface TimedWord {
  word: string;
  /** Относительные границы слова в [0,1]. */
  start: number;
  end: number;
}

/** Границы слов для «караоке»-подсветки субтитров. */
export function buildWordTimeline(text: string): TimedWord[] {
  const words: { word: string; start: number; w: number }[] = [];
  const tokens = text.toLowerCase().split(/(\s+)/);
  for (const tk of tokens) {
    if (!tk.trim()) continue;
    const w = tk
      .split('')
      .reduce((s, ch) => {
        if (PAUSE_CHARS.has(ch) && ch !== '-' && ch !== '—') return s + 0.1;
        const v = charViseme(ch);
        if (v) return s + (isVowel(ch) ? 1.9 : 1.1);
        return s + 0.2;
      }, 0);
    words.push({ word: tk.replace(/[.,!?;:…«»"]/g, ''), start: 0, w: Math.max(0.6, w) });
  }
  const total = words.reduce((s, x) => s + x.w, 0) || 1;
  let acc = 0;
  return words.map((x) => {
    const start = acc / total;
    acc += x.w;
    return { word: x.word, start, end: acc / total };
  });
}

/** Относительный момент реплики -> визема. */
export function visemeAt(segments: SpeechSegment[], t01: number): VisemeId {
  if (segments.length === 0) return 'rest';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (t01 < s.start) break;
    if (t01 >= s.start && t01 <= s.start + s.dur) return s.viseme;
    // на случай пропуска: берём ближайший предыдущий
  }
  return segments[segments.length - 1]?.viseme ?? 'rest';
}
