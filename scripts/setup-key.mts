/* ============================================================
   Ключ AI-провайдера при установке.

   Вызывается из start.cmd перед запуском сервиса. Если ключ уже сохранён
   на этом компьютере — печатает маску и выходит, ничего не спрашивая.
   Если ключа нет — просит вставить его в консоль (ввод скрыт), проверяет
   у провайдера и сохраняет в data/settings.json зашифрованным под текущую
   учётную запись Windows (см. lib/secretStore.ts). Больше его не спросят.

   Ключа нет ни в репозитории, ни в архиве проекта — только здесь.

     npm run setup:key            — спросить, только если ключа ещё нет
     npm run setup:key -- --change  — заменить сохранённый ключ
   ============================================================ */

import { AiError } from '../lib/ai/errors';
import { probeCredentials } from '../lib/ai/provider';
import { config, maskKey, providerConfigured, providerSettingsSource, saveProviderSettings } from '../lib/config';

const change = process.argv.includes('--change');

function describe(): string {
  const { source, protection } = providerSettingsSource();
  if (source === 'env') return 'из переменных окружения (.env) — режим разработки';
  return protection === 'dpapi-user' ? 'сохранён на этом компьютере, зашифрован' : 'сохранён на этом компьютере';
}

/** Скрытый ввод: вместо символов печатаются звёздочки. Вставка через Ctrl+V или правый клик работает. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') { // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\b' || ch === '\u007f') { // Backspace
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write('*');
        }
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  if (providerConfigured() && !change) {
    console.log(`  Ключ AI-провайдера: ${maskKey(config.apiKey)} — ${describe()}. Вводить ничего не нужно.`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.log('  Ключ AI-провайдера не задан. Запустите start.cmd в окне консоли или введите ключ');
    console.log('  в кабинете преподавателя («Подключение AI»).');
    return;
  }

  console.log('');
  console.log('  Нужен ключ AI-провайдера — это разовая настройка при установке.');
  console.log('  Ключ сохранится только на этом компьютере в зашифрованном виде');
  console.log('  и больше спрашиваться не будет. Вставьте его и нажмите Enter');
  console.log('  (Enter без ключа — пропустить и ввести позже в кабинете преподавателя).');
  console.log('');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await readHidden('  Ключ: ');
    if (!key) {
      console.log('  Пропущено. Сцены не запустятся, пока ключ не введён в кабинете преподавателя.');
      return;
    }
    if (/\s/.test(key) || key.length < 12) {
      console.log('  Ключ выглядит обрезанным или с пробелами — скопируйте его целиком.');
      continue;
    }
    process.stdout.write('  Проверяю ключ у провайдера… ');
    let warning = '';
    try {
      await probeCredentials(config.baseUrl, key);
      console.log('принят.');
    } catch (e) {
      if (e instanceof AiError && e.code === 'bad_request') {
        console.log('провайдер отклонил ключ. Проверьте, что он скопирован целиком и не отозван.');
        continue;
      }
      console.log('провайдер не ответил.');
      warning = '  Ключ сохранён без проверки — если сцены не запустятся, замените его: npm run setup:key -- --change';
    }
    saveProviderSettings({ apiKey: key, baseUrl: config.baseUrl });
    console.log(`  Готово: ${maskKey(key)} — ${describe()}.`);
    if (warning) console.log(warning);
    return;
  }
  console.log('  Ключ не сохранён. Его можно ввести позже в кабинете преподавателя.');
}

main().catch((e) => {
  // Настройка ключа не должна мешать запуску сервиса.
  console.log(`  Не удалось настроить ключ: ${e instanceof Error ? e.message : e}`);
});
