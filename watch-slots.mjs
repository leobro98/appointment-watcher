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
    throw new Error(`Required field is missing in personal-data.json: ${field}`);
  }
}
if (!/^\d{1,2}$/.test(userData.birthDate?.day ?? '') ||
    !/^\d{1,2}$/.test(userData.birthDate?.month ?? '') ||
    !/^\d{4}$/.test(userData.birthDate?.year ?? '')) {
  throw new Error('Check the birth date in personal-data.json (day, month, year).');
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
  console.log('\nIn the browser, manually complete the appointment process until you reach the time selection page /suggest.');
  console.log('Then press Enter in this terminal.');
  await rl.question('');

  if (new URL(page.url()).pathname.replace(/\/$/, '') !== '/suggest') {
    throw new Error(`Expected the /suggest page, but the current page is ${new URL(page.url()).pathname}.`);
  }

  console.log(`Checking the page every ${POLL_MS / 1000} seconds. Press Ctrl+C to stop.`);
  while (true) {
    const slots = await timeCandidates(page);
    if (!slots.length) {
      console.log(`${new Date().toLocaleTimeString()} — no available slots yet`);
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
    console.log(`Earliest visible slot found: ${fresh[0].text}. Selecting it.`);
    await page.locator('button, a, [role="button"]').nth(fresh[0].index).click();
    await page.waitForTimeout(1000);

    const ja = page.getByRole('button', { name: /^Ja$/i });
    try {
      await ja.first().waitFor({ state: 'visible', timeout: 5000 });
      await ja.first().click();
      console.log('Clicked the "Ja" slot confirmation button.');
    } catch {
      console.log('The "Ja" confirmation dialog did not appear; continuing to the personal details form.');
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
      throw new Error('Could not select the salutation from the local profile.');
    }

    await page.locator('#vorname').fill(userData.firstName);
    await page.locator('#nachname').fill(userData.lastName);
    const emailFields = page.locator('#email, #emailwhlg');
    if (await emailFields.count() !== 2) throw new Error('Could not find both email fields on the page.');
    await emailFields.nth(0).fill(userData.email);
    await emailFields.nth(1).fill(userData.email);
    if (!(await emailFields.evaluateAll(fields => fields.every(field => field.validity.valid)))) {
      throw new Error('The website rejected the email address in personal-data.json.');
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
    if (!(await consent.isChecked())) throw new Error('The data processing consent checkbox is not selected.');

    const summary = await page.locator('body').innerText();
    const targetRequest = summary.includes('Fahrerlaubnisbehörde') && summary.includes('Umschreibung ausländischer Führerschein (EU+EWR)');
    const testRequest = summary.includes('Einwohnerangelegenheiten') && summary.includes('Personalausweis - Antrag');
    if (!targetRequest && !testRequest) throw new Error('The summary does not match an allowed test or target service; the request was not submitted.');

    const reserve = page.locator('#chooseTerminButton');
    if (!(await reserve.isEnabled())) throw new Error('The "Reservieren" button is disabled; the request was not submitted.');
    await reserve.click();
    await page.waitForTimeout(1500);
    console.log('Clicked the "Reservieren" button. Check the page and your email for confirmation or cancellation.');
    await rl.question('After checking your email, press Enter to close the browser... ');
    break;
  }
} catch (error) {
  console.error(`Automation stopped: ${error.message}`);
  console.error('Check the page manually. If an error occurred while submitting, the result may be uncertain.');
  await rl.question('Press Enter to close the browser... ');
} finally {
  await context.close();
  rl.close();
}
