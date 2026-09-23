import { NextResponse } from 'next/server';
import { AiError } from './ai/errors';

/* ============================================================
   Единый формат ошибок API.

   Любой маршрут отвечает на ошибку одинаково:
     { "error": { "code": "quota_exceeded", "message": "Лимит…" } }
   code — стабильный машинный идентификатор (на него можно завязывать
   логику интерфейса), message — готовый текст для человека на русском.
   Полный список кодов — docs/API.md.
   ============================================================ */

/** Ошибка доступа или валидации запроса: несёт HTTP-статус и код. */
export class AuthError extends Error {
  constructor(public status: number, public code: string, message = code) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Тексты для кодов AuthError. Код без текста получает общий по статусу. */
const MESSAGES: Record<string, string> = {
  unauthorized: 'Войдите в систему, чтобы продолжить',
  invalid_credentials: 'Неверный логин или пароль',
  invalid_origin: 'Запрос отклонён: он пришёл не со страницы тренажёра',
  json_required: 'Ожидалось тело запроса в формате JSON',
  body_too_large: 'Слишком большой запрос',
  invalid_json: 'Тело запроса не является корректным JSON',
  teacher_required: 'Это действие доступно только преподавателю',
  student_required: 'Экзамен проходят только студенты',
  password_length_12_256: 'Пароль должен быть длиной от 12 до 256 символов',
  invalid_username: 'Логин: латиница, цифры, точка, дефис или подчёркивание, от 3 до 64 символов',
  username_taken: 'Такой логин уже занят',
  invalid_displayName: 'Укажите имя (до 120 символов)',
  invalid_name: 'Укажите название (до 120 символов)',
  invalid_title: 'Укажите название задания (до 120 символов)',
  invalid_quota: 'Лимит должен быть целым числом от 0 до 1 000 000',
  invalid_disabled: 'Некорректное значение флага доступа',
  invalid_membership: 'Некорректный запрос на изменение состава группы',
  invalid_cases: 'Выберите от 1 до 100 разных существующих кейсов',
  invalid_studentId: 'Не указан студент',
  invalid_domain: 'Такого раздела практики нет',
  invalid_mode: 'Неизвестный режим прохождения',
  invalid_format: 'Неизвестный формат сцены',
  format_not_supported: 'Этот раздел не поддерживает выбранный формат',
  assignment_required_for_exam: 'Экзамен запускается только по заданию преподавателя',
  assignment_case_not_found: 'Этот кейс не назначен вам в задании',
  attempt_already_used: 'Попытка по этому экзаменационному кейсу уже использована',
  quota_exceeded: 'Лимит обращений к AI исчерпан — обратитесь к преподавателю',
  duplicate_request: 'Этот запрос уже обрабатывается',
  turn_in_progress: 'Предыдущий ответ ещё обрабатывается — подождите',
  turn_attempts_exhausted: 'Собеседник не смог ответить несколько раз подряд — попробуйте позже',
  evaluation_attempts_exhausted: 'Разбор не удался несколько раз подряд — обратитесь к преподавателю',
  session_not_found: 'Сессия не найдена',
  group_not_found: 'Группа не найдена',
  student_not_found: 'Студент не найден',
  assignment_not_found: 'Задание не найдено',
  group_not_empty: 'В группе есть студенты — удалить можно только пустую группу',
  group_has_assignments: 'У группы есть задания — сначала удалите их',
  assignment_has_attempts: 'По заданию уже есть попытки — удалить его нельзя',
  bootstrap_closed: 'Аккаунт преподавателя уже создан — войдите со своим логином',
  invalid_secret: 'Неверный код запуска. Он напечатан в консоли сервера',
  too_many_attempts: 'Слишком много попыток — подождите и повторите',
};

const BY_STATUS: Record<number, string> = {
  400: 'Некорректный запрос',
  401: MESSAGES.unauthorized,
  403: 'Недостаточно прав',
  404: 'Не найдено',
  409: 'Конфликт с текущим состоянием',
  413: MESSAGES.body_too_large,
  415: MESSAGES.json_required,
  429: 'Слишком много запросов — подождите и повторите',
};

const AI_STATUS: Record<string, number> = {
  rate_limited: 429,
  bad_request: 400,
  refusal: 502,
  timeout: 504,
};

export function errorMessage(code: string, status = 400): string {
  return MESSAGES[code] ?? BY_STATUS[status] ?? 'Ошибка запроса';
}

/** Ответ-ошибка в едином формате. */
export function errorJson(
  status: number,
  code: string,
  message = errorMessage(code, status),
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

/**
 * Превратить любое исключение маршрута в ответ. Непредвиденные ошибки
 * пишутся в консоль сервера, а наружу уходит только общий текст —
 * без стека и путей на диске.
 */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    const message = e.message && e.message !== e.code ? e.message : errorMessage(e.code, e.status);
    return errorJson(e.status, e.code, message);
  }
  if (e instanceof AiError) return errorJson(AI_STATUS[e.code] ?? 502, e.code, e.message);
  console.error('[api]', e);
  return errorJson(500, 'internal_error', 'Внутренняя ошибка сервиса');
}
