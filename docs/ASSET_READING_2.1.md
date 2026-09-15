# 阅读封面 · 2.1.0

采用用户指定的 [anthropic-art](https://github.com/HalfAI1102/anthropic-art) 技能，使用内置 image_gen 生成三幅原创手绘插画。参考图仅用于学习线条、层次和配色，未随网站分发；未复制官方作品构图或标识。作品并非 Anthropic 或 Apple 官方资产。

散文：燕麦色、小径与树。小说：紫灰色、书页化作飞鸟。科学：淡绿色、放大镜中的嫩芽。三类各一张，所有文章（包括个人导入文章）共用同一映射，不逐篇复制图片。

网站使用 `public/images/reading-{essay,fiction,science}-{480,960}.webp`，3:2 比例、居中裁切、按设备宽度选择分辨率。未加载和加载失败时保持同一比例与分类底色。仅做等比例缩小和 WebP 压缩，不修改生成的构图。

生成方式：内置 image_gen；每类一次生成。以下为完整提示词。

## essay

```text
Use case: stylized-concept.
Asset type: one finished horizontal category cover for a Chinese English-reading app, no text. An original editorial illustration, part of a coherent three-image series.
Reference roles: the three attached images are ONLY style references for rounded, uneven near-black ink gestures, asymmetry, simplified objects and an irregular ivory carrier shape. Do not copy their house, globe, hands, or arrangements. Do not treat their apparent black/transparent outer canvases as a background reference.
Style/medium: expressive naive hand drawing, bold slightly wobbly continuous black ink strokes with natural width variation and rounded ends. Quiet, thoughtful, mature and warm; human rather than technically geometric. Flat opaque two-dimensional color. No realism.
Composition/framing: landscape 3:2, 1536 by 1024. A single clear central symbolic relationship with generous 12–18% breathing room; focal cluster about 65% of width and 70% of height; readable at a 300px thumbnail. All important marks safely inside central 75%. No text space needed.
Color system: near-black #141413 marks on one large irregular ivory #FAF9F5 carrier shape, surrounded on every edge and corner by the specified single muted accent color. The carrier is an organic silhouette, not a geometric rounded rectangle. Fully opaque image.
Materials/textures: clean flat color, subtle analog wobble in contour only, no artificial grain or digital painting texture.
Text: none.
Avoid: text, letters, numbers, logos, watermark, border, white or black outer canvas, transparency, gradients, shadows, 3D, glass, photographic lighting, glossy surfaces, fine technical drawing, corporate stock-vector perfection, crowded decorative motifs, exact copied reference composition.
Primary request: essays and attentive everyday observation, expressed as one loose winding footpath passing through a simple ivory hillside toward a single small crooked tree. Black ink lines suggest the path and the tree; just a few asymmetric rounded leaves, no detailed landscape. One calm unified cluster. Scene/backdrop: full-bleed opaque oat #E3DACC.
```

## fiction

```text
Use case: stylized-concept.
Asset type: one finished horizontal category cover for a Chinese English-reading app, no text. An original editorial illustration, part of a coherent three-image series.
Reference roles: the three attached images are ONLY style references for rounded, uneven near-black ink gestures, asymmetry, simplified objects and an irregular ivory carrier shape. Do not copy their house, globe, hands, or arrangements. Do not treat their apparent black/transparent outer canvases as a background reference.
Style/medium: expressive naive hand drawing, bold slightly wobbly continuous black ink strokes with natural width variation and rounded ends. Quiet, thoughtful, mature and warm; human rather than technically geometric. Flat opaque two-dimensional color. No realism.
Composition/framing: landscape 3:2, 1536 by 1024. A single clear central symbolic relationship with generous 12–18% breathing room; focal cluster about 65% of width and 70% of height; readable at a 300px thumbnail. All important marks safely inside central 75%. No text space needed.
Color system: near-black #141413 marks on one large irregular ivory #FAF9F5 carrier shape, surrounded on every edge and corner by the specified single muted accent color. The carrier is an organic silhouette, not a geometric rounded rectangle. Fully opaque image.
Materials/textures: clean flat color, subtle analog wobble in contour only, no artificial grain or digital painting texture.
Text: none.
Avoid: text, letters, numbers, logos, watermark, border, white or black outer canvas, transparency, gradients, shadows, 3D, glass, photographic lighting, glossy surfaces, fine technical drawing, corporate stock-vector perfection, crowded decorative motifs, exact copied reference composition.
Primary request: stories opening the imagination, expressed as an open ivory book whose right-hand page gently becomes one simple bird lifting off. Use just a few loose black ink contours for pages and wings, no written lines or letters. Book and bird form one flowing relationship, not separate clipart. Scene/backdrop: full-bleed opaque heather #CBCADB.
```

## science

```text
Use case: stylized-concept.
Asset type: one finished horizontal category cover for a Chinese English-reading app, no text. An original editorial illustration, part of a coherent three-image series.
Reference roles: the three attached images are ONLY style references for rounded, uneven near-black ink gestures, asymmetry, simplified objects and an irregular ivory carrier shape. Do not copy their house, globe, hands, or arrangements. Do not treat their apparent black/transparent outer canvases as a background reference.
Style/medium: expressive naive hand drawing, bold slightly wobbly continuous black ink strokes with natural width variation and rounded ends. Quiet, thoughtful, mature and warm; human rather than technically geometric. Flat opaque two-dimensional color. No realism.
Composition/framing: landscape 3:2, 1536 by 1024. A single clear central symbolic relationship with generous 12–18% breathing room; focal cluster about 65% of width and 70% of height; readable at a 300px thumbnail. All important marks safely inside central 75%. No text space needed.
Color system: near-black #141413 marks on one large irregular ivory #FAF9F5 carrier shape, surrounded on every edge and corner by the specified single muted accent color. The carrier is an organic silhouette, not a geometric rounded rectangle. Fully opaque image.
Materials/textures: clean flat color, subtle analog wobble in contour only, no artificial grain or digital painting texture.
Text: none.
Avoid: text, letters, numbers, logos, watermark, border, white or black outer canvas, transparency, gradients, shadows, 3D, glass, photographic lighting, glossy surfaces, fine technical drawing, corporate stock-vector perfection, crowded decorative motifs, exact copied reference composition.
Primary request: curiosity about the living world, expressed as one oversized hand-drawn magnifying glass framing a small asymmetric leafy sprout. The irregular ivory carrier lies behind the whole glass and sprout. One stem with three generous simple leaves, expressive black contours, and a short imperfect handle at lower right. No hands, atoms, globe, or extra objects. Scene/backdrop: full-bleed opaque cactus #BCD1CA.
```
