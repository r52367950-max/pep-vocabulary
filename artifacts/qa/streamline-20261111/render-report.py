from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, math, statistics, subprocess, re
R=Path(__file__).resolve().parent
S=json.loads((R/'summary.json').read_text())
C=json.loads((R/'workload-final.json').read_text())
N=S['checks']['unitRounds'][0]['pass']; M=S['checks']['runtimeMatrixRounds'][0]
improvement=(1-S['performance']['after'][2]['p95']/S['performance']['before'][2]['p95'])*100
throughput=S['performance']['after'][2]['rps']/S['performance']['before'][2]['rps']
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
  self.d.text((1160,48),'2026.11.11 · 2.19.3',font=font(23),fill=MUTED)
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
  self.d.text((90,2181),'LOCAL VALIDATION  /  本地验证 · 未发布 · 仅图片报告',font=font(22),fill=MUTED)
  self.d.text((1360,2173),f'{self.n:02} / 07',font=font(32,True),fill=INK)
  self.im.save(R/f'report-page-{self.n}.png')
  return {'page':self.n,'contentBottom':self.y,'height':H}
layout=[]
p=Page(1,'01 / Outcome','指引精简与\n安全性能验证','GPT-6 Astra / Claude Opus 5.5 官方资料核查 · 词迹工作区优化')
# Three measured headline values.
y=p.y
for x,value,label in [(90,'84.6%','AGENTS.md 字节减少'),(580,f'{N} × 2','最终代码完整回归通过'),(1070,f'{improvement:.1f}%','12 并发混合负载 p95 降低')]:
 p.d.text((x,y),value,font=font(76,True),fill=INK);p.d.text((x,y+106),label,font=font(24),fill=MUTED)
p.y=y+190
p.section('已完成的工作')
p.item('01','缩短常驻指引','删除重复执行协议、禁词表、无来源引用与过时状态。模型按任务自主选择实现与验证方式，保留数据、权限及内容来源边界。')
p.item('02','修复隐私竞态与已知严重依赖漏洞','返回前复核隐私版本，发出请求前复核配置身份；更新 React/RSC 安全补丁，关闭未使用的框架动作入口。独立复核发现与证据见第 7 页。')
p.item('03','减少实际请求路径上的重复工作','学习日志逐日读取合并为 D1 批处理；助手复核只读版本信息；JSON 请求体只维护一次整体超时竞争，减少分块累积回调。')
p.section('交付状态')
p.table(['项目','结果'],[
 ['版本与兼容','2.19.2 → 2.19.3；兼容性修复，备份格式与词条 ID 保留，无新增迁移。'],
 ['代码与证据','工作区已修改；原始日志、复现脚本、JSON 测量与截图保留在项目 artifacts/qa/streamline-20261111/。'],
 ['线上与外部检查','未提交、未发布；获准执行 npm 全依赖与生产依赖审计，修复后已知告警均为 0。云端深度扫描协调工具不可用。'],
],[290,1130],27)
p.note('基线提交：f10737e675cf5e55352f0a9d2808600eb19e664d。所有性能数字来自本轮实测；合成数据运行于真实本地生产栈，不代表线上用户流量或真实模型服务延迟。')
layout.append(p.save())

p=Page(2,'02 / Prompt guidance','少写通用协议，\n只保留项目约束。','截至 2026-11-11 核查官方资料；“Cloud Opus 5.5”按 Claude Opus 5.5 理解。')
p.item('A','GPT-6 Astra','官方指出 Astra 对 AGENTS.md 和技能文件指令更敏感，应审查可访问规则。自主推进、澄清边界和验证投入要与任务相匹配。本次据此删去重复协议，不固定模型、代理数或推理强度。')
p.item('B','Claude Opus 5.5','官方建议用代表性任务校准 effort，以 medium 为起点，并移除无必要的“仔细思考”提示。长任务应明确完成条件。本次仅更新项目指引，没有更换应用模型或执行付费 A/B 评测。')
p.section('文件精简 · UTF-8 字节')
rows=[]
for d in S['documents']:rows.append([d['name'],f"{d['beforeBytes']:,}",f"{d['afterBytes']:,}",f"−{d['reductionPercent']:.1f}%"])
p.table(['文件','之前','之后','减少'],rows,[650,250,250,270],27)
totalBefore=sum(d['beforeBytes'] for d in S['documents']); totalAfter=sum(d['afterBytes'] for d in S['documents'])
p.note(f'四份指引合计 {totalBefore:,} → {totalAfter:,} 字节，减少 {(1-totalAfter/totalBefore)*100:.1f}%。CLAUDE.md 保持一行导入；完整来源、迁移和设计资料按需查阅，不复制到常驻提示词中。字节数不等同于模型 token 数。')
p.section('保留的约束')
p.text('账户隔离与同源校验；密钥服务端加密；限流与出站限制；事务、CAS 和 generation；离线学习与备份兼容；来源标记；中文、键盘、触控和减少动效。',29)
p.section('官方来源与定位')
p.note('[1] OpenAI · Using GPT-6 → Prompting best practices\nhttps://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices')
p.note('[2] Anthropic · Prompting Claude Opus 5.5 → Calibrate effort / Unattended agentic runs / Thinking instructions in chat system prompts\nhttps://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5')
p.note('[3] OpenAI · Custom instructions with AGENTS.md\nhttps://learn.chatgpt.com/docs/agent-configuration/agents-md')
layout.append(p.save())

p=Page(3,'03 / Security','隐私变化之后，\n旧回答停止返回。','发现 S-01：标准词汇助手缺少生成结束时的上下文复核。此次以同一测试对照旧模块与修复模块。')
p.table(['生成期间发生的变化','旧版 HTTP','修复后 HTTP'],[
 ['无变化：正常对照','200','200'],['关闭学习记忆','200，返回旧回答','409，拒绝返回'],['日志隐私版本变化','200，返回旧回答','409，拒绝返回'],['更换模型配置','200，返回旧回答','409，拒绝返回'],
],[740,340,340],27)
p.note('触发：同一账户的其他页面或设备在模型生成期间修改设置。影响是过期的个性化结果仍被返回；本轮未发现由此跨账户读取。新复核覆盖 8 类标准词汇助手的共享返回路径，聊天工具循环也复用相同版本检查。')
p.section('实现与正常对照')
p.text('verifyLearningContext 只比较账户范围、记忆版本与上下文版本，不再次读取日志正文。新学习活动增加日志普通 revision 时仍可继续；隐私 revision 改变时拒绝。读取上下文期间发生的记忆变化也有回归覆盖。',28)
p.text('D1 batch 保留用户条件、删除过滤、日期与事件排序、每天 20 条限制和整日引用去重。分块 JSON 保留字节上限、UTF-8 严格解码、取消和超时，同时减少每块建立 Promise.race 的累积开销。',28)
p.section('广泛安全回归覆盖')
p.table(['边界','本轮覆盖内容'],[
 ['身份 / HTTP','缺失身份、伪造入口、跨站与 opaque Origin、私有 no-store、JSON 脱敏；覆盖 28 个 API。'],
 ['数据 / 并发','备份恢复、跨账户、CAS 冲突、删除墓碑、迟到任务、配额与事务回滚、迁移重放。'],
 ['模型 / 资源','提示注入与材料来源、工具参数/预算/取消、计费与密钥作用域、受限出站、流式字节与超时。'],
 ['导入 / 浏览器','DOCX/PDF 资源限制、服务工作线程缓存、离线恢复、附件不持久化、临时会话与跨标签删除。'],
],[280,1140],26)
p.note(f'证据：privacy-before.log（1 正常通过 / 3 旧版失败）；security-after.log（初次定向 21 项通过）；最终两轮全量回归各 {N} 项通过。本地独立审查与动态回归不等同于不可用的云端深度扫描。')
layout.append(p.save())

p=Page(4,'04 / HTTP performance','从真实请求路径\n衡量优化效果。','生产构建 + 本地 workerd + 临时 D1 + 完整 HTTP 响应体；不是单个函数的微基准。')
p.text('8 个隔离账户 × 30 天历史，共 46,800 条事件。7 个账户每天 80 条，1 个高密度账户每天 1,000 条。混合请求：50% 日志读取、20% 记忆读取、10% 词库、10% 首页、10% 日志写入。',28)
p.y+=18
p.table(['并发 / 状态','p50 ms','p95 ms','p99 ms','请求/秒'],[
 [f"{b['concurrency']} / 修改前",f"{b['p50']:.1f}",f"{b['p95']:.1f}",f"{b['p99']:.1f}",f"{b['rps']:.1f}"] if i%2==0 else
 [f"{b['concurrency']} / 修改后",f"{b['p50']:.1f}",f"{b['p95']:.1f}",f"{b['p99']:.1f}",f"{b['rps']:.1f}"]
 for i,b in enumerate([v for pair in zip(S['performance']['before'],S['performance']['after']) for v in pair])
],[400,255,255,255,255],29)
p.note('每个版本 3 轮 × 3 并发档。1 / 4 / 12 并发合并样本分别为 60 / 240 / 720；各版本共 1,020 请求，错误均为 0。百分位按原始样本合并计算；吞吐按总请求数 / 总墙钟时间计算。')
p.section('12 并发 · p95 对照')
scale=1000/600;y=p.y
for label,value,color in [('之前',S['performance']['before'][2]['p95'],'#a6aaa7'),('之后',S['performance']['after'][2]['p95'],INK)]:
 p.d.text((90,y+3),label,font=font(28),fill=INK);p.d.rectangle((210,y,210+value*scale,y+47),fill=color);p.d.text((230+value*scale,y+2),f'{value:.1f} ms',font=font(29,True),fill=INK);y+=84
p.y=y+15
p.text(f'p95 减少 {improvement:.1f}%，吞吐增加至约 {throughput:.2f} 倍。30 天日志的数据库调用由“1 次日期查询 + 最多 30 次事件读取”收敛为“1 次日期查询 + 1 次批处理”。',29)
p.section('方法与解释边界')
p.text('两侧都从干净临时数据库启动；同一脚本、数据规模与请求比例，预热 5 次日志读取不计入测量。\n主机 AMD EPYC 9V74，容器配额 4 CPU / 16 GiB，Node v24.22.1。测量串行执行，没有把模型生成耗时混入结果。',27)
p.note('并发 1 / 4 / 12 分别启用 1 / 4 / 8 个账户，密集账户在 12 并发参与。闭环压力不是线上容量承诺；无 WAN 或真实 D1 网络拓扑。主对照为 workload-before.json / workload-final.json；此前另有两组三轮复验。')
layout.append(p.save())

p=Page(5,'05 / Sustained & browser','持续请求与\n重负载交互复验。','最终构建追加独立三轮 HTTP 复验；浏览器以真实界面、词库、存储与事件执行。')
soak=C['soak'];a=sorted(x['ms'] for x in soak);q=lambda v:a[math.ceil(v*len(a))-1]
p.table(['持续负载','结果'],[
 [f"12 并发 / {S['sustained']['seconds']} 秒",f"日志、记忆、词库与首页持续读取；{S['sustained']['requests']:,} 请求，{S['sustained']['errors']} 错误。"],
 ['延迟 p50 / p95 / p99',f'{q(.5):.1f} / {q(.95):.1f} / {q(.99):.1f} ms'],
 ['四个 30 秒区间 p95',' / '.join(f"{x['p95']:.1f}" for x in S['sustained']['segments'])+' ms'],
],[520,900],28)
p.note('持续负载是读取场景，写入已在混合负载和并发回归中覆盖。此前另有 60 秒、6,471 次请求复验。分钟级观察不足以评估小时级泄漏或生产长时间稳定性。')
p.section('浏览器重负载 · 三次中位数')
p.text('每次新建浏览器上下文，预置 50 个会话、2,000 条消息（约 491k 字符）。桌面 1440×900；手机视口 390×844 并模拟 4 倍 CPU 降速。',27)
p.y+=15
b=S['browser']
p.table(['实际操作','桌面','手机视口 / CPU×4'],[
 [label,f"{b['desktop'][key]['median']:.0f} ms",f"{b['phone-cpu4'][key]['median']:.0f} ms"] for label,key in [('启动至今日页','startupMs'),('打开 AI 对话','chatMs'),('展开 50 会话列表','listMs'),('搜索至单条结果','searchMs'),('连续输入整句','typingMs')]
],[600,350,470],28)
p.note('这里是自动化操作到结果的墙钟耗时，含 Playwright 调度；不是 INP。每档只有三次，采用中位数与原始记录，不宣称统计显著性。页面错误与横向溢出均为 0。')
p.section('保留的性能限制')
p.text(f"四倍降速测试共观察到 {b['phone-cpu4']['longTasks']} 个超过 50 ms 的长任务，最长 {b['phone-cpu4']['maxLongTaskMs']:.0f} ms；搜索单次最大约 {b['phone-cpu4']['searchMs']['max']:.0f} ms。低端设备仍需关注历史解析、渲染与主线程工作，并在物理设备复测。",28)
p.text(f"桌面 / 手机视口最终 JS 堆中位数约 {b['desktop']['heapBytes']['median']/1e6:.1f} / {b['phone-cpu4']['heapBytes']['median']/1e6:.1f} MB；单次快照不代表无泄漏。AI 与账户元数据使用测试返回，未测真实模型质量、延迟或 Live 麦克风。",28)
p.note('证据：workload-final.json；最终 browser-performance.json（6 次）；integration-browser.json（19 组）。四视口功能检查还覆盖 1180×760 与 820×1100 平板尺寸。')
layout.append(p.save())

p=Page(6,'06 / Evidence & limits','验证清单、复现入口\n与覆盖边界。','报告只交付 PNG；工程目录保留原始证据与可重跑脚本。')
p.table(['检查','本轮结果'],[
 ['全量回归',f"{S['checks']['testFiles']} 个测试文件；最终代码两轮各 {N} / {N}，通过 {N*2:,} 次用例执行。"],
 ['生产运行时',f'28 个 API 与框架入口矩阵 {M} × 2；现有 Worker/D1 smoke 54 × 2，均通过。'],
 ['构建与数据','类型、ESLint、生产构建、产物校验、词库与阅读审计通过。词库仍有声明的数据缺口。'],
 ['浏览器','19 组关键交互通过；四视口、切账户、临时会话、附件、实际练习、跨标签删除；另有 6 次重负载测量。'],
],[400,1020],26)
p.section('主要复现命令')
p.note('npm test\nnode --import ./tests/register.mjs --test tests/context-fencing.test.mjs tests/backend-security.test.mjs\nnpm run test:security -- /tmp/security.json\nnode scripts/benchmark-workload.mjs --soak-seconds 120 --output /tmp/workload.json')
p.note('浏览器：先运行 node scripts/serve-qa.mjs，再将其 QA_URL 作为 CIJI_QA_URL，执行 artifacts/qa/streamline-20261111/ 下的 integration-browser.mjs 与 browser-performance.mjs。需要 Chromium / Playwright。')
p.section('检查解释与剩余范围')
p.item('01','认证矩阵采用合法输入和精确状态码','缺失身份与不可信入口必须返回 401；跨站、opaque Origin 等按路由契约返回 403。旧版“任意 4xx”验法已废弃，最终证据使用收紧后的矩阵。正常身份读取与私有响应头也验证。')
p.item('02','外部审计完成；云端深扫与线上仍有边界','收到本次明确授权后完成 npm 审计与修复复查。Codex Security 深扫协调工具未提供，不能声称其全库扫描已完成。未验证线上网关、真实模型、物理设备；未提交或部署。')
p.item('03','数据与长期稳定性','词库仍有 333 个开放英文释义缺口、153 个音标不完整词条、7 个未解析单元。本轮不是全库人工终审；分钟级负载和浏览器 CPU 模拟不替代生产长稳测试。')
p.note('完整性核对：报告数字来自本轮 JSON / 日志；此前报告仅用于版式与项目上下文。所有 PNG 按 1600×2264 输出，检查文字边界后交付。')
layout.append(p.save())

p=Page(7,'07 / Independent review','追加审计发现，\n已落实到修复与回归。','两名 subagent 分别复核安全调用路径与测试证据；主代理整合后重新构建并验证最终代码。')
p.item('S-02','配置删除与发出请求之间存在竞态','修复前：先加载旧配置，随后配置被删除，新的上下文快照却以“已删除”为基线，仍能使用旧密钥发出 1 次请求并返回 200。独立复现仅使用本地 SQLite 与模拟 provider。')
p.text('另一个独立反例：预算预留期间关闭记忆，旧内容仍进入 provider mock，最后才返回 409。修复后 mock 调用为 0；未发送预留只退一次，既有计费保留。相关 46 项定向场景全部通过。',28)
p.y+=15
p.text('修复：runtime 绑定每次保存更换的 write_token；预算预留后核对配置与学习上下文，再发起调用。已完成的设置或隐私撤销导致 409，未发送预留退回。完成复核也纳入 token，捕捉相同时间戳下的变更；密钥重加密保持正常。',28)
p.section('S-03 / 已知严重 RSC 依赖漏洞')
p.table(['检查点','处理与证据'],[
 ['官方通告','GHSA-xqc2-xf4c-x3h3 / CVE-2026-126187；React Server Components 未授权远程代码执行，CVSS 9.5。'],
 ['实际可达性','react-server-dom-webpack 虽列为 devDependency，其解码器被打入生产 Worker，且表单处理先于业务 API 鉴权；不能只审计 prod 依赖。'],
 ['修复与复查','React / React DOM / RSC：19.2.8 → 19.2.9。npm 全依赖与 omit=dev 复查均为 0 个已知告警；全树 638 个依赖项。'],
 ['持续约束','CI 改为 audit:deps 覆盖构建链；检查安装版本、同版 peers 与锁文件副本。运行时安全矩阵已纳入 npm test / CI。'],
 ],[310,1110],26)
p.section('减少未使用的框架入口')
p.text('应用未用 Server Actions。框架前拒绝 action 请求（404）及 multipart POST（415）。\n覆盖页面、RSC 与 API 路径，不读取正文；HTML/RSC GET、正常 JSON API 保持可用。',28)
p.note('未知 action 字段曾触发通用 500，未外泄堆栈；现不会到达解码器，未执行 RCE 载荷。发送前隐私校验涵盖标准助手、chat、写作出题、听写计划及语音文字反馈/辅导；OCR 与 Live 沿用各自流程。已发出的上游调用无法追回，不宣称跨网络原子撤销。')
p.note('来源：https://github.com/advisories/GHSA-xqc2-xf4c-x3h3\n证据：dependencies-before / after / prod.json；runtime-security-patched-round1.log（修前 500）；最终安全矩阵、配置竞态复现与回归日志。')
layout.append(p.save())
(R/'report-layout.json').write_text(json.dumps(layout,ensure_ascii=False,indent=2)+'\n')
# Small contact sheet used only for visual verification.
contact=Image.new('RGB',(1200,1698),'#ddd')
for n in range(1,8):
 im=Image.open(R/f'report-page-{n}.png');im.thumbnail((400,566));contact.paste(im,(((n-1)%3)*400,((n-1)//3)*566))
contact.save(R/'report-preview.png')
print(json.dumps(layout))
