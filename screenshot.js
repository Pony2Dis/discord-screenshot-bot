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
  // create a US‑based context:
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      // force US‑style content
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);

  // navigate & wait for initial HTML
  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000
  });

  //
  // 2a. Try dismissing either the “Agree” popup or the OneTrust cookie banner
  //
  //  — CNN U.S. version:
  const usAgree = page.locator('a:has-text("Agree")');
  if (await usAgree.count() > 0) {
    console.log('🔓 Found U.S. “Agree” link, clicking…');
    await usAgree.first().click({ force: true });
    await page.waitForTimeout(1_000);
  } else {
    // — E.U. version: OneTrust banner
    const euAccept = page.locator('#onetrust-accept-btn-handler');
    if (await euAccept.count() > 0) {
      console.log('🔓 Found E.U. “Accept All” button, clicking…');
      await euAccept.first().click({ force: true });
      await page.waitForTimeout(1_000);
    } else {
      console.log('⚠️ No known banner found; continuing anyway.');
    }
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
