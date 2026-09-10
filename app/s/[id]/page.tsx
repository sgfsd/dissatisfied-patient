import SessionScreen from '@/components/session/SessionScreen';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Vera Practice — консультация' };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionScreen sessionId={id} />;
}
