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

export { ORIGINAL_EXAMPLES, findOriginalExample, type OriginalExample } from "./examples";

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
