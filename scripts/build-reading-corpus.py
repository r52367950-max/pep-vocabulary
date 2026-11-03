"""Rebuild curated readings from pinned, unabridged source files, never model text.

Selections are half-open blank-line block ranges after the Gutenberg START line.
Only typographic underscore markup and hard line wraps are normalized. Source
paragraph boundaries and complete sentences are retained. Run audit-readings.mjs
after rebuilding. Metadata and bilingual introductions are editorial additions.
"""
import gzip
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/readings"
OUT = ROOT / "public/readings/v1"
sources = json.loads((DATA / "sources.json").read_text())
selections = json.loads((DATA / "curation.json").read_text())
catalog = json.loads((OUT / "index.json").read_text())
catalog = [a for a in catalog if a["addedIn"] != "2.1.0"]
evidence = []
articles = {}
supplemental = [json.loads(file.read_text()) for file in sorted((DATA / "supplemental").glob("*.json"))]
seen = set()

def article_path(article_id):
    if not isinstance(article_id, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", article_id) or len(article_id) > 91:
        raise ValueError("Invalid reading ID")
    target = (OUT / "articles" / f"{article_id}.json").resolve()
    target.relative_to((OUT / "articles").resolve())
    return target

# Check every output before source extraction or any writes.
for item in [*catalog, *selections, *supplemental]:
    article_id = item["id"]
    article_path(article_id)
    if article_id in seen:
        raise ValueError(f"Duplicate reading ID: {article_id}")
    seen.add(article_id)

for selection in selections:
    spec = dict(selection)
    book, start, end = spec.pop("book"), spec.pop("start"), spec.pop("end")
    source = sources[str(book)]
    raw = gzip.decompress((DATA / source["file"]).read_bytes())
    assert hashlib.sha256(raw).hexdigest() == source["sha256"]
    body = re.split(r"\*\*\* START[^\n]*\n", raw.decode("utf-8-sig"), maxsplit=1)[1]
    blocks = re.split(r"\n\s*\n", body)
    excluded = spec.pop("excludeBlocks", [])
    chosen = [b for i, b in enumerate(blocks) if start <= i < end and i not in excluded]
    paragraphs = [re.sub(r"\s+", " ", b.replace("_", "")).strip() for b in chosen]
    paragraphs = [p for p in paragraphs if p]
    assert paragraphs and not any(re.search(r"GUTENBERG|\[Illustration|\[Picture|\[Footnote|\*\*\* END", p, re.I) for p in paragraphs), spec["id"]
    spec.update({
        "sourceUrl": source["url"],
        "rights": {"label": "公版原文", "basis": "本版本据 Project Gutenberg 的美国公版电子书提取；保留原句，仅整理换行与排版。版权状态的地域依据为美国，其他地区须以当地法律为准。", "url": source["rightsUrl"]},
        "wordCount": len(re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)*", " ".join(paragraphs))),
        "addedIn": "2.1.0",
    })
    article = {**spec, "paragraphs": [{"en": p} for p in paragraphs]}
    articles[spec["id"]] = article
    catalog.append(spec)
    evidence.append({"id": spec["id"], "source": source["file"], "sourceSha256": source["sha256"], "startBlock": start, "endBlockExclusive": end, "excludedCaptionBlocks": excluded, "opening": paragraphs[0][:100], "ending": paragraphs[-1][-100:], "bodySha256": hashlib.sha256("\n\n".join(paragraphs).encode()).hexdigest()})

# Other collections contain exact NOAA extracts and clearly labelled originals.
for article in supplemental:
    articles[article["id"]] = article
    catalog.append({k: v for k, v in article.items() if k not in ("paragraphs", "targets", "questions")})

# Mix categories and lengths in the first page; curated order remains deterministic.
priority = ["andersen-real-princess", "stevenson-walking-tours", "noaa-estuaries", "sewell-my-early-home", "cather-art-fiction", "noaa-tides", "carroll-rabbit-hole", "thoreau-winter-walk", "noaa-ocean-formation"]
catalog.sort(key=lambda a: (priority.index(a["id"]) if a["id"] in priority else len(priority), a["id"]))
# Serialize every article before writing any generated content.
serialized = {article_path(key): json.dumps(value, ensure_ascii=False, indent=2) + "\n" for key, value in articles.items()}
for target, content in serialized.items():
    target.write_text(content)
(OUT / "index.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
(DATA / "extraction-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
print(f"Built {len(selections)} literary readings; {len(catalog)} total articles.")
