import json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
def load(path, axes):
    f = instancer.instantiateVariableFont(TTFont(path), axes)
    return f, f['head'].unitsPerEm, f.getGlyphSet(), f.getBestCmap(), f['hmtx']
f, upm, gs, cmap, hmtx = load('syne-var.ttf', {'wght': 800})            # the mark
fw, upmw, gsw, cmapw, hmtxw = load('archivo-var.ttf', {'wdth': 100, 'wght': 800})  # the words
# GPOS pair kerning (format 1 pairs) if present
def kerning(f):
  kern = {}
  try:
    for lookup in f['GPOS'].table.LookupList.Lookup:
        for st in lookup.SubTable:
            if st.LookupType == 2 and st.Format == 1:
                for i, first in enumerate(st.Coverage.glyphs):
                    for pr in st.PairSet[i].PairValueRecord:
                        v = pr.Value1.XAdvance if pr.Value1 and hasattr(pr.Value1,'XAdvance') else 0
                        if v: kern[(first, pr.SecondGlyph)] = v
  except Exception as e: pass
  return kern
kern = kerning(f); kernw = kerning(fw)
def run(text, size, gs=gs, cmap=cmap, hmtx=hmtx, kern=kern, upm=upm):
    k = size/upm; pen = SVGPathPen(gs); x = 0; prev = None
    for ch in text:
        g = cmap[ord(ch)]
        if prev: x += kern.get((prev, g), 0)
        tp = TransformPen(pen, (k, 0, 0, -k, x*k, 0)); gs[g].draw(tp)
        x += hmtx[g][0]; prev = g
    bp = BoundsPen(gs); xx = 0; prev=None
    # bounds via a second pass
    from fontTools.pens.boundsPen import BoundsPen as BP
    bpen = BP(gs); xx=0; prev=None
    for ch in text:
        g = cmap[ord(ch)]
        if prev: xx += kern.get((prev, g), 0)
        gs[g].draw(TransformPen(bpen, (k,0,0,-k,xx*k,0))); xx += hmtx[g][0]; prev=g
    x1,y1,x2,y2 = bpen.bounds
    return {'d': pen.getCommands(), 'bbox': {'x1':x1,'y1':y1,'x2':x2,'y2':y2}, 'adv': x*k}
W = dict(gs=gsw, cmap=cmapw, hmtx=hmtxw, kern=kernw, upm=upmw)
capB = run('B', 100, **W)['bbox']
out = {'Corgi': run('Corgi',100, **W), 'Brain': run('Brain',100, **W),
       'space': hmtxw[cmapw[32]][0]*100/upmw, 'capH': capB['y2']-capB['y1'], 'wordFont': 'Archivo 800, width 100'}
json.dump(out, open('paths.json','w'))
print('ok', out['capH'])
