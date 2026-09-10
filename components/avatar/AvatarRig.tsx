'use client';
/* ============================================================
   AvatarRig — «живой» пациент с объёмной (2.5D) подачей.
   Это не плоский «paint»: лицо и плечи отрисованы слоями с
   сферическим освещением, бликом, мягкими тенями, многослойными
   волосами и посадочной тенью — портрет читается как 3D-рендер.
   Анимация ведётся напрямую через DOM в requestAnimationFrame
   (без лишних ре-рендеров React).
   - виземы из текста реплики (./visemes) поверх реальной длительности аудио;
   - модуляция аудио-энергией через AnalyserNode (рот «дышит» со звуком);
   - эмоции, моргание, дыхание, микроповороты головы, взгляд.
   ============================================================ */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { PatientEmotion } from '@/lib/types';
import type { Persona } from '@/lib/personas';
import {
  buildSpeechTimeline,
  visemeAt,
  VISEME_OPENNESS,
} from './visemes';
import './avatar.css';

/* ---------- Пресеты эмоций (числовые параметры лица) ---------- */

export interface MouthPreset {
  style: 'neutral' | 'tight' | 'downturn' | 'smirk' | 'quiver' | 'parted' | 'cry' | 'open';
  idleOpen: number; // 0..1 «открытость» рта в покое
}

export interface EmotionFace {
  browShift: number; // подъём бровей целиком, px (вверх +)
  furrow: number;    // +/-: внутр. концы бровей. Плюс = внутрь вниз (гнев),
                     // минус = внутрь вверх (горе/тревога), px
  lid: number;       // 0..1 открытость глаз в покое
  mouth: MouthPreset;
  cheeks: number;    // 0..1 покраснение щёк
  tears: number;     // 0..1 слёзы
}

export const EMOTION_PRESETS: Record<PatientEmotion, EmotionFace> = {
  neutral:    { browShift: 0,  furrow: 0,  lid: 0.96, mouth: { style: 'neutral',  idleOpen: 0.14 }, cheeks: 0.16, tears: 0 },
  irritated:  { browShift: 1,  furrow: 9,  lid: 0.9,  mouth: { style: 'tight',    idleOpen: 0.05 }, cheeks: 0.34, tears: 0 },
  angry:      { browShift: -1, furrow: 14, lid: 0.8,  mouth: { style: 'tight',    idleOpen: 0.05 }, cheeks: 0.44, tears: 0 },
  aggressive: { browShift: -4, furrow: 18, lid: 0.75, mouth: { style: 'open',     idleOpen: 0.2 },  cheeks: 0.5,  tears: 0 },
  upset:      { browShift: 2,  furrow: -14, lid: 0.84, mouth: { style: 'cry',      idleOpen: 0.34 }, cheeks: 0.6,  tears: 0.85 },
  sarcastic:  { browShift: 3,  furrow: 2,  lid: 0.92, mouth: { style: 'smirk',    idleOpen: 0.16 }, cheeks: 0.2,  tears: 0 },
  cold:       { browShift: -3, furrow: 11, lid: 0.84, mouth: { style: 'tight',    idleOpen: 0.02 }, cheeks: 0.1,  tears: 0 },
  anxious:    { browShift: 6,  furrow: -5, lid: 0.93, mouth: { style: 'parted',   idleOpen: 0.2 },  cheeks: 0.22, tears: 0 },
  sad:        { browShift: 0,  furrow: -15, lid: 0.85, mouth: { style: 'downturn', idleOpen: 0.12 }, cheeks: 0.3,  tears: 0.3 },
};

/* ---------- Геометрия ---------- */

type Shape = Persona['art']['shape'];

const EYE_Y = 258;
const MOUTH_Y = 304;
/* Примечание о волосяном покрове вокруг рта: контур бороды/щетины устроен так,
   что его верхняя кромка (арка) огибает губы снизу и НЕ заходит на рот — рот
   остаётся открытым геометрией самого контура. Дополнительный evenodd-вырез
   здесь НЕЛЬЗЯ добавлять: эллипс-дыра, выступающая выше арки, инвертирует
   чётность и, наоборот, заливает полосу над губой волосами. */

function headOutline(shape: Shape): string {
  if (shape === 'oval') {
    return 'M200 96 C 256 96 302 138 302 206 C 302 272 262 352 200 352 C 138 352 98 272 98 206 C 98 138 144 96 200 96 Z';
  }
  if (shape === 'angular') {
    return 'M200 92 C 258 92 304 130 304 196 C 304 244 290 296 256 336 C 232 362 168 362 144 336 C 110 296 96 244 96 196 C 96 130 142 92 200 92 Z';
  }
  // round
  return 'M200 102 C 262 102 308 142 308 214 C 308 282 266 346 200 346 C 134 346 92 282 92 214 C 92 142 138 102 200 102 Z';
}

/* Ухо (левое): полускрыто за краем лица, с внутренней раковиной.
   Правое ухо — тот же путь, зеркалится через transform. */
function earPath(): string {
  return [
    'M 92 206 C 110 200 122 218 125 240',
    'C 127 262 118 282 103 289 C 91 291 82 278 80 266',
    'C 77 245 82 213 92 206 Z',
  ].join(' ');
}
function earInner(): string {
  return 'M 93 218 C 104 216 112 230 110 249 C 109 265 101 277 92 281';
}

/* Бровь — заполненная «ломаная» дуга (не штрих): толще к переносице,
   изгиб аркой. Возвращает замкнутый путь. */
function browD(eyeX: number, innerDy: number, raise: number): string {
  const innerX = eyeX + (eyeX < 200 ? 16 : -16);
  const outerX = eyeX + (eyeX < 200 ? -17 : 17);
  const baseY = 236;
  const iy = baseY + innerDy - raise;
  const oy = baseY - raise;
  // направление от внешнего конца к внутреннему; нормаль вниз
  const dx = innerX - outerX;
  const dy = iy - oy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const midX = (outerX + innerX) / 2;
  const midY = (oy + iy) / 2;
  const arch = 3.4 + Math.abs(innerDy) * 0.06;
  // толщина: у виска тоньше, у переносицы толще
  const tO = 3.2;
  const tI = 5.3;
  const tM = (tO + tI) / 2;
  const f = (n: number) => n.toFixed(1);
  const topCX = midX;
  const topCY = midY - arch;
  const botCX = midX + nx * tM;
  const botCY = midY - arch + ny * tM;
  const oBotX = outerX + nx * tO;
  const oBotY = oy + ny * tO;
  const iBotX = innerX + nx * tI;
  const iBotY = iy + ny * tI;
  return `M ${f(outerX)} ${f(oy)} Q ${f(topCX)} ${f(topCY)} ${f(innerX)} ${f(iy)} L ${f(iBotX)} ${f(iBotY)} Q ${f(botCX)} ${f(botCY)} ${f(oBotX)} ${f(oBotY)} Z`;
}

/* ---- Рот: верхняя и нижняя губа раздельно + тёмная полость, зубы, язык.
   Всё считается от центра (200, mouthY). Возвращает набор d-путей. ---- */
function lipSet(mouthY: number, open: number, style: MouthPreset['style'], time: number) {
  const y0 = mouthY - 1.2;
  let lScale = 1;
  let gapK = 1;
  let arch = 1;
  let cL = 0;   // подъём левого уголка, px (вверх +)
  let cR = 0;   // подъём правого уголка
  switch (style) {
    case 'tight': lScale = 0.8; gapK = 0.45; arch = 0.62; cL = 0.6; cR = 0.6; break;
    case 'downturn': arch = 0.9; cL = -4; cR = -4; break;
    case 'cry': gapK = 0.9; arch = 1.1; cL = -5; cR = -5; break;
    case 'quiver': cL = Math.sin(time * 32) * 1.5; cR = Math.sin(time * 32 + 1.7) * 1.5; break;
    case 'smirk': lScale = 1; gapK = 0.8; cL = 4.8; cR = -0.6; break;
    case 'open': arch = 1.18; break;
    default: break;
  }
  const L = (20 * lScale + open * 2.4) * 1.04;
  const up = (3.4 + open * 0.9) * arch;
  const rawGap = (open - 0.13) * 14.5;
  const gap = Math.min(13.5, Math.max(0, rawGap * gapK));
  const f = (n: number) => n.toFixed(1);
  const yL = y0 + 0.8 - cL;   // левый уголок
  const yR = y0 + 0.8 - cR;   // правый уголок

  // Верхняя губа (красная кайма с луком Купидона)
  const top = [
    `M ${f(-L)} ${f(yL)}`,
    `C ${f(-L * 0.58)} ${f(yL - 1.2)} ${f(-L * 0.3)} ${f(y0 - up - 1.6)} ${f(-L * 0.1)} ${f(y0 - up - 2.2)}`,
    `Q 0 ${f(y0 - up + 1.1)} ${f(L * 0.1)} ${f(y0 - up - 2.2)}`,
    `C ${f(L * 0.3)} ${f(y0 - up - 1.6)} ${f(L * 0.58)} ${f(yR - 1.2)} ${f(L)} ${f(yR)}`,
    `Q 0 ${f(y0 + 3.0 + gap * 0.16)} ${f(-L)} ${f(yL)} Z`,
  ].join(' ');

  // Нижняя губа (свисает при открытом рте)
  const lowTop = y0 + 3.4 + gap * 1.16;
  const bot = [
    `M ${f(L)} ${f(yR)}`,
    `C ${f(L * 0.6)} ${f(y0 + 1.6 - cR * 0.4)} ${f(L * 0.25)} ${f(y0 + 2.8 - cR * 0.2)} 0 ${f(lowTop)}`,
    `C ${f(-L * 0.25)} ${f(y0 + 2.8 - cL * 0.2)} ${f(-L * 0.6)} ${f(y0 + 1.6 - cL * 0.4)} ${f(-L)} ${f(yL)}`,
    `C ${f(-L * 0.5)} ${f(y0 + 4.4 + gap * 0.55 - cL * 0.3)} ${f(-L * 0.16)} ${f(y0 + 7.4 + gap * 1.1 - cL * 0.12)} 0 ${f(y0 + 8.0 + gap * 1.16)}`,
    `C ${f(L * 0.16)} ${f(y0 + 7.4 + gap * 1.1 - cR * 0.12)} ${f(L * 0.5)} ${f(y0 + 4.4 + gap * 0.55 - cR * 0.3)} ${f(L)} ${f(yR)} Z`,
  ].join(' ');

  // Тёмная полость рта: тонкая линия смыкания, когда рот закрыт,
  // и раскрывающаяся щель, когда говорит.
  const tTop = y0 + 2.3;
  const tBot = tTop + (gap > 0.2 ? 1.2 + gap * 1.1 : 0.6);
  const cy = (tTop + tBot) / 2;
  const ry = Math.max(0.55, (tBot - tTop) / 2);
  const rx = Math.max(1.2, L - 1.6);
  const dark = `M ${f(200 - rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 1 0 ${f(200 + rx)} ${f(cy)} A ${f(rx)} ${f(ry)} 0 1 0 ${f(200 - rx)} ${f(cy)} Z`;

  // Зубы (верхний ряд) — показываются при заметном открытии
  const teethW = Math.max(0, L - 4.5);
  const teeth = `M ${f(200 - teethW)} ${f(y0 + 2.8)} Q ${f(200)} ${f(y0 + 3.9)} ${f(200 + teethW)} ${f(y0 + 2.8)} L ${f(200 + teethW)} ${f(y0 + 4.6)} Q ${f(200)} ${f(y0 + 5.9)} ${f(200 - teethW)} ${f(y0 + 4.6)} Z`;

  // Язык — мягкое пятно в нижней части полости
  const tongueY = y0 + 3.6 + gap * 0.72;
  const tongue = `M ${f(200 - rx * 0.66)} ${f(tongueY)} Q ${f(200)} ${f(tongueY + 3.2)} ${f(200 + rx * 0.66)} ${f(tongueY)} Q ${f(200)} ${f(tongueY + 1.6)} ${f(200 - rx * 0.66)} ${f(tongueY)} Z`;

  return { top, bot, dark, teeth, tongue, gap };
}

/* Силуэт волос за головой + передняя прядь. Возвращает пути,
   привязанные к арту персоны. */
function hairPaths(art: Persona['art']) {
  switch (art.hairStyle) {
    case 'long': {
      return {
        behind: `M 98 300 C 84 214 100 108 200 92 C 300 108 316 214 302 300 C 316 344 340 392 356 418 C 342 436 330 440 316 442 C 320 428 314 414 302 400 C 296 388 292 372 288 356 C 282 378 272 400 254 418 C 240 436 226 442 214 444 C 224 424 228 402 228 380 L 228 236 C 214 228 186 228 172 236 L 172 380 C 172 402 176 424 186 444 C 174 442 160 436 146 418 C 128 400 118 378 112 356 C 108 372 104 388 98 400 C 86 414 80 428 84 442 C 70 440 58 436 44 418 C 60 392 84 344 98 300 Z`,
        front: `M 152 90 C 172 70 228 70 248 90 C 262 106 260 138 250 150 C 258 162 256 186 250 206 L 150 206 C 144 186 142 162 150 150 C 140 138 138 106 152 90 Z`,
        // пряди перед плечами (по бокам)
        side: `M 300 300 C 330 320 350 358 346 404 C 344 428 330 442 314 446 C 322 436 324 420 320 406 C 316 372 304 336 294 314 C 291 308 294 302 300 300 Z`,
      };
    }
    case 'bob': {
      return {
        behind: `M 104 250 C 94 158 132 96 200 92 C 268 96 306 158 296 250 C 300 268 300 288 294 304 C 310 320 316 344 312 362 L 292 356 C 294 332 292 312 286 298 C 270 330 246 354 216 364 L 184 364 C 154 354 130 330 114 298 C 108 312 106 332 108 356 L 88 362 C 84 344 90 320 106 304 C 100 288 100 268 104 250 Z`,
        front: `M 118 88 C 140 66 260 66 282 88 C 298 106 300 132 294 152 C 302 160 306 174 306 190 C 304 148 288 118 256 104 C 238 96 162 96 144 104 C 112 118 96 148 94 190 C 94 174 98 160 106 152 C 100 132 102 106 118 88 Z`,
      };
    }
    case 'bun': {
      return {
        behind: `M 102 236 C 96 152 140 96 200 92 C 260 96 304 152 298 236 L 270 234 C 276 170 248 126 200 122 C 152 126 124 170 130 234 Z`,
        front: `M 130 96 C 150 76 250 76 270 96 C 288 112 292 134 286 152 C 294 162 298 180 298 198 C 292 156 268 126 230 114 C 220 111 180 111 170 114 C 132 126 108 156 102 198 C 102 180 106 162 114 152 C 108 134 112 112 130 96 Z`,
        extra: `M 200 84 C 222 84 238 98 240 124 C 241 150 233 166 218 170 C 232 182 228 204 208 208 C 210 192 202 178 186 176 C 170 178 162 192 164 208 C 144 204 140 182 154 170 C 139 166 131 150 132 124 C 134 98 178 84 200 84 Z`,
      };
    }
    case 'curly-short': {
      const bumps: string[] = [];
      for (let i = 0; i < 7; i++) {
        const cx = 108 + i * 30;
        bumps.push(`M ${cx - 30} 122 A 30 30 0 1 0 ${cx + 30} 122 A 30 30 0 1 0 ${cx - 30} 122`);
      }
      bumps.push('M 112 96 A 42 42 0 1 0 288 96 A 42 42 0 1 0 112 96');
      return {
        behind: `M 102 240 C 94 158 138 96 200 92 C 262 96 306 158 298 240 C 292 176 264 132 200 126 C 136 132 108 176 102 240 Z`,
        front: bumps.join(' '),
      };
    }
    case 'balding': {
      return {
        behind: `M 108 224 C 104 184 140 148 200 146 C 260 148 296 184 292 224 L 268 220 C 272 184 244 160 200 158 C 156 160 128 184 132 220 Z`,
        front: `M 102 204 C 100 172 128 146 162 142 C 150 152 148 170 152 190 L 118 214 Z M 298 204 C 300 172 272 146 238 142 C 250 152 252 170 248 190 L 282 214 Z M 148 134 C 168 122 232 122 252 134 C 236 118 164 118 148 134 Z`,
      };
    }
    default: { // short — мужская стрижка с висками
      return {
        behind: `M 102 228 C 96 158 140 92 200 88 C 260 92 304 158 298 228 L 272 222 C 278 158 248 118 200 114 C 152 118 122 158 128 222 Z`,
        front: `M 118 96 C 148 76 252 76 282 96 C 300 112 304 134 298 154 C 306 162 310 176 310 192 C 306 152 288 122 256 108 C 238 100 162 100 144 108 C 112 122 94 152 90 192 C 90 176 94 162 102 154 C 96 134 100 112 118 96 Z`,
      };
    }
  }
}

/* ---------- Компонент ---------- */

export interface AvatarHandle {
  /** Проиграть реплику пациента с синхронной артикуляцией. */
  speak: (url: string, text: string) => Promise<void>;
  /** Остановить текущую озвучку. */
  stop: () => void;
  /** Ручная установка энергии голоса 0..1 (если аудио играет вне рига). */
  setEnergy: (v: number) => void;
  setSpeaking: (v: boolean) => void;
}

export interface AvatarRigProps {
  persona: Persona;
  emotion: PatientEmotion;
  /** Взгляд на собеседника (а не в сторону). */
  attentive?: boolean;
  listening?: boolean;
  thinking?: boolean;
  className?: string;
  /** Прогресс озвучки реплики, 0..1 (для подсветки субтитров). */
  onSpeechProgress?: (t01: number) => void;
}

export const AvatarRig = forwardRef<AvatarHandle, AvatarRigProps>(function AvatarRig(
  { persona, emotion, attentive = true, listening = false, thinking = false, className, onSpeechProgress },
  ref
) {
  const headRef = useRef<SVGGElement>(null);
  const browLRef = useRef<SVGPathElement>(null);
  const browRRef = useRef<SVGPathElement>(null);
  const eyeLRef = useRef<SVGGElement>(null);
  const eyeRRef = useRef<SVGGElement>(null);
  const lidLRef = useRef<SVGGElement>(null);
  const lidRRef = useRef<SVGGElement>(null);
  const lipTopRef = useRef<SVGPathElement>(null);
  const lipBotRef = useRef<SVGPathElement>(null);
  const mouthDarkRef = useRef<SVGPathElement>(null);
  const teethRef = useRef<SVGPathElement>(null);
  const tongueRef = useRef<SVGPathElement>(null);
  const tearLRef = useRef<SVGPathElement>(null);
  const tearRRef = useRef<SVGPathElement>(null);
  const cheekLRef = useRef<SVGEllipseElement>(null);
  const cheekRRef = useRef<SVGEllipseElement>(null);

  const propsRef = useRef({ persona, emotion, attentive, listening, thinking });
  useEffect(() => {
    propsRef.current = { persona, emotion, attentive, listening, thinking };
  });

  const speechRef = useRef({
    timeline: [] as ReturnType<typeof buildSpeechTimeline>,
    speaking: false,
    startedAt: 0,
    duration: 0,
    energy: 0.2,
    energyTarget: 0.2,
    text: '',
  });

  // «смягчённые» (интерполируемые) параметры лица — эмоции перетекают плавно
  const sm = useRef({ browShift: 0, furrow: 0, lid: 0.9, tears: 0, cheeks: 0.3 });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const resolveRef = useRef<(() => void) | null>(null);
  const onProgressRef = useRef(onSpeechProgress);
  useEffect(() => { onProgressRef.current = onSpeechProgress; });

  const art = persona.art;
  const gid = `vpa-${persona.key}`;
  const visual = useMemo(() => ({
    head: headOutline(art.shape),
    hair: hairPaths(art),
  }), [persona.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // начальные статичные пути рта (нейтраль), чтобы SSR/первый кадр были целыми
  const initialLips = useMemo(
    () => lipSet(MOUTH_Y, 0.14, 'neutral', 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /* ---------- Императивный API ---------- */

  useImperativeHandle(ref, () => ({
    speak(url, text) {
      stopSpeaking();
      return new Promise<void>((resolve) => {
        resolveRef.current = resolve;
        const audio = new Audio(url);
        audio.preload = 'auto';
        audioRef.current = audio;
        const sp = speechRef.current;
        sp.text = text;
        sp.timeline = buildSpeechTimeline(text);
        sp.speaking = true;
        sp.startedAt = performance.now();
        sp.duration = 0;
        sp.energy = 0.24;
        sp.energyTarget = 0.24;

        const fallback = () => { sp.duration = Math.max(1.4, text.length * 0.085); sp.energyTarget = 0.4; };
        const finish = () => {
          sp.speaking = false;
          try { source?.disconnect(); } catch { /* noop */ }
          if (audioRef.current === audio) audioRef.current = null;
          const r = resolveRef.current;
          resolveRef.current = null;
          r?.();
        };
        let source: MediaElementAudioSourceNode | null = null;
        try {
          if (typeof window !== 'undefined') {
            const Ctor = window.AudioContext
              ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (Ctor && !ctxRef.current) ctxRef.current = new Ctor();
            const ctx = ctxRef.current;
            if (ctx) {
              source = ctx.createMediaElementSource(audio);
              if (!analyserRef.current) {
                const a = ctx.createAnalyser();
                a.fftSize = 512;
                a.smoothingTimeConstant = 0.7;
                analyserRef.current = a;
              }
              const analyser = analyserRef.current;
              source.connect(analyser);
              analyser.connect(ctx.destination);
              void ctx.resume();
            }
          }
        } catch { /* контекст недоступен — рот живёт по виземам */ }

        audio.addEventListener('ended', finish, { once: true });
        audio.addEventListener('error', finish, { once: true });
        audio.addEventListener('loadedmetadata', () => {
          if (audio.duration && Number.isFinite(audio.duration)) sp.duration = audio.duration;
        });
        void audio.play().catch(() => {
          // автоплей заблок��рован — «говорим» по оценочной длительности и завершаем сами
          fallback();
          window.setTimeout(finish, Math.ceil(sp.duration * 1000) + 250);
        });
      });
    },
    stop() { stopSpeaking(); },
    setEnergy(v) { speechRef.current.energyTarget = Math.max(0, Math.min(1, v)); },
    setSpeaking(v) { speechRef.current.speaking = v; },
  }));

  function stopSpeaking() {
    const sp = speechRef.current;
    sp.speaking = false;
    const a = audioRef.current;
    if (a) {
      try { a.pause(); } catch { /* noop */ }
      a.src = '';
      audioRef.current = null;
    }
    const r = resolveRef.current;
    resolveRef.current = null;
    r?.();
  }

  /* ---------- Главный цикл анимации ---------- */

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let t = 0;
    let blinkTimer = 1600 + Math.random() * 2600;
    let blinkUntil = 0;
    let saccadeTimer = 1000 + Math.random() * 1600;
    let saccadeX = 0;
    let saccadeY = 0;
    const energyBuf = new Uint8Array(512);

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      t += dt;
      const { persona: p, emotion: emo, attentive: att, listening: lis, thinking: thk } = propsRef.current;
      const preset = EMOTION_PRESETS[emo] ?? EMOTION_PRESETS.neutral;
      const sp = speechRef.current;
      const face = sm.current;
      const artP = p.art;

      // сэмпл аудио-энергии
      const analyser = analyserRef.current;
      if (sp.speaking && analyser) {
        analyser.getByteTimeDomainData(energyBuf);
        let sum = 0;
        for (let i = 0; i < energyBuf.length; i++) {
          const v = (energyBuf[i] - 128) / 128;
          sum += v * v;
        }
        sp.energyTarget = Math.max(0.16, Math.sqrt(sum / energyBuf.length));
      }
      sp.energy += (sp.energyTarget - sp.energy) * 0.3;

      // плавный переход эмоций
      const k = 1 - Math.pow(0.0004, dt); // мягкое затухание к цели
      face.browShift += (preset.browShift - face.browShift) * Math.min(1, k * 1.7);
      face.furrow += (preset.furrow - face.furrow) * Math.min(1, k * 2.1);
      face.cheeks += (preset.cheeks - face.cheeks) * Math.min(1, k * 1.5);
      face.tears += (preset.tears - face.tears) * Math.min(1, k * 1.3);
      face.lid += (preset.lid - face.lid) * Math.min(1, k * 2.6);

      /* ---- Моргание ---- */
      blinkTimer -= dt * 1000;
      let lidBase = face.lid * (1 - artP.lidDroop * 0.3);
      if (blinkTimer <= 0) {
        blinkUntil = now + 150;
        blinkTimer = (sp.speaking ? 4200 : 2300) + Math.random() * 3300;
      }
      if (now < blinkUntil) lidBase *= 0.06;
      const openAmt = Math.max(0.03, lidBase);

      /* ---- Голова: дыхание, покачивание, кивок ---- */
      const head = headRef.current;
      if (head) {
        const breath = Math.sin(t * 1.35) * 1.5;
        const sway = Math.sin(t * 0.5) * 1.9;
        const nod = sp.speaking ? Math.sin(t * 6.5) * 1.4 * (0.5 + sp.energy) : Math.sin(t * 0.85) * 0.7;
        const tilt = sway * (att ? 0.45 : 1) + (thk ? 2.6 : 0) + nod + (lis ? Math.sin(t * 1.1) * 0.5 : 0);
        head.setAttribute('transform',
          `translate(${(sway * 0.8).toFixed(2)} ${(breath * 0.45 + (thk ? 3 : 0)).toFixed(2)}) rotate(${tilt.toFixed(2)} 200 240)`);
      }

      /* ---- Брови (заполненные дуги) ---- */
      const tension = sp.speaking ? Math.max(0, sp.energy - 0.55) * 7 : 0;
      if (browLRef.current) browLRef.current.setAttribute('d', browD(170, face.furrow, face.browShift + tension));
      if (browRRef.current) browRRef.current.setAttribute('d', browD(230, face.furrow, face.browShift + tension));

      /* ---- Взгляд (саккады + направление) ---- */
      saccadeTimer -= dt * 1000;
      if (saccadeTimer <= 0) {
        saccadeTimer = 1500 + Math.random() * 2500;
        saccadeX = (Math.random() - 0.5) * 4.6;
        saccadeY = (Math.random() - 0.5) * 3.2;
        if (!att) { saccadeX = 0; saccadeY = 0; }
      }
      const lookX = (att ? (lis ? 0.2 : 0.7) : 2.6) + saccadeX;
      const lookY = (thk ? -2.2 : 0) + saccadeY;

      /* ---- Глаза: открытость + веко-нависание ----
         Масштаб СТРОГО вокруг центра глаза (EYE_Y), иначе при прищуре/моргании
         зрачок уезжает к макушке (scale относительно y=0 холста). */
      if (eyeLRef.current) eyeLRef.current.setAttribute('transform',
        `translate(170 ${EYE_Y}) scale(1 ${openAmt.toFixed(3)}) translate(-170 ${-EYE_Y})`);
      if (eyeRRef.current) eyeRRef.current.setAttribute('transform',
        `translate(230 ${EYE_Y}) scale(1 ${openAmt.toFixed(3)}) translate(-230 ${-EYE_Y})`);
      // верхнее веко опускается, когда глаз прикрыт (моргание / птоз)
      const lidDown = 1 - openAmt;
      if (lidLRef.current) lidLRef.current.setAttribute('transform',
        `translate(170 243) scale(1 ${lidDown.toFixed(3)}) translate(-170 -243)`);
      if (lidRRef.current) lidRRef.current.setAttribute('transform',
        `translate(230 243) scale(1 ${lidDown.toFixed(3)}) translate(-230 -243)`);

      const pupils = document.querySelectorAll<SVGGElement>('[data-vp-pupil]');
      pupils.forEach((g) => {
        g.setAttribute('transform', `translate(${(lookX * 2.3).toFixed(2)} ${(lookY * 2.1).toFixed(2)})`);
      });

      /* ---- Рот (верхняя/нижняя губа, полость, зубы, язык) ---- */
      let open: number;
      let style: MouthPreset['style'];
      let t01 = -1;
      if (sp.speaking && sp.duration > 0) {
        t01 = Math.min(0.999, Math.max(0, (now - sp.startedAt) / 1000 / sp.duration));
        const vis = visemeAt(sp.timeline, t01);
        const vo = VISEME_OPENNESS[vis];
        const loud = 0.6 + sp.energy * 0.85;
        open = Math.min(1, vo * loud);
        if (open < 0.05 && sp.energy > 0.5) open = 0.16;
        if (preset.mouth.style === 'smirk') style = 'smirk';
        else if (emo === 'aggressive' && vo >= 0.3) style = 'open';
        else style = 'neutral';
      } else {
        style = preset.mouth.style;
        open = preset.mouth.idleOpen;
        if (style === 'quiver' || (style === 'cry' && emo === 'upset')) {
          open += Math.sin(t * 11) * 0.05 + 0.03;
        }
        if (style === 'tight' && emo === 'cold') open = 0.02;
      }
      const lips = lipSet(MOUTH_Y, Math.max(0.02, open), style, t);
      if (lipTopRef.current) lipTopRef.current.setAttribute('d', lips.top);
      if (lipBotRef.current) lipBotRef.current.setAttribute('d', lips.bot);
      if (mouthDarkRef.current) mouthDarkRef.current.setAttribute('d', lips.dark);
      if (teethRef.current) {
        teethRef.current.setAttribute('d', lips.teeth);
        teethRef.current.setAttribute('opacity', lips.gap > 2 ? Math.min(1, (lips.gap - 2) / 5).toFixed(2) : '0');
      }
      if (tongueRef.current) {
        tongueRef.current.setAttribute('d', lips.tongue);
        tongueRef.current.setAttribute('opacity', lips.gap > 5.5 ? Math.min(1, (lips.gap - 5.5) / 3).toFixed(2) : '0');
      }
      if (t01 >= 0) onProgressRef.current?.(t01);

      /* ---- Щёки ---- */
      const blush = Math.min(1, face.cheeks + (sp.speaking && sp.energy > 0.55 ? 0.08 : 0));
      const cheekOp = 0.1 + blush * 0.42;
      if (cheekLRef.current) cheekLRef.current.setAttribute('fill-opacity', cheekOp.toFixed(2));
      if (cheekRRef.current) cheekRRef.current.setAttribute('fill-opacity', cheekOp.toFixed(2));

      /* ---- Слёзы ---- */
      if (tearLRef.current) {
        tearLRef.current.setAttribute('opacity', face.tears > 0.03 ? face.tears.toFixed(2) : '0');
        tearLRef.current.setAttribute('transform', `translate(0 ${((t * 22) % 24).toFixed(1)})`);
      }
      if (tearRRef.current) {
        tearRRef.current.setAttribute('opacity', face.tears > 0.03 ? face.tears.toFixed(2) : '0');
        tearRRef.current.setAttribute('transform', `translate(0 ${((t * 18 + 10) % 24).toFixed(1)})`);
      }

      // страховка завершения реплики
      if (sp.speaking && sp.duration > 0 && now - sp.startedAt > sp.duration * 1000 + 300) {
        sp.speaking = false;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const s = persona.art;
  const head = visual.head;
  const hi = s.hairColor;
  const skin = s.skin;
  const shade = s.skinShade;
  const f = (n: number) => n.toFixed(1);

  return (
    <svg key={persona.key} viewBox="0 0 420 520" className={className} role="img" aria-label={`Пациент ${persona.firstName}`}>
      <defs>
        {/* освещение лица: верхний мягкий свет */}
        <radialGradient id={`${gid}-glow`} cx="0.42" cy="0.3" r="0.85">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.26" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        {/* затемнение края «сферы» лица */}
        <radialGradient id={`${gid}-edge`} cx="0.48" cy="0.4" r="0.82">
          <stop offset="0" stopColor={shade} stopOpacity="0" />
          <stop offset="0.7" stopColor={shade} stopOpacity="0" />
          <stop offset="0.86" stopColor={shade} stopOpacity="0.12" />
          <stop offset="1" stopColor={shade} stopOpacity="0.42" />
        </radialGradient>
        {/* объём волос: свет сверху, углубление снизу */}
        <linearGradient id={`${gid}-hairsh`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="0.35" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.72" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.3" />
        </linearGradient>
        {/* одежда: свет и тень по вертикали */}
        <linearGradient id={`${gid}-cloth`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="0.3" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.6" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.2" />
        </linearGradient>
        <filter id={`${gid}-bl1`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
        <filter id={`${gid}-bl2`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        <filter id={`${gid}-bl3`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
        <clipPath id={`${gid}-faceclip`}>
          <path d={head} />
        </clipPath>
      </defs>

      <g ref={headRef}>
        {/* ============ ВОЛОСЫ: задний массив ============ */}
        {visual.hair.behind && (
          <g>
            <path d={visual.hair.behind} fill={hi} />
            <path d={visual.hair.behind} fill={`url(#${gid}-hairsh)`} />
            {/* нижняя кромка волос мягко темнеет у шеи */}
            <path d={visual.hair.behind} fill="none" stroke="#000" strokeOpacity="0.1" strokeWidth="1.5" />
          </g>
        )}

        {/* ============ ТОРС И ОДЕЖДА ============ */}
        <path
          d="M 200 522 C 98 522 90 474 96 444 C 100 416 112 390 130 377 C 142 368 154 361 168 359 C 172 359 175 361 177 366 C 181 376 190 391 200 398 C 210 391 219 376 223 366 C 225 361 228 359 232 359 C 246 361 258 368 270 377 C 288 390 300 416 304 444 C 310 474 302 522 200 522 Z"
          fill={s.garment}
        />
        <path
          d="M 200 522 C 98 522 90 474 96 444 C 100 416 112 390 130 377 C 142 368 154 361 168 359 C 172 359 175 361 177 366 C 181 376 190 391 200 398 C 210 391 219 376 223 366 C 225 361 228 359 232 359 C 246 361 258 368 270 377 C 288 390 300 416 304 444 C 310 474 302 522 200 522 Z"
          fill={`url(#${gid}-cloth)`}
        />
        {/* мягкие складки ткани по бокам */}
        <g stroke="#000" strokeOpacity="0.08" strokeWidth="2" fill="none" strokeLinecap="round">
          <path d="M 132 430 C 128 460 130 488 140 508" />
          <path d="M 268 430 C 272 460 270 488 260 508" />
          <path d="M 150 446 C 148 470 152 494 160 512" opacity="0.6" />
          <path d="M 250 446 C 252 470 248 494 240 512" opacity="0.6" />
        </g>
        {/* ворот: лёгкий V-вырез с бликом по кромке */}
        <path
          d="M 177 366 C 181 376 190 391 200 398 C 210 391 219 376 223 366"
          fill="none" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="2" strokeLinecap="round"
        />

        {/* ============ ШЕЯ (поверх ворота) ============ */}
        <path
          d="M 178 352 C 186 347 214 347 222 352 C 226 360 228 372 226 386 C 222 394 211 399 200 399 C 189 399 178 394 174 386 C 172 372 174 360 178 352 Z"
          fill={skin}
        />
        <g fill={shade}>
          <path d="M 174 386 C 172 372 174 360 178 352 C 181 350 185 349 189 350 C 182 356 178 370 180 388 C 176 390 174 389 174 386 Z" opacity="0.4" />
          <path d="M 226 386 C 228 372 226 360 222 352 C 219 350 215 349 211 350 C 218 356 222 370 220 388 C 224 390 226 389 226 386 Z" opacity="0.5" />
        </g>
        {/* тень от подбородка на шею */}
        <ellipse cx="200" cy="356" rx="30" ry="9" fill={shade} opacity="0.35" filter={`url(#${gid}-bl2)`} />

        {/* ============ ВОЛОСЫ ПО БОКАМ (перед плечами) ============ */}
        {visual.hair.side && (
          <g>
            <path d={visual.hair.side} fill={hi} opacity="0.96" />
            <path d={visual.hair.side} fill={`url(#${gid}-hairsh)`} />
            <path d={visual.hair.side} transform="translate(400 0) scale(-1 1)" fill={hi} opacity="0.96" />
            <path d={visual.hair.side} transform="translate(400 0) scale(-1 1)" fill={`url(#${gid}-hairsh)`} />
          </g>
        )}

        {/* ============ УШИ (за лицом — виден только край) ============ */}
        <g>
          <path d={earPath()} fill={skin} />
          <path d={earPath()} fill={`url(#${gid}-edge)`} />
          <path d={earInner()} fill="none" stroke={shade} strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
        </g>
        <g transform="translate(400 0) scale(-1 1)">
          <path d={earPath()} fill={skin} />
          <path d={earPath()} fill={`url(#${gid}-edge)`} />
          <path d={earInner()} fill="none" stroke={shade} strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
        </g>

        {/* ============ ЛИЦО (сфера) ============ */}
        <path d={head} fill={skin} />
        <path d={head} fill={`url(#${gid}-edge)`} />
        <path d={head} fill={`url(#${gid}-glow)`} />
        {/* мягкий блик на лбу */}
        <ellipse cx="182" cy="150" rx="58" ry="40" fill="#ffffff" opacity="0.1" filter={`url(#${gid}-bl2)`} />
        {/* лёгкая тень под скулами */}
        <path d="M 132 268 C 150 296 176 306 200 306 C 224 306 250 296 268 268 C 250 292 226 302 200 302 C 174 302 150 292 132 268 Z" fill={shade} opacity="0.12" filter={`url(#${gid}-bl1)`} />

        {/* нос: свет слева, тень справа, капля тени снизу */}
        <path d="M 196 250 C 189 262 189 276 195 287" fill="none" stroke="#ffffff" strokeWidth="3.4" strokeLinecap="round" opacity="0.32" />
        <path d="M 204 250 C 211 262 212 278 205 290" fill="none" stroke={shade} strokeWidth="5" strokeLinecap="round" opacity="0.2" />
        <path d="M 200 282 C 208 288 209 296 202 300 C 208 297 210 291 200 282 Z" fill={shade} opacity="0.16" />
        <ellipse cx="200" cy="293" rx="9" ry="3" fill={shade} opacity="0.3" filter={`url(#${gid}-bl1)`} />
        <g stroke={shade} strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.55">
          <path d="M 191 287 C 193 292 197 293 201 291" />
          <path d="M 209 287 C 207 292 203 293 199 291" />
        </g>
        <ellipse cx="196" cy="287" rx="3.4" ry="2.4" fill="#ffffff" opacity="0.4" filter={`url(#${gid}-bl1)`} />

        {/* лёгкая тень под глазами и нижнее веко */}
        <ellipse cx="170" cy="274" rx="15" ry="4.5" fill={shade} opacity="0.14" filter={`url(#${gid}-bl1)`} />
        <ellipse cx="230" cy="274" rx="15" ry="4.5" fill={shade} opacity="0.14" filter={`url(#${gid}-bl1)`} />

        {/* щёки (румянец) */}
        <ellipse ref={cheekLRef} cx="150" cy="288" rx="20" ry="12" fill={s.blush} fillOpacity="0.4" filter={`url(#${gid}-bl1)`} />
        <ellipse ref={cheekRRef} cx="250" cy="288" rx="20" ry="12" fill={s.blush} fillOpacity="0.4" filter={`url(#${gid}-bl1)`} />

        {/* возрастные линии */}
        {s.ageMarks > 0.25 && (
          <g stroke={shade} strokeWidth="1.4" strokeLinecap="round" fill="none" opacity={Math.min(0.55, (s.ageMarks - 0.25) * 0.8)}>
            {/* лёгкие «гусиные лапки» у внешних уголков глаз */}
            <path d="M 150 252 Q 152 260 150 268" />
            <path d="M 250 252 Q 248 260 250 268" />
            <path d="M 178 296 Q 190 303 200 298" opacity="0.8" />
            <path d="M 222 296 Q 210 303 200 298" opacity="0.8" />
            <path d="M 168 152 Q 188 144 208 150" />
            <path d="M 200 150 Q 218 156 232 164" opacity="0.7" />
            <path d="M 146 212 Q 152 207 162 205" opacity="0.7" />
            <path d="M 254 212 Q 248 207 238 205" opacity="0.7" />
          </g>
        )}

        {/* глаза (в клипе лица) */}
        <g clipPath={`url(#${gid}-faceclip)`}>
          {[170, 230].map((cx) => (
            <g key={cx} ref={cx === 170 ? eyeLRef : eyeRRef}>
              <ellipse cx={cx} cy={EYE_Y} rx="16" ry="12.4" fill="#fffdf6" />
              {/* верхняя внутренняя тень глазного яблока */}
              <ellipse cx={cx} cy={EYE_Y - 1.6} rx="14.4" ry="6.6" fill="#c9bfae" opacity="0.2" />
              <g data-vp-pupil>
                {/* радужка с тёмным лимбом и мягким бликом сверху */}
                <circle cx={cx} cy={EYE_Y + 0.6} r="7.1" fill={s.eyeColor} />
                <circle cx={cx} cy={EYE_Y + 0.6} r="7.1" fill="none" stroke="#000" strokeOpacity="0.18" strokeWidth="1.2" />
                <circle cx={cx} cy={EYE_Y - 0.6} r="7" fill="#ffffff" opacity="0.12" />
                <circle cx={cx} cy={EYE_Y + 0.6} r="3.2" fill="#16110d" />
                <circle cx={cx + 2.2} cy={EYE_Y - 1.4} r="1.7" fill="#ffffff" />
                <circle cx={cx - 1.8} cy={EYE_Y + 2.2} r="0.85" fill="#ffffff" opacity="0.55" />
              </g>
            </g>
          ))}
          {/* нижнее веко */}
          <path d="M 157 271 Q 170 275.5 183 271" fill="none" stroke={shade} strokeWidth="1.3" strokeLinecap="round" opacity="0.42" />
          <path d="M 217 271 Q 230 275.5 243 271" fill="none" stroke={shade} strokeWidth="1.3" strokeLinecap="round" opacity="0.42" />
        </g>

        {/* нависающее верхнее веко (опускается при моргании и птозе) */}
        <g>
          <g ref={lidLRef}>
            <path
              d="M 151 243 Q 170 240.5 189 243 L 189 254 C 189 262 178 269 170 270 C 162 269 151 262 151 254 Z"
              fill={skin}
            />
            <path d="M 153 256 C 158 263 165 267 170 267 C 175 267 182 263 187 256" fill="none" stroke={shade} strokeWidth="1.4" strokeLinecap="round" opacity="0.35" />
          </g>
          <g ref={lidRRef}>
            <path
              d="M 211 243 Q 230 240.5 249 243 L 249 254 C 249 262 238 269 230 270 C 222 269 211 262 211 254 Z"
              fill={skin}
            />
            <path d="M 213 256 C 218 263 225 267 230 267 C 235 267 242 263 247 256" fill="none" stroke={shade} strokeWidth="1.4" strokeLinecap="round" opacity="0.35" />
          </g>
        </g>

        {/* складка века над глазом */}
        <path d="M 156 240 Q 170 234 184 240" fill="none" stroke={shade} strokeWidth="1.6" strokeLinecap="round" opacity="0.3" />
        <path d="M 216 240 Q 230 234 244 240" fill="none" stroke={shade} strokeWidth="1.6" strokeLinecap="round" opacity="0.3" />

        {/* очки */}
        {s.glasses && (
          <g fill="none" stroke="#3b352c" strokeWidth="2.4" opacity="0.88" strokeLinecap="round">
            <ellipse cx="170" cy="260" rx="21.5" ry="18.5" />
            <ellipse cx="230" cy="260" rx="21.5" ry="18.5" />
            {/* лёгкий блик на стёклах */}
            <path d="M 153 250 Q 158 243 168 242" stroke="#ffffff" strokeWidth="2" strokeOpacity="0.5" />
            <path d="M 213 250 Q 218 243 228 242" stroke="#ffffff" strokeWidth="2" strokeOpacity="0.5" />
            <path d="M 191.5 253 Q 200 246.5 208.5 253" strokeWidth="1.5" />
            <path d="M 148.5 257 L 128 248" />
            <path d="M 251.5 257 L 272 248" />
          </g>
        )}

        {/* брови */}
        <path ref={browLRef} d={browD(170, 0, 0)} fill={s.browColor} />
        <path ref={browRRef} d={browD(230, 0, 0)} fill={s.browColor} />

        {/* рот: нижняя губа → полость → язык → зубы → верхняя губа */}
        <path ref={lipBotRef} d={initialLips.bot} fill={s.lips} />
        <path ref={mouthDarkRef} d={initialLips.dark} fill="#4c1a15" />
        <path ref={tongueRef} d={initialLips.tongue} fill="#a84537" opacity="0" />
        <path ref={teethRef} d={initialLips.teeth} fill="#fff9ec" opacity="0" />
        <path ref={lipTopRef} d={initialLips.top} fill={s.lips} />
        {/* мягкий блик нижней губы */}
        <ellipse cx="200" cy={MOUTH_Y + 3.4} rx="9" ry="2.4" fill="#ffffff" opacity="0.18" filter={`url(#${gid}-bl1)`} />
        {/* тень под нижней губой (ментальная складка) */}
        <ellipse cx="200" cy={MOUTH_Y + 9.5} rx="12" ry="3.2" fill={shade} opacity="0.16" filter={`url(#${gid}-bl1)`} />

        {/* усы / борода / щетина */}
        {s.facialHair === 'stubble' && (
          <path
            d="M 158 296 Q 200 320 242 296 Q 232 342 200 350 Q 168 342 158 296 Z"
            fill={s.hairColor} opacity="0.16" filter={`url(#${gid}-bl1)`}
          />
        )}
        {s.facialHair === 'beard' && (
          <g>
            <path
              d="M 152 292 C 150 320 166 342 186 354 C 190 356 210 356 214 354 C 234 342 250 320 248 292 C 240 316 220 330 200 330 C 180 330 160 316 152 292 Z"
              fill={s.hairColor} opacity="0.92"
            />
            <path
              d="M 152 292 C 150 320 166 342 186 354 C 190 356 210 356 214 354 C 234 342 250 320 248 292 C 240 316 220 330 200 330 C 180 330 160 316 152 292 Z"
              fill={`url(#${gid}-hairsh)`} opacity="0.5"
            />
          </g>
        )}
        {s.facialHair === 'mustache' && (
          <g>
            <path d="M 170 300 Q 200 314 230 300 Q 218 322 200 318 Q 182 322 170 300 Z" fill={s.hairColor} opacity="0.94" />
            <path d="M 182 306 Q 200 313 218 306" fill="none" stroke={s.skinShade} strokeWidth="1.4" strokeLinecap="round" opacity="0.3" />
          </g>
        )}

        {/* слёзы */}
        <g>
          <path ref={tearLRef} opacity="0" d="M 160 288 C 154 299 158 306 162 304 C 165 302 163 295 160 288 Z" fill="#9cc9dd" />
          <path ref={tearRRef} opacity="0" d="M 240 288 C 234 299 238 306 242 304 C 245 302 243 295 240 288 Z" fill="#9cc9dd" />
        </g>

        {/* ============ ВОЛОСЫ: передняя прядь ============ */}
        {visual.hair.front && (
          <g>
            {/* тень от чёлки на лоб */}
            <path d={visual.hair.front} transform="translate(0 5)" fill={shade} opacity="0.35" filter={`url(#${gid}-bl1)`} />
            <path d={visual.hair.front} fill={hi} />
            <path d={visual.hair.front} fill={`url(#${gid}-hairsh)`} />
          </g>
        )}
        {visual.hair.extra && (
          <g>
            <path d={visual.hair.extra} fill={hi} />
            <path d={visual.hair.extra} fill={`url(#${gid}-hairsh)`} />
          </g>
        )}
      </g>
    </svg>
  );
});
