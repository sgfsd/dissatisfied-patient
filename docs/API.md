# Vera Practice — контракты HTTP API

Документ для тех, кто пишет или переделывает интерфейс. Сервер — это
маршруты `app/api/**`, клиент общается с ним только через них. Типы
ответов — в [`lib/types.ts`](../lib/types.ts) (и `ProgressDTO` в
[`lib/progress.ts`](../lib/progress.ts)); импортировать их в клиентский код
можно и нужно через `import type`.

## Правила для клиента

- **Из `lib/` в браузерный код идут только типы**, плюс `lib/types.ts`
  (подписи эмоций и доменов расспроса) и `lib/personas.ts` (внешность аватаров).
  Реестр доменов (`lib/domains`), база, конфиг и промты в клиент не импортируются:
  всё, что попало в JS-чанк, студент читает в DevTools, а статические чанки
  отдаются без входа. Каталог разделов берите из `GET /api/catalog` или из пропса
  страницы (`publicCatalog()`).
- Вход — cookie `vera_account` (HttpOnly, SameSite=Strict), ставит и снимает сервер.
- Изменяющие запросы (POST/PATCH/DELETE) браузер отправляет с заголовком `Origin`
  своего сайта — это защита от межсайтовых запросов, ничего делать не нужно.
  Запросы без `Origin` отклоняются (`403 invalid_origin`).
- JSON-тела — с `Content-Type: application/json`, не больше 16 КБ.
- Типизированный помощник — `api<T>()` в `components/shared/utils.ts`: бросает
  `ApiError` с `code`, `status` и готовым текстом `message`.

## Ошибки

Все маршруты отвечают на ошибку одинаково:

```json
{ "error": { "code": "quota_exceeded", "message": "Лимит обращений к AI исчерпан — обратитесь к преподавателю" } }
```

`code` стабилен — на него можно завязывать логику интерфейса; `message` —
готовый текст на русском. Словарь кодов — `lib/errors.ts`. Основные:

| HTTP | code | Когда |
|---|---|---|
| 400 | `bad_request`, `invalid_*`, `password_length_12_256`, `format_not_supported` | некорректный ввод |
| 401 | `unauthorized`, `invalid_credentials`, `invalid_secret` | нет входа, неверный пароль или код запуска |
| 403 | `invalid_origin`, `teacher_required`, `student_required` | нет прав |
| 404 | `session_not_found`, `group_not_found`, `student_not_found`, `assignment_not_found`, `assignment_case_not_found` | нет объекта или он чужой (чужое и несуществующее неразличимы) |
| 409 | `username_taken`, `attempt_already_used`, `turn_in_progress`, `duplicate_request`, `bootstrap_closed`, `group_not_empty`, `group_has_assignments`, `assignment_has_attempts` | конфликт состояния |
| 429 | `quota_exceeded`, `too_many_attempts` (+ `Retry-After`), `turn_attempts_exhausted`, `evaluation_attempts_exhausted`, `rate_limited` | лимиты |
| 502/504 | `provider_unreachable`, `refusal`, `invalid_json`, `timeout` | сбой AI-провайдера — можно повторить |
| 500 | `internal_error` | непредвиденная ошибка (подробности — в консоли сервера) |

## Служебное

| Метод и путь | Доступ | Ответ |
|---|---|---|
| `GET /api/health` | все | `{ ok, database, providerConfigured, bootstrapNeeded, accounts, sessions, done, messages, scenarios }` |
| `GET /api/catalog` | вошедшие | `{ domains: PublicDomain[] }` — разделы и кейсы без скрытых карточек |

## Вход

| Метод и путь | Тело | Ответ |
|---|---|---|
| `POST /api/auth/bootstrap` | `{ adminPassword, username, password, displayName }` | `{ user }` — первый преподаватель; `adminPassword` — код из консоли сервера или `ADMIN_PASSWORD` |
| `POST /api/auth/login` | `{ username, password }` | `{ user }` |
| `POST /api/auth/logout` | — | `{ ok: true }` |
| `GET /api/auth/me` | — | `{ user }` |
| `GET /api/auth/quota` | — | `{ limit, used, remaining, byKind: [{ kind, label, count }] }` |

`user` — `{ id, role: 'trainee' | 'supervisor', displayName, username, disabled, requestQuota }`.
Логин: латиница, цифры, `._-`, 3–64 символа. Пароль: 12–256 символов.

## Сцены (студент)

| Метод и путь | Тело | Ответ |
|---|---|---|
| `POST /api/sessions` | `{ domain?, caseId?, mode?: 'practice' \| 'exam', format?: 'short' \| 'long', assignmentId? }` | `{ session: SessionPublicDTO }` |
| `GET /api/sessions/:id` | — | `{ session, messages: MessageDTO[], evaluation: EvaluationDTO \| null }` |
| `POST /api/sessions/:id/turn` | `{ doctorText, source: 'typed' \| 'stt' }` | `{ outcome: PatientTurnOutcome \| { kind: 'eval_ready' } }` |
| `POST /api/sessions/:id/evaluate` | — | `{ evaluation: EvaluationDTO }` |
| `POST /api/stt` | сырое аудио; `Content-Type: audio/webm \| ogg \| mp4 \| mpeg \| wav`; заголовок `Idempotency-Key` (8–100 символов `[A-Za-z0-9_-]`) | `{ text }` |
| `GET /api/audio/:key` | — | `audio/mpeg`, поддерживает `Range` |
| `GET /api/history` | — | `{ rows, stats }` — завершённые прогоны |
| `GET /api/progress` | — | `ProgressDTO` |
| `GET /api/progress/export?format=csv\|json` | — | файл |

Жизненный цикл сессии: `active` → (последний ответ врача) `evaluating` →
(разбор) `done`; `aborted` — истекло время экзамена или сцену бросили на 12+ часов.

- `session.opener.audioUrl` и `outcome.audioUrl` могут быть `null`: озвучка не
  удалась, реплику показывают текстом. Интерфейс не должен от неё зависеть.
- Ответ на ход: ответ врача с номером `limit` возвращает `{ kind: 'eval_ready' }`,
  после чего клиент вызывает `evaluate`.
- Если собеседник не смог ответить (5xx провайдера), ход откатывается — тот же
  текст можно отправить снова (до 3 попыток на ход).
- Повторный `evaluate`, пока разбор идёт, ждёт тот же результат; готовый разбор
  отдаётся из базы бесплатно.
- **Экзамен:** студент получает `evaluation` без `criteria`, `overallSummary` и
  `coverage` — только итог, `safetyFlag` и `flags`. Полный разбор видит преподаватель.
- `session.recordMaxSeconds` — потолок одной голосовой записи.

## Кабинет преподавателя

Все маршруты требуют роль `supervisor`, кроме `GET /api/teacher/assignments`
(студент получает задания своих групп).

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /api/teacher/groups` | — | `{ groups: [{ id, name, createdAt }] }` |
| `POST /api/teacher/groups` | `{ name }` | `201 { group }` |
| `PATCH /api/teacher/groups/:id` | `{ name }` | `{ ok: true }` |
| `DELETE /api/teacher/groups/:id` | — | `{ ok: true }`; только пустая группа без заданий |
| `GET /api/teacher/students?groupId=` | — | `{ students: user[] }` |
| `POST /api/teacher/students` | `{ groupId, username, password, displayName }` | `201 { student }` |
| `PATCH /api/teacher/students/:id` | `{ disabled?, requestQuota?, password?, displayName?, resetUsage? }` | `{ ok: true }`; отключение и смена пароля гасят входы |
| `POST /api/teacher/memberships` | `{ groupId, studentId, add: boolean }` | `{ ok: true }`; только студенты этого преподавателя |
| `GET /api/teacher/stats?groupId=` | — | `{ overview, criteria, domains, students, sessions }` |
| `GET /api/teacher/export?groupId=` | — | CSV (`;`, UTF-8 с BOM) |
| `GET /api/teacher/transcripts?studentId=` | — | `{ sessions }` |
| `GET /api/teacher/transcripts/:sessionId` | — | `{ session, messages, evaluation: EvaluationDTO \| null }` — полный, в том числе по экзамену |
| `GET /api/teacher/assignments` | — | `{ assignments: [{ id, groupId, title, createdAt, cases: [{ domainKey, caseId }] }] }` |
| `POST /api/teacher/assignments` | `{ groupId, title, cases: [{ domainKey, caseId }] }` | `201 { assignment }` |
| `DELETE /api/teacher/assignments/:id` | — | `{ ok: true }`; пока нет ни одной попытки |
| `GET /api/settings` | — | `{ configured, keyHint, baseUrl, source: 'saved' \| 'env' \| 'none', encrypted }` — `saved`: введён при установке или в кабинете, `encrypted`: зашифрован DPAPI |
| `POST /api/settings` | `{ apiKey, baseUrl? }` | `{ ok, verified, warning, keyHint, baseUrl }` — ключ проверяется у провайдера и сохраняется зашифрованным |
| `DELETE /api/settings` | — | `{ ok, configured }` — забыть сохранённый ключ (`.env` не трогается) |

Ключ провайдера в ответы не попадает никогда — только маска `keyHint`.
