require('dotenv').config();
const { firefox } = require('playwright');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');

console.log('token length:', process.env.DISCORD_TOKEN?.length);
console.log('channel id :', process.env.CHANNEL_ID);

const URL      = 'https://edition.cnn.com/markets/fear-and-greed';
const VIEWPORT = { width: 1200, height: 2800 };
const CLIP     = { x: 0, y: 0, width: 1200, height: 2800 };

(async () => {
  // 1. Discord login
  const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
  await bot.login(process.env.DISCORD_TOKEN);
  console.log('✅ Logged in');

  // 2. Screenshot with Playwright/Firefox
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize(VIEWPORT);

  // navigate & wait for initial HTML
  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000
  });

  // 2a. Dismiss CNN’s “Legal Terms and Privacy” modal by clicking “Agree”
  try {
    const agreeBtn = page.locator('button:has-text("Agree")');
    await agreeBtn.waitFor({ state: 'visible', timeout: 10_000 });
    console.log('🔓 “Agree” button is visible');
    await agreeBtn.click({ force: true });
    console.log('🔓 Privacy modal dismissed via button click');
    await page.waitForTimeout(1_000);
  } catch (e) {
    console.warn('⚠️ Could not find or click “Agree”:', e);
  }

  // 2b. wait up to 30s for the gauge value to be injected
  await page.waitForFunction(() => {
    const el = document.querySelector('.market-fng-gauge__dial-number-value');
    return el?.textContent?.trim().length > 0;
  }, { timeout: 30_000 });
  console.log('⏱ Gauge value is present');

  // once the number is present, grab the screenshot
  const buffer = await page.screenshot({ clip: CLIP });
  await browser.close();

  // 3. Post to Discord
  const channel = await bot.channels.fetch(process.env.CHANNEL_ID);
  await channel.send({
    files: [ new AttachmentBuilder(buffer, { name: 'fear-and-greed.png' }) ]
  });
  console.log('📸 Screenshot sent');

  await bot.destroy();
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
