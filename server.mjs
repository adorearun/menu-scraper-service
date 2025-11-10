// server.mjs (ESM) — Microservice: POST /extract { url, model?, engine?, geo?, headless? } -> { items: [...] }

import Fastify from 'fastify';
import OpenAI from 'openai';
import * as playwright from 'playwright';
import sharp from 'sharp';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY'); process.exit(1);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const PRICE_SYM_RE = /[$€£¥₹₩₽]/;
const currencyFrom = (t='')=>{
  const sym = t.match(PRICE_SYM_RE)?.[0] || '';
  const map = { '$':'USD','€':'EUR','£':'GBP','¥':'JPY','₹':'INR','₩':'KRW','₽':'RUB' };
  return map[sym] || (t.match(/\bUSD|EUR|GBP|JPY|INR|KRW|RUB\b/i)?.[0]?.toUpperCase() || '');
};
const priceToNumber = (raw)=> {
  if (raw == null) return null;
  const m = String(raw).replace(/[, ]/g,'').match(/\d+(?:\.\d{1,2})?/);
  return m ? Number(m[0]) : null;
};
function dedup(rows){
  const seen = new Set();
  return rows.filter(r=>{
    const k = `${(r.item||'').toLowerCase()}::${(r.size||'').toLowerCase()}::${r.price}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

async function autoScroll(page, { step=1000, delay=250, max=60 }={}) {
  for (let i=0;i<max;i++){
    await page.evaluate(y => window.scrollBy(0, y), step);
    await page.waitForTimeout(delay);
  }
}

async function splitTallPng(pngBuf, targetHeight = 2800) {
  const meta = await sharp(pngBuf).metadata();
  if (!meta.height || meta.height <= targetHeight) return [pngBuf];
  const parts = [];
  let y = 0;
  while (y < meta.height) {
    const h = Math.min(targetHeight, meta.height - y);
    const part = await sharp(pngBuf).extract({ left: 0, top: y, width: meta.width, height: h }).png().toBuffer();
    parts.push(part);
    y += h;
  }
  return parts;
}
const bufferToDataUrl = (buf)=> `data:image/png;base64,${buf.toString('base64')}`;

async function openaiParseImages(buffers, model='gpt-4o-mini') {
  const content = [{
    type: 'text',
    text:
`You are a precise menu parser. Extract menu items from the image(s).
Return ONLY JSON:
{
  "items": [
    { "item": "Latte", "size": "12 oz", "price": 4.25, "description": "Espresso with steamed milk", "currency": "USD" }
  ]
}
Rules:
- One row per size/price (split multi-size entries).
- Price must be a number (no currency symbol).
- Keep names concise; do not merge multiple items.
- Include description only if clearly tied to the item; else "".
- Currency "" if unknown.`
  }];
  for (const buf of buffers) {
    content.push({ type: 'image_url', image_url: { url: bufferToDataUrl(buf) } });
  }

  const resp = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    temperature: 0.1,
    messages: [
      { role: 'system', content: 'Return accurate, structured data only.' },
      { role: 'user', content }
    ],
  });

  let rows = [];
  try {
    const json = JSON.parse(resp.choices?.[0]?.message?.content || '{"items": []}');
    rows = Array.isArray(json.items) ? json.items : [];
  } catch { rows = []; }

  rows = rows.map(r => ({
    item: (r.item || '').trim(),
    size: (r.size || '').trim(),
    price: typeof r.price === 'number' ? r.price : priceToNumber(r.price),
    description: (r.description || '').trim(),
    currency: (r.currency || '').toUpperCase() || currencyFrom(r.price_symbol || ''),
  })).filter(r => r.item && (r.price ?? null) !== null);

  return dedup(rows);
}

const pickLauncher = (engine) =>
  engine === 'firefox' ? playwright.firefox :
  engine === 'webkit'  ? playwright.webkit  :
                         playwright.chromium;

async function renderAndScreenshot({ url, engine='chromium', headless=true, geo, timeoutMs=180000 }) {
  const launcher = pickLauncher(engine);
  const browser = await launcher.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 2000 },
    userAgent: UA,
    geolocation: geo ? { latitude: Number(geo.split(',')[0]), longitude: Number(geo.split(',')[1]) } : undefined,
    permissions: geo ? ['geolocation'] : [],
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    } catch {}
  });

  const u = new URL(url);
  const hasHash = !!u.hash;
  const baseUrl = hasHash ? url.split('#')[0] : url;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(()=>{});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});

  const coax = async () => {
    const sels = [
      'a:has-text("Order Now")', 'button:has-text("Order Now")',
      'button:has-text("Start order")', 'button:has-text("Pickup")',
      'button:has-text("Delivery")', 'button:has-text("ASAP")',
      'button:has-text("Continue")'
    ];
    for (const sel of sels) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 600 })) {
          await el.click({ timeout: 1500 }).catch(()=>{});
          await page.waitForTimeout(400);
        }
      } catch {}
    }
  };

  await coax();
  if (hasHash) {
    await page.evaluate(h => { location.hash = h; }, u.hash).catch(()=>{});
    await page.waitForTimeout(800);
    await coax();
  }

  await autoScroll(page, { step: 1000, delay: 300, max: 80 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});

  const bodyText = (await page.evaluate(() => (document.body?.innerText || ''))).toLowerCase();
  if (bodyText.length < 200 || bodyText.includes("doesn't currently have any products")) {
    const root = `${u.protocol}//${u.host}/`;
    await page.goto(root, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
    const orderSels = [
      'a:has-text("Order Online")', 'a:has-text("Order")', 'a:has-text("Menu")',
      'button:has-text("Order Online")', 'button:has-text("Order")', 'button:has-text("Menu")'
    ];
    for (const sel of orderSels) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1200 })) {
          await el.click({ timeout: 2000 }).catch(()=>{});
          await page.waitForTimeout(600);
          break;
        }
      } catch {}
    }
    await autoScroll(page, { step: 1000, delay: 250, max: 50 });
  }

  const pngBuffer = await page.screenshot({ fullPage: true, type: 'png' });
  await browser.close();
  return pngBuffer;
}

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true }));

app.post('/extract', {
  schema: {
    body: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        model: { type: 'string', default: 'gpt-4o-mini' },
        engine: { type: 'string', enum: ['chromium','firefox','webkit'], default: 'chromium' },
        geo: { type: 'string' },         // "lat,lon"
        headless: { type: 'boolean', default: true }
      }
    }
  }
}, async (req, reply) => {
  const { url, model='gpt-4o-mini', engine='chromium', geo, headless=true } = req.body;
  try {
    const fullPng = await renderAndScreenshot({ url, engine, headless, geo });
    const chunks = await splitTallPng(fullPng, 2800);
    const items = await openaiParseImages(chunks, model);
    return reply.send({ items, meta: { chunks: chunks.length, engine, model } });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'extract_failed', message: String(err?.message || err) });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`→ up on http://localhost:${PORT}`);
});
