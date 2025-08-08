export async function listMyTickers({ message }) {
    // TODO: implement your “user’s first-mentioned tickers” logic here
    await message.channel.send("אלו כל הטיקרים שלך שאני עוקב אחריהם:\n(בקרוב: נתממשק למקור הנתונים שלך)");
  }
  