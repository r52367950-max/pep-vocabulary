// Remove CSS declarations that are provably overridden by a later declaration of the same
// property on the exact same selector, in the same at-rule context, in load order.
// usage: node artifacts/qa/css-overridden.mjs [--list] [--write]
// Exits 1 when any declaration is dead, so it doubles as a regression check.
import postcss from 'postcss';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../../app/', import.meta.url).pathname;
const order = ['studio-controls.css', 'globals.css', 'reading-surfaces.css', 'interface.css', 'settings-dialog.css', 'learn.css'];
const write = process.argv.includes('--write');
const modern = /\b(dvh|svh|lvh|dvw|svw|lvw|color-mix|oklch|oklab|lab\(|lch\(|light-dark|round\(|cqi|cqw|cqh|anchor)\b|-webkit-|-moz-/;

const trees = order.map(file => ({ file, tree: postcss.parse(readFileSync(root + file, 'utf8'), { from: file }) }));
const norm = s => s.replace(/\s+/g, ' ').split(',').map(p => p.trim()).join(', ');

function context(rule) {
  const parts = [];
  for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type === 'atrule') parts.unshift(`@${p.name} ${p.params.replace(/\s+/g, ' ').trim()}`);
    else if (p.type === 'rule') parts.unshift(`&${norm(p.selector)}`);
  }
  return parts.join(' | ');
}

// last[key] = the latest declaration seen so far for (context, selector, property)
const decls = [];
for (const { file, tree } of trees) {
  tree.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    const ctx = context(rule), sel = norm(rule.selector);
    rule.each(node => {
      if (node.type !== 'decl') return;
      decls.push({ file, rule, node, key: `${ctx} || ${sel} || ${node.prop.toLowerCase()}` });
    });
  });
}
const byKey = new Map();
for (const d of decls) (byKey.get(d.key) ?? byKey.set(d.key, []).get(d.key)).push(d);

const removed = [];
for (const list of byKey.values()) {
  for (let i = 0; i < list.length - 1; i++) {
    const earlier = list[i];
    const later = list.slice(i + 1);
    // Same-rule duplicates are usually progressive-enhancement fallbacks: keep them.
    const winner = later.find(d => d.rule !== earlier.rule);
    if (!winner) continue;
    if (earlier.node.important && !later.some(d => d.node.important)) continue;
    if (later.some(d => modern.test(d.node.value)) && !modern.test(earlier.node.value)) continue;
    if (earlier.node.prop.startsWith('--') && false) continue;
    removed.push({ file: earlier.file, sel: norm(earlier.rule.selector), prop: earlier.node.prop, value: earlier.node.value, by: `${winner.file}: ${winner.node.value}` });
    earlier.node.remove();
  }
}
// Drop rules left empty by the removal (only if they held declarations originally).
let emptied = 0;
for (const { tree } of trees) {
  tree.walkRules(rule => { if (!rule.nodes.length) { rule.remove(); emptied++; } });
  tree.walkAtRules(at => { if (at.nodes && !at.nodes.length && !/keyframes|layer|font-face/.test(at.name)) at.remove(); });
}
console.log(`removed declarations: ${removed.length}, emptied rules: ${emptied}`);
const perFile = {};
for (const r of removed) perFile[r.file] = (perFile[r.file] || 0) + 1;
console.log(perFile);
if (process.argv.includes('--list')) for (const r of removed) console.log(`${r.file} ${r.sel} { ${r.prop}: ${r.value} }  <- ${r.by}`);
if (removed.length && !write) process.exitCode = 1;
if (write) for (const { file, tree } of trees) writeFileSync(root + file, tree.toString());
