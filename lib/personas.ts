/* ============================================================
   Персонажи-пациенты. Один источник правды: и для арт-рига (SVG),
   и для выбора TTS-голоса, и как контекст генератора сцены.
   Ключ персонажа выбирается сервером под демографическую ось сценария;
   модель не «выдумывает» внешность — арт всегда консистентен.
   ============================================================ */

export type FaceShape = 'round' | 'oval' | 'angular';
export type HairStyle = 'bob' | 'bun' | 'short' | 'long' | 'balding' | 'curly-short';
export type FacialHairStyle = 'none' | 'stubble' | 'beard' | 'mustache';

export interface PersonaArt {
  shape: FaceShape;
  skin: string;         // базовый тон
  skinShade: string;    // тень
  hairStyle: HairStyle;
  hairColor: string;
  browColor: string;
  eyeColor: string;
  lidDroop: number;     // 0..1 нависание века (возраст)
  glasses: boolean;
  facialHair: FacialHairStyle;
  ageMarks: number;     // 0..1 морщины/возрастные линии
  blush: string;
  lips: string;
  garment: string;      // цвет одежды
}

export interface Persona {
  key: string;
  firstName: string;
  age: number;
  gender: 'f' | 'm';
  voice: string;                // голос TTS-провайдера
  voiceBase: string;            // постоянная часть инструкции тембра
  // психологический портрет для генератора/актёра
  temper: string;
  speechStyle: string;
  art: PersonaArt;
}

export const PERSONAS: Persona[] = [
  {
    key: 'anna58', firstName: 'Анна', age: 58, gender: 'f',
    voice: 'sage', voiceBase: 'женщина около 60 лет, низковатый тёплый тембр, спокойная речь с нотками усталости',
    temper: 'обидчивая, долго копит недовольство, дорожит порядком и уважением',
    speechStyle: 'говорит развёрнуто, с бытовыми деталями, иногда повторяется',
    art: {
      shape: 'round', skin: '#e4b398', skinShade: '#c98f74', hairStyle: 'bun', hairColor: '#a9a29b',
      browColor: '#8b8078', eyeColor: '#5c534a', lidDroop: 0.6, glasses: true, facialHair: 'none',
      ageMarks: 0.7, blush: '#d9a08f', lips: '#b06a5d', garment: '#4e7d6a',
    },
  },
  {
    key: 'mikhail67', firstName: 'Михаил', age: 67, gender: 'm',
    voice: 'onyx', voiceBase: 'мужчина за 60, низкий голос с хрипотцой, размеренная уверенная речь',
    temper: 'привык к порядку, требовательный, не терпит, когда им пренебрегают; за жёсткостью — страх потерять контроль',
    speechStyle: 'короткие рубленые фразы, редко повышает голос, давит весом слов',
    art: {
      shape: 'angular', skin: '#d9a98c', skinShade: '#bc8063', hairStyle: 'short', hairColor: '#c9c2ba',
      browColor: '#9a8f86', eyeColor: '#4a423b', lidDroop: 0.55, glasses: true, facialHair: 'none',
      ageMarks: 0.85, blush: '#c98f7a', lips: '#a36555', garment: '#4a5f6d',
    },
  },
  {
    key: 'sergey41', firstName: 'Сергей', age: 41, gender: 'm',
    voice: 'echo', voiceBase: 'мужчина средних лет, ровный средний тембр, напористая склонность ускорять темп при возбуждении',
    temper: 'вспыльчивый, ощущает несправедливость, склонен переходить на личности, но отходчив при уважительном тоне',
    speechStyle: 'средне-многословный, любит риторические вопросы и сравнения',
    art: {
      shape: 'oval', skin: '#e2b394', skinShade: '#c28c6b', hairStyle: 'short', hairColor: '#3a312c',
      browColor: '#2e2824', eyeColor: '#4d3624', lidDroop: 0.25, glasses: false, facialHair: 'stubble',
      ageMarks: 0.35, blush: '#cf8f70', lips: '#a35f4d', garment: '#5f6f5a',
    },
  },
  {
    key: 'oksana34', firstName: 'Оксана', age: 34, gender: 'f',
    voice: 'nova', voiceBase: 'женщина 30–35 лет, звонкий женский тембр, эмоциональная, речь может срываться',
    temper: 'тревожная, на грани срыва, за претензией — страх за себя или близкого',
    speechStyle: 'многословная, сбивчивая, тараторит, когда тревожится',
    art: {
      shape: 'oval', skin: '#efc6a6', skinShade: '#d39b78', hairStyle: 'long', hairColor: '#6b4a32',
      browColor: '#5a3d2a', eyeColor: '#3f5a4a', lidDroop: 0.2, glasses: false, facialHair: 'none',
      ageMarks: 0.15, blush: '#e0a58a', lips: '#b0675a', garment: '#8a6a8f',
    },
  },
  {
    key: 'dina26', firstName: 'Дина', age: 26, gender: 'f',
    voice: 'shimmer', voiceBase: 'молодая женщина, светлый тембр, быстрая речь, склонна к сарказму',
    temper: 'умная, язвительная, проверяет границы, подкалывает, за этим — желание, чтобы её воспринимали всерьёз',
    speechStyle: 'немногословная, точные формулировки, ирония и полунамёки',
    art: {
      shape: 'oval', skin: '#f2d3b8', skinShade: '#d9ab8c', hairStyle: 'bob', hairColor: '#8c7457',
      browColor: '#6e5840', eyeColor: '#3d5c4a', lidDroop: 0.15, glasses: false, facialHair: 'none',
      ageMarks: 0.05, blush: '#e3b096', lips: '#b76a55', garment: '#4f6d8a',
    },
  },
  {
    key: 'timur45', firstName: 'Тимур', age: 45, gender: 'm',
    voice: 'alloy', voiceBase: 'мужчина 40–45 лет, бархатистый средний тембр, неторопливая речь',
    temper: 'сдержанный, немногословный, копит напряжение внутри; внешне холоден, внутри — обида и тревога',
    speechStyle: 'очень немногословный, паузы, сухие формулировки, не идёт на контакт первым',
    art: {
      shape: 'angular', skin: '#c98d6a', skinShade: '#a56a49', hairStyle: 'short', hairColor: '#1f1b18',
      browColor: '#1a1714', eyeColor: '#2f2a25', lidDroop: 0.3, glasses: false, facialHair: 'beard',
      ageMarks: 0.4, blush: '#b5705a', lips: '#8f4f42', garment: '#4a4a52',
    },
  },
  {
    key: 'galina73', firstName: 'Галина', age: 73, gender: 'f',
    voice: 'coral', voiceBase: 'пожилая женщина, мягкий голос, медленная речь, иногда не слышит с первого раза',
    temper: 'растерянная, тревожная, боится оказаться обузой, плачет от бессилия',
    speechStyle: 'сбивчивая, ласковая, обращается с надеждой, легко пугается резкого тона',
    art: {
      shape: 'round', skin: '#eecfb4', skinShade: '#d3a888', hairStyle: 'curly-short', hairColor: '#e2dbd2',
      browColor: '#b9aca0', eyeColor: '#6a6157', lidDroop: 0.7, glasses: true, facialHair: 'none',
      ageMarks: 0.9, blush: '#d8a18c', lips: '#b0766a', garment: '#8a6d9e',
    },
  },
  {
    key: 'nikita30', firstName: 'Никита', age: 30, gender: 'm',
    voice: 'fable', voiceBase: 'молодой мужчина, звонкий тембр, быстрая взволнованная речь',
    temper: 'импульсивный, обижается на «канцелярский» тон, хочет простых человеческих объяснений',
    speechStyle: 'многословный, эмоциональные восклицания, жаргон, легко перебивает',
    art: {
      shape: 'round', skin: '#e6bd9e', skinShade: '#c6906d', hairStyle: 'curly-short', hairColor: '#4a3a28',
      browColor: '#3d3022', eyeColor: '#4d3526', lidDroop: 0.1, glasses: false, facialHair: 'none',
      ageMarks: 0.1, blush: '#d69a7c', lips: '#a85f4c', garment: '#3f6b6b',
    },
  },
];

export const PERSONA_BY_KEY: Record<string, Persona> = Object.fromEntries(PERSONAS.map((p) => [p.key, p]));
export const PERSONA_KEYS = PERSONAS.map((p) => p.key);

/** Диапазоны демографии — сервер мапит ось «возраст» на конкретную персону. */
export type DemographyBand = 'young' | 'middle' | 'senior';
export const DEMOGRAPHY: Record<DemographyBand, { age: [number, number]; keys: string[] }> = {
  young: { age: [25, 38], keys: ['dina26', 'oksana34', 'nikita30', 'sergey41'] },
  middle: { age: [39, 55], keys: ['sergey41', 'timur45', 'anna58', 'oksana34'] },
  senior: { age: [60, 78], keys: ['galina73', 'mikhail67', 'anna58', 'timur45'] },
};

export function personaById(key: string): Persona {
  const p = PERSONA_BY_KEY[key];
  if (!p) throw new Error(`Неизвестная персона: ${key}`);
  return p;
}
