/* ============================================================
   Сквозная проверка бэкенда БЕЗ обращений к AI-провайдеру.

   Проверяет то, что не стоит денег: здоровье сервиса, первый запуск
   преподавателя, создание группы и студента, вход, лимиты, права,
   защиту от подбора пароля, закрытость аудио и CSV-выгрузку.
   Сцены здесь не запускаются — это платно, для них scripts/e2e-smoke.mjs.

   Смоук создаёт аккаунты и группы, поэтому поднимать сервер под него нужно
   на ОТДЕЛЬНОЙ папке данных, чтобы не засорять рабочую базу:

       DATA_DIR=data-smoke npx next start -p 3100
       BASE_URL=http://127.0.0.1:3100 ADMIN_PASSWORD=<код из консоли> \
         node scripts/backend-smoke.mjs

   Код запуска сервер печатает в консоль при старте, пока нет ни одного
   преподавателя. Можно вместо него задать ADMIN_PASSWORD серверу.
   ============================================================ */

import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const ORIGIN = new URL(BASE).origin;

function envValue(name) {
  if (process.env[name]) return process.env[name];
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const hit = raw.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm'));
      if (hit) return hit[1].replace(/^["']|["']$/g, '').trim();
    } catch {
      /* файла нет */
    }
  }
  return '';
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Каждый «клиент» держит свои cookie: преподаватель и студент независимы. */
function client() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async fetch(path, init) {
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      if (!['GET', 'HEAD'].includes(method)) headers.set('Origin', ORIGIN);
      if (cookie) headers.set('Cookie', cookie);
      const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const pair = setCookie.split(';', 1)[0];
        if (pair.split('=')[1]) cookie = pair;
        else cookie = '';
      }
      const type = res.headers.get('content-type') ?? '';
      let body = null;
      if (res.status !== 204) body = type.includes('json') ? await res.json().catch(() => null) : await res.text();
      return { res, body, setCookie };
    },
    json(path, payload, method = 'POST') {
      return this.fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
  };
}

const stamp = Date.now().toString(36);
const teacher = { username: `t${stamp}`, password: 'Teacher-Pass-123456', displayName: 'Преподаватель Тест' };
const student = { username: `s${stamp}`, password: 'Student-Pass-123456', displayName: 'Студент Тест' };

async function main() {
  console.log(`Vera Practice — смоук бэкенда (без AI) · ${BASE}\n`);

  /* ---------- 1. Здоровье ---------- */
  const anon = client();
  const health = await anon.fetch('/api/health');
  check('GET /api/health → 200', health.res.status === 200, String(health.res.status));
  check('база отвечает', health.body?.database === 'ready');
  console.log(
    `   провайдер настроен: ${health.body?.providerConfigured} · нужен bootstrap: ${health.body?.bootstrapNeeded} · аккаунтов: ${health.body?.accounts}`,
  );

  /* ---------- 2. Всё закрыто без входа ---------- */
  for (const path of ['/api/auth/me', '/api/history', '/api/auth/quota', '/api/teacher/groups', '/api/teacher/stats']) {
    const r = await anon.fetch(path);
    check(`${path} без входа → 401/403`, [401, 403].includes(r.res.status), String(r.res.status));
  }
  const audio = await anon.fetch('/api/audio/' + 'a'.repeat(32));
  check('аудио без входа → 401 (не 404)', audio.res.status === 401, String(audio.res.status));
  const anonCatalog = await anon.fetch('/api/catalog');
  check('каталог без входа → 401', anonCatalog.res.status === 401, String(anonCatalog.res.status));

  /* ---------- 2а. Единый формат ошибок: { error: { code, message } } ---------- */
  const unauth = await anon.fetch('/api/auth/me');
  check(
    'ошибка в едином формате',
    unauth.body?.error?.code === 'unauthorized' && typeof unauth.body?.error?.message === 'string',
    JSON.stringify(unauth.body),
  );
  const wrong = await client().json('/api/auth/login', { username: `nobody${stamp}`, password: 'wrong-password-x' });
  check(
    'неверный пароль → 401 с понятным текстом',
    wrong.res.status === 401 && wrong.body?.error?.code === 'invalid_credentials' && /парол/i.test(wrong.body?.error?.message ?? ''),
    wrong.body?.error?.message,
  );

  /* ---------- 3. Защита от подбора пароля ---------- */
  const brute = client();
  let blocked = false;
  for (let i = 0; i < 9; i++) {
    const r = await brute.json('/api/auth/login', { username: `ghost${stamp}`, password: 'wrong-password-x' });
    if (r.res.status === 429) {
      blocked = true;
      check('вход блокируется после серии неудач', true, `на попытке ${i + 1}, Retry-After=${r.res.headers.get('retry-after')}`);
      break;
    }
  }
  if (!blocked) check('вход блокируется после серии неудач', false, 'за 9 попыток блокировки не было');

  /* ---------- 4. Первый запуск преподавателя ---------- */
  const adminPassword = envValue('ADMIN_PASSWORD');
  if (!adminPassword) {
    check('ADMIN_PASSWORD задан', false, 'без него bootstrap недоступен — остальное пропущено');
    return;
  }
  const t = client();
  const boot = await t.json('/api/auth/bootstrap', { ...teacher, adminPassword });
  const bootstrapClosed = boot.res.status === 409;
  if (bootstrapClosed) {
    console.log('\n   аккаунт преподавателя уже существует — нужен существующий логин');
    const tu = envValue('TEACHER_USERNAME');
    const tp = envValue('TEACHER_PASSWORD');
    if (!tu || !tp) {
      check('вход преподавателя', false, 'задайте TEACHER_USERNAME и TEACHER_PASSWORD для повторного прогона');
      return;
    }
    const login = await t.json('/api/auth/login', { username: tu, password: tp });
    check('вход существующего преподавателя → 200', login.res.status === 200, String(login.res.status));
    if (login.res.status !== 200) return;
  } else {
    check('POST /api/auth/bootstrap → 200', boot.res.status === 200, String(boot.res.status));
    check('роль supervisor', boot.body?.user?.role === 'supervisor', boot.body?.user?.role);
    if (boot.res.status !== 200) return;
  }

  const me = await t.fetch('/api/auth/me');
  check('cookie входа работает', me.res.status === 200 && me.body?.user?.role === 'supervisor');
  check('cookie без флага Secure по HTTP', !/;\s*Secure/i.test(t.cookie ? boot.setCookie ?? '' : ''), 'важно для сети кафедры');

  /* ---------- 5. Группа и студент ---------- */
  const group = await t.json('/api/teacher/groups', { name: `Группа ${stamp}` });
  check('POST /api/teacher/groups → 201', group.res.status === 201, String(group.res.status));
  const groupId = group.body?.group?.id;
  check('id группы получен', Boolean(groupId));

  const short = await t.json('/api/teacher/students', { ...student, password: 'short', groupId });
  check('короткий пароль отклонён', short.res.status === 400, String(short.res.status));
  check('…с объяснением, а не «что-то пошло не так»', /12/.test(short.body?.error?.message ?? ''), short.body?.error?.message);

  const created = await t.json('/api/teacher/students', { ...student, groupId });
  check('POST /api/teacher/students → 201', created.res.status === 201, String(created.res.status));
  const studentId = created.body?.student?.id;
  check('квота студента из настроек', created.body?.student?.requestQuota > 0, `лимит ${created.body?.student?.requestQuota}`);

  const dup = await t.json('/api/teacher/students', { ...student, groupId });
  check('повторный логин отклонён', dup.res.status === 409, String(dup.res.status));

  /* ---------- 6. Студент входит и видит своё ---------- */
  const s = client();
  const sLogin = await s.json('/api/auth/login', { username: student.username, password: student.password });
  check('вход студента → 200', sLogin.res.status === 200, String(sLogin.res.status));
  const quota = await s.fetch('/api/auth/quota');
  check('GET /api/auth/quota → 200', quota.res.status === 200);
  check('лимит не израсходован', quota.body?.used === 0, `использовано ${quota.body?.used} из ${quota.body?.limit}`);
  const sTeacher = await s.fetch('/api/teacher/stats');
  check('студент не видит кабинет преподавателя → 403', sTeacher.res.status === 403, String(sTeacher.res.status));
  const sHistory = await s.fetch('/api/history');
  check('история студента доступна и пуста', sHistory.res.status === 200 && sHistory.body?.rows?.length === 0);
  const catalog = await s.fetch('/api/catalog');
  const catalogText = JSON.stringify(catalog.body ?? {});
  check('каталог разделов доступен студенту', catalog.res.status === 200 && catalog.body?.domains?.length > 0);
  check(
    'в каталоге нет скрытых карточек и эталонов',
    !/expectedPlan|safetyNet|redFlags|"facts"|calibration|rubric/.test(catalogText),
  );

  /* ---------- 7. CSRF: запрос без Origin ---------- */
  const noOrigin = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
    body: JSON.stringify({ domain: 'conflict' }),
  });
  check('POST без Origin отклонён', noOrigin.status === 403, String(noOrigin.status));

  /* ---------- 8. Агрегаты и выгрузка ---------- */
  const stats = await t.fetch(`/api/teacher/stats?groupId=${groupId}`);
  check('GET /api/teacher/stats → 200', stats.res.status === 200, String(stats.res.status));
  check('в сводке виден студент', stats.body?.overview?.students >= 1, `студентов ${stats.body?.overview?.students}`);
  const csv = await t.fetch(`/api/teacher/export?groupId=${groupId}`);
  check('GET /api/teacher/export → CSV', csv.res.status === 200 && /Студент;Логин/.test(String(csv.body)));

  /* ---------- 9. Управление студентом ---------- */
  const disable = await t.json(`/api/teacher/students/${studentId}`, { disabled: true }, 'PATCH');
  check('отключение студента → 200', disable.res.status === 200, String(disable.res.status));
  const afterDisable = await s.fetch('/api/auth/me');
  check('отключённый студент разлогинен', afterDisable.res.status === 401, String(afterDisable.res.status));
  const reLogin = await client().json('/api/auth/login', { username: student.username, password: student.password });
  check('отключённый не может войти', reLogin.res.status === 401, String(reLogin.res.status));
  await t.json(`/api/teacher/students/${studentId}`, { disabled: false }, 'PATCH');

  const quotaBad = await t.json(`/api/teacher/students/${studentId}`, { requestQuota: -5 }, 'PATCH');
  check('отрицательная квота отклонена', quotaBad.res.status === 400, String(quotaBad.res.status));

  const pwd = await t.json(`/api/teacher/students/${studentId}`, { password: 'New-Student-Pass-9876' }, 'PATCH');
  check('смена пароля → 200', pwd.res.status === 200, String(pwd.res.status));
  const oldPwd = await client().json('/api/auth/login', { username: student.username, password: student.password });
  check('старый пароль больше не работает', oldPwd.res.status === 401, String(oldPwd.res.status));
  const newPwd = await client().json('/api/auth/login', { username: student.username, password: 'New-Student-Pass-9876' });
  check('новый пароль работает', newPwd.res.status === 200, String(newPwd.res.status));

  /* ---------- 10. Задания ---------- */
  const assignment = await t.json('/api/teacher/assignments', {
    groupId,
    title: `Экзамен ${stamp}`,
    cases: [{ domainKey: 'call-center', caseId: 'triage-adult' }],
  });
  check('POST /api/teacher/assignments → 201', assignment.res.status === 201, String(assignment.res.status));
  const badCase = await t.json('/api/teacher/assignments', {
    groupId,
    title: 'Мимо',
    cases: [{ domainKey: 'call-center', caseId: 'no-such-case' }],
  });
  check('несуществующий кейс отклонён', badCase.res.status === 400, String(badCase.res.status));

  const assignmentId = assignment.body?.assignment?.id;
  const groupBusy = await t.fetch(`/api/teacher/groups/${groupId}`, { method: 'DELETE' });
  check('непустую группу удалить нельзя', groupBusy.res.status === 409, String(groupBusy.res.status));

  if (assignmentId) {
    const del = await t.fetch(`/api/teacher/assignments/${assignmentId}`, { method: 'DELETE' });
    check('удаление задания без попыток → 200', del.res.status === 200, String(del.res.status));
  }

  /* ---------- 11. Чужие данные недоступны ---------- */
  const otherTeacher = client();
  const otherBoot = await otherTeacher.json('/api/auth/bootstrap', {
    username: `x${stamp}`,
    password: 'Other-Pass-123456',
    displayName: 'Другой',
    adminPassword,
  });
  check('второй bootstrap закрыт', otherBoot.res.status === 409, String(otherBoot.res.status));

  const foreign = await t.fetch('/api/teacher/transcripts?studentId=local');
  check('чужой студент не отдаётся', foreign.res.status === 404, String(foreign.res.status));

  console.log(
    failures
      ? `\n✗ проблем: ${failures}\n`
      : '\n✓ бэкенд в порядке: доступ, лимиты, права, агрегаты и выгрузка работают\n',
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('\nсмоук упал:', e.message);
  process.exit(1);
});
