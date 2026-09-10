'use client';
/* Граница ошибки сцены: вместо «Application error» показывает понятное
   сообщение, кнопку перезапуска (диалог сохранён на сервере) и техническую
   деталь, чтобы при повторении можно было сразу увидеть причину. */
import Link from 'next/link';

export default function SceneError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const detail = error?.message && String(error.message) !== 'Error'
    ? String(error.message)
    : error?.digest
      ? `digest: ${error.digest}`
      : null;

  return (
    <div className="vp-scene-error vp-in">
      <p className="eyebrow">Ошибка</p>
      <h1>Сцена прервалась</h1>
      <p>
        Произошла внутренняя ошибка интерфейса. Ваш диалог сохранён на сервере —
        просто вернитесь на сцену: пациент и ход беседы будут на месте.
      </p>
      {detail && (
        <p style={{ font: '12px/1.45 ui-monospace, Consolas, monospace', color: 'var(--faint)', marginTop: 14, wordBreak: 'break-word' }}>
          {detail}
        </p>
      )}
      <div className="vp-scene-error-actions">
        <button type="button" className="vp-btn vp-btn--dark" onClick={reset}>
          Обновить сцену
        </button>
        <Link className="vp-btn vp-btn--ghost" href="/">В приёмную</Link>
      </div>
    </div>
  );
}
