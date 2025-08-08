import axios from "axios";
import fs from "fs/promises";
import path from "path";

const NASDAQ_TRADED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt";
const OUT = "./super_pony/scanner/all_tickers.txt";

function parsePipeTxt(txt) {
  const lines = txt.trim().split(/\r?\n/);
  const headers = lines[0].split("|").map(h => h.trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  return lines.slice(1).map(l => l.split("|")).filter(cols => cols.length === headers.length).map(cols => ({
    symbol: cols[idx["CQS Symbol"]] || cols[idx["Symbol"]],
    test: cols[idx["Test Issue"]],
    isEtf: cols[idx["ETF"]],
  }));
}

const ensureDir = async (f) => fs.mkdir(path.dirname(f), { recursive: true });

(async () => {
  const { data } = await axios.get(NASDAQ_TRADED_URL, { responseType: "text" });
  const rows = parsePipeTxt(data);

  // Keep active + non-test issues. (You can also filter out ETFs by isEtf === "N" if you want.)
  const tickers = rows
    .filter(r => r.symbol && r.test === "N")
    .map(r => r.symbol.trim().toUpperCase())
    .filter(Boolean);

  // Optional: normalize class/series variants if you want dots instead of hyphens:
  // const tickers = raw.map(t => t.replace(/-/g, "."));

  const unique = Array.from(new Set(tickers)).sort();
  await ensureDir(OUT);
  await fs.writeFile(OUT, unique.join("\n") + "\n", "utf-8");
  console.log(`Wrote ${unique.length} tickers to ${OUT}`);
})();
