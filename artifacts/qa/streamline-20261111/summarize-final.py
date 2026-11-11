from pathlib import Path
import json, math, statistics, subprocess, re, hashlib

R = Path(__file__).resolve().parent
ROOT = R.parents[2]
read = lambda name: json.loads((R / name).read_text())
quantile = lambda values, p: sorted(values)[math.ceil(len(values) * p) - 1]

def workload(name):
    data = read(name)
    result = []
    for concurrency in (1, 4, 12):
        runs = [r for r in data['scenarios'] if r['concurrency'] == concurrency]
        values = [v for r in data['samples'] if r['concurrency'] == concurrency for v in r['latencies']]
        result.append(dict(concurrency=concurrency, n=len(values), p50=quantile(values, .5),
            p95=quantile(values, .95), p99=quantile(values, .99),
            rps=len(values)*1000/sum(r['elapsedMs'] for r in runs),
            roundP95=[r['p95'] for r in runs], errors=sum(len(r['errors']) for r in runs)))
    return result

documents = []
for name in ('AGENTS.md', 'docs/DEVELOPMENT.md', 'docs/prompt-guidance.md', 'PROJECT_STATE.md'):
    before = subprocess.check_output(['git', 'show', f'f10737e675cf5e55352f0a9d2808600eb19e664d:{name}'], cwd=ROOT)
    after = (ROOT / name).read_bytes()
    documents.append(dict(name=name, beforeBytes=len(before), afterBytes=len(after), reductionPercent=(1-len(after)/len(before))*100))

browser = {}
for device in ('desktop', 'phone-cpu4'):
    runs = [r for r in read('browser-performance.json')['runs'] if r['device'] == device]
    metrics = {}
    for key in ('startupMs', 'chatMs', 'listMs', 'searchMs', 'typingMs', 'heapBytes'):
        values = [r[key] for r in runs]
        metrics[key] = dict(median=statistics.median(values), min=min(values), max=max(values))
    metrics['longTasks'] = sum(len(r['longTasks']) for r in runs)
    metrics['maxLongTaskMs'] = max([v for r in runs for v in r['longTasks']] or [0])
    metrics['pageErrors'] = sum(len(r['pageErrors']) for r in runs)
    metrics['overflow'] = max(r['overflow'] for r in runs)
    browser[device] = metrics

final = read('workload-final.json')
soak = final['soak']
soakSummary = dict(seconds=final['soakSeconds'], requests=len(soak), errors=sum(r['status'] != 200 for r in soak),
    p50=quantile([r['ms'] for r in soak], .5), p95=quantile([r['ms'] for r in soak], .95), p99=quantile([r['ms'] for r in soak], .99))
soakSummary['segments'] = [dict(start=start, p95=quantile([r['ms'] for r in soak if start <= r['at']/1000 < start+30], .95)) for start in range(0, final['soakSeconds'], 30)]

def unit(name):
    text = (R / name).read_text()
    return {k: int(re.findall(rf'(?:ℹ |# ){k} (\d+)', text)[-1]) for k in ('tests','pass','fail','cancelled','skipped')}

matrices = [read(f'runtime-security-final-round{i}.json') for i in (1,2)]
for matrix in matrices:
    assert not matrix.get('failures'), matrix.get('failures')
units = [unit(f'unit-final-round{i}.log') for i in (1,2)]
assert all(u['tests'] == u['pass'] and u['fail'] == 0 for u in units)
assert units[0] == units[1]
assert len(matrices[0]['checks']) == len(matrices[1]['checks'])
smoke = []
for round in (1, 2):
    log = (R/f'runtime-final-round{round}.log').read_text()
    smoke.append(len(json.loads(log[log.index('{\n  "runtime"'):])['results']))
functional = read('integration-browser.json')
assert functional['status'] == 'passed' and not functional['pageErrors']
summary = dict(baseline='f10737e675cf5e55352f0a9d2808600eb19e664d', version='2.19.3', documents=documents,
    performance=dict(before=workload('workload-before.json'), after=workload('workload-final.json')),
    browser=browser, sustained=soakSummary,
    checks=dict(unitRounds=units, testFiles=len(list((ROOT/'tests').glob('*.test.mjs'))),
        runtimeMatrixRounds=[len(m['checks']) for m in matrices], routes=matrices[0]['routes'],
        runtimeSmokeRounds=smoke, browser=len(functional['checks'])),
    audit=dict(before=read('dependencies-before.json')['metadata']['vulnerabilities'],
        after=read('dependencies-after.json')['metadata']['vulnerabilities'],
        production=read('dependencies-prod.json')['metadata']['vulnerabilities'],
        dependencies=read('dependencies-after.json')['metadata']['dependencies']))
(R/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
changed = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, text=True).splitlines()
changed += ['scripts/local-worker.mjs','scripts/benchmark-workload.mjs','scripts/check-runtime-security.mjs','scripts/serve-qa.mjs','tests/context-fencing.test.mjs','tests/private-api-fixtures.mjs']
verification = dict(baseline=summary['baseline'], version=summary['version'], checks=summary['checks'],
    audit=summary['audit'], sustained=soakSummary,
    blocked=dict(deepSecurityScan='Codex Security coordinator unavailable; scoped independent reviews and broad local tests performed.'),
    notPerformed=['production deployment','production gateway validation','paid provider calls','physical device measurements','RCE exploitation'],
    evidence=['unit-final-round1.log','unit-final-round2.log','runtime-final-round1.log','runtime-final-round2.log',
        'runtime-security-final-round1.json','runtime-security-final-round2.json','workload-before.json','workload-final.json',
        'browser-performance.json','integration-browser.json','dependencies-before.json','dependencies-after.json','dependencies-prod.json',
        'independent-review/review-summary.json','data-audit-final.log','reading-audit-final.log','typecheck-final2.log','lint-final2.log','build-final2.log'],
    sourceSha256={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sorted(set(changed)) if (ROOT/name).is_file()},
    reportPages=[f'report-page-{n}.png' for n in range(1,8)])
(R/'verification.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2)+'\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
