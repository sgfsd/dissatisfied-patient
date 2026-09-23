import TeacherScreen from '@/components/teacher/TeacherScreen';
import { publicCatalog } from '@/lib/domains';

export default function TeacherPage() {
  return <TeacherScreen catalog={publicCatalog()} />;
}
