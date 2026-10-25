import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { chromium, type Browser } from 'playwright-core';
import { DATA_DIR } from './db.ts';

/**
 * Finished card PNGs (PRD 5단계). The screen's own render page (#/render/<id>/<n>)
 * draws one card at 1080×1350 from the saved layout, and the installed Edge (or
 * Chrome) takes a picture of it, so the file matches what the editor showed
 * (DECISIONS B27). No browser is downloaded.
 */

export const CARD_W = 1080;
export const CARD_H = 1350;
const CHANNELS = (process.env.CARD_NEWS_RENDER_BROWSER ?? 'msedge,chrome').split(',').map((s) => s.trim()).filter(Boolean);

let browser: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const errors: string[] = [];
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel });
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`카드를 찍을 브라우저(Edge 또는 Chrome)를 실행하지 못했습니다. ${errors.join(' / ')}`);
}

function getBrowser(): Promise<Browser> {
  browser ??= launch().then((b) => {
    b.on('disconnected', () => { browser = null; });
    return b;
  }, (err) => { browser = null; throw err; });
  return browser;
}

export async function closeRenderer() {
  const b = browser;
  browser = null;
  await (await b?.catch(() => null))?.close();
}

// One card at a time: a second request waits instead of opening more pages. The
// browser closes after a minute unused, so a server window closed without Ctrl+C
// does not leave it running for long.
const IDLE_MS = 60_000;
let idleTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  if (idleTimer) clearTimeout(idleTimer);
  const next = queue.then(fn, fn);
  queue = next.catch(() => {}).finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { closeRenderer().catch(() => {}); }, IDLE_MS);
    idleTimer.unref();
  });
  return next;
};

export const outputDir = (projectId: string) => path.join(DATA_DIR, 'projects', projectId, 'output');
export const outputName = (index: number) => `card-${String(index).padStart(2, '0')}.png`;

/** Where the text sat on the page that was pictured, in card pixels. */
export interface TextMeasure {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** A line or block wider than its box (text pushed sideways out of view). */
  overflowX: boolean;
  /** Text lying on the picture with too little contrast to read, or null. */
  overlap: string | null;
  /** The text drawn, without the ** highlight marks, to compare with the saved layout. */
  headline: string;
  body: string;
}

export interface RenderedCard {
  index: number;
  file: string;
  png: Buffer;
  /** Whether the card fonts actually loaded (otherwise a fallback font was used). */
  fontLoaded: boolean;
  measure: TextMeasure | null;
}

/** Throws unless `png` is a real PNG of exactly the card size. */
export function checkCardPng(png: Buffer) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 33 || !sig.every((b, i) => png[i] === b) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('만든 파일이 PNG 형식이 아닙니다.');
  }
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== CARD_W || h !== CARD_H) throw new Error(`만든 PNG 크기가 ${w}×${h}입니다(기대 ${CARD_W}×${CARD_H}).`);
}

/** Renders one card through the screen's render page and saves it under `dir` (default output/). */
export function renderCard(baseUrl: string, projectId: string, index: number, dir = outputDir(projectId)): Promise<RenderedCard> {
  return serial(async () => {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: CARD_W, height: CARD_H }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${baseUrl}/#/render/${projectId}/${index}`);
      await page.waitForFunction(() => {
        const w = window as unknown as { __renderReady?: boolean; __renderError?: string };
        return w.__renderReady || w.__renderError;
      }, null, { timeout: 30_000 });
      const state = await page.evaluate(() => {
        const w = window as unknown as { __renderError?: string; __renderFont?: boolean; __renderMeasure?: TextMeasure };
        return { error: w.__renderError ?? null, font: w.__renderFont === true, measure: w.__renderMeasure ?? null };
      });
      if (state.error) throw new Error(state.error);
      const png = await page.locator('#render-card .face').screenshot({ type: 'png', animations: 'disabled' });
      checkCardPng(png);
      mkdirSync(dir, { recursive: true });
      const file = outputName(index);
      writeFileSync(path.join(dir, file), png);
      return { index, file, png, fontLoaded: state.font, measure: state.measure };
    } finally {
      await page.close().catch(() => {});
    }
  });
}

/** A ZIP archive without compression (PNG is already compressed). */
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // UTF-8 names
    local.writeUInt16LE(0, 8);                // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}
