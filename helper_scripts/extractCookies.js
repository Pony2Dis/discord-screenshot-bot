// extractCookies.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { CookieJar, Cookie } = require('tough-cookie');

(async () => {
  // 1) Load profile path from .env
  const profile = process.env.FIREFOX_PROFILE_PATH;
  if (!profile) {
    console.error('❌ Set FIREFOX_PROFILE_PATH in your .env');
    process.exit(1);
  }

  // 2) Read cookies.sqlite via sql.js
  const dbFile = path.join(profile, 'cookies.sqlite');
  let buffer;
  try {
    buffer = fs.readFileSync(dbFile);
  } catch (err) {
    console.error('❌ Error reading cookies.sqlite:', err.message);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(buffer);

  // 3) Query cookies for twitter.com and x.com with necessary fields
  const res = db.exec(`
    SELECT host, name, value, path, isSecure, expiry, isHttpOnly, sameSite
      FROM moz_cookies
     WHERE host LIKE '%.twitter.com' OR host LIKE '%.x.com'
     ORDER BY expiry DESC
     LIMIT 100
  `);

  if (!res.length || !res[0].values.length) {
    console.error('❌ No twitter.com or x.com cookies found!');
    process.exit(1);
  } else {
    console.log(`${res[0].values.length} twitter.com/x.com cookies found`);
  }

  // 4) Build a tough-cookie jar
  const jar = new CookieJar();
  const { columns, values } = res[0];
  const seenCookies = new Set(); // Track unique cookies to avoid duplicates
  for (let row of values) {
    const c = columns.reduce((o, col, i) => ({ ...o, [col]: row[i] }), {});
    const cookieKey = `${c.name}:${c.host}:${c.path}`; // Uniquely identify cookies

    // Skip duplicates (keep most recent due to ORDER BY expiry DESC)
    if (seenCookies.has(cookieKey)) {
      console.log(`Skipping duplicate cookie: ${c.name} for ${c.host}`);
      continue;
    }
    seenCookies.add(cookieKey);

    // Log cookie details for debugging
    console.log('Processing cookie:', {
      name: c.name,
      value: c.value,
      domain: c.host,
      path: c.path,
      secure: !!c.isSecure,
      httpOnly: !!c.isHttpOnly,
      sameSite: c.sameSite,
      expiry: c.expiry ? new Date(c.expiry * 1000) : 'Session'
    });

    try {
      const cookie = new Cookie({
        key: c.name,
        value: c.value,
        domain: c.host.startsWith('.') ? c.host.slice(1) : c.host,
        path: c.path || '/',
        secure: !!c.isSecure,
        httpOnly: !!c.isHttpOnly,
        sameSite: c.sameSite === '0' ? 'None' : c.sameSite || undefined, // Map Firefox sameSite
        expires: c.expiry ? new Date(c.expiry * 1000) : undefined
      });
      jar.setCookieSync(cookie, `https://${c.host.startsWith('.') ? c.host.slice(1) : c.host}`);
    } catch (err) {
      console.warn(`⚠️ Failed to set cookie ${c.name}: ${err.message}`);
    }
  }

  // 5) Serialize headers for both twitter.com and x.com
  const domains = ['twitter.com', 'x.com'];
  let headers = {};
  for (const domain of domains) {
    try {
      headers[domain] = jar.getCookieStringSync(`https://${domain}`, { expire: false });
      console.log(`Cookie header for ${domain} (length: ${headers[domain].length}):`, headers[domain]);
    } catch (err) {
      console.warn(`⚠️ Error generating cookie header for ${domain}: ${err.message}`);
      headers[domain] = '';
    }
  }

  // Write the non-empty header (prefer x.com if available)
  const header = headers['x.com'] || headers['twitter.com'];
  if (header.length === 0) {
    console.warn('⚠️ Cookie header is empty! Check cookie attributes or login status.');
  }

  const outPath = path.resolve(process.cwd(), 'cookies.txt');
  try {
    fs.writeFileSync(outPath, header, { encoding: 'utf-8', flag: 'w' });
    console.log('✅ cookies.txt written to:', outPath);
  } catch (err) {
    console.error('❌ Error writing cookies.txt:', err.message);
    process.exit(1);
  }

  // 6) Check for authentication cookies
  const authCookies = values.some(row => ['auth_token', 'ct0'].includes(row[1]));
  if (!authCookies) {
    console.warn('⚠️ No auth_token or ct0 cookies found. You may not be logged in.');
  }

  // 7) Clean up
  db.close();
})();