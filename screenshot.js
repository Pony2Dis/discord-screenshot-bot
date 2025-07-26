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

  // 2. Launch browser in “US mode”
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);

  // 3. Go to the page
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // 5. Wait for the Fear & Greed gauge
  await page.waitForFunction(() => {
    const el = document.querySelector('.market-fng-gauge__dial-number-value');
    return el?.textContent?.trim().length > 0;
  }, { timeout: 30_000 });
  console.log('⏱ Gauge value is present');

  // 4. Try to click the “Agree” link by your CSS path
  const agreeLink = page.locator('body > div:nth-child(16) > div:nth-child(1) > a:nth-child(3)');
  try {
    await agreeLink.waitFor({ state: 'visible', timeout: 5_000 });
    await agreeLink.click({ force: true });
    console.log('🔓 Clicked “Agree” via CSS selector');
    // give it a moment to go away
    await page.waitForTimeout(1_000);
  } catch {
    console.log('⚠️ “Agree” link not found via CSS path, falling back...');
    // (you can add your old fallback here if you like)
  }

  // 6. Screenshot & send
  const buffer = await page.screenshot({ clip: CLIP });
  await browser.close();

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
