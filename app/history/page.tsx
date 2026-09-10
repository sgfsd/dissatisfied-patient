import HistoryScreen from '@/components/history/HistoryScreen';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Vera Practice — история прогонов' };

export default function HistoryPage() {
  return <HistoryScreen />;
}
