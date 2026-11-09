// Packs the built prototype into one self-contained page for private review hosting.
// Run after the Vite build:  node prototypes/ai-companion/scripts/bundle-artifact.mjs
// Output (not committed): dist/ciji-ai-prototype.html for hosting that supplies the document
// skeleton, and dist/ciji-ai-prototype-standalone.html to open directly from disk.
import { readFile, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", dist), "utf8");
const script = /<script[^>]+src="\.\/(assets\/[^"]+\.js)"/.exec(index)?.[1];
const style = /<link[^>]+href="\.\/(assets\/[^"]+\.css)"/.exec(index)?.[1];
if (!script || !style) throw new Error("Build output not found; run the Vite build first.");
const js = await readFile(new URL(script, dist), "utf8");
const css = await readFile(new URL(style, dist), "utf8");
if (/\bimport\(/.test(js) || /url\((?!data:)/.test(css)) throw new Error("The bundle loads further files; inline them before packing.");

// The host pads the page for the safe area itself, so in-flow bars stop adding the insets and
// full-height layouts use the space inside that padding.
const host = ":root{--vh:calc(100dvh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));--safe-top:0px;--safe-bottom:0px}";
const page = `<title>词迹 AI 对话原型</title>
<style>${css}
${host}</style>
<div id="root" lang="zh-CN"></div>
<script type="module">${js.replaceAll("</script", "<\\/script")}</script>
`;
await writeFile(new URL("ciji-ai-prototype.html", dist), page);
console.log(`ciji-ai-prototype.html ${(page.length / 1024).toFixed(0)} KB`);

// A complete document for opening straight from disk: the browser keeps the safe areas itself.
const standalone = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>词迹 AI 对话原型</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`;
await writeFile(new URL("ciji-ai-prototype-standalone.html", dist), standalone);
console.log(`ciji-ai-prototype-standalone.html ${(standalone.length / 1024).toFixed(0)} KB`);
