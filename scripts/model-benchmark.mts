import { evaluateDialogue, type EvalMessage } from '../lib/evaluation/evaluator';
import { REGRESSION_CASES, moodOf, type RegressionCase } from './regression-cases';
import { personaById } from '../lib/personas';

// Affordable candidates from the supplied price sheet only.
const DEFAULT_MODELS = [
  'openai/gpt-4o-mini',
  'deepseek/deepseek-v4-flash',
  'qwen/qwen3.5-flash-02-23',
  'mistralai/mistral-small-3.2-24b-instruct',
  'z-ai/glm-4.7-flash',
  'qwen/qwen3.7-plus',
];

const args = process.argv.slice(2);
const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const models = value('--models')?.split(',').map((item) => item.trim()).filter(Boolean) ?? DEFAULT_MODELS;
const limit = Math.max(1, Number(value('--limit') ?? 6));
const repeats = Math.max(1, Number(value('--repeats') ?? 1));
const cases = REGRESSION_CASES.filter((item) =>
  /strong|weak|safety|injection|spikes|consent|call-center/.test(item.key),
).slice(0, limit);

function messages(c: RegressionCase): EvalMessage[] {
  const result: EvalMessage[] = [{ speaker: 'patient', text: c.opener.text, emotion: c.opener.emotion }];
  for (const turn of c.dialogue) {
    result.push({ speaker: 'doctor', text: turn.doctor, emotion: null });
    if (turn.patient) result.push({ speaker: 'patient', ...turn.patient });
  }
  return result;
}

function params(c: RegressionCase, model: string) {
  const persona = personaById(c.personaKey);
  return {
    domainTitle: c.domain,
    categoryTitle: c.category,
    personaKey: c.personaKey,
    patientFirst: persona.firstName,
    patientAge: persona.age,
    moodLabel: c.moodLabel ?? moodOf(c.opener.emotion),
    complaintSeed: c.complaint,
    openerText: c.opener.text,
    hiddenMotive: c.motive,
    actingNotes: c.actingNotes,
    messages: messages(c),
    domainKey: c.domainKey,
    rubricId: c.rubricId,
    caseFacts: c.caseFacts,
    requestId: `bench_${model.replace(/\W/g, '_')}_${c.key}`,
    model,
  };
}

function pass(c: RegressionCase, verdict: Awaited<ReturnType<typeof evaluateDialogue>>): boolean {
  const expected = new Map(c.criteria.map((criterion) => [criterion.name, criterion]));
  const scoresOk = verdict.criteria.length === c.criteria.length && verdict.criteria.every((criterion) => {
    const range = expected.get(criterion.name);
    return range && criterion.score >= range.min && criterion.score <= range.max &&
      (criterion.score === 0 || Boolean(criterion.evidenceQuote));
  });
  const total = verdict.criteria.reduce((sum, criterion) => sum + criterion.score, 0);
  const safetyOk = Boolean(verdict.safetyFlag) === Boolean(c.expectSafety);
  const injectionOk = verdict.flags.includes('prompt_injection') === Boolean(c.expectInjectionFlag);
  return Boolean(scoresOk && total >= c.total[0] && total <= c.total[1] && safetyOk && injectionOk);
}

async function main() {
  if (!cases.length) throw new Error('No benchmark cases selected');
  console.log(`Model benchmark: ${models.length} models x ${cases.length} cases x ${repeats} repeats`);
  const rows: Array<{ model: string; passed: number; calls: number; errors: number; ms: number }> = [];
  for (const model of models) {
    let passed = 0;
    let errors = 0;
    let calls = 0;
    const started = Date.now();
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const testCase of cases) {
        calls += 1;
        try {
          const verdict = await evaluateDialogue(params(testCase, model));
          const ok = pass(testCase, verdict);
          if (ok) passed += 1;
          console.log(`${ok ? 'PASS' : 'FAIL'} ${model} ${testCase.key}`);
        } catch (error) {
          errors += 1;
          console.log(`ERROR ${model} ${testCase.key}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    rows.push({ model, passed, calls, errors, ms: Date.now() - started });
  }
  console.log('\nSummary');
  for (const row of rows.sort((a, b) => b.passed - a.passed || a.errors - b.errors || a.ms - b.ms)) {
    console.log(`${row.model}: ${row.passed}/${row.calls}, errors=${row.errors}, avg=${Math.round(row.ms / row.calls)}ms`);
  }
  if (rows.every((row) => row.errors === row.calls)) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
