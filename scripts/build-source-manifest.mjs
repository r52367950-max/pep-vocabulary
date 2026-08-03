import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cache = process.env.PEP_VOCAB_SOURCE_CACHE || "/workspace/source-cache/pep-vocab";
const uploads = process.env.PEP_VOCAB_UPLOADS || "/workspace/scratch/242015b76399/project_sources";
const books = JSON.parse(readFileSync(join(root, "config/books.json"), "utf8"));
const acquiredAt = "2026-08-03";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pdfInfo(path) {
  try {
    const text = execFileSync("pdfinfo", [path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const value = (key) => text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() || null;
    return { pages: Number(value("Pages")) || null, encrypted: value("Encrypted"), producer: value("Producer") };
  } catch {
    return { pages: null, encrypted: null, producer: null };
  }
}

function recordFile({ id, title, path, kind, sourceUrl, parsingMethod, versionStatus, rights, notes, metadata = {} }) {
  if (!existsSync(path)) {
    return { id, title, fileName: basename(path), path, kind, status: "missing", ...metadata };
  }
  const info = path.toLowerCase().endsWith(".pdf") ? pdfInfo(path) : {};
  return {
    id,
    title,
    fileName: basename(path),
    path,
    bytes: statSync(path).size,
    sha256: sha256(path),
    pages: info.pages ?? null,
    encrypted: info.encrypted ?? null,
    producer: info.producer ?? null,
    sourceUrl,
    acquiredAt,
    parsingMethod,
    versionStatus,
    rights,
    knownIssues: notes || [],
    ...metadata,
  };
}

const entries = books.map((book) => recordFile({
  id: book.id,
  title: book.title,
  path: join(cache, book.path),
  kind: "textbook-candidate",
  sourceUrl: `https://github.com/TapXWorld/ChinaTextbook/tree/master/${book.stage === "high" ? "高中" : "初中"}/人教版/英语`,
  parsingMethod: book.ocrPath ? "page-image + OCR candidate + visual cross-check" : "PDF text layer + page-image visual cross-check",
  versionStatus: book.versionStatus,
  rights: "copyrighted-reference-only; do-not-redistribute",
  notes: book.ocrPath
    ? ["原 PDF 无可用文本层；OCR 仅作候选，正式字段需与页图或独立来源一致。"]
    : ["Poppler 报告部分 Marked Content 参数异常；词表文本和页图仍可读取。"],
  metadata: {
    publisher: book.publisher,
    volume: book.volume,
    isbn: null,
    edition: book.edition || null,
    printing: null,
    copyrightYear: book.copyrightYear || null,
    editorialDate: book.editorialDate || null,
    wordListPages: book.wordList,
  },
}));

entries.push(
  recordFile({
    id: "STD-HS-EN-2017-2020",
    title: "普通高中英语课程标准（2017年版2020年修订）",
    path: join(cache, "standards/high-school-english-2017-2020.pdf"),
    kind: "curriculum-standard",
    sourceUrl: "https://www.pep.com.cn/xw/zt/rjwy/gzkb2020/202205/P020220517522153664167.pdf",
    parsingMethod: "PDF text layer + appendix reconciliation",
    versionStatus: "verified-primary",
    rights: "official-reference; extracted word list only",
  }),
  recordFile({
    id: "STD-COMPULSORY-EN-2022",
    title: "义务教育英语课程标准（2022年版）",
    path: join(cache, "standards/compulsory-english-2022.pdf"),
    kind: "curriculum-standard",
    sourceUrl: "https://www.moe.gov.cn/srcsite/A26/s8001/202204/W020220420582349487953.pdf",
    parsingMethod: "PDF image/text extraction + visual inspection",
    versionStatus: "verified-primary",
    rights: "official-reference; extracted requirements only",
  }),
  recordFile({
    id: "OEWN-2025-PLUS",
    title: "Open English WordNet 2025 plus JSON",
    path: join(cache, "open-data/oewn/english-wordnet-2025-plus-json.zip"),
    kind: "open-dictionary",
    sourceUrl: "https://en-word.net/downloads/english-wordnet-2025-plus-json.zip",
    parsingMethod: "JSON entry/synset join",
    versionStatus: "verified-primary",
    rights: "CC BY 4.0; Open English WordNet contributors",
  }),
  recordFile({
    id: "IPA-DICT-EN-UK",
    title: "ipa-dict English UK pronunciation list",
    path: join(cache, "open-data/ipa-dict/en_UK.txt"),
    kind: "open-pronunciation-data",
    sourceUrl: "https://github.com/open-dict-data/ipa-dict/blob/master/data/en_UK.txt",
    parsingMethod: "tab-separated pronunciation lookup",
    versionStatus: "verified-primary",
    rights: "MIT; open-dict-data/ipa-dict",
  }),
  recordFile({
    id: "IPA-DICT-EN-US",
    title: "ipa-dict English US pronunciation list",
    path: join(cache, "open-data/ipa-dict/en_US.txt"),
    kind: "open-pronunciation-data",
    sourceUrl: "https://github.com/open-dict-data/ipa-dict/blob/master/data/en_US.txt",
    parsingMethod: "tab-separated pronunciation lookup",
    versionStatus: "verified-primary",
    rights: "MIT; open-dict-data/ipa-dict",
  }),
  recordFile({
    id: "ECDICT-2025",
    title: "ECDICT free English-Chinese dictionary database",
    path: join(cache, "open-data/ecdict/ecdict.csv"),
    kind: "open-dictionary",
    sourceUrl: "https://github.com/skywind3000/ECDICT/blob/master/ecdict.csv",
    parsingMethod: "CSV lookup; core translation and phonetic fields only",
    versionStatus: "verified-primary",
    rights: "MIT; Copyright (c) 2025 Linwei",
    notes: ["只取核心释义与音标；商业词典标识列和不可追溯扩展内容不作为权威来源。"],
  }),
  {
    id: "DRIVE-ARCHITECTURE-RECOMMENDATIONS",
    title: "VOCAB_APP_ARCHITECTURE_AND_FEATURE_RECOMMENDATIONS.md",
    fileName: "VOCAB_APP_ARCHITECTURE_AND_FEATURE_RECOMMENDATIONS.md",
    path: "Google Drive file 1I7ZVvsxtAklPZHNMoT6SZpR-cwiacGH3",
    bytes: 32451,
    sha256: null,
    pages: null,
    kind: "project-brief",
    sourceUrl: "https://drive.google.com/file/d/1I7ZVvsxtAklPZHNMoT6SZpR-cwiacGH3",
    acquiredAt,
    parsingMethod: "Google Drive text fetch",
    versionStatus: "verified-user-source",
    rights: "private project material",
    knownIssues: ["Drive connector supplied complete text but not a local byte-identical copy; SHA-256 is unavailable."],
  },
  {
    id: "MIKIGO-MIDDLE-CROSSCHECK",
    title: "english-chinese-words 人教版初中词表",
    fileName: "32 scoped Markdown/meta files",
    path: join(cache, "open-data/mikigo-middle"),
    bytes: null,
    sha256: null,
    pages: null,
    kind: "cross-check-word-list",
    sourceUrl: "https://github.com/mikigo/english-chinese-words/tree/main/docs/人教版初中",
    acquiredAt,
    parsingMethod: "Markdown headings and first bold gloss only",
    versionStatus: "verified-cross-source",
    rights: "Apache-2.0 repository; examples and expanded notes excluded because upstream provenance is not field-level",
    knownIssues: ["只用于核对词头和核心中文义；不使用仓库中的例句、同义词或扩展短语。"],
  },
);

if (existsSync(uploads)) {
  const originalNames = [
    "03_暑期滚动七周主计划.md", "06_记录与复盘模板.md", "04_六科学科路线图.md",
    "2026暑期学习项目核心文件.md", "08_诊断与测评蓝图.md", "00_新项目启用说明.md",
    "01_项目总指令_粘贴到项目设置.md", "02_学生档案与项目状态.md", "05_首周启动包.md",
    "07_资料与来源索引.md", "09_GPT-Live-1英语口语教练提示词.md", "biology_required_1.pdf",
    "biology_selective_1.pdf", "biology_selective_2.pdf", "biology_required_2.pdf", "chemistry_selective_1.pdf",
  ];
  readdirSync(uploads).sort().forEach((name, index) => {
    const path = join(uploads, name);
    entries.push(recordFile({
      id: `UPLOAD-${String(index + 1).padStart(2, "0")}`,
      title: originalNames[index] || name,
      path,
      kind: "user-upload-out-of-scope",
      sourceUrl: null,
      parsingMethod: name.endsWith(".pdf") ? "metadata scan only" : "UTF-8 text scan",
      versionStatus: "verified-user-source",
      rights: "private user material; not redistributed",
      notes: ["已扫描并确认与本英语词汇应用的教材数据工程无直接关系，未进入词库。"],
    }));
  });
}

const manifest = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  sourceRoot: cache,
  policy: {
    rawTextbooksCommitted: false,
    formalReleaseUnknownRightsAllowed: false,
    ocrMayDirectlyPublish: false,
  },
  entries,
};

writeFileSync(join(root, "source_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const rows = entries.map((item) => `| ${item.id} | ${item.title.replaceAll("|", "\\|")} | ${item.pages ?? "—"} | ${item.versionStatus} | ${item.parsingMethod} | ${item.rights} |`);
const markdown = `# 来源清单\n\n` +
  `生成时间：${manifest.generatedAt}  \n` +
  `机器可读版本：[source_manifest.json](./source_manifest.json)\n\n` +
  `原始教材、整页 OCR 和页图只保存在不发布的来源缓存中。正式包只包含结构化词条、最短必要证据定位和许可清楚的开放数据字段。\n\n` +
  `| ID | 标题 | 页数 | 版本状态 | 解析方式 | 权利状态 |\n|---|---|---:|---|---|---|\n${rows.join("\n")}\n\n` +
  `## 缺失与版本结论\n\n` +
  `目标高中七册与初中五册均已有候选文件，没有缺册。候选文件未显示可可靠提取的 ISBN/印次，因此这些字段保持空值；版本状态不被夸大为印次级确认。七年级下册和八年级下册原文件没有可用文本层，已执行 OCR，并要求词头、核心义和单元边界至少与页图或独立结构化来源一致后才进入正式发布包。\n\n` +
  `## 已知问题\n\n` +
  `- 教材版权页明确禁止未经许可复制；PDF、整篇课文和整页 OCR 不随应用发布。\n` +
  `- ChinaTextbook 仅作为候选文件入口，公开可见不等于可再分发。\n` +
  `- 两册扫描版的 OCR 不能单独形成正式字段。\n` +
  `- 用户上传的生物、化学教材和学习计划已登记，但不属于本词库数据来源。\n`;
writeFileSync(join(root, "SOURCE_MANIFEST.md"), markdown);

console.log(`source manifest: ${entries.length} records (${books.length} textbooks)`);
