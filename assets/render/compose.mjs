// Composes the Supa Brain asset files from the outlines in paths.json (Syne 800 mark, Archivo 800 words).
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('paths.json', 'utf8'));
const OUT = process.argv[2] || '..';
// Core Supabase palette: jade green on near-black.
const C = { green: '#3ECF8E', greenDeep: '#24B47E', night: '#171717', surface: '#1C1C1C', border: '#2E2E2E', snow: '#EDEDED', white: '#FFFFFF', muted: '#898989' };
fs.mkdirSync(`${OUT}/logo`, { recursive: true });

const S = P.S, B = P.B; // glyph paths at nominal size 300, baseline at y=0
const bh = B.bbox.y2 - B.bbox.y1;
const glyph = (g, x, baseline, k, fill) =>
  `<path d="${g.d}" fill="${fill}" transform="translate(${(x - g.bbox.x1 * k).toFixed(2)} ${baseline.toFixed(2)}) scale(${k.toFixed(4)})"/>`;

// The SB pair: S then B on one baseline, `gap` apart, B cap height `h`, left edge at x, top of B at y.
function pair(x, y, h, gap, sFill, bFill) {
  const k = h / bh, sw = (S.bbox.x2 - S.bbox.x1) * k, bw = (B.bbox.x2 - B.bbox.x1) * k, baseline = y + h;
  return { svg: glyph(S, x, baseline, k, sFill) + glyph(B, x + sw + gap, baseline, k, bFill), width: sw + gap + bw };
}
const word = (text, x, baseline, capH, fill) => {
  const k = capH / P.capH;
  return { svg: `<path d="${P[text].d}" fill="${fill}" transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${k.toFixed(4)})"/>`, width: P[text].adv * k, space: P.space * k };
};
const svgHead = (w, h, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">`;
const write = (file, w, h, label, comment, body) => fs.writeFileSync(`${OUT}/logo/${file}`, `${svgHead(w, h, label)}\n  <!-- ${comment} -->\n  ${body}\n</svg>\n`);

// --- marks (512 box) ---
const mk = (file, s, b, comment) => {
  const h = 136, gap = 14, w = pair(0, 0, h, gap, s, b).width;
  write(file, 512, 512, 'Supa Brain mark', comment, pair((512 - w) / 2, (512 - h) / 2, h, gap, s, b).svg);
};
mk('supabrain-mark-dark.svg', C.snow, C.green, 'For night or dark surfaces: snow S, green B.');
mk('supabrain-mark.svg', C.night, C.greenDeep, 'Primary mark, for white or light surfaces: night S, deep green B.');
mk('supabrain-mark-on-green.svg', C.night, C.white, 'For the green field: night S, white B.');
mk('supabrain-mark-mono.svg', 'currentColor', 'currentColor', 'Single colour. Set color on the parent.');

// --- wordmark (mark + Supa Brain) ---
let geom;
{
  const capH = 128, h = 200, gap = 20, after = 56, H = 512, baseline = 156 + h;
  const markW = pair(0, 0, h, gap, '', '').width;
  const build = (file, s, b, text, accent, comment) => {
    const w1 = word('Supa', markW + after, baseline, capH, text);
    const w2 = word('Brain', markW + after + w1.width + w1.space, baseline, capH, accent);
    const totalW = Math.ceil(markW + after + w1.width + w1.space + w2.width + 8);
    geom = { totalW, H };
    write(file, totalW, H, 'Supa Brain', comment, pair(0, 156, h, gap, s, b).svg + '\n  ' + w1.svg + '\n  ' + w2.svg);
  };
  build('supabrain-wordmark-dark.svg', C.snow, C.green, C.snow, C.green, 'Wordmark for night or dark surfaces. All outlined, no font needed.');
  build('supabrain-wordmark.svg', C.night, C.greenDeep, C.night, C.greenDeep, 'Wordmark for white or light surfaces.');
  build('supabrain-wordmark-on-green.svg', C.night, C.white, C.night, C.white, 'Wordmark for the green field.');
  fs.writeFileSync('wordmark-geom.json', JSON.stringify(geom));
}

// --- app icons (512 tile) ---
{
  const h = 116, gap = 12, w = pair(0, 0, h, gap, '', '').width, x = (512 - w) / 2, y = (512 - h) / 2;
  write('supabrain-icon.svg', 512, 512, 'Supa Brain', 'App icon: white tile, night S, deep green B.',
    `<rect width="512" height="512" rx="112" fill="${C.white}"/>\n  ${pair(x, y, h, gap, C.night, C.greenDeep).svg}`);
  write('supabrain-icon-dark.svg', 512, 512, 'Supa Brain', 'App icon, night tile: snow S, green B.',
    `<rect width="512" height="512" rx="112" fill="${C.night}"/>\n  ${pair(x, y, h, gap, C.snow, C.green).svg}`);
  write('supabrain-icon-green.svg', 512, 512, 'Supa Brain', 'App icon, green tile: night S, white B.',
    `<rect width="512" height="512" rx="112" fill="${C.green}"/>\n  ${pair(x, y, h, gap, C.night, C.white).svg}`);
}

// --- render pages ---
const read = f => fs.readFileSync(`${OUT}/logo/${f}`, 'utf8').replace(/<svg[^>]*>/, m => m.replace(/width="\d+" height="\d+"/, ''));
const page = (title, body, css) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&display=swap">\n<style>html,body{margin:0}${css}</style></head><body>${body}</body></html>\n`;
const banner = (file, wm, bg, grid) => fs.writeFileSync(file, page('Supa Brain banner', `<div class="b"><div class="wm">${read(wm)}</div></div>`,
  `body{background:${bg}} .b{width:1280px;height:640px;background:${bg};display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
   .b:before{content:"";position:absolute;inset:0;background-image:linear-gradient(${grid} 1px,transparent 1px),linear-gradient(90deg,${grid} 1px,transparent 1px);background-size:40px 40px}
   .b:after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:${C.green}}
   .wm{position:relative;width:860px} .wm svg{width:100%;height:auto;display:block}`));
banner('banner.html', 'supabrain-wordmark.svg', C.white, 'rgba(23,23,23,.05)');
banner('banner-dark.html', 'supabrain-wordmark-dark.svg', C.night, 'rgba(237,237,237,.05)');
const bare = (file, svg, css) => fs.writeFileSync(file, page('Supa Brain', svg, `body{background:transparent} ${css}`));
bare('icon.html', read('supabrain-icon.svg'), 'svg{width:100vw;height:100vh;display:block}');
for (const [f, s] of [['wordmark.html', 'supabrain-wordmark.svg'], ['wordmark-dark.html', 'supabrain-wordmark-dark.svg']])
  bare(f, `<div class="w">${read(s)}</div>`, `.w{width:${geom.totalW / 2}px} svg{width:100%;height:auto;display:block}`);

// contact sheet
const cell = (bg, inner, cap) => `<div class="card"><div class="cell" style="background:${bg}">${inner}</div><small>${cap}</small></div>`;
const sw = (hex, name, use) => `<div class="sw"><i style="background:${hex}"></i><b>${name}</b><span>${hex}</span><span>${use}</span></div>`;
fs.writeFileSync('sheet.html', page('Supa Brain base assets',
  `<div class="sheet"><h2>Palette · core Supabase colours</h2><div class="row">
    ${sw(C.green, 'Green', 'B, "Brain", actions')}${sw(C.greenDeep, 'Green deep', 'green on light, pressed')}${sw(C.night, 'Night', 'page background')}${sw(C.surface, 'Surface', 'cards')}${sw(C.border, 'Border', 'lines')}${sw(C.snow, 'Snow', 'text, the S')}${sw(C.muted, 'Muted', 'secondary text')}
  </div><h2>Marks · assets/logo</h2><div class="row">
    ${cell(C.white, read('supabrain-mark.svg'), 'supabrain-mark.svg · primary, on white')}
    ${cell(C.night, read('supabrain-mark-dark.svg'), 'supabrain-mark-dark.svg · on night')}
    ${cell(C.green, read('supabrain-mark-on-green.svg'), 'supabrain-mark-on-green.svg · on green')}
    ${cell(C.surface, `<div style="color:${C.snow};width:220px;height:220px">${read('supabrain-mark-mono.svg')}</div>`, 'supabrain-mark-mono.svg · one colour')}
  </div><h2>Icons · assets/icons</h2><div class="row"><div class="card"><div class="strip">
    <img src="../icons/icon-512.png" width="160" height="160"><img src="../icons/icon-256.png" width="128" height="128"><img src="../icons/icon-128.png" width="96" height="96"><img src="../icons/icon-48.png" width="48" height="48"><img src="../icons/icon-32.png" width="32" height="32"><img src="../icons/icon-16.png" width="16" height="16">
  </div><small>icon-512 · 256 · 128 · 48 · 32 · 16</small></div>
    ${cell(C.surface, `<div style="width:160px;height:160px">${read('supabrain-icon-green.svg')}</div>`, 'supabrain-icon-green.svg · alternate tile')}
    ${cell(C.surface, `<div style="width:160px;height:160px">${read('supabrain-icon-dark.svg')}</div>`, 'supabrain-icon-dark.svg · alternate tile')}
  </div><h2>Wordmarks · assets/logo and assets/banner</h2><div class="row">
    ${cell(C.white, `<div style="width:88%">${read('supabrain-wordmark.svg')}</div>`, 'supabrain-wordmark.svg · primary, on white')}
    ${cell(C.night, `<div style="width:88%">${read('supabrain-wordmark-dark.svg')}</div>`, 'supabrain-wordmark-dark.svg · on night')}
    ${cell(C.green, `<div style="width:88%">${read('supabrain-wordmark-on-green.svg')}</div>`, 'supabrain-wordmark-on-green.svg · on green')}
  </div></div>`,
  `body{background:#0F0F0F;font-family:"JetBrains Mono",monospace;color:${C.muted}} .sheet{width:1600px;box-sizing:border-box;padding:40px;display:flex;flex-direction:column;gap:24px}
   h2{font:600 11px "JetBrains Mono",monospace;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 -8px;color:${C.green}}
   .row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start} .card{display:flex;flex-direction:column;gap:8px;align-items:center}
   .card small{font-size:11px;text-align:center;max-width:360px} .cell{width:360px;height:240px;border-radius:12px;border:1px solid ${C.border};display:flex;align-items:center;justify-content:center}
   .cell>svg{width:220px;height:220px} .cell div svg{width:100%;height:auto;display:block}
   .strip{display:flex;gap:20px;align-items:flex-end;padding:24px;height:192px;box-sizing:content-box;border-radius:12px;border:1px solid ${C.border};background:${C.surface}} img{display:block}
   .sw{display:flex;flex-direction:column;gap:4px;font-size:11px;width:200px} .sw i{height:72px;border-radius:10px;border:1px solid ${C.border}} .sw b{color:${C.snow};font-weight:600;margin-top:4px}`));
console.log('composed', geom);
