import { NextResponse } from 'next/server';
import { bootstrapNeeded, dbStats, getDb } from '@/lib/db';
import { providerConfigured } from '@/lib/config';

/**
 * GET /api/health — проверка готовности сервера без раскрытия данных.
 * Нужна при развёртывании на кафедре: по этому адресу видно, что сервис
 * поднялся, база доступна и ключ провайдера задан. Ключ, адрес провайдера
 * и любые пользовательские данные не отдаются.
 */
export async function GET() {
  try {
    const db = getDb();
    const { n: accounts } = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };

    return NextResponse.json(
      {
        ok: true,
        database: 'ready',
        providerConfigured: providerConfigured(),
        bootstrapNeeded: bootstrapNeeded(),
        accounts,
        ...dbStats(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    // Подробности — в консоль сервера: адрес открыт без входа, пути на диске наружу не отдаём.
    console.error('[health]', e);
    return NextResponse.json(
      { ok: false, database: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
