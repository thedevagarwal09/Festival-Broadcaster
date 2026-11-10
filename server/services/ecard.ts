/**
 * Festival e-card generator (sharp + SVG).
 *
 * Draws a 1080×1350 (4:5) card: gradient background, decorative frame, a festival motif, a title
 * and an optional sign-off line. The card is the same for every recipient (personalisation stays in
 * the caption), so it is uploaded to WhatsApp once and reused for the whole campaign.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { CardMotif, Occasion } from '../../src/lib/occasions';
import type { MediaInfo } from '../../src/lib/types';

const W = 1080;
const H = 1350;
const FONT =
  "'Noto Sans Devanagari', 'Lohit Devanagari', 'Kohinoor Devanagari', 'Noto Sans', 'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif";

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Small deterministic RNG so a card looks the same when regenerated with the same text. */
function rng(seedText: string): () => number {
  let a = [...seedText].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 1779033703);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FESTIVE = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff70a6', '#ff924c', '#52b788'];

/** Positions in the top and bottom bands, away from the text in the middle. */
function edgePoints(r: () => number, count: number): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const top = i % 2 === 0;
    return [80 + r() * (W - 160), top ? 90 + r() * 260 : H - 330 + r() * 240];
  });
}

function star(cx: number, cy: number, outer: number, fill: string): string {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const rad = i % 2 === 0 ? outer : outer * 0.45;
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    return `${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`;
  });
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

function motif(kind: CardMotif, accent: string, r: () => number): string {
  const out: string[] = [];
  switch (kind) {
    case 'diyas': {
      out.push('<defs><radialGradient id="glow"><stop offset="0" stop-color="#ffd27a" stop-opacity="0.65"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>');
      out.push('<linearGradient id="flame" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff6a00"/><stop offset="1" stop-color="#ffe066"/></linearGradient></defs>');
      const xs = [190, 365, 540, 715, 890];
      for (const [i, x] of xs.entries()) {
        const y = H - 190 + (i % 2) * 18;
        out.push(`<circle cx="${x}" cy="${y - 70}" r="95" fill="url(#glow)"/>`);
        out.push(`<path d="M${x - 70},${y} Q${x},${y + 70} ${x + 70},${y} Z" fill="#c2410c"/>`);
        out.push(`<path d="M${x - 70},${y} Q${x},${y + 20} ${x + 70},${y}" fill="none" stroke="${accent}" stroke-width="6"/>`);
        out.push(`<path d="M${x},${y - 85} C${x + 22},${y - 50} ${x + 18},${y - 18} ${x},${y - 8} C${x - 18},${y - 18} ${x - 22},${y - 50} ${x},${y - 85} Z" fill="url(#flame)"/>`);
      }
      for (let i = 0; i < 40; i++) out.push(`<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * 330 + 60).toFixed(0)}" r="${(r() * 3 + 1).toFixed(1)}" fill="${accent}" opacity="${(r() * 0.6 + 0.3).toFixed(2)}"/>`);
      break;
    }
    case 'splashes':
      for (const [x, y] of edgePoints(r, 26)) {
        const c = FESTIVE[Math.floor(r() * FESTIVE.length)];
        out.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(r() * 70 + 25).toFixed(0)}" fill="${c}" opacity="${(r() * 0.35 + 0.35).toFixed(2)}"/>`);
        for (let k = 0; k < 4; k++) out.push(`<circle cx="${(x + (r() - 0.5) * 220).toFixed(0)}" cy="${(y + (r() - 0.5) * 180).toFixed(0)}" r="${(r() * 14 + 4).toFixed(0)}" fill="${c}" opacity="0.6"/>`);
      }
      break;
    case 'fireworks':
      for (const [x, y] of edgePoints(r, 6)) {
        const c = FESTIVE[Math.floor(r() * FESTIVE.length)];
        const rays = 18;
        const len = r() * 80 + 90;
        for (let k = 0; k < rays; k++) {
          const a = (Math.PI * 2 * k) / rays;
          const x2 = x + Math.cos(a) * len;
          const y2 = y + Math.sin(a) * len;
          out.push(`<line x1="${(x + Math.cos(a) * 20).toFixed(0)}" y1="${(y + Math.sin(a) * 20).toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}" stroke="${c}" stroke-width="4" stroke-linecap="round" opacity="0.9"/>`);
          out.push(`<circle cx="${x2.toFixed(0)}" cy="${y2.toFixed(0)}" r="5" fill="${accent}"/>`);
        }
      }
      break;
    case 'bells':
      for (const [x, s] of [[300, 1], [780, -1]] as const) {
        const y = 230;
        out.push(`<g transform="translate(${x},${y}) rotate(${12 * s})"><path d="M-70,60 C-70,-20 -45,-75 0,-80 C45,-75 70,-20 70,60 L85,80 L-85,80 Z" fill="${accent}"/><circle cx="0" cy="92" r="16" fill="#f4d35e"/><path d="M-30,-85 Q0,-120 30,-85" fill="none" stroke="#f4d35e" stroke-width="10"/></g>`);
      }
      out.push(`<path d="M420,150 Q540,110 660,150" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round"/>`);
      for (let i = 0; i < 70; i++) out.push(`<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * H).toFixed(0)}" r="${(r() * 4 + 2).toFixed(1)}" fill="#ffffff" opacity="${(r() * 0.5 + 0.3).toFixed(2)}"/>`);
      break;
    case 'kites':
      for (const [x, y] of edgePoints(r, 7)) {
        const c = FESTIVE[Math.floor(r() * FESTIVE.length)];
        const s = r() * 30 + 45;
        out.push(`<g transform="rotate(${(r() * 30 - 15).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"><polygon points="${x},${y - s} ${x + s * 0.8},${y} ${x},${y + s * 1.2} ${x - s * 0.8},${y}" fill="${c}"/><line x1="${x}" y1="${y - s}" x2="${x}" y2="${y + s * 1.2}" stroke="#fff" stroke-width="3" opacity="0.7"/><path d="M${x},${y + s * 1.2} q20,40 -10,80 q-30,40 0,80" fill="none" stroke="${c}" stroke-width="3"/></g>`);
      }
      break;
    case 'tricolor': {
      out.push(`<rect x="0" y="0" width="${W}" height="150" fill="#FF9933"/><rect x="0" y="${H - 150}" width="${W}" height="150" fill="#138808"/>`);
      const cx = W / 2;
      const cy = 330;
      out.push(`<circle cx="${cx}" cy="${cy}" r="95" fill="none" stroke="#000080" stroke-width="8"/><circle cx="${cx}" cy="${cy}" r="14" fill="#000080"/>`);
      for (let k = 0; k < 24; k++) {
        const a = (Math.PI * 2 * k) / 24;
        out.push(`<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * 92).toFixed(1)}" y2="${(cy + Math.sin(a) * 92).toFixed(1)}" stroke="#000080" stroke-width="3"/>`);
      }
      break;
    }
    case 'moon':
      out.push(`<defs><mask id="crescent"><rect width="${W}" height="${H}" fill="#fff"/><circle cx="600" cy="230" r="120" fill="#000"/></mask></defs>`);
      out.push(`<circle cx="540" cy="260" r="140" fill="${accent}" mask="url(#crescent)"/>`);
      for (let i = 0; i < 18; i++) out.push(star(r() * W, r() * 420 + 40, r() * 10 + 6, accent));
      out.push(`<g transform="translate(${W / 2},${H - 230})"><rect x="-38" y="-70" width="76" height="120" rx="14" fill="${accent}" opacity="0.9"/><rect x="-22" y="-50" width="44" height="80" rx="8" fill="#fff7d6"/><path d="M-30,-70 L0,-110 L30,-70 Z" fill="${accent}"/></g>`);
      break;
    case 'flowers':
      for (const [x, y] of [[110, 120], [W - 110, 120], [110, H - 120], [W - 110, H - 120], [W / 2, 120], [W / 2, H - 110]] as const) {
        const petals = 8;
        for (let k = 0; k < petals; k++) out.push(`<ellipse cx="${x}" cy="${y - 42}" rx="20" ry="44" fill="${accent}" opacity="0.85" transform="rotate(${(360 / petals) * k} ${x} ${y})"/>`);
        out.push(`<circle cx="${x}" cy="${y}" r="22" fill="#ffd166"/>`);
      }
      break;
    case 'leaves':
      for (const [x, y] of edgePoints(r, 22)) {
        const c = ['#c2410c', '#d97706', '#b45309', '#9a3412', '#ca8a04'][Math.floor(r() * 5)];
        out.push(`<g transform="rotate(${(r() * 360).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"><ellipse cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" rx="${(r() * 18 + 22).toFixed(0)}" ry="${(r() * 10 + 12).toFixed(0)}" fill="${c}" opacity="0.85"/><line x1="${(x - 30).toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x + 30).toFixed(0)}" y2="${y.toFixed(0)}" stroke="#7c2d12" stroke-width="2"/></g>`);
      }
      break;
    case 'balloons':
      for (const [i, x] of [120, 240, 840, 960].entries()) {
        for (let k = 0; k < 2; k++) {
          const c = FESTIVE[(i * 2 + k) % FESTIVE.length];
          const bx = x + (k ? 50 : 0);
          const by = 230 + k * 110 + (i % 2) * 40;
          out.push(`<ellipse cx="${bx}" cy="${by}" rx="52" ry="64" fill="${c}"/><ellipse cx="${bx - 18}" cy="${by - 24}" rx="10" ry="16" fill="#fff" opacity="0.5"/><path d="M${bx},${by + 64} q14,60 -6,120 q-20,60 6,120" fill="none" stroke="${c}" stroke-width="3"/>`);
        }
      }
      for (let i = 0; i < 60; i++) out.push(`<rect x="${(r() * W).toFixed(0)}" y="${(r() * 300 + H - 360).toFixed(0)}" width="10" height="18" fill="${FESTIVE[i % FESTIVE.length]}" transform="rotate(${(r() * 90).toFixed(0)})" opacity="0.8"/>`);
      break;
    case 'hearts':
      for (const [x, y] of edgePoints(r, 18)) {
        const s = r() * 0.8 + 0.5;
        out.push(`<path transform="translate(${x.toFixed(0)},${y.toFixed(0)}) scale(${s.toFixed(2)})" d="M0,30 C-55,-10 -35,-60 0,-30 C35,-60 55,-10 0,30 Z" fill="${accent}" opacity="${(r() * 0.4 + 0.45).toFixed(2)}"/>`);
      }
      break;
    case 'mandala': {
      const cx = W / 2;
      const cy = 300;
      for (const [ring, count, rx, ry, op] of [[150, 24, 16, 46, 0.35], [105, 16, 18, 40, 0.55], [60, 12, 14, 28, 0.85]] as const) {
        for (let k = 0; k < count; k++) out.push(`<ellipse cx="${cx}" cy="${cy - ring}" rx="${rx}" ry="${ry}" fill="${accent}" opacity="${op}" transform="rotate(${(360 / count) * k} ${cx} ${cy})"/>`);
      }
      out.push(`<circle cx="${cx}" cy="${cy}" r="32" fill="${accent}"/><circle cx="${cx}" cy="${cy}" r="180" fill="none" stroke="${accent}" stroke-width="3" opacity="0.5"/>`);
      for (const [x, y] of [[120, H - 150], [W - 120, H - 150]] as const) {
        for (let k = 0; k < 12; k++) out.push(`<ellipse cx="${x}" cy="${y - 40}" rx="10" ry="30" fill="${accent}" opacity="0.6" transform="rotate(${30 * k} ${x} ${y})"/>`);
      }
      break;
    }
    case 'confetti':
      for (let i = 0; i < 140; i++) {
        const x = r() * W;
        const y = r() < 0.5 ? r() * 360 + 50 : H - 60 - r() * 330;
        out.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${(r() * 10 + 8).toFixed(0)}" height="${(r() * 14 + 10).toFixed(0)}" fill="${FESTIVE[i % FESTIVE.length]}" transform="rotate(${(r() * 180).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`);
      }
      break;
  }
  return out.join('');
}

/** Break a title into at most 3 lines of roughly equal length. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export interface ECardInput {
  occasion: Occasion;
  title: string;
  subtitle: string;
}

export function renderECardSvg({ occasion, title, subtitle }: ECardInput): string {
  const [bgTop, bgBottom, accent, textColor] = occasion.card.palette;
  const r = rng(`${occasion.id}|${title}|${subtitle}`);
  const lines = wrap(title, 14);
  const longest = Math.max(...lines.map((l) => [...l].length), 1);
  const size = Math.min(140, Math.floor(1500 / longest));
  const lineGap = size * 1.12;
  const blockTop = H / 2 - ((lines.length - 1) * lineGap) / 2 + size * 0.3;
  const subLines = subtitle ? wrap(subtitle, 34).slice(0, 2) : [];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgTop}"/><stop offset="1" stop-color="${bgBottom}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${motif(occasion.card.motif, accent, r)}
  <rect x="36" y="36" width="${W - 72}" height="${H - 72}" rx="36" fill="none" stroke="${accent}" stroke-width="6" opacity="0.85"/>
  <rect x="56" y="56" width="${W - 112}" height="${H - 112}" rx="26" fill="none" stroke="${accent}" stroke-width="2" opacity="0.5"/>
  ${lines
    .map(
      (l, i) =>
        `<text x="${W / 2}" y="${(blockTop + i * lineGap).toFixed(0)}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${textColor}">${esc(l)}</text>`,
    )
    .join('\n  ')}
  <line x1="${W / 2 - 120}" y1="${(blockTop + (lines.length - 1) * lineGap + size * 0.55).toFixed(0)}" x2="${W / 2 + 120}" y2="${(blockTop + (lines.length - 1) * lineGap + size * 0.55).toFixed(0)}" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>
  ${subLines
    .map(
      (l, i) =>
        `<text x="${W / 2}" y="${(blockTop + (lines.length - 1) * lineGap + size * 0.55 + 80 + i * 56).toFixed(0)}" text-anchor="middle" font-family="${FONT}" font-weight="500" font-size="44" fill="${textColor}" opacity="0.9">${esc(l)}</text>`,
    )
    .join('\n  ')}
</svg>`;
}

/** Render the card to a JPEG in the uploads folder and return it as an attachment. */
export async function createECard(input: ECardInput, outputDir: string, owner: string): Promise<MediaInfo> {
  const svg = renderECardSvg(input);
  const data = await sharp(Buffer.from(svg)).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  const file = `${Date.now()}-${randomUUID()}.jpg`;
  await fs.writeFile(path.join(outputDir, file), data);
  const info: MediaInfo = {
    file,
    mediaType: 'image',
    mimeType: 'image/jpeg',
    size: data.length,
    originalSize: data.length,
    originalName: `${input.occasion.name} e-card.jpg`,
    width: W,
    height: H,
    durationSec: null,
    compressed: true,
    note: `${input.occasion.name} e-card — the same card goes to everyone; the caption is personalised.`,
  };
  // owner: lets Erase my data find this file. It is never sent to the browser.
  await fs.writeFile(path.join(outputDir, `${file}.json`), JSON.stringify({ ...info, owner }));
  return info;
}
