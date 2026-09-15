import type { LexiconIndexEntry } from "./lexicon";

export type ReadingArticle = {
  id: string;
  title: string;
  titleZh: string;
  topic: string;
  level: "高中基础" | "高中进阶";
  minutes: number;
  source: "词迹原创 · 非教材原文";
  paragraphs: readonly { en: string; zh: string }[];
  targets: readonly string[];
  questions: readonly {
    id: string;
    prompt: string;
    options: readonly string[];
    answerIndex: number;
    explanation: string;
  }[];
};

// These texts and translations were written for this application. They are not
// extracts from textbooks, news articles, or the external dictionary dataset.
export const READINGS: readonly ReadingArticle[] = [
  {
    id: "a-place-to-begin",
    title: "A Place to Begin",
    titleZh: "从阅览室开始",
    topic: "校园",
    level: "高中基础",
    minutes: 3,
    source: "词迹原创 · 非教材原文",
    paragraphs: [
      {
        en: "On her first week at a new school, Lin felt anxious about speaking in class. During lunch, she found a quiet reading room. A student volunteer showed her a shelf of short stories and invited her to join a small reading group. Lin agreed, although she was not confident about her English.",
        zh: "转学后的第一周，林对课堂发言感到不安。午饭时间，她找到了一间安静的阅览室。一名学生志愿者带她看了一架短篇小说，并邀请她参加一个小型阅读小组。林答应了，尽管她对自己的英语还不太有信心。",
      },
      {
        en: "The group met twice a week. Each person chose one paragraph and explained why it mattered. Lin prepared a few sentences before every meeting. Her goal was not to finish the most books, but to express one clear idea. After a month, she began to take part in class discussions too.",
        zh: "小组每周见面两次。每个人选一段文字，解释它为何重要。每次聚会前，林都会准备几句话。她的目标是表达清楚一个想法，而非读完最多的书。一个月后，她也开始参与课堂讨论了。",
      },
    ],
    targets: [
      "anxious",
      "volunteer",
      "confident",
      "prepare",
      "express",
      "take part in",
    ],
    questions: [
      {
        id: "begin-1",
        prompt: "What did Lin do before each meeting?",
        options: [
          "She prepared a few sentences.",
          "She finished a whole novel.",
          "She wrote a report for her teacher.",
        ],
        answerIndex: 0,
        explanation: "第二段明确写到，她在每次聚会前准备几句话。",
      },
      {
        id: "begin-2",
        prompt: "What change does the final sentence show?",
        options: [
          "Lin stopped visiting the reading room.",
          "Lin became more willing to share her ideas.",
          "Lin decided to study a different language.",
        ],
        answerIndex: 1,
        explanation: "她开始参加课堂讨论，说明她逐渐愿意在更多场合表达想法。",
      },
    ],
  },
  {
    id: "a-small-question",
    title: "A Small Question",
    titleZh: "一个小问题",
    topic: "生物",
    level: "高中基础",
    minutes: 3,
    source: "词迹原创 · 非教材原文",
    paragraphs: [
      {
        en: "Our biology group wanted to know whether light affected the growth of bean plants. We placed six similar plants near a window and another six farther away. We used the same soil and gave each plant the same amount of water. Every afternoon, we measured their height and wrote down what we could observe.",
        zh: "我们的生物小组想知道光照是否影响豆苗生长。我们把六株相似的豆苗放在窗边，另外六株放在离窗更远的地方。两组使用相同的土壤，每株获得等量的水。每天下午，我们测量株高，并记下观察到的现象。",
      },
      {
        en: "After two weeks, the groups looked different. However, our teacher asked us to check the temperature in both places. It was warmer by the window. We realised that one experiment could not answer every question. Good research requires careful records and a willingness to examine other explanations before treating a result as strong evidence.",
        zh: "两周后，两组豆苗看起来有所不同。不过，老师让我们检查两处的温度。窗边更暖和。我们意识到，一次实验无法回答所有问题。好的研究需要细致的记录，也需要愿意在把结果视为有力证据之前，考虑其他解释。",
      },
    ],
    targets: [
      "observe",
      "experiment",
      "research",
      "evidence",
      "temperature",
      "result",
    ],
    questions: [
      {
        id: "question-1",
        prompt: "What factor did the group fail to keep the same?",
        options: [
          "The amount of water.",
          "The type of soil.",
          "The temperature.",
        ],
        answerIndex: 2,
        explanation:
          "两组水量与土壤相同，但窗边温度更高，因此温度也可能影响结果。",
      },
      {
        id: "question-2",
        prompt: "Why was the teacher's question useful?",
        options: [
          "It proved that light had no effect.",
          "It encouraged the group to consider another explanation.",
          "It showed that measuring plants was unnecessary.",
        ],
        answerIndex: 1,
        explanation:
          "老师指出了另一个可能影响结果的因素；文章并未证明光照没有作用。",
      },
    ],
  },
  {
    id: "between-two-stations",
    title: "Between Two Stations",
    titleZh: "两站之间",
    topic: "旅行",
    level: "高中基础",
    minutes: 3,
    source: "词迹原创 · 非教材原文",
    paragraphs: [
      {
        en: "Before dawn, our train stopped at a small station. Most passengers were asleep, but I stayed by the window. Beyond the platform, a woman was opening a shop. A cyclist waited for a truck to pass. I had expected the journey to be empty time before we reached our destination. Instead, these ordinary scenes held my attention.",
        zh: "黎明前，火车停在一座小站。大多数乘客还睡着，我却一直望着窗外。站台外，一位女士正在开店门。一名骑车人等着卡车经过。我原以为旅途只是到达目的地之前的一段空白时间，这些普通的场景却吸引了我的注意。",
      },
      {
        en: "Later, we walked through a local market without a fixed schedule. We bought breakfast and asked a shopkeeper about the old bridge nearby. He pointed us towards a narrow street. By evening, my notebook contained no list of famous sights. It held small details that helped me imagine daily life in an unfamiliar city.",
        zh: "后来，我们没有按固定日程，走进了当地的一处市场。我们买了早餐，向店主打听附近的老桥。他指向一条狭窄的街道。到了晚上，我的笔记本里没有名胜清单，记录的是一些小细节。它们帮助我想象这座陌生城市里的日常生活。",
      },
    ],
    targets: [
      "journey",
      "destination",
      "local",
      "schedule",
      "ordinary",
      "detail",
    ],
    questions: [
      {
        id: "stations-1",
        prompt: "What surprised the writer during the train journey?",
        options: [
          "The interest of ordinary scenes.",
          "The number of famous sights.",
          "The speed of the train.",
        ],
        answerIndex: 0,
        explanation: "第一段中，作者原以为旅途乏味，却被普通的日常场景吸引。",
      },
      {
        id: "stations-2",
        prompt: "What was the notebook mainly used to record?",
        options: [
          "Ticket prices.",
          "Small details of everyday life.",
          "A strict travel plan.",
        ],
        answerIndex: 1,
        explanation: "最后两句强调，笔记中记录的是帮助理解城市生活的细节。",
      },
    ],
  },
  {
    id: "before-the-bin",
    title: "Before the Bin",
    titleZh: "扔进垃圾桶之前",
    topic: "环境",
    level: "高中基础",
    minutes: 3,
    source: "词迹原创 · 非教材原文",
    paragraphs: [
      {
        en: "Our school put recycling bins beside the playground, but the environmental club wanted to do more. For one week, members counted the disposable cups left after lunch. Then they asked students why they used them. Some had forgotten their bottles; others said the drinking fountains were too far from their classrooms.",
        zh: "学校在操场边放置了回收桶，但环保社团希望多做一些事。整整一周，成员们统计午饭后留下的一次性杯子，然后询问同学使用它们的原因。一些人忘带水瓶，另一些人说饮水处离教室太远。",
      },
      {
        en: "The club suggested adding a water station near the dining hall and keeping clean spare cups there. A month later, fewer disposable cups appeared in the bins. The project taught us to look beyond a simple message such as 'recycle more'. To reduce waste, we also need to understand the choices people face and make a better choice easier.",
        zh: "社团建议在食堂附近增设饮水点，并准备干净的备用杯。一个月后，垃圾桶里的一次性杯子减少了。这个项目让我们懂得，思考不能止于“多回收”这样简单的口号。要减少浪费，还需要了解人们面临的选择，让更好的选择更容易实现。",
      },
    ],
    targets: ["recycle", "reduce", "suggest", "waste", "project", "choice"],
    questions: [
      {
        id: "bin-1",
        prompt: "Why did club members ask students questions?",
        options: [
          "To find out why they used disposable cups.",
          "To choose a new club leader.",
          "To make a list of students who forgot lunch.",
        ],
        answerIndex: 0,
        explanation: "调查的目的是了解使用一次性杯子的原因，随后据此提出措施。",
      },
      {
        id: "bin-2",
        prompt: "Which idea best matches the project's lesson?",
        options: [
          "Signs alone can solve every waste problem.",
          "Recycling bins should be removed.",
          "Practical changes can help people waste less.",
        ],
        answerIndex: 2,
        explanation: "饮水点与备用杯改变了使用条件，使减少浪费更容易做到。",
      },
    ],
  },
  {
    id: "check-the-answer",
    title: "Check the Answer",
    titleZh: "核对答案",
    topic: "科技",
    level: "高中进阶",
    minutes: 3,
    source: "词迹原创 · 非教材原文",
    paragraphs: [
      {
        en: "For a history project, our class tried an AI tool that could create a summary in seconds. Its first answer sounded clear and confident. Yet when we checked the dates against our textbook, we found two mistakes. One source mentioned in the answer did not seem to exist. Speed had made the task easier, but it had not made the information reliable.",
        zh: "做历史项目时，我们班尝试了一款能在几秒内生成摘要的人工智能工具。它的第一个回答清楚而肯定。然而，对照课本核对日期时，我们发现了两处错误。回答提到的一项资料似乎并不存在。速度让任务变得容易，却没有让信息变得可靠。",
      },
      {
        en: "We changed our approach. We used the tool to suggest questions, then searched for evidence ourselves. We also removed names and personal details before sharing any notes. Technology was still useful, but we remained responsible for the final work. The best result came from combining a helpful tool with careful human judgement.",
        zh: "我们改变了做法：让工具提出问题，再亲自查找证据。在分享笔记前，我们也删去了姓名和个人细节。技术仍然有用，但我们依旧需要对最终作品负责。将有帮助的工具与审慎的人类判断结合，才取得了最好的结果。",
      },
    ],
    targets: [
      "create",
      "reliable",
      "evidence",
      "technology",
      "responsible",
      "source",
    ],
    questions: [
      {
        id: "answer-1",
        prompt: "What showed that the first answer was unreliable?",
        options: [
          "It took too long to appear.",
          "It contained incorrect dates and a doubtful source.",
          "It used words from the textbook.",
        ],
        answerIndex: 1,
        explanation: "第一段列出了日期错误和疑似不存在的资料来源。",
      },
      {
        id: "answer-2",
        prompt: "How did the class use the tool afterwards?",
        options: [
          "They accepted every answer without checking.",
          "They stopped asking any questions.",
          "They used its questions as a starting point for their own research.",
        ],
        answerIndex: 2,
        explanation: "第二段说明，他们让工具提出问题，然后自己查证。",
      },
    ],
  },
  {
    id: "notes-in-the-margin",
    title: "Notes in the Margin",
    titleZh: "书页旁的笔记",
    topic: "文学生活",
    level: "高中进阶",
    minutes: 3,
    source: "词迹原创 · 非教材原文",
    paragraphs: [
      {
        en: "On a rainy afternoon, I read the opening chapter of a novel twice. The first time, I followed the action. The second time, I noticed how the author described a room through what the main character chose to see. A cracked cup received three lines, while the expensive furniture was hardly mentioned.",
        zh: "一个下雨的下午，我把一部小说的第一章读了两遍。第一遍，我关注情节。第二遍，我注意到，作者通过主人公选择看到的东西来描写房间。一个有裂纹的杯子用了三行文字，昂贵的家具却几乎没有被提到。",
      },
      {
        en: "I wrote a question in the margin: why does this cup matter? I did not search for an answer immediately. Instead, I kept reading and changed my guess as new details appeared. Literature sometimes asks us to remain uncertain for a while. That patience can reveal more than a quick explanation of what a story is supposed to mean.",
        zh: "我在页边写下一个问题：这个杯子为什么重要？我没有立刻查找答案，而是继续读，随着新细节的出现修改自己的猜想。文学有时要求我们容许一时的不确定。这种耐心可能比急于解释一个故事的所谓含义，让我们发现更多。",
      },
    ],
    targets: [
      "chapter",
      "author",
      "character",
      "literature",
      "describe",
      "reveal",
    ],
    questions: [
      {
        id: "margin-1",
        prompt: "What did the writer notice on the second reading?",
        options: [
          "How the room reflected the character's attention.",
          "How much every piece of furniture cost.",
          "How many chapters the novel contained.",
        ],
        answerIndex: 0,
        explanation:
          "第二遍阅读关注的是主人公注意哪些物件，以及作者如何借此呈现房间。",
      },
      {
        id: "margin-2",
        prompt: "What does the final paragraph encourage readers to do?",
        options: [
          "Avoid changing their first interpretation.",
          "Keep reading and revise their ideas when necessary.",
          "Find an online explanation before finishing a chapter.",
        ],
        answerIndex: 1,
        explanation:
          "作者随着新细节调整猜想，并肯定容许不确定、耐心阅读的价值。",
      },
    ],
  },
];

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

export function findReadingTargets(
  article: ReadingArticle,
  entries: readonly LexiconIndexEntry[],
): LexiconIndexEntry[] {
  const wanted = new Set(article.targets.map((word) => word.toLowerCase()));
  const matches = new Map<string, LexiconIndexEntry>();
  for (const entry of entries) {
    const word = entry.headword.toLowerCase();
    if (wanted.has(word) && !matches.has(word)) matches.set(word, entry);
  }
  return article.targets
    .map((word) => matches.get(word.toLowerCase()))
    .filter((entry): entry is LexiconIndexEntry => Boolean(entry));
}

export function readingWordCount(article: ReadingArticle): number {
  return article.paragraphs.reduce(
    (count, paragraph) =>
      count + (paragraph.en.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)?.length || 0),
    0,
  );
}
