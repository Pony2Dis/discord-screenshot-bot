import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import axios from 'axios';

const { DISCORD_TOKEN, FINNHUB_TOKEN, BOT_CHANNEL_ID } = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () =>
  console.log(`Logged in as ${client.user.tag}`)
);

client.on('messageCreate', async (message) => {
  if (message.channel.id !== BOT_CHANNEL_ID || message.author.bot) return;

  if (message.content.toLowerCase().startsWith('/todays earnings')) {
    await message.channel.send('🔄 Fetching today’s earnings...');
    try {
      const today = new Date().toISOString().split('T')[0];
      const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`;
      const resp = await axios.get(url);
      const items = resp.data.earnings || resp.data;
      if (!items.length) {
        return message.channel.send('לא מצאתי דיווח רווחים להיום.');
      }
      const formatted = items
        .map(e => `• **${e.symbol}** at ${e.time}`)
        .join('\n');
      await message.channel.send(`**המדווחות בתאריך - ${today}:**\n${formatted}`);
    } catch (err) {
      console.error(err);
      await message.channel.send('❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים.');
    }
  }
});

client.login(DISCORD_TOKEN);
