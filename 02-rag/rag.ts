// 模块 2：RAG —— 开卷考试
//
// 流程：读文档 → 切片 → [A 关键词检索 / B 向量检索] → 拼进 prompt → 生成
//
// 面试核心答案（动手前先记住）：
//   RAG = 模型的知识不够新/不够私有时，先从外部资料"检索"出相关段落，
//   塞进上下文，再让模型"生成"答案——开卷考试。改的是上下文，不是模型本身。
//
// 两个阶段：
//   阶段 A（TODO 1/2/4）：纯本地关键词检索，零 API 成本，写完立刻能跑
//   阶段 B（TODO 3）：换成 embedding 向量检索，和 A 跑同样的问题对比效果
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

// 聊天模型走 Coding Plan 端点
const CHAT_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const CHAT_MODEL = "glm-4.6";

// embedding 走按量计费的标准端点（Coding Plan 只包聊天模型）。
// 报"余额不足/无权限"时两个选择：① bigmodel 充 1~2 元（embedding-3 很便宜）；
// ② 注册硅基流动（有免费的 BAAI/bge-large-zh-v1.5），改下面两行即可
const EMBED_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const EMBED_MODEL = "embedding-3";

const apiKey = process.env.GLM_API_KEY;
// const embedApiKey = process.env.EMBED_API_KEY; // 假设 embedding API key 存在单独的环境变量中
if (!apiKey) {
  console.error("没找到 GLM_API_KEY。请在 ai-agent-lab/.env 里配置");
  process.exit(1);
}
const chatClient = new OpenAI({ apiKey, baseURL: CHAT_BASE_URL });
const embedClient = new OpenAI({ apiKey, baseURL: EMBED_BASE_URL });

// ---------- 文档读取（给你写好的，不用动） ----------
type Chunk = { file: string; index: number; text: string };

async function loadDocs(): Promise<{ file: string; text: string }[]> {
  const dir = path.join(import.meta.dirname, "docs");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  return Promise.all(
    files.map(async (f) => ({ file: f, text: await fs.readFile(path.join(dir, f), "utf-8") }))
  );
}

// ---------- TODO 1：切片 ----------
//   按"长度 + 重叠"切：每个 chunk 约 size 个字符，相邻 chunk 重叠 overlap 个字符。
//   思考（面试考点）：chunk 太大 → 检索不精准 + 白白占上下文；
//                    太小 → 一句话被拦腰斩断，语义不完整。
//   经验值：中文 200~500 字/片，重叠 50 字左右。
//   加分项：生产上会先按标题/段落等语义边界切，再对超长段落二次切——比硬切好。
function chunk(text: string, size = 300, overlap = 50): string[] {
  if (text.length <= size) {
    return [text];
  }
  const res: string[] = [];
  const chunkSize = size - overlap;
  const totalSize = text.length;
  const count = Math.ceil(totalSize / chunkSize);
  for (let i = 0; i < count; i++) {
    const item = text.slice(i*chunkSize, Math.min(i*chunkSize + size, totalSize));
    res.push(item);
  }
  return res;
}

// ---------- TODO 2：阶段 A —— 关键词检索（零成本，先跑通这个） ----------
//   对每个 chunk 打分：查询里的每个字/词在 chunk 中出现的次数之和，降序取前 k。
//   这是 BM25 的简化版（BM25 额外做了词频饱和、文档长度惩罚、IDF 加权）。
//   写完先体验：查"远程办公"能命中；查"在家上班"呢？——记住这个失败案例，阶段 B 见分晓。
function searchKeyword(query: string, chunks: Chunk[], k = 3): Chunk[] {
  // throw new Error("TODO 2：实现关键词检索");
  const map = new Map();
  for (let i = 0,len = chunks.length; i< len; i++) {
    const chunk = chunks[i];
    const count = getCount(query, chunk);
    map.set(chunk, count);
  }
  // 按分数降序排列并取前 k 个
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([chunk]) => chunk);
}

function getCount(query: string, chunk: Chunk): number {
  const reg = /[,.!?，。！？、\s]/g;
  let score = 0;
  const cleanString = query.replaceAll(reg, '');
  for (let i = 0, len = cleanString.length; i < len; i++) {
    const item = cleanString.slice(i, i + 2);
    score += (chunk.text.split(item).length - 1);
  }
  return score;
}

// ---------- TODO 3：阶段 B —— 向量检索 ----------
//   3a) embedAll：批量把文本转成向量。input 传数组，一次请求批量搞定（省请求次数）。
//       返回 number[][]，顺序和输入一致。模型用 EMBED_MODEL。
//   3b) cosine：手写余弦相似度 = 点积 / (模A * 模B)，约 5 行。
//       思考：embedding 已经归一化的话，余弦相似度退化成什么？（点积）
//   3c) searchVector：query 向量和所有 chunk 向量算余弦相似度，降序取前 k。
//       面试考点：pgvector/Milvus 这些"向量数据库"本质就是存向量+算相似度+排序，
//       海量数据时用 HNSW 等近似索引换速度——原理和你这 10 行一样。
async function embedAll(texts: string[]): Promise<number[][]> {
  // throw new Error("TODO 3a：实现批量 embedding");
  const response = await embedClient.embeddings.create({
    model: EMBED_MODEL,
    input: texts
  });
  return response.data.map(item => item.embedding);
}

function cosine(a: number[], b: number[]): number {
  // throw new Error("TODO 3b：实现余弦相似度");
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

async function searchVector(query: string, chunks: (Chunk & { embedding: number[] })[], k = 3): Promise<Chunk[]> {
  // throw new Error("TODO 3c：实现向量检索");
  const queryEmbedding = await embedAll([query]);
  const queryVector = queryEmbedding[0];
  const scores = chunks.map(chunk => ({
    chunk,
    score: cosine(queryVector, chunk.embedding)
  }));
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ chunk }) => chunk);
}

// ---------- TODO 4：RAG 生成 ----------
//   把检索到的 chunks 编号拼进 prompt，要求模型：
//   ① 只根据资料回答；② 回答末尾标注引用了哪几号资料；③ 资料里没有就明说"资料中未提及"。
//   这三条就是"引用溯源 + 防幻觉"的最低配实现——面试可以整段讲。
async function answer(question: string, retrieved: Chunk[]): Promise<string> {
  // throw new Error("TODO 4：实现 RAG 生成");
  const retrievedText = retrieved.map((chunk, index) => `【${index + 1}】${chunk.text}`).join("\n");
  const prompt = `请根据以下资料回答问题：
${retrievedText}
要求：
1. 只根据资料回答；
2. 回答末尾标注引用了哪几号资料；
3. 资料里没有就明说"资料中未提及"。`;

  const response = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "user", content: question },
      { role: "system", content: prompt }
    ]
  });

  return response.choices[0].message.content || '资料中未提及';
}

// ---------- 主流程（不用动） ----------
type Retriever = (query: string) => Promise<Chunk[]>;

async function evaluate(name: string, retrieve: Retriever, questions: string[]) {
  console.log(`\n########## 检索方式：${name} ##########`);
  for (const q of questions) {
    console.log(`\n【问】${q}`);
    const retrieved = await retrieve(q);
    console.log("【检索到】", retrieved.map((c) => `${c.file}#${c.index}`).join(", "));
    console.log("【答】", await answer(q, retrieved));
  }
}

const docs = await loadDocs();
const chunks: Chunk[] = docs.flatMap((d) =>
  chunk(d.text).map((text, index) => ({ file: d.file, index, text }))
);
console.log(`共 ${docs.length} 篇文档，切出 ${chunks.length} 个 chunk`);

// 能区分两种检索能力的问题：第 1 题关键词就能中，第 2/3 题考语义理解
const QUESTIONS = [
  "年假有几天？",
  "在家上班可以吗？",
  "音箱半夜会吵到邻居吗？",
];

// 阶段 A：关键词版，写完 TODO 1/2/4 即可跑
await evaluate("关键词检索", async (q) => searchKeyword(q, chunks), QUESTIONS);

// 阶段 B：向量版，写完 TODO 3 再解开下面注释（embedding 报错不影响阶段 A）
const embedded = chunks.map((c, i) => ({ ...c }));
{
  const vectors = await embedAll(chunks.map((c) => c.text));
  vectors.forEach((v, i) => (embedded[i].embedding = v));
  await evaluate("向量检索", async (q) => searchVector(q, embedded), QUESTIONS);
}
