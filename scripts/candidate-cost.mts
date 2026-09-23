#!/usr/bin/env tsx
/* ============================================================
   Цена одной студенческой сессии по каждой модели.

   Считаем не «среднюю цену за миллион», а фактические деньги: берём
   замеренный расход токенов (candidate-screen --meter) и умножаем на
   прайс провайдера. Это принципиально: рассуждающая модель с дешёвым
   прайсом тратит сотни токенов выхода на внутренние размышления перед
   каждой репликой и в итоге стоит дороже «дорогой» модели без reasoning.

   Состав короткой сцены взят из lib/config.ts: 1 генерация сценария +
   3 реплики пациента + 1 разбор. Распознавание речи и синтез считаются
   отдельными моделями и в расчёт не входят.
   ============================================================ */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const value = (name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const usagePath = value('--usage') ?? 'usage.json';

/** Прайс proxyapi, ₽ за миллион токенов: [вход, выход]. */
const PRICE: Record<string, [number, number]> = {
  'qwen/qwen3-coder-flash': [26.32, 136.84],
  'mistralai/codestral-2508': [41.05, 126.32],
  'z-ai/glm-4.6v': [41.05, 126.32],
  'microsoft/wizardlm-2-8x22b': [84.21, 84.21],
  'deepseek/deepseek-chat-v3': [43.16, 126.32],
  'deepseek/deepseek-chat-v3-0324': [33.68, 136.84],
  'qwen/qwen3-next-80b-a3b-instruct': [13.68, 157.89],
  'deepseek/deepseek-v3.1-terminus': [36.84, 136.84],
  'google/gemma-2-27b-it': [87.37, 87.37],
  'qwen/qwen3-coder-480b-a35b-07-25': [41.05, 136.84],
  'minimax/minimax-m2': [34.74, 147.37],
  'minimax/minimax-m2.5': [36.84, 147.37],
  'stepfun/step-3.7-flash': [27.37, 157.89],
  'minimax/minimax-01': [27.37, 157.89],
  'xiaomi/mimo-v2.5-pro': [58.95, 126.32],
  'qwen/qwen3.7-plus': [37.5, 150.0],
  'sao10k/l3.3-euryale-70b': [87.37, 101.05],
  'nousresearch/hermes-3-llama-3.1-70b': [94.74, 94.74],
  'qwen/qwen3-next-80b-a3b-thinking': [21.05, 168.42],
  'thedrummer/skyfall-36b-v2': [74.74, 115.79],
  'openai/gpt-audio-mini': [39.0, 155.0],
  'openai/gpt-4o-mini': [39.0, 155.0],
  'meta/muse-glimmer-30b': [41.05, 157.89],
  'deepseek/deepseek-v4.1-flash': [41.05, 168.42],
  'meituan/longcat-2.0': [41.05, 168.42],
  'minimax/minimax-m3': [41.05, 168.42],
  'kwaipilot/kat-coder-pro-v2': [41.05, 168.42],
  'minimax/minimax-m2.7': [41.05, 168.42],
  'minimax/minimax-m2-her': [41.05, 168.42],
  'minimax/minimax-m2.1': [41.05, 168.42],
  'qwen/qwen3.5-35b-a3b': [42.11, 168.42],
  'baidu/ernie-4.5-vl-424b-a47b': [56.84, 168.42],
  'qwen/qwen-2.5-coder-32b-instruct': [89.47, 136.84],
  'thinkingmachines/inkling-small': [61.05, 168.42],
  'deepseek/deepseek-r1-distill-llama-70b': [115.79, 115.79],
  'sao10k/l3.1-euryale-70b': [115.79, 115.79],
  'qwen/qwen3.5-27b': [26.32, 210.53],
  'deepseek/deepseek-v4-flash-0731': [60.0, 180.0],
  'qwen/qwen3.5-plus-02-15': [35.79, 210.53],
  'qwen/qwen2.5-vl-72b-instruct': [115.79, 136.84],
  'qwen/qwen3.6-plus': [37.5, 225.0],
  'perplexity/sonar': [136.84, 136.84],
  'nousresearch/hermes-3-llama-3.1-405b': [136.84, 136.84],
  'mistralai/mistral-large': [67.37, 210.53],
  'qwen/qwen3.5-plus-20260420': [41.05, 242.11],
  'aion-labs/aion-3.0-mini': [94.74, 189.47],
  'relace/relace-apply-3': [115.79, 168.42],
  'morph/morph-v3-fast': [115.79, 168.42],
  'qwen/qwen3-vl-235b-a22b-instruct': [28.42, 263.16],
  'z-ai/glm-4.7': [53.68, 242.11],
};

/** Сколько вызовов каждой роли в одной короткой сцене (см. lib/config.ts). */
const CALLS_PER_SESSION: Record<string, number> = { scenario: 1, actor: 3, eval: 1 };

interface UsageRow { model: string; role: string; calls: number; promptPerCall: number; completionPerCall: number; reasoningPerCall: number }

const usage = JSON.parse(readFileSync(usagePath, 'utf8')) as UsageRow[];
const byModel = new Map<string, UsageRow[]>();
for (const row of usage) {
  if (!byModel.has(row.model)) byModel.set(row.model, []);
  byModel.get(row.model)!.push(row);
}

const rub = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;

const table: Array<{
  model: string;
  session: number;
  perRole: Record<string, number>;
  reasoningShare: number;
  roles: string[];
}> = [];

for (const [model, rows] of byModel) {
  const price = PRICE[model];
  if (!price) continue;
  let session = 0;
  const perRole: Record<string, number> = {};
  let completion = 0;
  let reasoning = 0;
  for (const r of rows) {
    const n = CALLS_PER_SESSION[r.role];
    if (!n) continue;
    const cost = rub(r.promptPerCall, price[0]) + rub(r.completionPerCall, price[1]);
    perRole[r.role] = cost;
    session += cost * n;
    completion += r.completionPerCall;
    reasoning += r.reasoningPerCall;
  }
  table.push({
    model,
    session,
    perRole,
    reasoningShare: completion > 0 ? reasoning / completion : 0,
    roles: rows.map((r) => r.role),
  });
}

table.sort((a, b) => a.session - b.session);

console.log('\n══ ЦЕНА ОДНОЙ КОРОТКОЙ СЦЕНЫ (1 сценарий + 3 реплики + 1 разбор), ₽ ══');
console.log('  ₽/сцена   ₽/100 сцен   сценарий   реплика    разбор   reasoning   модель');
for (const row of table) {
  const f = (x?: number) => (x === undefined ? '     —' : x.toFixed(4).padStart(9));
  console.log(
    `${row.session.toFixed(4).padStart(9)}  ${(row.session * 100).toFixed(2).padStart(11)}  ` +
      `${f(row.perRole.scenario)} ${f(row.perRole.actor)} ${f(row.perRole.eval)}  ` +
      `${(row.reasoningShare * 100).toFixed(0).padStart(8)}%   ${row.model}`
  );
}

console.log('\n══ ЦЕНА ОТДЕЛЬНО ПО РОЛЯМ, ₽ за 100 вызовов ══');
for (const role of ['eval', 'actor', 'scenario']) {
  const ranked = table
    .filter((r) => r.perRole[role] !== undefined)
    .sort((a, b) => a.perRole[role] - b.perRole[role]);
  console.log(`\n${role}:`);
  for (const r of ranked) console.log(`  ${(r.perRole[role] * 100).toFixed(2).padStart(7)} ₽  ${r.model}`);
}
