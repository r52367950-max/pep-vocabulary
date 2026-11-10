"""Render the verified report data to editable HTML, PDF, and page PNGs.

Run from any directory: python /absolute/path/render-report.py
report-data.json contains this run's facts; no live provider calls are made.
"""
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def esc(value):
    return html.escape(str(value), quote=True)

def render(data):
    version = esc(data['version'])
    bench = data['benchmark']
    old, new = bench['beforeMs'], bench['afterMs']
    fmt = lambda value: f'{value:.3f}' if value < 1 else f'{value:.2f}'
    checks = ''.join(f'<div class="check"><span class="num">{i:02d}</span><div><h3>{esc(item["title"])}</h3><p>{esc(item["detail"])}</p></div><span class="state">{esc(item["state"])}</span></div>' for i,item in enumerate(data['checks'],1))
    limits = ''.join(f'<article><b>{esc(item["value"])}</b><span>{esc(item["label"])}</span></article>' for item in data['limits'])
    delivery = data['delivery']
    provenance = esc(data['provenance'])
    return '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>词迹 · 学习助手 Harness 报告</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#dadada;color:#202020;font-family:Arial,"Noto Sans CJK SC",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-size:9pt;line-height:1.65}a{color:inherit;text-decoration:none}h1,h2,h3,p,figure{margin:0}.page{width:210mm;height:297mm;padding:14mm 16mm 11mm;display:flex;flex-direction:column;background:#f3f3f2;break-after:page;overflow:hidden}.page:last-child{break-after:auto}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #222;padding-bottom:11px;font-size:6.7pt;color:#626262}.brand{font-size:12pt;font-weight:700;color:#202020;margin-right:22px;letter-spacing:1px}.mono,.eyebrow,.num,.footer,.tag,.state{font-family:"DejaVu Sans Mono","Noto Sans CJK SC",monospace}.eyebrow{font-size:6.6pt;letter-spacing:1.1px;color:#696969;margin-top:26px}.title{display:grid;grid-template-columns:1fr 110px;gap:28px;align-items:end;margin-top:15px}h1{font-size:33pt;line-height:1.25;letter-spacing:-1.3px;font-weight:700}.version{border-left:1px solid #bdbdbd;padding-left:15px;font-size:7.2pt;line-height:1.9;color:#626262}.version b{display:block;font-size:17pt;font-weight:400;color:#222;letter-spacing:-.6px}.lead{font-size:9pt;line-height:1.9;color:#5b5b5b;margin-top:18px;max-width:610px}.section-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #222;padding-bottom:8px;margin-top:24px}.section-head h2,.section-head h3{font-size:10pt;font-weight:600}.section-head span{font-size:6.6pt;color:#666}.flow{display:grid;grid-template-columns:1fr 14px 1fr 14px 1fr;gap:8px;margin-top:16px}.step{border:1px solid #bbb;padding:14px 13px;background:#ededec;min-height:118px}.num{font-size:6.9pt;color:#767676;display:block;margin-bottom:8px}.step h3{font-size:9pt;margin-bottom:5px;font-weight:600}.step p{font-size:7.2pt;line-height:1.8;color:#5e5e5e}.arrow{font-size:14pt;color:#7c7c7c;align-self:center;text-align:center}.loop-note{margin-top:9px;font-size:6.7pt;color:#626262;line-height:1.8}.limits{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid #bdbdbd;border-top:1px solid #bdbdbd;margin-top:18px}.limits article{display:flex;align-items:baseline;gap:11px;padding:12px 16px;border-left:1px solid #bbb}.limits article:first-child{padding-left:0;border:0}.limits b{font-size:24pt;line-height:1.2;font-weight:400;letter-spacing:-.8px}.limits span{font-size:7pt;color:#656565}.tools{display:grid;grid-template-columns:1fr 1fr;column-gap:30px;margin-top:8px}.tool{padding:11px 0 12px;border-bottom:1px solid #c6c6c6}.tool h3{font-size:8.6pt;font-weight:600;display:flex;justify-content:space-between;gap:10px}.tool .tag{font-size:6.1pt;font-weight:400;color:#777}.tool p{margin-top:5px;font-size:7.2pt;line-height:1.8;color:#616161}.references{margin-top:18px;display:grid;grid-template-columns:76px 1fr;gap:17px;font-size:6.7pt;line-height:1.85;color:#636363}.references b{font-size:7.1pt;font-weight:600;color:#222}.references a{border-bottom:1px solid #aaa}.references small{display:block;font-size:6.3pt;color:#777;margin-top:4px}.footer{margin-top:auto;border-top:1px solid #bbb;padding-top:9px;display:flex;justify-content:space-between;gap:15px;font-size:6.1pt;line-height:1.8;color:#696969}.footer strong{font-weight:400;color:#333}.page-title{display:flex;justify-content:space-between;align-items:end;margin-top:14px}.page-title h2{font-size:29pt;line-height:1.28;letter-spacing:-1px}.folio{font-size:42pt;color:#aaa;font-weight:400;letter-spacing:-2px;line-height:1.2}.measure{border-top:1px solid #222;border-bottom:1px solid #bdbdbd;margin-top:25px;padding:17px 0 16px}.measure .label{font-size:6.8pt;color:#626262}.values{display:flex;gap:21px;align-items:baseline;margin-top:7px;line-height:1.2;font-size:43pt;font-weight:400;letter-spacing:-2px;font-variant-numeric:tabular-nums}.values .old{color:#818181}.values .to{font-size:22pt;letter-spacing:0;color:#777}.values .unit{font-size:9pt;letter-spacing:0;margin-left:-11px}.measure-notes{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin-top:14px;font-size:7pt;color:#616161;line-height:1.85}.measure-notes p:last-child{border-left:1px solid #bbb;padding-left:19px}.measure-notes strong{color:#222;font-weight:500}.check{display:grid;grid-template-columns:23px 1fr 75px;column-gap:14px;border-bottom:1px solid #bdbdbd;padding:12px 0}.check .num{margin-top:2px;margin-bottom:0}.check h3{font-size:8.6pt;font-weight:600}.check p{font-size:7.1pt;line-height:1.8;color:#616161;margin-top:4px}.state{font-size:6.8pt;text-align:right;line-height:1.8;margin-top:2px;color:#484848}.delivery{background:#e7e7e6;padding:15px 16px;display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:19px}.delivery h3{font-size:8pt;font-weight:600;margin-bottom:6px}.delivery p{font-size:7pt;color:#5e5e5e;line-height:1.8}.delivery a{border-bottom:1px solid #aaa;overflow-wrap:anywhere}.method{margin-top:12px;font-size:6.4pt;line-height:1.8;color:#707070}.provenance{margin-top:10px;font-size:6.4pt;color:#707070;line-height:1.8}
</style></head><body>
<section class="page"><header class="top"><div><span class="brand">词迹</span>学习助手 Harness 报告</div><span class="mono">2026.11.10</span></header>
<div class="eyebrow">AGENT HARNESS / 01</div><div class="title"><h1>工具可用，<br>调用有界。</h1><div class="version"><b>'''+version+'''</b>学习助手后端<br>轻量工具循环</div></div>
<p class="lead">接入现有 AI 对话：按需查询词库、计算与读取材料，再根据真实结果回答。保留账户隔离、每日预算和学习动作校验。</p>
<div class="section-head"><h2>一条明确的执行路径</h2><span>Cloudflare Worker · TypeScript</span></div>
<div class="flow"><article class="step"><span class="num">01 / REQUEST</span><h3>验证请求与上下文</h3><p>同源与身份检查；按来源开关读取资料与学习上下文。</p></article><span class="arrow">→</span><article class="step"><span class="num">02 / MODEL</span><h3>模型选择下一步</h3><p>直接回答，或提出结构化工具请求；每轮预留并结算 token。</p></article><span class="arrow">→</span><article class="step"><span class="num">03 / TOOLS</span><h3>执行、校验、返回</h3><p>工具名与参数白名单；返回有界结果；最终答案校验后交给界面。</p></article></div>
<p class="loop-note">工具结果返回下一轮模型。普通问答保持一次模型请求；取消、额度不足或达到上限时结束循环。</p>
<div class="limits">'''+limits+'''</div>
<div class="section-head"><h2>首批四个工具</h2><span>只读 · 确定性执行 · 有界输出</span></div><div class="tools">
<article class="tool"><h3>词库检索<span class="tag">search_lexicon</span></h3><p>查询已发布词条，返回稳定 ID、释义与出处，结果可用于学习操作卡。</p></article>
<article class="tool"><h3>算术计算<span class="tag">calculate</span></h3><p>解析基础算术表达式，服务于词数、时间与学习任务计算。</p></article>
<article class="tool"><h3>文本统计<span class="tag">text_stats</span></h3><p>统计提供文本的词数、句数等指标，帮助判断篇幅。</p></article>
<article class="tool"><h3>所选资料读取<span class="tag">read_source</span></h3><p>按位置读取本轮已提供的文章、文件和引用，限制每次摘录长度。</p></article></div>
<div class="references"><b>设计参考</b><div><a href="https://openai.com/index/unlocking-the-codex-harness/">Codex App Server</a>：统一模型与工具执行循环。<br><a href="https://code.claude.com/docs/en/agent-sdk/overview">Claude Agent SDK</a>：轮次、预算、取消与执行边界。<br><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>：显式能力注册、统一工具管线。<small>依据官方文档与公开仓库；详细链接与项目取舍见 docs/HARNESS_REFERENCES.md。</small></div></div>
<footer class="footer"><span>词迹 / pep-vocabulary<br><strong>工程报告 · '''+version+'''</strong></span><span>实现与验证记录<br>01 / 02</span></footer></section>
<section class="page"><header class="top"><div><span class="brand">词迹</span>性能与验证</div><span class="mono">2026.11.10</span></header><div class="eyebrow">PERFORMANCE & VERIFICATION / 02</div><div class="page-title"><h2>减少无效分配，<br>保留可核对的证据。</h2><span class="folio">02</span></div>
<div class="measure"><div class="label mono">'''+esc(bench['label'])+'''</div><div class="values"><span class="old">'''+fmt(old)+'''</span><span class="to">→</span><span>'''+fmt(new)+'''</span><span class="unit">ms</span></div><div class="measure-notes"><p>'''+esc(bench['sample'])+'''</p><p><strong>'''+esc(bench['change'])+'''</strong><br>'''+esc(bench['scope'])+'''</p></div></div>
<div class="section-head"><h3>本次验证</h3><span>仅列本轮实际执行结果</span></div>'''+checks+'''
<div class="delivery"><article><h3>交付与发布</h3><p>'''+esc(delivery['summary'])+'''</p>'''+(' <p><a href="'+esc(delivery['url'])+'">'+esc(delivery['label'])+'</a></p>' if delivery.get('url') else '')+'''</article><article><h3>验证范围</h3><p>'''+esc(data['limitation'])+'''</p></article></div>
<p class="method">复现：'''+esc(bench['command'])+'''。'''+esc(bench['method'])+'''</p><p class="provenance">'''+provenance+'''</p><footer class="footer"><span>词迹 / pep-vocabulary<br><strong>工程报告 · '''+version+'''</strong></span><span>实现与验证记录<br>02 / 02</span></footer></section></body></html>'''

if __name__ == '__main__':
    from playwright.sync_api import sync_playwright
    import fitz
    data = json.loads((ROOT / 'report-data.json').read_text())
    (ROOT / 'report.html').write_text(render(data))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 794, 'height': 1123}, device_scale_factor=1)
        page.set_content((ROOT / 'report.html').read_text(), wait_until='load')
        page.evaluate('document.fonts.ready')
        layout = page.locator('.page').evaluate_all('elements => elements.map(el => ({width:el.clientWidth,height:el.clientHeight,scrollHeight:el.scrollHeight,contentBottom:Math.max(...[...el.children].map(c=>c.getBoundingClientRect().bottom))-el.getBoundingClientRect().top}))')
        if any(p['scrollHeight'] > p['height'] + 1 for p in layout):
            raise RuntimeError(f'Report overflows: {layout}')
        page.pdf(path=str(ROOT / 'report.pdf'), format='A4', print_background=True, prefer_css_page_size=True)
        browser.close()
    doc = fitz.open(ROOT / 'report.pdf')
    if len(doc) != 2:
        raise RuntimeError(f'Expected 2 report pages, got {len(doc)}')
    for i,page in enumerate(doc,1):
        page.get_pixmap(matrix=fitz.Matrix(2,2), alpha=False).save(ROOT / f'report-page-{i}.png')
    (ROOT / 'report-layout.json').write_text(json.dumps(layout,indent=2)+'\n')
    print(json.dumps({'pages':len(doc),'layout':layout},ensure_ascii=False))
