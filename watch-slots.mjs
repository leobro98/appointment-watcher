import readline from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const START_URL = 'https://termine.duesseldorf.de/';
const POLL_MS = 60_000;
const PROFILE_DIR = fileURLToPath(new URL('./browser-profile/', import.meta.url));
const userData = JSON.parse(await readFile(new URL('./personal-data.json', import.meta.url), 'utf8'));
const rl = readline.createInterface({ input, output });

for (const field of ['salutation', 'firstName', 'lastName', 'email']) {
  if (typeof userData[field] !== 'string' || !userData[field].trim()) {
    throw new Error(`В personal-data.json не заполнено обязательное поле: ${field}`);
  }
}
if (!/^\d{1,2}$/.test(userData.birthDate?.day ?? '') ||
    !/^\d{1,2}$/.test(userData.birthDate?.month ?? '') ||
    !/^\d{4}$/.test(userData.birthDate?.year ?? '')) {
  throw new Error('В personal-data.json проверьте дату рождения (day, month, year).');
}

async function timeCandidates(page) {
  return page.locator('button, a, [role="button"]').evaluateAll(nodes => {
    const time = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
    return nodes.map((node, index) => ({
      index,
      text: (node.innerText || node.getAttribute('aria-label') || '').trim(),
      visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
      disabled: node.matches(':disabled,[aria-disabled="true"]'),
    })).filter(item => item.visible && !item.disabled && time.test(item.text));
  });
}

const systemChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
  headless: false,
  ignoreDefaultArgs: ['--no-sandbox'],
  args: ['--start-maximized'],
  viewport: null,
});
const page = context.pages()[0] ?? await context.newPage();

try {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  console.log('\nВ браузере вручную пройдите процесс регистрации до страницы выбора времени /suggest.');
  console.log('Затем нажмите Enter в этом терминале.');
  await rl.question('');

  if (new URL(page.url()).pathname.replace(/\/$/, '') !== '/suggest') {
    throw new Error(`Ожидалась страница /suggest, сейчас открыта ${new URL(page.url()).pathname}.`);
  }

  console.log(`Проверяю страницу раз в ${POLL_MS / 1000} секунд. Ctrl+C — остановить.`);
  while (true) {
    const slots = await timeCandidates(page);
    if (!slots.length) {
      console.log(`${new Date().toLocaleTimeString()} — свободных слотов пока нет`);
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      if (new URL(page.url()).pathname.replace(/\/$/, '') === '/suggest') {
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
      continue;
    }

    const fresh = await timeCandidates(page);
    if (!fresh.length) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      continue;
    }
    console.log(`Найден первый видимый слот: ${fresh[0].text}. Выбираю его.`);
    await page.locator('button, a, [role="button"]').nth(fresh[0].index).click();
    await page.waitForTimeout(1000);

    const ja = page.getByRole('button', { name: /^Ja$/i });
    try {
      await ja.first().waitFor({ state: 'visible', timeout: 5000 });
      await ja.first().click();
      console.log('Подтверждение слота «Ja» нажато.');
    } catch {
      console.log('Окно «Ja» не появилось; продолжаю к форме данных.');
    }

    await page.getByText(/Eingabe der persönlichen Daten/i).first().waitFor({ state: 'visible', timeout: 15000 });
    const salutationButton = page.locator('#sexselect-button');
    await salutationButton.click();
    let option = page.getByRole('option', { name: userData.salutation, exact: true });
    if (await option.count()) {
      await option.first().click();
    } else {
      option = page.getByText(userData.salutation, { exact: true });
      await option.last().click();
    }
    if (!(await salutationButton.innerText()).includes(userData.salutation)) {
      throw new Error('Не удалось выбрать Anrede из локального профиля.');
    }

    await page.locator('#vorname').fill(userData.firstName);
    await page.locator('#nachname').fill(userData.lastName);
    const emailFields = page.locator('#email, #emailwhlg');
    if (await emailFields.count() !== 2) throw new Error('На странице не найдены оба поля e-mail.');
    await emailFields.nth(0).fill(userData.email);
    await emailFields.nth(1).fill(userData.email);
    if (!(await emailFields.evaluateAll(fields => fields.every(field => field.validity.valid)))) {
      throw new Error('Сайт отклонил e-mail из personal-data.json.');
    }
    if (userData.phone) await page.locator('#phone').fill(userData.phone);
    await page.locator('#geburtsdatumDay').fill(userData.birthDate.day);
    await page.locator('#geburtsdatumMonth').fill(userData.birthDate.month);
    await page.locator('#geburtsdatumYear').fill(userData.birthDate.year);

    const consent = page.locator('input[name="agreementChecked"]');
    if (!(await consent.isChecked())) {
      const consentText = page.locator('#privacy_check_agreement');
      await consentText.scrollIntoViewIfNeeded();
      await consentText.click();
    }
    if (!(await consent.isChecked())) throw new Error('Согласие на обработку данных не отмечено.');

    const summary = await page.locator('body').innerText();
    const targetRequest = summary.includes('Fahrerlaubnisbehörde') && summary.includes('Umschreibung ausländischer Führerschein (EU+EWR)');
    const testRequest = summary.includes('Einwohnerangelegenheiten') && summary.includes('Personalausweis - Antrag');
    if (!targetRequest && !testRequest) throw new Error('Сводка не соответствует разрешённой тестовой или целевой услуге; запрос не отправлен.');

    const reserve = page.locator('#chooseTerminButton');
    if (!(await reserve.isEnabled())) throw new Error('Кнопка Reservieren не активна; запрос не отправлен.');
    await reserve.click();
    await page.waitForTimeout(1500);
    console.log('Кнопка Reservieren нажата. Проверьте результат на странице и письмо с подтверждением/отменой.');
    await rl.question('После проверки письма нажмите Enter, чтобы закрыть браузер... ');
    break;
  }
} catch (error) {
  console.error(`Автоматизация остановлена: ${error.message}`);
  console.error('Проверьте страницу вручную: при ошибке во время отправки результат мог быть неопределённым.');
  await rl.question('Нажмите Enter, чтобы закрыть браузер... ');
} finally {
  await context.close();
  rl.close();
}
