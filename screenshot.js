const puppeteer = require('puppeteer');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');

const URL      = 'https://edition.cnn.com/markets/fear-and-greed';
const VIEWPORT = { width: 1200, height: 800 };
const CLIP     = { x: 100, y: 200, width: 800, height: 400 };

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once('ready', () => {
  (async () => {
    const browser = await puppeteer.launch();
    const page    = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(URL, { waitUntil: 'networkidle2' });
    const buffer  = await page.screenshot({ clip: CLIP });
    await browser.close();

    const channel = await bot.channels.fetch(process.env.CHANNEL_ID);
    const attachment = new AttachmentBuilder(buffer, { name: 'shot.png' });
    await channel.send({ files: [attachment] });
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
});

bot.login(process.env.DISCORD_TOKEN);
