"""Render verified chat-experience evidence in the user's compact Opus report style."""
import base64
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def esc(value):
    return html.escape(str(value), quote=True)


def heading(number, title):
    return f'<h2><span>{number:02d}</span> {esc(title)}</h2>'


def table(headers, rows, class_name):
    cells = ''.join('<tr>' + ''.join(f'<td>{esc(cell)}</td>' for cell in row) + '</tr>' for row in rows)
    return f'<table class="{class_name}"><thead><tr>' + ''.join(f'<th>{esc(item)}</th>' for item in headers) + '</tr></thead><tbody>' + cells + '</tbody></table>'


def screenshot(path, caption):
    data = base64.b64encode((ROOT / path).read_bytes()).decode('ascii')
    return f'<figure><div class="image-frame"><img src="data:image/png;base64,{data}" alt="{esc(caption)}"></div><figcaption>{esc(caption)}</figcaption></figure>'


def footer(data, number):
    return f'<footer><span>词迹 · {esc(data["version"])} · 同一 PR 更新周期</span><span>{number:02d} / 02</span></footer>'


def render(data, browser):
    if not data['fullTest'] or browser['status'] != 'passed':
        raise ValueError('Final full-test and browser evidence are required')
    checks = [['完整回归', data['fullTest']['result'], data['fullTest']['scope']], *data['checks']]
    samples = [item for item in browser['results'] if 'samples' in item]
    restored = [item for item in browser['results'] if 'restoredChars' in item]
    measured = [
        ['渐进显示观测', ' / '.join(f'{item["width"]} px：{item["samples"]} 个样本' for item in samples), '各样本均为最终正文前缀，完整保留字素边界。'],
        ['生成中刷新', ' / '.join(f'{item["width"]} px：恢复 {item["restoredChars"]} 字符' for item in restored), '恢复为已停止；未出现尚未显示的后半段，无重播。'],
        ['布局与控制台', '桌面 1440 × 900 · 手机 390 × 844', '无横向溢出、未捕获页面错误；两种视图上翻均保持位置。']
    ]
    references = ' · '.join(f'<a href="{esc(url)}">{esc(label)}</a>' for label, url in data['sources'])
    return '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>词迹：对话反馈与线上身份修复</title>
<style>
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;color:#282828;background:#ddd;font-family:Arial,"Noto Sans CJK SC",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-size:12px;line-height:1.65}h1,h2,p,figure{margin:0}a{color:inherit;text-decoration:none;border-bottom:1px solid #aaa}.page{width:210mm;height:297mm;padding:13mm 14mm 11mm;background:#f7f7f5;display:flex;flex-direction:column;break-after:page}.page:last-child{break-after:auto}h1{font-size:24px;line-height:1.4;font-weight:700;letter-spacing:-.4px}.meta{font-size:10.5px;line-height:1.75;color:#777;margin-top:8px}h2{font-size:10.5px;font-weight:600;letter-spacing:.5px;color:#666;border-top:1px solid #bdbdb8;padding-top:7px;margin:21px 0 9px}h2 span,footer{font-family:"DejaVu Sans Mono","Noto Sans CJK SC",monospace}h2 span{font-size:9.8px;letter-spacing:1px;margin-right:5px}.scope{display:grid;grid-template-columns:1.05fr 1fr;gap:25px}.scope p{font-size:11.8px}.scope .note{color:#666}.scope ul{margin:0;padding-left:17px}ul{margin:0;padding-left:18px}li+li{margin-top:3px}table{border-collapse:collapse;table-layout:fixed;width:100%;font-size:11.25px;line-height:1.65}th,td{border-bottom:1px solid #d0d0cb;text-align:left;padding:7px 6px;vertical-align:top}th{font-size:11px;color:#555;font-weight:600;border-top:1px solid #d0d0cb;padding-top:6px;padding-bottom:6px}td:first-child,th:first-child{padding-left:5px}td:last-child,th:last-child{padding-right:5px}.fixes th:nth-child(1){width:20%}.fixes th:nth-child(2){width:28%}.fixes th:nth-child(3){width:52%}.metrics th:nth-child(1){width:20%}.metrics th:nth-child(2){width:34%}.metrics th:nth-child(3){width:46%}.checks th:nth-child(1){width:20%}.checks th:nth-child(2){width:25%}.checks th:nth-child(3){width:55%}.small-note,.source{font-size:10.1px;line-height:1.7;color:#777;margin-top:9px}.screenshots{display:grid;grid-template-columns:2.2fr 1fr;gap:14px}.image-frame{height:275px;border:1px solid #d1d1cc;background:#eee;display:flex;justify-content:center;align-items:center;overflow:hidden}.image-frame img{display:block;width:100%;height:100%;object-fit:contain}figcaption{font-size:10.2px;color:#777;margin-top:7px}.remaining{font-size:11.3px}footer{margin-top:auto;padding-top:9px;border-top:1px solid #c4c4be;display:flex;justify-content:space-between;font-size:9.2px;color:#777;line-height:1.6}
</style></head><body><section class="page">
<h1>对话反馈与线上身份修复</h1><p class="meta">''' + esc(data['date']) + ' · 分支 ' + esc(data['branch']) + ' · 应用版本 ' + esc(data['version']) + '<br>' + esc(data['deliveryState']) + '</p>' + heading(1, '参考与设计') + '''
<div class="scope"><p>参考 ChatGPT 的 Working 状态与 Claude 的折叠摘要：等待期间给出真实阶段，正文连续出现，保留停止控制和阅读位置。</p><div class="note"><ul><li>OpenAI 提供公开推理摘要；按供应商支持情况展示。</li><li>回答与摘要先经过来源、账户上下文校验，再呈现。</li><li>同一 PR 推送前的追加修复统一沿用 2.19.3。</li></ul></div></div>''' + heading(2, '问题与修复') + table(['问题', '原因', '修复'], data['fixes'], 'fixes') + heading(3, '交互实测') + table(['场景', '观测', '结果'], measured, 'metrics') + '''
<p class="small-note">Chromium 实际页面、解析器与本地存储；接口使用定时 Web ReadableStream 测试数据。此处记录交互行为，不作服务商响应时间或吞吐性能比较。</p>
<p class="source">依据：''' + references + '</p>' + footer(data, 1) + '''</section><section class="page">
<h1>界面与验证记录</h1><p class="meta">''' + esc(data['date']) + ' · ' + esc(data['version']) + ' · 测试证据与交付状态</p>' + heading(4, '截图') + '<div class="screenshots">' + screenshot('thinking-1440.png', '桌面 · 思考中文字与光标；等待时可停止。') + screenshot('answer-390.png', '手机 · 逐步显示完成；摘要默认折叠。') + '</div><p class="small-note">截图内容为受控测试数据，用于检验中文、组合 Emoji、重音字符与来源标识；未调用付费模型。</p>' + heading(5, '验证结果') + table(['检查', '结果', '实际覆盖'], checks, 'checks') + heading(6, '交付与剩余事项') + '''
<ul class="remaining"><li>线上身份配置已生效；新对话代码仍在本地 2.19.3 候选中，随本次 PR 交付。</li><li>状态来自真实服务端执行阶段；最终安全校验后的完整回答在客户端逐步显示。公开摘要随最终结果返回。</li><li>尚未进行真实付费模型及物理 iPad / Safari 验证。此前安全修复与数据库迁移仍随同一候选版本交付。</li></ul>
<p class="source">证据：browser-results.json、browser-check.mjs、full-test.log；后端与客户端流式单测、组件状态与来源回归。线上配置修复保持既有访问范围，未发布本地候选源代码。</p>''' + footer(data, 2) + '</section></body></html>'


if __name__ == '__main__':
    import fitz
    from playwright.sync_api import sync_playwright
    data = json.loads((ROOT / 'report-data.json').read_text())
    browser_evidence = json.loads((ROOT / 'browser-results.json').read_text())
    document = render(data, browser_evidence)
    (ROOT / 'report.html').write_text(document)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 794, 'height': 1123})
        page.set_content(document, wait_until='load')
        page.evaluate('document.fonts.ready')
        if not page.locator('img').evaluate_all('items => items.every(img => img.complete && img.naturalWidth > 0)'):
            raise RuntimeError('A report screenshot failed to load')
        layout = page.locator('.page').evaluate_all('''elements => elements.map(el => ({
            width:el.clientWidth,height:el.clientHeight,scrollHeight:el.scrollHeight,
            footerTop:el.querySelector('footer').getBoundingClientRect().top-el.getBoundingClientRect().top,
            previousBottom:el.querySelector('footer').previousElementSibling.getBoundingClientRect().bottom-el.getBoundingClientRect().top
        }))''')
        if any(item['scrollHeight'] > item['height'] + 1 or item['previousBottom'] > item['footerTop'] for item in layout):
            raise RuntimeError(f'Report content overflows: {layout}')
        page.pdf(path=str(ROOT / 'report.pdf'), format='A4', print_background=True, prefer_css_page_size=True)
        browser.close()
    pdf = fitz.open(ROOT / 'report.pdf')
    if len(pdf) != 2:
        raise RuntimeError(f'Expected two pages, got {len(pdf)}')
    for number, page in enumerate(pdf, 1):
        page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(ROOT / f'report-page-{number}.png')
    (ROOT / 'report-layout.json').write_text(json.dumps(layout, indent=2) + '\n')
    print(json.dumps({'pages': len(pdf), 'layout': layout}, ensure_ascii=False))
