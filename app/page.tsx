import HomeScreen from '@/components/home/HomeScreen';
import { publicCatalog } from '@/lib/domains';

/* Каталог собирается на сервере: в браузер уходит только публичная
   проекция реестра, без скрытых карточек кейсов. */
export default function HomePage() {
  return <HomeScreen catalog={publicCatalog()} />;
}
