/* Ошибки AI-слоя с кодом — чтобы бизнес-логика могла различать
   недоступность провайдера, таймаут, отказ модели и битые ответы. */

export type AiErrorCode =
  | 'provider_unreachable'
  | 'timeout'
  | 'rate_limited'
  | 'bad_request'
  | 'invalid_json'
  | 'refusal'
  | 'unknown';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;
  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}
