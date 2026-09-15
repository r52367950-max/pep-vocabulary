export type OriginalExample = {
  word: string;
  en: string;
  zh: string;
  source: "词迹原创";
  /** Manually chosen alternatives, not an automatic claim of semantic similarity. */
  distractors: readonly string[];
};

const examples: Array<[string, string, string, string[]]> = [
  [
    "challenge",
    "Speaking in front of the whole school was a new challenge for me.",
    "在全校师生面前发言对我来说是一次新的挑战。",
    ["habitat", "author", "temperature"],
  ],
  [
    "confident",
    "After a week of practice, I felt confident about giving the speech.",
    "练习了一周后，我对发表演讲有了信心。",
    ["absent", "narrow", "ancient"],
  ],
  [
    "anxious",
    "She felt anxious about the exam and could not stop worrying.",
    "她为考试感到焦虑，始终担心不已。",
    ["confident", "ordinary", "available"],
  ],
  [
    "improve",
    "Reading your draft aloud can help you improve its rhythm.",
    "把草稿朗读出来，可以帮助你改善行文的节奏。",
    ["recycle", "reserve", "observe"],
  ],
  [
    "volunteer",
    "A student volunteer offered to guide visitors around the school without pay.",
    "一名学生志愿者主动提出，无偿带访客参观学校。",
    ["experiment", "destination", "chapter"],
  ],
  [
    "experiment",
    "We tested one variable at a time and kept the temperature constant throughout the experiment.",
    "实验中，我们每次只检验一个变量，并始终保持温度不变。",
    ["poem", "habitat", "journey"],
  ],
  [
    "observe",
    "Use a microscope to observe the cells in this leaf.",
    "用显微镜观察这片叶子中的细胞。",
    ["recycle", "reserve", "communicate"],
  ],
  [
    "evidence",
    "The scientist collected evidence to test whether the explanation was correct.",
    "这位科学家收集证据，以检验这个解释是否正确。",
    ["privacy", "furniture", "literature"],
  ],
  [
    "species",
    "The island is home to several species of birds found nowhere else.",
    "这座岛上栖息着几种其他地方没有的鸟类。",
    ["chapters", "schedules", "journeys"],
  ],
  [
    "habitat",
    "Draining the wetland would destroy the natural habitat of these birds.",
    "排干湿地会破坏这些鸟类的自然栖息地。",
    ["schedule", "privacy", "chapter"],
  ],
  [
    "explore",
    "We took a small boat to explore the caves along the coast.",
    "我们乘小船探索沿岸的洞穴。",
    ["recycle", "achieve", "communicate"],
  ],
  [
    "journey",
    "The train journey from our town to the coast took six hours.",
    "从我们的小镇乘火车到海边，这段旅程花了六小时。",
    ["species", "author", "evidence"],
  ],
  [
    "destination",
    "Our final destination was a village beside the lake.",
    "我们的最终目的地是湖边的一座村庄。",
    ["experiment", "privacy", "poem"],
  ],
  [
    "reserve",
    "We need to reserve two seats before all the train tickets are sold.",
    "我们需要在火车票售罄前预订两个座位。",
    ["observe", "reduce", "recycle"],
  ],
  [
    "local",
    "The museum tells the stories of local people who have lived in this town for years.",
    "这座博物馆讲述了在镇上生活多年的当地居民的故事。",
    ["ancient", "absent", "empty"],
  ],
  [
    "environment",
    "Cleaner buses can help protect the environment by reducing air pollution.",
    "更清洁的公交车可以通过减少空气污染来保护环境。",
    ["chapter", "schedule", "author"],
  ],
  [
    "reduce",
    "Turning off unused lights can reduce the amount of electricity we waste.",
    "关掉不用的灯，可以减少我们浪费的电量。",
    ["increase", "observe", "reserve"],
  ],
  [
    "recycle",
    "Please recycle these glass bottles instead of throwing them into the general waste bin.",
    "请回收这些玻璃瓶，不要把它们扔进普通垃圾桶。",
    ["observe", "achieve", "communicate"],
  ],
  [
    "protect",
    "A helmet can protect your head if you fall off your bicycle.",
    "如果骑车摔倒，头盔可以保护你的头部。",
    ["explore", "recycle", "reserve"],
  ],
  [
    "balance",
    "She lost her balance on the wet path and almost fell.",
    "她在湿滑的小路上失去平衡，差点摔倒。",
    ["destination", "literature", "habitat"],
  ],
  [
    "technology",
    "New technology allows doctors to examine detailed images of the heart.",
    "新技术让医生能够查看心脏的详细影像。",
    ["literature", "privacy", "furniture"],
  ],
  [
    "create",
    "The students will create a short film about the history of their school.",
    "学生们将制作一部关于校史的短片。",
    ["recycle", "reserve", "concentrate"],
  ],
  [
    "reliable",
    "Check the facts against a reliable source before sharing the story.",
    "分享这件事之前，先依据可靠的来源核对事实。",
    ["broken", "narrow", "anxious"],
  ],
  [
    "privacy",
    "The app protects your privacy by keeping personal notes on your own device.",
    "这款应用把个人笔记保存在你自己的设备上，以保护你的隐私。",
    ["journey", "habitat", "literature"],
  ],
  [
    "literature",
    "The course introduces students to literature through novels, poems and plays.",
    "这门课通过小说、诗歌和戏剧，引导学生了解文学。",
    ["temperature", "transport", "agriculture"],
  ],
  [
    "poem",
    "She read a short poem whose final line described the sound of rain.",
    "她读了一首短诗，诗的最后一行描写了雨声。",
    ["species", "habitat", "experiment"],
  ],
  [
    "author",
    "The author of this novel spent three years researching its historical setting.",
    "这部小说的作者花了三年时间研究故事的历史背景。",
    ["destination", "chapter", "schedule"],
  ],
  [
    "character",
    "The main character in the novel learns to accept help from other people.",
    "小说的主人公逐渐学会接受他人的帮助。",
    ["temperature", "schedule", "evidence"],
  ],
  [
    "chapter",
    "The last chapter of the novel explains why the family left their home.",
    "小说的最后一章解释了这家人离开家乡的原因。",
    ["species", "habitat", "privacy"],
  ],
  [
    "curious",
    "The child was curious about the stars and kept asking how they formed.",
    "这个孩子对星星很好奇，不断询问它们是如何形成的。",
    ["absent", "ordinary", "available"],
  ],
  [
    "discover",
    "Careful observation may help us discover why the leaves have changed colour.",
    "仔细观察或许能帮助我们发现树叶变色的原因。",
    ["reserve", "recycle", "communicate"],
  ],
  [
    "concentrate",
    "I find it easier to concentrate when my phone is in another room.",
    "手机放在另一个房间时，我发现自己更容易集中注意力。",
    ["recycle", "reserve", "achieve"],
  ],
  [
    "focus on",
    "For today's revision, focus on the words you found difficult yesterday.",
    "今天复习时，重点关注昨天觉得困难的单词。",
    ["give up", "run out of", "break into"],
  ],
  [
    "take part in",
    "All students are welcome to take part in the discussion and share their ideas.",
    "欢迎所有同学参与讨论，分享想法。",
    ["run out of", "look down on", "give in to"],
  ],
  [
    "benefit",
    "One benefit of walking to school is the chance to get regular exercise.",
    "步行上学的一个好处是有机会经常锻炼。",
    ["habitat", "species", "chapter"],
  ],
  [
    "available",
    "Two seats are still available, so you can book them now.",
    "还有两个空座，因此你现在可以预订。",
    ["anxious", "curious", "responsible"],
  ],
  [
    "responsible",
    "Each group is responsible for cleaning its own table after the experiment.",
    "实验结束后，每个小组负责清理自己的桌子。",
    ["absent", "ancient", "narrow"],
  ],
  [
    "solution",
    "Repairing the old pump was a cheaper solution to the water shortage.",
    "修理旧水泵是解决供水不足问题的一种更便宜的办法。",
    ["chapter", "species", "poem"],
  ],
  [
    "communicate",
    "We use words and gestures to communicate with people around us.",
    "我们用语言和手势与周围的人沟通。",
    ["recycle", "achieve", "reserve"],
  ],
  [
    "perspective",
    "Reading the same event from another character's perspective changed my view of it.",
    "从另一个人物的视角阅读同一事件，改变了我对它的看法。",
    ["temperature", "destination", "habitat"],
  ],
  [
    "independent",
    "She became more independent after learning to plan her own meals and budget.",
    "学会自己安排餐食和预算后，她变得更独立了。",
    ["absent", "ancient", "narrow"],
  ],
  [
    "adapt",
    "Some plants can adapt to dry conditions by storing water in their leaves.",
    "有些植物通过在叶片中储水来适应干旱环境。",
    ["reserve", "recycle", "achieve"],
  ],
  [
    "compare",
    "Place the two maps side by side to compare the routes they show.",
    "把两张地图并排放置，比较图中显示的路线。",
    ["reserve", "achieve", "recycle"],
  ],
  [
    "patient",
    "Please be patient while I check the figures one more time.",
    "请耐心等我再核对一次这些数字。",
    ["absent", "ancient", "empty"],
  ],
  [
    "achieve",
    "With regular practice, she hopes to achieve her goal of running five kilometres.",
    "通过定期练习，她希望实现跑完五公里的目标。",
    ["recycle", "observe", "reserve"],
  ],
  [
    "opportunity",
    "The school trip gave us an opportunity to study wildlife outside the classroom.",
    "这次学校出行给了我们在课堂外研究野生生物的机会。",
    ["author", "habitat", "species"],
  ],
  [
    "schedule",
    "I wrote the time of every meeting in my weekly schedule.",
    "我把每场会议的时间写进了每周日程表。",
    ["species", "habitat", "experiment"],
  ],
  [
    "pattern",
    "A repeating pattern of blue circles covered the cloth.",
    "布上布满了由蓝色圆圈重复组成的图案。",
    ["privacy", "journey", "literature"],
  ],
];

export const ORIGINAL_EXAMPLES: readonly OriginalExample[] = examples.map(
  ([word, en, zh, distractors]) => ({
    word,
    en,
    zh,
    distractors,
    source: "词迹原创",
  }),
);

const byWord = new Map(
  ORIGINAL_EXAMPLES.map((example) => [example.word, example]),
);
export function findOriginalExample(
  headword: string,
): OriginalExample | undefined {
  return byWord.get(
    headword.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " "),
  );
}

