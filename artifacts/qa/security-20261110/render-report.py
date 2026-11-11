"""Render this run's verified report-data.json as editable HTML, PDF and PNG pages.

Usage: python3 artifacts/qa/security-20261110/render-report.py
The renderer never calls an AI provider or reads production data.
"""
import html
import json
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def esc(value):
    return html.escape(str(value), quote=True)


def section(number, title):
    return f'<h2><span>{number:02d}</span> {esc(title)}</h2>'


def footer(data, page):
    return (f'<footer><span>词迹 · {esc(data["version"])} · {esc(data["deliveryState"])}</span>'
            f'<span>{page:02d} / 02</span></footer>')


def screenshot_url(path):
    image = ROOT / path
    return 'data:image/png;base64,' + base64.b64encode(image.read_bytes()).decode('ascii')


def render(data):
    fixes = ''.join(
        f'<tr><td><b>{esc(item["title"])}</b><small>{esc(item["severity"])}</small></td>'
        f'<td>{esc(item["cause"])}</td><td>{esc(item["fix"])}</td></tr>'
        for item in data['fixes'])
    additions = ''.join(f'<li><b>{esc(item["title"])}</b>：{esc(item["detail"])}</li>'
                        for item in data['additional'])
    benchmark = data['benchmark']
    metrics = []
    for row in benchmark['rows']:
        before, after = row['beforeMs'], row['afterMs']
        if before < 0 or after < 0:
            raise ValueError('Measured timings must be nonnegative')
        largest = max(before, after, 0.001)
        metrics.append(
            f'<tr><td>{esc(row["label"])}</td><td class="numeric">{before:.2f} ms</td>'
            f'<td class="numeric">{after:.2f} ms</td><td class="bar-cell">'
            f'<div class="bar before" style="width:{before / largest * 100:.3f}%"></div>'
            f'<div class="bar after" style="width:{after / largest * 100:.3f}%"></div></td></tr>')
    screenshots = ''.join(
        f'<figure><div class="image-frame"><img src="{screenshot_url(item["path"])}" alt="{esc(item["caption"])}"></div>'
        f'<figcaption>{esc(item["caption"])}</figcaption></figure>'
        for item in data['screenshots'])
    checks = ''.join(
        f'<tr><td><b>{esc(item["title"])}</b></td><td>{esc(item["result"])}</td>'
        f'<td>{esc(item["evidence"])}</td></tr>' for item in data['checks'])
    remaining = ''.join(f'<li>{esc(item)}</li>' for item in data['remaining'])
    commands = ''.join(f'<div><code>{esc(item)}</code></div>' for item in data['commands'])
    return '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>词迹：安全修复与性能验证</title>
<style>
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;color:#282828;background:#ddd;font-family:Arial,"Noto Sans CJK SC",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-size:12.1px;line-height:1.65}h1,h2,p,figure{margin:0}a{color:inherit;text-decoration:none;border-bottom:1px solid #aaa}.page{width:210mm;height:297mm;padding:13mm 14mm 11mm;background:#f7f7f5;display:flex;flex-direction:column;break-after:page}.page:last-child{break-after:auto}h1{font-size:24px;line-height:1.4;font-weight:700;letter-spacing:-.4px}.meta{font-size:10.7px;line-height:1.75;color:#777;margin-top:8px}h2{font-size:10.5px;font-weight:600;letter-spacing:.5px;color:#666;border-top:1px solid #bdbdb8;padding-top:7px;margin:22px 0 9px}h2 span,code,footer,.small-mono{font-family:"DejaVu Sans Mono","Noto Sans CJK SC",monospace}h2 span{font-size:9.8px;letter-spacing:1px;margin-right:5px}.scope{display:grid;grid-template-columns:1.05fr 1fr;gap:25px}.scope p{font-size:11.9px}.scope .note{color:#666}.scope ul{margin:0;padding-left:17px}ul{margin:0;padding-left:18px}li+li{margin-top:3px}table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:11.5px;line-height:1.65}th,td{border-bottom:1px solid #d0d0cb;text-align:left;padding:8px 6px;vertical-align:top}th{font-size:11px;color:#555;font-weight:600;border-top:1px solid #d0d0cb;padding-top:6px;padding-bottom:6px}td:first-child,th:first-child{padding-left:5px}td:last-child,th:last-child{padding-right:5px}td b{font-weight:500}td small{display:block;color:#777;font-size:10px;margin-top:3px}.fixes col:nth-child(1){width:21%}.fixes col:nth-child(2){width:29%}.fixes col:nth-child(3){width:50%}.extra{font-size:11.5px;margin-top:11px}.extra b{font-weight:500}.intro{margin-bottom:8px;font-size:11.5px}.metrics col:nth-child(1){width:33%}.metrics col:nth-child(2),.metrics col:nth-child(3){width:19%}.metrics col:nth-child(4){width:29%}.metrics td{vertical-align:middle;padding-top:9px;padding-bottom:9px}.numeric{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.bar-cell{padding-left:19px;padding-right:10px}.bar{height:7px;min-width:1px}.before{background:#b4b6b0;margin-bottom:8px}.after{background:#292b29}.small-note{font-size:10.2px;line-height:1.7;color:#777;margin-top:8px}.screenshots{display:grid;grid-template-columns:2.15fr 1fr;gap:14px}.image-frame{height:250px;border:1px solid #d1d1cc;background:#eeeeeb;display:flex;justify-content:center;align-items:center;overflow:hidden}.image-frame img{display:block;width:100%;height:100%;object-fit:contain}figcaption{font-size:10.2px;color:#777;margin-top:7px}.checks col:nth-child(1){width:22%}.checks col:nth-child(2){width:23%}.checks col:nth-child(3){width:55%}.checks{font-size:11.3px}.checks td{padding-top:7px;padding-bottom:7px}.remaining{font-size:11.3px}.commands{margin-top:10px;font-size:9.7px;color:#6b6b66;line-height:1.7;overflow-wrap:anywhere}code{font-size:9px}.source{font-size:9.6px;color:#777;margin-top:10px;line-height:1.6}footer{margin-top:auto;padding-top:9px;border-top:1px solid #c4c4be;display:flex;justify-content:space-between;font-size:9.2px;color:#777;line-height:1.6}
</style></head><body><section class="page">
<h1>词迹：安全修复与性能验证</h1>
<p class="meta">'''+esc(data['date'])+''' · 分支 '''+esc(data['branch'])+''' · '''+esc(data['deliveryState'])+''' · 应用版本 '''+esc(data['version'])+'''</p>
'''+section(1, '扫描与修复范围')+'''
<div class="scope"><p>'''+esc(data['scope'])+'''</p><div class="note"><ul>'''+''.join(f'<li>{esc(item)}</li>' for item in data['scopeNotes'])+'''</ul></div></div>
'''+section(2, '问题与修复')+'''
<table class="fixes"><colgroup><col><col><col></colgroup><thead><tr><th>问题</th><th>原因</th><th>修复</th></tr></thead><tbody>'''+fixes+'''</tbody></table>
<ul class="extra">'''+additions+'''</ul>
'''+section(3, '性能（实际测量）')+'''
<p class="intro">'''+esc(benchmark['sample'])+'''</p>
<table class="metrics"><colgroup><col><col><col><col></colgroup><thead><tr><th>场景</th><th class="numeric">修改前</th><th class="numeric">修改后</th><th></th></tr></thead><tbody>'''+''.join(metrics)+'''</tbody></table>
<p class="small-note">'''+esc(benchmark['explanation'])+''' 浅灰为改前，炭黑为改后；每行使用同一比例。</p>
<p class="source">扫描来源：<a href="'''+esc(data['scanUrl'])+'''">Codex Security Cloud · '''+esc(data['scanCompleted'])+'''</a>。<br>'''+esc(data['benchmark']['scope'])+'''</p>
'''+footer(data,1)+'''</section>
<section class="page"><h1>界面与验证记录</h1>
<p class="meta">'''+esc(data['date'])+''' · '''+esc(data['version'])+''' · '''+esc(data['verificationSubtitle'])+'''</p>
'''+section(4, '截图')+'''
<div class="screenshots">'''+screenshots+'''</div>
'''+section(5, '验证结果')+'''
<table class="checks"><colgroup><col><col><col></colgroup><thead><tr><th>检查</th><th>结果</th><th>实际覆盖</th></tr></thead><tbody>'''+checks+'''</tbody></table>
'''+section(6, '交付与剩余事项')+'''
<ul class="remaining">'''+remaining+'''</ul>
<div class="commands">'''+commands+'''</div>
<p class="source">'''+esc(data['evidenceNote'])+'''</p>
'''+footer(data,2)+'''</section></body></html>'''


if __name__ == '__main__':
    from playwright.sync_api import sync_playwright
    import fitz
    data = json.loads((ROOT / 'report-data.json').read_text())
    (ROOT / 'report.html').write_text(render(data))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 794, 'height': 1123})
        page.set_content((ROOT / 'report.html').read_text(), wait_until='load')
        page.evaluate('document.fonts.ready')
        if not page.locator('img').evaluate_all('items => items.every(img => img.complete && img.naturalWidth > 0)'):
            raise RuntimeError('A report screenshot failed to load')
        layout = page.locator('.page').evaluate_all('''elements => elements.map(el => ({
            width:el.clientWidth,height:el.clientHeight,scrollHeight:el.scrollHeight,
            contentBottom:Math.max(...[...el.children].map(c=>c.getBoundingClientRect().bottom))-el.getBoundingClientRect().top,
            footerTop:el.querySelector('footer').getBoundingClientRect().top-el.getBoundingClientRect().top,
            previousBottom:el.querySelector('footer').previousElementSibling.getBoundingClientRect().bottom-el.getBoundingClientRect().top
        }))''')
        if any(item['scrollHeight'] > item['height'] + 1 or item['previousBottom'] > item['footerTop'] for item in layout):
            raise RuntimeError(f'Report content overflows: {layout}')
        page.pdf(path=str(ROOT / 'report.pdf'), format='A4', print_background=True, prefer_css_page_size=True)
        browser.close()
    document = fitz.open(ROOT / 'report.pdf')
    if len(document) != 2:
        raise RuntimeError(f'Expected two report pages, got {len(document)}')
    for number, page in enumerate(document, 1):
        page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(ROOT / f'report-page-{number}.png')
    (ROOT / 'report-layout.json').write_text(json.dumps(layout, indent=2) + '\n')
    print(json.dumps({'pages': len(document), 'layout': layout}, ensure_ascii=False))
