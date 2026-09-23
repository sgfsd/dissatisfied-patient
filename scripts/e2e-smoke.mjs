/* ============================================================
   Сквозной смоук: новая сцена → открывающая реплика (TTS) →
   два ответа врача → «живой» пациент → разбор супервизора → история.
   Требует запущенного сервера (npm run start / dev).
   ============================================================ */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const ORIGIN = new URL(BASE).origin;
const USERNAME = process.env.E2E_USERNAME;
const PASSWORD = process.env.E2E_PASSWORD;
let cookie = '';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function jfetch(path, init) {
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  if (!['GET', 'HEAD'].includes(method)) headers.set('Origin', ORIGIN);
  if (cookie) headers.set('Cookie', cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const type = res.headers.get('content-type') ?? '';
  let body = null;
  if (res.status !== 204) {
    body = type.includes('json') ? await res.json() : await res.arrayBuffer();
  }
  return { res, body };
}

function doctorAnswers(n) {
  const pool = [
    'Понимаю ваше возмущение, вы ждали больше часа — это действительно долго. Давайте я сейчас разберусь, что можно сделать, чтобы вы больше не ждали. Расскажите, с какой проблемой пришли?',
    'Спасибо, что объяснили. Скажите, как давно вас это беспокоит и что именно вас тревожит больше всего? Я хочу убедиться, что мы ничего не упустим.',
    'Я вас услышал. Давайте договоримся о конкретном плане: я проверю вашу карту, запишу вас на нужное обследование и объясню, что и зачем мы делаем. Если что-то пойдёт не так — вот мой контакт, звоните напрямую.',
  ];
  return pool[Math.min(n, pool.length - 1)];
}

async function main() {
  console.log(`Vera Practice e2e · ${BASE}\n`);

  if (USERNAME || PASSWORD) {
    if (!USERNAME || !PASSWORD) throw new Error('Set both E2E_USERNAME and E2E_PASSWORD');
    const login = await jfetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
    check('POST /api/auth/login → 200', login.res.status === 200, login.res.status);
    cookie = login.res.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    check('login cookie received', Boolean(cookie));
  } else {
    throw new Error('Authentication required: set E2E_USERNAME and E2E_PASSWORD');
  }

  // 1. Создание сцены
  const start = await jfetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'outpatient' }),
  });
  check('POST /api/sessions → 200', start.res.status === 200, start.res.status);
  if (start.res.status !== 200) throw new Error(`Session creation failed (${start.res.status})`);
  const { session } = start.body;
  check('сцена: есть opener с audioUrl', Boolean(session?.opener?.text && session.opener.audioUrl));
  check('сцена: ожидается обменов', session.exchangesLimit >= 1 && session.exchangesLimit <= 4, `limit=${session.exchangesLimit}`);
  console.log(`   сцена: ${session.domain} · ${session.category} · пациент ${session.patientFirst}, эмоция ${session.opener.emotion}\n`);

  const sid = session.sessionId;

  // 2. Открывающая реплика доступна как mp3
  const audio = await jfetch(session.opener.audioUrl);
  check('GET opener audio → 200 mp3', audio.res.status === 200 && audio.res.headers.get('content-type')?.includes('audio/mpeg'), audio.res.status);
  const audioBytes = audio.body.byteLength;
  check('озвучка не пустая', audioBytes > 2000, `${Math.round(audioBytes / 1024)} KiB`);

  // 3. Диалог: отвечаем до упора
  let turns = 0;
  let patientLines = 0;
  let gotEvalReady = false;
  const limit = session.exchangesLimit;
  while (turns < limit) {
    const answer = doctorAnswers(turns);
    const t0 = Date.now();
    const turn = await jfetch(`/api/sessions/${sid}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctorText: answer, source: 'typed' }),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (turn.res.status !== 200) { check(`ход ${turns + 1} → 200`, false, turn.res.status); break; }
    const { outcome } = turn.body;
    turns += 1;
    if (outcome.kind === 'eval_ready') { gotEvalReady = true; break; }
    patientLines += 1;
    check(`ответ врача #${turns} → реплика пациента`, Boolean(outcome.text && outcome.emotion && outcome.audioUrl), `${secs}s · эмоция ${outcome.emotion}`);
    const pa = await jfetch(outcome.audioUrl);
    check(`   озвучка ответа пациента`, pa.res.status === 200 && (pa.body?.byteLength ?? 0) > 2000, `${Math.round((pa.body?.byteLength ?? 0) / 1024)} KiB`);
  }
  check('диалог дошёл до оценки', gotEvalReady, `${turns} ответов врача, ${patientLines} реплик пациента`);

  // 4. Разбор
  const t1 = Date.now();
  const ev = await jfetch(`/api/sessions/${sid}/evaluate`, { method: 'POST' });
  const evalSecs = ((Date.now() - t1) / 1000).toFixed(1);
  check('POST evaluate → 200', ev.res.status === 200, `за ${evalSecs}с`);
  const e = ev.body?.evaluation ?? ev.body;
  check('критерии со шкалами', e?.criteria?.length >= 4, `${e?.criteria?.length} критериев`);
  const sumMax = e?.criteria?.reduce((s, c) => s + c.maxScore, 0);
  const sumScored = e?.criteria?.reduce((s, c) => s + c.score, 0);
  check('баллы в пределах шкал', e?.totalScore === sumScored && e?.maxScore === sumMax, `${e?.totalScore}/${e?.maxScore}`);
  check('у критериев есть цитаты и объяснения', e?.criteria?.every((c) => (c.score === 0 || c.evidenceQuote) && c.explanation));
  check('есть общий вывод', Boolean(e?.overallSummary?.length > 40), `${e?.overallSummary?.length} симв.`);
  console.log(`   итог: ${e?.totalScore}/${e?.maxScore} · ${e?.model}`);
  const evAgain = await jfetch(`/api/sessions/${sid}/evaluate`, { method: 'POST' });
  check('повторная оценка идемпотентна', evAgain.res.status === 200 && evAgain.body?.evaluation?.evaluationId === e?.evaluationId);

  // 5. Resume показывает оценку
  const rs = await jfetch(`/api/sessions/${sid}`);
  check('GET resume → done + оценка', rs.res.status === 200 && rs.body?.session?.status === 'done' && Boolean(rs.body?.evaluation));
  const patCount = rs.body.messages.filter((m) => m.speaker === 'patient').length;
  const docCount = rs.body.messages.filter((m) => m.speaker === 'doctor').length;
  check('сообщения сохранены', patCount === patientLines + 1 && docCount === turns, `${patCount} пациент / ${docCount} врач`);

  // 6. История
  const hist = await jfetch('/api/history');
  const found = hist.body?.rows?.find((r) => r.sessionId === sid);
  check('GET history → есть наша сцена', hist.res.status === 200 && Boolean(found), found ? `${found.totalScore}/${found.maxScore}` : 'нет');

  console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : '\nВСЁ ПРОШЛО');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('Смоук-скрипт упал:', e); process.exit(2); });
