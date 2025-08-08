export async function listAllTickers({ message }) {
    // TODO: implement your “all tickers under scanner” source here
    await message.channel.send("אלו כל הטיקרים שאני עוקב אחריהם:\n(בקרוב: נתממשק למקור הנתונים שלך)");
  }
  