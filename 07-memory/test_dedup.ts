// 治理测试台：①给旧数据补正文向量（幂等） ②阈值校准探针（纯计算，不写任何记忆文件）
// 用法：
//   node 07-memory/test_dedup.ts          → 补向量 + 打校准分数表
//   node 07-memory/test_dedup.ts clean    → 存量去重巡检（会真的合并/删除，跑前看一眼审计日志目录）
//   node 07-memory/test_dedup.ts clean 0.72 → 巡检用更松的阈值（存量两两比对可以松一点，有 LLM 并集兜底）
import 'dotenv/config'
import { MERGE_THRESHOLD, dedupeMemories } from './memory.ts'
// 引 mini_agent 只为副作用：注册 LLM 合并策略（isMain 保护下不会跑会话）
import './mini_agent.ts'
import { backfillContentVectors, cosine, embed, parseVectorsFromFile } from './vector_store.ts'

await backfillContentVectors()

// ---------- 阈值校准：应合并的（同义/重复/部分重叠） vs 不应合并的（相邻主题/无关） ----------
const vectors = await parseVectorsFromFile()
const byName = new Map(vectors.map((v) => [v.name, v.contentVector ?? []]))

const probes: Array<[string, string]> = [
	['P1 同义改写（期望：合并进 family-size）', '赵德升家一共七口人：本人赵德升、媳妇李露露、儿子赵睿泽，弟弟赵德财、妹妹赵慧，父亲赵立成，母亲孙花'],
	['P2 重复事实（期望：合并进 birth-years）', '赵德升1994年出生，妻子李露露比他小一岁，1995年出生'],
	['P3 部分重叠（期望：合并，并集场景）', '赵德升2013年从郧阳区一中毕业考上延安大学，高中暑假还在洗车店打工挣钱'],
	['P4 相邻主题新事实（期望：不合并，新建）', '赵德升的儿子赵睿泽上小学了，喜欢踢足球'],
	['P5 完全无关（期望：不合并，新建）', '用户最近在学 Rust，每周健身三次，早上六点起床'],
]

const queryVecs = await embed(probes.map(([, text]) => text))
console.log(`\n===== 阈值校准（MERGE_THRESHOLD = ${MERGE_THRESHOLD}）=====`)
for (let i = 0; i < probes.length; i++) {
	const [label] = probes[i]
	const top3 = [...byName.entries()]
		.filter(([, vec]) => vec.length)
		.map(([name, vec]) => ({ name, score: cosine(queryVecs[i], vec) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
	console.log(`\n${label}`)
	top3.forEach((s, j) => console.log(`  top${j + 1}: ${s.name}  ${s.score.toFixed(3)}`))
	console.log(`  判定: ${top3[0].score >= MERGE_THRESHOLD ? '→ 走合并' : '→ 新建记忆'}`)
}

// ---------- 存量巡检 ----------
if (process.argv[2] === 'clean') {
	const threshold = Number(process.argv[3]) || undefined
	console.log(`\n===== 存量去重巡检（阈值 ${threshold ?? MERGE_THRESHOLD}）=====`)
	const report = await dedupeMemories({ threshold })
	console.log(report.length ? report.join('\n') : '没有发现 ≥ 阈值的重复记忆')
}
