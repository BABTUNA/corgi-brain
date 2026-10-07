// Composes the Corgi Brain asset files. The corgi head is drawn from plain shapes; the words
// are Archivo 800 outlines from paths.json (python3 extract.py), so no font is needed anywhere.
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('paths.json', 'utf8'));
const OUT = process.argv[2] || '..';
// Fawn palette: a red-fawn corgi.
const C = { fawn: '#E8873A', fawnDeep: '#CF7128', fawnInk: '#A34F1A', cream: '#FFF6EA', blush: '#F6C9A0', ink: '#1E1B18', white: '#FFFFFF', paper: '#FAF7F2', line: '#EAE3D9', stone: '#6E665E' };
fs.mkdirSync(`${OUT}/logo`, { recursive: true });

// The corgi head in a 512 box (content spans about x 62-450, y 58-460).
const HEAD = 'M256 186 C150 186 76 236 76 316 C76 396 160 446 256 446 C352 446 436 396 436 316 C436 236 362 186 256 186 Z';
let uid = 0;
function head(c, id = `h${uid++}`) {
  return `<defs><clipPath id="${id}"><path d="${HEAD}"/></clipPath></defs>
    <g stroke-linejoin="round" stroke-width="28">
      <path d="M96 268 L150 72 L270 196 Z" fill="${c.fur}" stroke="${c.fur}"/>
      <path d="M416 268 L362 72 L242 196 Z" fill="${c.fur}" stroke="${c.fur}"/>
      <path d="M140 224 L162 124 L222 188 Z" fill="${c.ear}" stroke="${c.ear}" stroke-width="16"/>
      <path d="M372 224 L350 124 L290 188 Z" fill="${c.ear}" stroke="${c.ear}" stroke-width="16"/>
    </g>
    <path d="${HEAD}" fill="${c.fur}"/>
    <path clip-path="url(#${id})" d="M256 196 C240 196 236 250 226 300 C212 350 150 360 150 400 C150 432 200 456 256 456 C312 456 362 432 362 400 C362 360 300 350 286 300 C276 250 272 196 256 196 Z" fill="${c.blaze}"/>
    <path d="${HEAD}" fill="none" stroke="${c.fur}" stroke-width="20"/>
    <circle cx="186" cy="306" r="16" fill="${c.eye}"/><circle cx="326" cy="306" r="16" fill="${c.eye}"/>
    <path d="M230 358 Q256 344 282 358 Q278 384 256 390 Q234 384 230 358 Z" fill="${c.eye}"/>`;
}
const FAWN = { fur: C.fawn, ear: C.blush, blaze: C.cream, eye: C.ink };
const ON_FAWN = { fur: C.cream, ear: C.blush, blaze: C.white, eye: C.ink };
// one colour: silhouette with the eyes and nose cut out
const mono = (id = `m${uid++}`) => `<defs><mask id="${id}"><rect width="512" height="512" fill="#fff"/>
    <circle cx="186" cy="306" r="16"/><circle cx="326" cy="306" r="16"/><path d="M230 358 Q256 344 282 358 Q278 384 256 390 Q234 384 230 358 Z"/></mask></defs>
    <g mask="url(#${id})" fill="currentColor"><g stroke="currentColor" stroke-linejoin="round" stroke-width="28"><path d="M96 268 L150 72 L270 196 Z"/><path d="M416 268 L362 72 L242 196 Z"/></g><path d="${HEAD}"/></g>`;

const svgHead = (w, h, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}">`;
const write = (file, w, h, label, comment, body) => fs.writeFileSync(`${OUT}/logo/${file}`, `${svgHead(w, h, label)}\n  <!-- ${comment} -->\n  ${body}\n</svg>\n`);
const placed = (body, x, y, k) => `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})">${body}</g>`;
const word = (text, x, baseline, capH, fill) => {
  const k = capH / P.capH;
  return { svg: `<path d="${P[text].d}" fill="${fill}" transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${k.toFixed(4)})"/>`, width: P[text].adv * k, space: P.space * k };
};

// --- marks (512 box) ---
write('corgibrain-mark.svg', 512, 512, 'Corgi Brain mark', 'Primary mark: the fawn corgi head. Works on white, paper and ink.', head(FAWN));
write('corgibrain-mark-dark.svg', 512, 512, 'Corgi Brain mark', 'Same head, for ink or dark surfaces (kept as its own file so pages can pick by name).', head(FAWN));
write('corgibrain-mark-on-fawn.svg', 512, 512, 'Corgi Brain mark', 'For the fawn field: cream head, white blaze.', head(ON_FAWN));
write('corgibrain-mark-mono.svg', 512, 512, 'Corgi Brain mark', 'Single colour. Set color on the parent.', mono());

// --- wordmarks: head (340 tall) + Corgi Brain ---
let geom;
{
  const k = 340 / 512, capH = 128, H = 512, markX = -36 * k, markY = (H - 340) / 2 + 8, baseline = 340;
  const textX = 450 * k + markX + 36;
  const build = (file, c, text, accent, comment) => {
    const w1 = word('Corgi', textX, baseline, capH, text);
    const w2 = word('Brain', textX + w1.width + w1.space, baseline, capH, accent);
    const totalW = Math.ceil(textX + w1.width + w1.space + w2.width + 8);
    geom = { totalW, H };
    write(file, totalW, H, 'Corgi Brain', comment, placed(head(c), markX, markY, k) + '\n  ' + w1.svg + '\n  ' + w2.svg);
  };
  build('corgibrain-wordmark.svg', FAWN, C.ink, C.fawn, 'Wordmark for white or light surfaces. All outlined, no font needed.');
  build('corgibrain-wordmark-dark.svg', FAWN, C.cream, C.fawn, 'Wordmark for ink or dark surfaces.');
  build('corgibrain-wordmark-on-fawn.svg', ON_FAWN, C.ink, C.white, 'Wordmark for the fawn field.');
  fs.writeFileSync('wordmark-geom.json', JSON.stringify(geom));
}

// --- app icons (512 tile, head at 80%) ---
{
  const k = 0.8, x = (512 - 512 * k) / 2, y = (512 - 512 * k) / 2 - 6;
  const tile = (file, bg, c, comment) => write(file, 512, 512, 'Corgi Brain', comment, `<rect width="512" height="512" rx="112" fill="${bg}"/>\n  ${placed(head(c), x, y, k)}`);
  tile('corgibrain-icon.svg', C.cream, FAWN, 'App icon: cream tile, fawn corgi.');
  tile('corgibrain-icon-dark.svg', C.ink, FAWN, 'App icon, ink tile.');
  tile('corgibrain-icon-fawn.svg', C.fawn, ON_FAWN, 'App icon, fawn tile: cream corgi.');
}

// --- render pages ---
const read = f => fs.readFileSync(`${OUT}/logo/${f}`, 'utf8').replace(/<svg[^>]*>/, m => m.replace(/width="\d+" height="\d+"/, ''));
const page = (title, body, css) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&family=Onest:wght@500&display=swap">\n<style>html,body{margin:0}${css}</style></head><body>${body}</body></html>\n`;
const banner = (file, wm, bg, grid, tag) => fs.writeFileSync(file, page('Corgi Brain banner', `<div class="b"><div class="wm">${read(wm)}</div><p>Your team's know-how for every web app, kept current by an agent.</p></div>`,
  `body{background:${bg}} .b{width:1280px;height:640px;background:${bg};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;position:relative;overflow:hidden}
   .b:before{content:"";position:absolute;inset:0;background-image:radial-gradient(${grid} 1.5px,transparent 1.5px);background-size:28px 28px}
   .b:after{content:"";position:absolute;left:0;right:0;bottom:0;height:8px;background:${C.fawn}}
   .wm{position:relative;width:820px} .wm svg{width:100%;height:auto;display:block}
   p{position:relative;margin:0;font:500 26px Onest,sans-serif;color:${tag}}`));
banner('banner.html', 'corgibrain-wordmark.svg', C.paper, 'rgba(30,27,24,.07)', C.stone);
banner('banner-dark.html', 'corgibrain-wordmark-dark.svg', C.ink, 'rgba(255,246,234,.07)', '#B9AFA4');
const bare = (file, svg, css) => fs.writeFileSync(file, page('Corgi Brain', svg, `body{background:transparent} ${css}`));
bare('icon.html', read('corgibrain-icon.svg'), 'svg{width:100vw;height:100vh;display:block}');
for (const [f, s] of [['wordmark.html', 'corgibrain-wordmark.svg'], ['wordmark-dark.html', 'corgibrain-wordmark-dark.svg']])
  bare(f, `<div class="w">${read(s)}</div>`, `.w{width:${geom.totalW / 2}px} svg{width:100%;height:auto;display:block}`);

// contact sheet
const cell = (bg, inner, cap) => `<div class="card"><div class="cell" style="background:${bg}">${inner}</div><small>${cap}</small></div>`;
const sw = (hex, name, use) => `<div class="sw"><i style="background:${hex}"></i><b>${name}</b><span>${hex}</span><span>${use}</span></div>`;
fs.writeFileSync('sheet.html', page('Corgi Brain logo sheet',
  `<div class="sheet"><h2>Palette · Fawn</h2><div class="row">
    ${sw(C.fawn, 'Fawn', 'fur, "Brain", fills, glow')}${sw(C.fawnInk, 'Fawn ink', 'buttons, orange text')}${sw(C.cream, 'Cream', 'blaze, tiles')}${sw(C.blush, 'Blush', 'inner ears, tints')}${sw(C.ink, 'Ink', 'text, eyes')}${sw(C.paper, 'Paper', 'page background')}${sw(C.stone, 'Stone', 'muted text')}
  </div><h2>Marks · assets/logo</h2><div class="row">
    ${cell(C.white, read('corgibrain-mark.svg'), 'corgibrain-mark.svg · primary')}
    ${cell(C.ink, read('corgibrain-mark-dark.svg'), 'corgibrain-mark-dark.svg · on ink')}
    ${cell(C.fawn, read('corgibrain-mark-on-fawn.svg'), 'corgibrain-mark-on-fawn.svg · on fawn')}
    ${cell(C.paper, `<div style="color:${C.ink};width:220px;height:220px">${read('corgibrain-mark-mono.svg')}</div>`, 'corgibrain-mark-mono.svg · one colour')}
  </div><h2>Icons · assets/icons</h2><div class="row"><div class="card"><div class="strip">
    <img src="../icons/icon-512.png" width="160" height="160"><img src="../icons/icon-256.png" width="128" height="128"><img src="../icons/icon-128.png" width="96" height="96"><img src="../icons/icon-48.png" width="48" height="48"><img src="../icons/icon-32.png" width="32" height="32"><img src="../icons/icon-16.png" width="16" height="16">
  </div><small>icon-512 · 256 · 128 · 48 · 32 · 16</small></div>
    ${cell(C.paper, `<div style="width:160px;height:160px">${read('corgibrain-icon-dark.svg')}</div>`, 'corgibrain-icon-dark.svg')}
    ${cell(C.paper, `<div style="width:160px;height:160px">${read('corgibrain-icon-fawn.svg')}</div>`, 'corgibrain-icon-fawn.svg')}
  </div><h2>Wordmarks · assets/logo and assets/banner</h2><div class="row">
    ${cell(C.white, `<div style="width:88%">${read('corgibrain-wordmark.svg')}</div>`, 'corgibrain-wordmark.svg · primary')}
    ${cell(C.ink, `<div style="width:88%">${read('corgibrain-wordmark-dark.svg')}</div>`, 'corgibrain-wordmark-dark.svg · on ink')}
    ${cell(C.fawn, `<div style="width:88%">${read('corgibrain-wordmark-on-fawn.svg')}</div>`, 'corgibrain-wordmark-on-fawn.svg · on fawn')}
  </div></div>`,
  `body{background:#EFEAE3;font-family:"JetBrains Mono",monospace;color:${C.stone}} .sheet{width:1600px;box-sizing:border-box;padding:40px;display:flex;flex-direction:column;gap:24px}
   h2{font:600 11px "JetBrains Mono",monospace;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 -8px;color:${C.fawnInk}}
   .row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start} .card{display:flex;flex-direction:column;gap:8px;align-items:center}
   .card small{font-size:11px;text-align:center;max-width:360px} .cell{width:360px;height:240px;border-radius:12px;border:1px solid ${C.line};display:flex;align-items:center;justify-content:center}
   .cell>svg{width:200px;height:200px} .cell div svg{width:100%;height:auto;display:block}
   .strip{display:flex;gap:20px;align-items:flex-end;padding:24px;height:192px;box-sizing:content-box;border-radius:12px;border:1px solid ${C.line};background:${C.white}} img{display:block}
   .sw{display:flex;flex-direction:column;gap:4px;font-size:11px;width:200px} .sw i{height:72px;border-radius:10px;border:1px solid #0001} .sw b{color:${C.ink};font-weight:600;margin-top:4px}`));
console.log('composed', geom);
