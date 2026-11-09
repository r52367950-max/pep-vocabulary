/**
 * Sentence-level Chinese translations and grammar notes for the prototype's sample article.
 * Written for the prototype; they are not NOAA's or a textbook's translation. Keys are
 * `${paragraph}-${sentence}` in the order produced by scripts/extract-data.mjs.
 */
export const NOTES_LABEL = "原型译注 · 为演示撰写，非 NOAA 官方译文或教材内容";

export type SentenceNote = { zh: string; core: string; points: string[] };

export const MANGROVE_NOTES: Record<string, SentenceNote> = {
  "0-0": {
    zh: "红树林（又称 mangal）生长在赤道附近的热带和亚热带纬度地区，那里的海面温度从不低于 16°C。",
    core: "主干：Mangrove forests … grow（主语 + 不及物动词）。",
    points: [
      "“or mangals” 是对主语的另一种叫法，起同位说明作用。",
      "where the sea surface temperatures never fall below 16°C 是 where 引导的定语从句，说明这些纬度地区的条件。",
    ],
  },
  "0-1": {
    zh: "世界热带地区大约三分之二的海岸线上都分布着红树林。",
    core: "主干：Mangals line the coastlines。",
    points: [
      "line 在这里是动词，意为“沿……排列、分布在……边上”。",
      "about two-thirds of 修饰数量，“大约三分之二的”。",
    ],
  },
  "1-0": {
    zh: "红树约有 80 种，它们都生长在缺氧（含氧量低）的土壤中；那里水流缓慢，细小的沉积物得以积累。",
    core: "主干：There are about 80 species of mangrove trees（There be 句型）。",
    points: [
      "all of which grow in hypoxic … soils 是“代词 + of which”引导的非限制性定语从句，which 指这 80 种红树。",
      "where slow-moving waters allow fine sediments to accumulate 修饰 soils；allow sth to do 表示“使……得以……”。",
    ],
  },
  "1-1": {
    zh: "许多红树林可以凭密集缠结的支柱根辨认出来，这些根让树木看起来像踩着高跷立在水面上。",
    core: "主干：Many mangrove forests can be recognized by …（情态动词 + 被动语态）。",
    points: [
      "that make the trees appear to be standing on stilts 是定语从句，修饰 prop roots。",
      "make sth do（使……）；appear to be doing（看起来正在……）。",
    ],
  },
  "1-2": {
    zh: "这片缠结的根系有助于减缓潮水的流动，使更多沉积物从水中沉降下来，堆积成泥质的底部。",
    core: "主干：This tangle of roots helps to slow the movement of tidal waters。",
    points: [
      "causing even more sediments to settle … and build up … 是现在分词短语作结果状语。",
      "cause sth to do；settle 与 build up 并列，共用 to。",
    ],
  },
  "2-0": {
    zh: "红树林能稳固海岸线，减少风暴潮、海流、波浪和潮汐造成的侵蚀。",
    core: "主干：Mangrove forests stabilize the coastline。",
    points: [
      "reducing erosion from … 是现在分词短语，说明稳固海岸线带来的结果。",
      "storm surges, currents, waves and tides 四项并列，作 from 的宾语。",
    ],
  },
  "3-0": {
    zh: "正如盐沼的高处和低处各自长着特定种类的草，红树林也有明显的分区，各区以生长在那里的红树种类为特征。",
    core: "主干：mangals have distinct zones。",
    points: [
      "Just like … salt marshes where specific types of grasses are found 是比较状语，其中 where 从句修饰 areas。",
      "characterized by the species … 是过去分词短语作后置定语，修饰 zones；that grows there 修饰 the species of mangrove tree。",
    ],
  },
  "3-1": {
    zh: "某种红树生长在哪里，取决于它对潮汐淹没和土壤盐度的耐受程度，以及养分是否充足。",
    core: "主干：Where a species of mangrove tree exists depends on …（主语从句作主语）。",
    points: [
      "Where a species … exists 是 where 引导的主语从句，谓语是 depends on。",
      "depends on 的宾语可理解为 its tolerance for (tidal flooding, soil salinity) 与 the availability of nutrients 两部分。",
    ],
  },
  "3-2": {
    zh: "佛罗里达有三种占优势的红树。",
    core: "主干：Three dominant species … are found in Florida（被动语态）。",
    points: ["be found in 表示“分布于、见于”；dominant 意为“占优势的”。"],
  },
  "4-0": {
    zh: "红色红树（Rhizophora mangle）占据红树林靠海的一侧，因此受潮汐淹没最多。",
    core: "主干：The red mangrove … colonizes the seaward side of the mangal。",
    points: [
      "括号内是学名，不影响句子结构。",
      "so it receives … 是 so 引导的结果分句；the greatest amount of 为最高级。",
    ],
  },
  "4-1": {
    zh: "再往内陆、在地势稍高的地方，生长着黑色红树（Avicennia germinanas）。",
    core: "主干：black mangroves … grow。",
    points: [
      "Further inland and at a slightly higher elevation 是前置的地点状语，主谓没有倒装。",
      "Further、higher 为比较级，与上一句靠海的一侧形成对照。",
    ],
  },
  "4-2": {
    zh: "黑色红树所在的区域，只在涨潮时被浅浅地淹没。",
    core: "主干：The zone … is only shallowly flooded during high tides（被动语态）。",
    points: ["in which black mangrove trees are found 是“介词 + which”引导的定语从句，修饰 the zone。"],
  },
  "4-3": {
    zh: "白色红树（Laguncularia racemosa）和钮扣树（Conocarpus erectus，不属于红树）朝向内陆，占据红树林中地势最高的部分。",
    core: "主干：White mangrove … and buttonwood trees … face inland and dominate the highest parts。",
    points: [
      "a non-mangrove species 是同位语，说明 buttonwood trees。",
      "face 与 dominate 是并列谓语；the highest parts 为最高级。",
    ],
  },
  "5-0": {
    zh: "白色红树和钮扣树生长的区域几乎从不被潮水淹没。",
    core: "主干：The zone … is almost never flooded by tidal waters（被动语态）。",
    points: ["where white mangrove and buttonwood trees grow 是定语从句，修饰 the zone；almost never 意为“几乎从不”。"],
  },
};
