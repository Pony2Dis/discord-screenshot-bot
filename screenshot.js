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

  // 2a. Go and dismiss the privacy modal
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  try {
    // 1) click the “Agree” button if present
    const agreeBtn = page.getByRole('button', { name: 'Agree' });
    if (await agreeBtn.count() > 0) {
      await agreeBtn.first().click();
      console.log('🔓 Privacy modal dismissed via button');
      await page.waitForTimeout(1_000);
    } else {
      throw new Error('no button');
    }
  } catch {
    // 2) remove any giant fixed overlay
    await page.evaluate(() => {
      document.querySelectorAll('div').forEach(el => {
        const s = window.getComputedStyle(el);
        if (
          s.position === 'fixed' &&
          parseFloat(s.width) / window.innerWidth > 0.5 &&
          parseFloat(s.height) / window.innerHeight > 0.2
        ) el.remove();
      });
    });
    console.log('🔓 Privacy modal removed by fallback');

    // 3) *last‑ditch*: remove any node whose text includes the modal title
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('div')) {
        if (el.textContent.includes('Legal Terms and Privacy')) {
          el.remove();
          return;
        }
      }
    });
    console.log('🔓 Privacy modal removed by text match');
  }

  // 2b. wait up to 30s for the gauge value to show
  await page.waitForFunction(() => {
    const el = document.querySelector('.market-fng-gauge__dial-number-value');
    return el?.textContent.trim().length > 0;
  }, { timeout: 30_000 });
  console.log('⏱ Gauge value is present');

  // 2c. screenshot
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
