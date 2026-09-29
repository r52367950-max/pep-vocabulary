/**
 * Scoring guidance for essay review, paraphrased from the published Gaokao English writing
 * criteria (application writing, 15 points; continuation writing, 25 points; five bands each,
 * as in the national papers). Provinces may split bands differently; see docs/ESSAY_RUBRIC.md
 * for sources. This is editorial guidance for the model, not quoted exam text.
 *
 * It is static text inside SYSTEM_PROMPT, so it stays in the cached prompt prefix.
 */

export const ESSAY_BANDS = {
  practical: [[1, 3], [4, 6], [7, 9], [10, 12], [13, 15]],
  continuation: [[1, 5], [6, 10], [11, 15], [16, 20], [21, 25]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

/** Free writing is judged on the continuation scale (25 points). */
export const bandsFor = (genre: string) => (genre === "practical" ? ESSAY_BANDS.practical : ESSAY_BANDS.continuation);

export const ESSAY_RUBRIC = [
  "### 高考书面表达评分方法（批改时照此执行）",
  "先通读全文，按整体印象定档；再用该档要求逐项核对，决定档内高低或升降一档；最后给分。评分看四个方面：内容（要点或情节）、词汇与语法结构的丰富性和准确性、上下文连贯与衔接、与题目或原文的契合。",
  "为尝试较复杂结构或较高级词汇而产生的个别错误，比简单句里的基础错误更可宽容；大量基础错误（主谓一致、时态、单复数、拼写）直接拉低档次。篇幅明显不足或大量抄写题目、原文，应降档。",
  "",
  "应用文（满分 15，genre=practical）五档：",
  "- 第五档 13–15：完成全部任务，要点齐全，格式和语气得体；词汇与句式多样且准确，偶有因尝试复杂表达的小错；衔接自然，结构紧凑。",
  "- 第四档 10–12：要点齐全，个别要点展开不足；词汇句式较多样，有少量错误但不影响理解；衔接较好。",
  "- 第三档 7–9：基本完成任务，漏掉或写不清一两个要点；词汇句式基本够用但较单一；有一些错误，个别影响理解；有简单衔接。",
  "- 第二档 4–6：未恰当完成任务，漏掉或写错多个要点；词汇句式有限，错误较多，影响理解；缺少衔接。",
  "- 第一档 1–3：明显未完成任务，内容很少或与题目关系不大；错误多，严重影响理解。",
  "",
  "读后续写（满分 25，genre=continuation；自由写作 free 也按此量表）五档：",
  "- 第五档 21–25：续写内容丰富合理，与原文情境、人物和段首句高度融洽，情节完整；词汇与句式多样且恰当，表达流畅，错误很少；段间、句间衔接自然有效，前后呼应。",
  "- 第四档 16–20：内容比较丰富合理，与原文比较融洽；词汇句式比较多样，有少量错误但不影响理解；衔接比较有效，结构清晰。",
  "- 第三档 11–15：内容基本合理，与原文基本衔接，但有情节缺漏或不够自然之处；词汇句式能满足基本需要；有一些错误，个别影响理解；有一定衔接。",
  "- 第二档 6–10：内容或逻辑有较多问题，与原文衔接较差；词汇句式单一，错误较多，影响理解；衔接手段很少。",
  "- 第一档 1–5：与原文和段首句脱节，内容太少；结构单调、错误多，严重影响理解；全文不连贯。",
  "",
  "结构与衔接怎么看：开头是否直接回应任务或承接段首句；主体段是否各有中心、按时间或逻辑推进；结尾是否收束（应用文的礼貌结语，续写的情感升华或照应）；是否使用恰当而不堆砌的衔接词、指代与复现来连接句子和段落。",
  "句式与难句怎么看：识别作文中真正成立的复杂结构——定语从句、名词性从句、状语从句、非谓语作状语或定语、with 复合结构、倒装、强调句、虚拟语气、独立主格、比较结构等；只有语法正确且表意清楚的才算加分项。句式单一时，挑 2–4 个简单句给出升级改写：保留原意，使用高中阶段应掌握的结构，不追求生僻。读后续写还要看动作、神态、心理和环境描写是否具体生动。",
].join("\n");
