from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, math, statistics, re, subprocess
R=Path(__file__).resolve().parent
W,H=1600,2264
BG='#f3f2ee'; INK='#222425'; MUTED='#626665'; LINE='#b8bab6'; WHITE='#ffffff'
FONT='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
BOLD='/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
fonts={}
def font(size,bold=False):
 key=(size,bold)
 if key not in fonts: fonts[key]=ImageFont.truetype(BOLD if bold else FONT,size,index=2)
 return fonts[key]
def wrap(s,f,width):
 out=[]
 for p in str(s).split('\n'):
  line=''
  tokens=[]
  for token in re.findall(r'[A-Za-z0-9][A-Za-z0-9_.:/#%+=?&@-]*|.',p):
   tokens.extend(list(token) if f.getlength(token)>width else [token])
  for i,c in enumerate(tokens):
   suffix='';j=i+1
   while j<len(tokens) and tokens[j] in ',，。；：！？、）)]}〉》”’':suffix+=tokens[j];j+=1
   if line and f.getlength(line+c+suffix)>width:
    if line[-1] in '（([{〈《“‘':out.append(line[:-1]);line=line[-1]
    else:out.append(line);line=''
   line+=c
  out.append(line)
 return out
class Page:
 def __init__(self,n,tag,title,sub):
  self.n=n;self.im=Image.new('RGB',(W,H),BG);self.d=ImageDraw.Draw(self.im)
  self.d.text((90,48),'词迹  /  工程验证报告',font=font(25,True),fill=INK)
  self.d.text((1160,48),'2026.11.11 · 2.19.4',font=font(23),fill=MUTED)
  self.d.line((90,108,1510,108),fill=INK,width=2)
  self.y=146;self.text(tag.upper(),22,MUTED);self.y+=15
  self.text(title,64,INK,True);self.y+=16;self.text(sub,27,MUTED);self.y+=35
 def text(self,s,size=29,color=INK,bold=False,x=90,width=1420,gap=1.5):
  lines=wrap(s,font(size,bold),width)
  for line in lines:self.d.text((x,self.y),line,font=font(size,bold),fill=color);self.y+=int(size*gap)
  return self.y
 def section(self,title):
  self.y+=15;self.d.line((90,self.y,1510,self.y),fill=LINE,width=1);self.y+=20;self.text(title,32,INK,True);self.y+=15
 def item(self,number,title,body):
  self.d.text((90,self.y),number,font=font(26),fill=MUTED);start=self.y
  self.text(title,32,INK,True,x=160,width=1350);self.y+=8;self.text(body,28,MUTED,x=160,width=1350);self.y+=26
 def table(self,headers,rows,widths,size=27):
  x=90;y=self.y
  self.d.rectangle((90,y,1510,y+58),fill=INK)
  for h,w in zip(headers,widths):self.d.text((x+15,y+12),h,font=font(24,True),fill=WHITE);x+=w
  y+=58
  for row in rows:
   height=max(len(wrap(cell,font(size),w-30)) for cell,w in zip(row,widths))*int(size*1.55)+30
   x=90
   for cell,w in zip(row,widths):
    for i,line in enumerate(wrap(cell,font(size),w-30)):self.d.text((x+15,y+14+i*int(size*1.55)),line,font=font(size),fill=INK)
    x+=w
   self.d.line((90,y+height,1510,y+height),fill=LINE,width=1);y+=height
  self.y=y+25
 def note(self,s):self.text(s,24,MUTED);self.y+=16
 def save(self):
  assert self.y<2130,(self.n,self.y)
  self.d.line((90,2160,1510,2160),fill=INK,width=2)
  self.d.text((90,2181),'RELEASE VALIDATION  /  候选源码验证 · 上线状态另见交付回执',font=font(22),fill=MUTED)
  self.d.text((1360,2173),f'{self.n:02} / 05',font=font(32,True),fill=INK)
  self.im.save(R/f'report-page-{self.n}.png')
  return {'page':self.n,'contentBottom':self.y,'height':H}
S=json.loads((R/'release-summary.json').read_text())
assert S['completeness']['complete'], 'Final evidence records are incomplete'
assert not S['completeness']['failed'] and not S['completeness']['invalid'], 'Final checks failed or evidence invalid'
def read(n):return json.loads((R/n).read_text())
def pct(a,p):return sorted(a)[max(0,math.ceil(len(a)*p)-1)]
def aggregate(raw,c):
 a=[v for s in raw['samples'] if s['concurrency']==c for v in s['latencies']]
 rows=[s for s in raw['scenarios'] if s['concurrency']==c]
 return [pct(a,.5),pct(a,.95),pct(a,.99),len(a)*1000/sum(s['elapsedMs'] for s in rows)]
before=read('sites-baseline-workload.json');after=read('release-workload.json')
b,a=aggregate(before,12),aggregate(after,12)
improvement=100*(1-a[1]/b[1]);ratio=a[3]/b[3]
soak=after['soak'];sr=read('stream-render-results.json');ui=read('mixed-ui-load.json');browser=read('browser-results.json')
unitcounts=[int(re.search(r'ℹ pass (\d+)',(R/f).read_text()).group(1)) for f in ['release-full-check.log','release-full-check-round2.log']]
layout=[]
p=Page(1,'01 / Scope & guidance','精简指引，\n保留关键边界。','最终复审 · 从已上线的 Sites 2.19.3 合并为 2.19.4 · 2026-11-11')
y=p.y
for x,value,label in [(90,'84.1%','AGENTS.md 字节减少'),(580,f'{unitcounts[0]} × 2','合并后完整回归通过'),(1070,f'{improvement:.1f}%','12 并发混合负载 p95 降低')]:
 p.d.text((x,y),value,font=font(74,True),fill=INK);p.d.text((x,y+104),label,font=font(24),fill=MUTED)
p.y=y+178
p.section('文档改动与保留的约束')
p.table(['文件','之前 / 之后（字节）','减少'],[['AGENTS.md','7,852 → 1,245','84.1%'],['docs/DEVELOPMENT.md','7,674 → 3,535','53.9%'],['PROJECT_STATE.md','3,067 → 1,293','57.8%'],['docs/prompt-guidance.md','1,380 → 1,364','1.2%']],[590,570,260],27)
p.text('删除重复执行协议、禁词表、无来源引用与过时状态。实现方式、推理投入、分工和验证由当前任务决定；保留离线能力、稳定 ID、账户隔离、CAS / 删除保护、凭据边界及内容来源。CLAUDE.md 继续导入 AGENTS.md。',28)
p.section('模型资料如何影响本次修改')
p.text('按官方资料采用简洁、直接、目标明确的指引，并允许模型选择实现路径。“Cloud Opus 5.5”按 Claude Opus 5.5 核查。提示建议不等于 API 硬性要求；未据此改变产品模型选项，也未进行付费模型 A/B。',27)
p.note('[1] OpenAI · GPT-6 Astra / latest model prompting best practices\nhttps://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices')
p.note('[2] Anthropic · Claude Opus 5.5 prompting\nhttps://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5')
p.note('[3] OpenAI · Custom instructions with AGENTS.md\nhttps://learn.chatgpt.com/docs/agent-configuration/agents-md')
p.note('以上文档精简以 GitHub 原基线 f10737e 为参照；本报告性能基线则为实际已上线的 Sites a9bb926，避免混用版本。')
layout.append(p.save())
p=Page(2,'02 / Security','调用前、返回前，\n都复核隐私状态。','三个独立审查范围：后端与 SSE、前端交互、发布链与证据。代码复审无未解决的安全阻塞项。')
p.item('S-01','隐私撤销后的旧回答仍可能返回','标准词汇助手原先缺少结束复核。修复后，无变化正常返回；关闭记忆、变更日志隐私或配置时拒绝过期结果。元数据复核不再次读取笔记或日志正文。')
p.item('S-02','配置删除或预算预留期间撤销仍可能发出请求','runtime 绑定配置 write_token，预算预留后核对当前配置与学习上下文。撤销已生效时不调用 provider，未发送的预留只退一次；已完成的上一轮调用仍计费。密钥重加密不误伤正常上下文。')
p.item('S-03','构建依赖中的已知严重 RSC 漏洞','React / React DOM / react-server-dom-webpack 19.2.8 → 19.2.9。RSC 解码器会进入生产 Worker，CI 因此审计完整依赖树；638 个依赖项的最终 npm 审计为 0 个已知漏洞。')
p.section('增加的纵深保护与动态对照')
p.table(['边界','最终行为及验证'],[
 ['框架入口','应用未使用 Server Actions：action 请求返回 404、multipart POST 返回 415；HTML / RSC GET 和正常 JSON API 仍可用。'],
 ['SSE 多轮调用','15 个 SSE 场景通过，含新增 8 个首轮 / 次轮预留后撤销测试；状态仅发送阶段元数据，答案与公开摘要通过验证后才释放。'],
 ['隐私与账户','保留 0010 迁移、统计型自动日志、clear-all CAS、迟到写入和账户隔离；聊天取消、逐字显示、来源核验继续有效。'],
 ['运行时矩阵','28 个私有 API 的身份、来源、响应头与正常对照；202 项检查 × 2。另有 Worker / D1 smoke 55 项 × 2。'],
 ],[310,1110],26)
p.note('GHSA-xqc2-xf4c-x3h3 / CVE-2026-126187，官方 CVSS 9.5；未执行 RCE 载荷。\nhttps://github.com/advisories/GHSA-xqc2-xf4c-x3h3')
p.note('边界：发送前检查与网络发送不是跨系统原子操作，已发出的上游请求无法追回。OCR / Live 沿用各自路径。人工多轮代码审查和本地测试不等同于本会话不可用的 Codex Security 云端深扫。')
layout.append(p.save())
p=Page(3,'03 / Production HTTP load','对照当前线上源码，\n测完整请求路径。','两版生产构建 · 本地 workerd + 临时 D1 · 完整 HTTP 响应体 · 串行测试')
p.text('8 个隔离账户、30 天、46,800 条合成历史事件；7 个账户每日 80 条，1 个密集账户每日 1,000 条。请求比例：日志读 50%、记忆读 20%、词库 10%、首页 10%、日志写 10%。',28)
p.y+=20
rows=[]
for c in [1,4,12]:
 for label,data in [('线上源码',before),('2.19.4',after)]: rows.append([f'{c} / {label}']+[f'{v:.1f}' for v in aggregate(data,c)])
p.table(['并发 / 构建','p50 ms','p95 ms','p99 ms','请求/秒'],rows,[400,255,255,255,255],28)
p.note('每版 3 轮 × 1 / 4 / 12 并发，总计 1,020 次混合请求、错误均为 0。五次预热不计；百分位合并原始样本计算，吞吐用总请求数 / 总时间。密集账户在 12 并发中参与。')
p.section('12 并发与持续负载')
p.text(f'混合负载 p95：{b[1]:.1f} → {a[1]:.1f} ms，减少 {improvement:.1f}%；吞吐 {b[3]:.1f} → {a[3]:.1f} 请求/秒，约 {ratio:.2f} 倍。日志读取由逐日多次查询合并为 D1 batch。',29)
p.y+=18
p.table(['120 秒 / 12 并发读取','结果'],[['请求 / 错误',f'{len(soak):,} / {sum(x["status"]!=200 for x in soak)}'],['p50 / p95 / p99', ' / '.join(f'{pct([x["ms"] for x in soak],q):.1f}' for q in [.5,.95,.99])+' ms'],['四个 30 秒区间 p95',' / '.join(f'{pct([x["ms"] for x in soak if i*30000<=x["at"]<(i+1)*30000],.95):.1f}' for i in range(4))+' ms']],[560,860],28)
p.section('测量边界')
p.text('容器有效配额 4 CPU / 16 GiB，AMD EPYC 9V74，Node v24.22.1。闭环并发没有用户思考时间，也不代表开放到达率容量；存在 coordinated omission。测试使用真实应用请求路径与合成数据，未覆盖 WAN、生产 D1 网络拓扑和真实模型服务。',27)
p.note('120 秒持续读取是短时稳定性检查，不能证明小时级耐久或不存在内存泄漏。所有轮次和逐路由数据保存在原始 JSON；此前未合并版本的更低时延不用于本报告结论。')
layout.append(p.save())
p=Page(4,'04 / Browser & rendering','新回答逐字显示，\n历史回答保持稳定。','已复现、修复并复验的真实 React DOM 渲染回归；整站复验受环境限制。')
p.table(['受控组件回归 / 3 轮','修复前','修复后'],[['20 次更新中的历史 RichText 解析','每轮 1,180 次','每轮 0 次'],['当前回答更新','每轮 20 次','每轮 20 次'],['词库更换后来源重新核验','59 条历史','59 条历史'],['20 次同步 commit 总耗时中位数',f'{statistics.median(sum(x["updateMs"]) for x in sr["runs"] if x["variant"]=="baseline"):.1f} ms',f'{statistics.median(sum(x["updateMs"]) for x in sr["runs"] if x["variant"]=="current"):.1f} ms']],[760,330,330],27)
p.note('将 words 经 memoized MessageRow 传给 AssistantReply，避免每条历史回答订阅不断变化的全局 Context。组件夹具含 120 条消息、59 条历史回答；同步 commit 耗时不包括布局、绘制、网络，不是 INP。')
p.section('完整页面验证')
p.text('本轮未完成：受管理预览 sites-preview 在启动时出现 listen EPERM（127.0.0.1），没有获得可用 URL。依照环境规则，没有另建预览服务或调整网络权限；最终整站功能和混合历史浏览器负载均标记为未验证。',28)
p.y+=16
p.text('已准备但未执行的整站脚本：50 个会话、2,000 条混合消息，打开 120 条历史并模拟 SSE / 渐进显示，桌面与 390px / CPU×4 各 3 轮。mixed-ui-load.json 明确记录 blocked_environment，不提供未经测量的数字。',28)
p.section('指标解释与可见限制')
p.text('上方的组件级 Chromium 实测已成功运行，且修前 / 修后均使用实际 MessageList、RichText 和 AiProvenance。它确认重复渲染修复及来源刷新，不替代整站页面、存储和交互集成验收。',28)
p.text('前轮代码曾通过 19 组交互、4 个视口及 6 次历史负载；这些证据保留在原目录，不能计作最终合并版本的浏览器通过结果。本轮 35 项 companion 回归已通过，合并后的完整回归另执行两轮。',28)
p.note('正常对照：词库切换会重新核验来源；停止回答、隐藏未显示后缀、切账户与临时会话的安全约束均保留。渐进显示发生在服务端完成安全验证之后，不将未验证生成片段直接暴露给界面。')
layout.append(p.save())
p=Page(5,'05 / Verification & release','最终证据与\n发布来源核对。','本页描述验证对象；实际 PR、提交 SHA、CI 和 Sites 发布结果见交付回执 PNG。')
p.table(['验收项','结果 / 范围'],[['完整验收两轮',f'回归 {unitcounts[0]} / {unitcounts[0]} 与 {unitcounts[1]} / {unitcounts[1]}；数据审计、类型、ESLint、生产构建、产物校验全部通过。'],['生产运行时两轮','Worker / D1 smoke 55 × 2；28 API 与框架入口安全矩阵 202 × 2，通过。'],['独立复审','后端及 SSE、前端、发布与证据三份审查，无未解决阻塞；新增 SSE 撤销与真实历史渲染回归。'],['性能及 UI','两版各 3 轮混合负载、最终 120 秒持续读取、3 轮组件对照通过；最终整站浏览器复测因环境限制未完成。'],['依赖与证据','npm 全树 638 依赖项，0 个已知漏洞；原始样本、日志、源码和证据 SHA-256 可追溯。']],[390,1030],27)
p.section('源码、迁移和归档')
p.text('以 GitHub f10737e 为 PR 基线，保留 Sites 已上线提交 a9bb926 的聊天反馈、统计型自动日志、0010 隐私清理与安全归档链。合并修复后使用 2.19.4，不回滚线上已有功能。',28)
p.text('发布包必须来自已提交且干净的源码：隔离检出 → 锁定依赖安装 → 重新构建 → 完整路径 / 类型 / 字节 / 哈希回读。归档包含普通文件形式的 drizzle、journal 与根 migrations；Sites 推送源码与部署包使用同一完整提交 SHA。',28)
p.section('复现入口')
p.note('npm test\nnpm run audit:deps\nnode scripts/benchmark-workload.mjs --build <build-dir> --output <result.json>\nnode scripts/benchmark-workload.mjs --soak-seconds 120 --output <result.json>\npython3 artifacts/qa/prepublish-20261111/summarize-release.py')
p.section('仍未覆盖的范围')
p.text('最终整站浏览器复测受环境限制；未进行真实模型付费调用、物理设备、WAN 负载、小时级耐久或独立云端深扫。词库仍有 333 个英文释义缺口、153 个音标不完整词条、7 个未解析单元；这不是词库人工终审。',27)
p.note('证据目录：artifacts/qa/prepublish-20261111/。历史 streamline、security、chat-experience 报告保留原时间点，不能代替本轮最终验证。图片只表达实测结果；分享范围继续保持 Sites 仅所有者访问。')
layout.append(p.save())
(R/'release-report-layout.json').write_text(json.dumps(layout,ensure_ascii=False,indent=2)+'\n')
contact=Image.new('RGB',(1200,1132),'#ddd')
for n in range(1,6):
 im=Image.open(R/f'report-page-{n}.png');im.thumbnail((400,566));contact.paste(im,(((n-1)%3)*400,((n-1)//3)*566))
contact.save(R/'report-preview.png')
print(json.dumps(layout))
