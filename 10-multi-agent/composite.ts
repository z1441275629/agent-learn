/*
模块 10 §7 v2：组合系统——研究⇄审校① → 写手⇄审校②（分段验的产线）

v1（git ab6cd46）：研究员直通写手，审校唯一挂在末端 → 验点唯一 → 全链验（素材+简报+稿件都给审校）。
v2 动因：验点从唯一改成分段——每段有自己的审校，每段只对上游负责。三笔账：
  ① 失败前移：v1 里简报的错要等写作循环才被看见（写手的 token 已经花掉）——三态账单
     「失败发现越早越便宜」的结构版；v2 烂简报在写手开工前就被打回，写作预算零损失
  ② 修订路由：v1 的修订指令只能喂写手，简报的错写手修不了只能绕（薄料轮「弃约保真」的影子）；
     v2 谁的问题回谁的循环
  ③ 一级验落地：审校② 只对简报关验稿件的忠实转写，handoff 不再带原始素材——省的钱乘在轮数上

产线结构（v2）：
  原始素材（本模块六节真实战果浓缩，无 PII 无网络）
    → 研究员 → 形状门检（免费）→ 审校①（真金白银）⇄ 研究员修订 → 验过的简报
    → 写手 → 审校②（一级验）⇄ 写手修订 → 周报

每段两级闸门（§3 门检与 §6 critic 的分工在产线各满血）：
  研究段契约天然结构化（条数 / 数字 / 主线标注 / 出处编号全是字面可判）→ digestCheck 纯函数上岗，
  免费的先跑——门检打回不烧审校的钱；A 版探针「乱码前缀 + ok:true 漏网」在此被拦。
  写作段契约是「自然段 + 语义」，机器判不了形状 → 只走 critic——门检的性价比 = 契约的机器可判度。

熔断语义分层（v2 最重要的结构决定）：
  - 中间段（研究）熔断 → 产线停机，交付熔断报告：审校② 只验忠实不验对错，未验简报流下去
    只会错得更安静——机器下游无法为上游的未验物负责，「降级交付」只能交给人
  - 末端段（写作）熔断 → 诚实降级交付最后一稿 + 未解决项（§6 语义原样——末端没有下游，人接管）

import 不重写（组装赛的证明，v2 加码）：
  parseCriticVerdict 两段共用——机器不认段，只认首行 PASS/FAIL 锚；
  criticPrompt 一字不改挂审校②——每段的「原始素材」= 它的直接上游交接物，简报对写作段就是源头；
  研究段新写 digestCriticPrompt：判据跟着交接物走（覆盖性/出处真实/主线合理是简报的质量轴，
  稿件的针对性/实用性对简报无意义）。

金笔记（v2 增量）：
  - 结构决定验法：验点唯一 → 全链验看源头；验点分段 → 每段只对上游——先定结构再定验法，不是反过来
  - 一级验的信任是买来的：审校② 敢只看简报，是因为审校① 验过简报——上游验收缺位，下游的验就退化
    成「对照一份未验物」；一级验的盲区（素材对、简报转错、稿件忠实转写）全靠审校① 拦
  - 熔断交付的位置语义：中间段停机、末端段降级——「带病放行」的危害随段位升高
  - 门检判得到多深 = 判据的字面可判度：出处「有标注、编号在素材范围内」机器判得了，
    「编号指对内容」判不了——那半截留给审校①（判据分层的精确切法）
  - 账：最好 4 发（v1 是 3 发，多一道审校①）；最坏 12 发（v1 是 7 发）——最坏账买的是
    「每次修订都修在对的段上」+「写作预算不替研究段的错买单」
*/
import { spawn, type SpawnResult } from './spawn.ts'
import { criticPrompt, parseCriticVerdict, type CriticVerdict } from './critic.ts'
import { TraceCollector } from '../11-production/trace.ts'

// 熔断预算：每段各持 2——分段验下轮预算独立，研究段的 2 轮不挤占写作段的
// （为什么是 2：一轮 = critic 一发 + 重写一发，两轮改不好大概率是指令问题不是轮数问题——§6 结论沿用）
const MAX_REVISIONS = 2

// ---------- 原始素材：本模块六节的真实战果（git log 浓缩，自带数字密度） ----------
// §9 起导出——基线探针 import 同一份（单一事实源：数据也只有一份，改素材两处不会漂移）
export const SOURCE_MATERIAL = [
  '§1 spawn 原语：子 agent 只回传结论（≤500 字契约+截断双保险），双 token 栏入账。',
  '§2 supervisor：失控探针打满 5 单、熔断拦下第 6 单；隔离实测——主管 prompt 13,749，五个子 agent 合计 92,917。',
  '§3 pipeline：门检三出路（打回/带标注放行/失败短路）；实测抓出打回只记最后一发的账本 bug。',
  '§4 fan-out：并行墙钟 51.1s vs 串行和 72.5s；迟到样本弃子后 0.8s 落地补账。',
  '§5 handoff：皮球探针实测——白名单是软锚不是硬闸，删了「数学运算」四个字模型照样自答。',
  '§6 generator-critic：修前熔断 completion 11,724 → 修后通过 7,557；critic 拆穿用字数统计冒充内容数字。',
].join('\n')

// 素材的节号上界——从数据推导不硬编码（素材改版不用记得回来改这里）
const MAX_SECTION = Math.max(...[...SOURCE_MATERIAL.matchAll(/§(\d+)/g)].map((m) => Number(m[1])))

// ---------- 研究员任务书 ----------
// ZCode 打样（评审意见：①「组织出周报」越权——研究员交简报，周报是写手的活，角色边界要切干净；
// ② 注意那行照抄了骨架注释的 meta 建议（「例如分组、标重要性」是给写任务书的人的提示），
// 要落成模型可执行的动作指令；③ 缺「替写手做掉哪些决定」——研究员的最大价值。亮点：join('\n') 学会了、条数/数字/出处三个锚都齐）
export function researchPrompt(): string {
  /* ---------- 你写的（原版——保留对照） ----------
	return [
		'角色：你是一个研究员，你根据原始的工作记录数据，组织出周报。',
		'输出契约：输出3-5条要点，至少2条数据带数字。你的输出要有依据，是组织格式，不是创造，每一条要指明出处',
		'注意：你的任务是研究，不是缩写。研究的价值在于组织，例如 分组、标重要性'
	].join('\n')
	---------- 打样版 ---------- */
  return [
    '角色：你是研究员。上游交接物是本周的原始工作记录，你要把它组织成【研究简报】——下游写手会拿你的简报写一篇给团队新人看的周报。',
    '研究方法（组织，不是缩写）：',
    '- 归类：同类战果合并为一条（比如多个章节里都出现「隔离」相关的证据，合成一条讲隔离）',
    '- 标重要性：判断哪条是本周主线——写手只会突出你标注了【主线】的那条',
    '- 替写手做决定：新人看不懂的术语标注需要解释、最有说服力的数字标注建议引用——你标出来，写手就不用猜',
    '输出契约：3~5 条要点，每条一行「要点内容（出处：§N）」；至少 2 条含素材里的具体数字；主线放第一行并标注【主线】；不要输出段落文字。',
  ].join('\n')
}

// ---------- 研究段门检：形状层（零成本，§3 的 check 上产线） ----------
// 四个字面锚：条数 3~5 / 首行【主线】/ ≥2 条含数字 / 出处标注且编号在素材范围内。
// 边界设计：出处「有标注、编号不越界」机器判得了；「编号指对内容」判不了——内容真假是审校① 的活。
// 门检混进内容判断就成了廉价 critic，两头不占（§3 预言的门检版）
export function digestCheck(digest: string, maxSection: number): string[] {
  const lines = digest.split('\n').filter((l) => l.trim())
  const issues: string[] = []
  if (lines.length < 3 || lines.length > 5) issues.push(`条数 ${lines.length} 不在 3~5 契约内`)
  if (!lines[0]?.includes('【主线】')) issues.push('首行未标注【主线】（契约：主线放第一行并标注）')
  // 锚的独立性（单测逮出的坑）：出处自带数字（§1 的 1），不剥掉它，「含数字」锚就成了出处锚的影子——
  // 两条契约各测各的，验数字只看剥掉出处后的正文
  const contentOf = (l: string) => l.replace(/（出处：§\d+）/, '').replace(/出处：§\d+/, '')
  const numbered = lines.filter((l) => /\d/.test(contentOf(l)))
  if (numbered.length < 2) issues.push(`含数字的要点仅 ${numbered.length} 条，契约要求至少 2 条`)
  const badRef = lines.filter((l) => {
    const m = l.match(/出处：§(\d+)/)
    return !m || Number(m[1]!) > maxSection
  })
  if (badRef.length) issues.push(`${badRef.length} 条缺「出处：§N」标注或编号越界（素材范围 §1~§${maxSection}）`)
  return issues
}

// ---------- 审校① 任务书：研究段质量层 ----------
// 与 §6 criticPrompt 同骨架（角色无工具 / checklist 三条 / 首行 PASS/FAIL 锚 / 只给方向不代改），
// 但判据换血——简报的质量轴不是稿件的：事实性升级成「出处指对」，
// 稿件的针对性/实用性对简报无意义，换成覆盖性与组织性——判据跟着交接物走
export function digestCriticPrompt(): string {
  return [
    '角色：你是研究段的审校员。上游交接物里有两样东西：原始素材和待审简报。你只评审、不代改；你没有任何工具，也不要尝试读文件、执行命令或调用任何东西——判断所需的一切已在交接物里。',
    '评审标准（逐条判定，只列不通过的）：',
    '1. 事实性：简报每条要点（含数字与出处标注）必须能在原始素材里找到依据，「出处：§N」必须指向真实存在且内容对应的条目。数字以合理核对为准：四舍五入/约数视为一致（如 85% 与 85.2%、35% 与 35.5% 是同一事实，不算缺陷），只有量级错误、方向错误或张冠李戴才不通过。',
    '2. 覆盖性：素材里有分量的战果不得缺席（带实测数字的、影响结构决策的优先），漏转即不通过；素材之外的编造同样不通过。表述风格、篇幅差异不构成未覆盖。',
    '3. 组织性：【主线】应标在素材中最有分量的一条上，归类合并要站得住。你是核对员不是代写员：只要简报的主线与素材自洽、有推导依据，就放行；不得因「另一条也很有分量」或你个人偏好而要求换主线。真正的缺陷是——主线标注明显失真、同类要点被拆散、简报结构无法体现素材主次。',
    '判据全集就是上面三条，评审只许依据这三条，不做清单外的判定。两条纪律：①首轮评审必须把全部不合格项一次性列全（覆盖性/事实性/组织性里有啥就说啥），后续轮次只做复核，不得逐轮挤牙膏式增量揭示新要求；②不得因简报逐轮变好而引入清单外新判据打回，也不得为「总得挑毛病」而打回——本轮三条无不合格项就是 PASS。',
    '输出契约（字面钉死，解析端按此判定）：全部通过 → 首行只写 PASS，不要输出其他任何内容；有不通过项 → 首行只写 FAIL，随后每行一条：编号 | 不通过项 | 原因 | 修订指令。',
    '修订指令只给方向不代改——你的产出是研究员下一轮的修订方向，不是改好的简报。',
  ].join('\n')
}

// ---------- 写手任务书 ----------
const REPORT_TASK = [
  '任务：基于上游交接物中的研究简报，写一段给团队新人看的技术周报。',
  '输出契约：一个自然段，150 字以内；含本周最重要的 1 项进展与下周方向；数字直接用简报里的，不要自造；不要列表格式。',
].join('\n')

// ---------- 产线本体 ----------
export interface ReviewRound {
  output: string // 该轮被审的交接物（简报某版 / 稿件某稿）
  critic: SpawnResult
  verdict: CriticVerdict
}

export interface CompositeResult {
  research: SpawnResult // 研究员首发（失败/短路路径）
  shapeRejections: number // 形状门检打回次数（免费层出手记录）
  researchRounds: ReviewRound[] // 研究⇄审校① 各轮（形状被打回的版本不进这里——没烧审校的钱，账记在 shapeRejections）
  researchSpawns: number // 研究员侧发数（首发 + 修订重写）
  digest: string // 交付下游的简报（研究段过审后；熔断时为最后一版，仅留账不交付）
  researchPassed: boolean
  writingRounds: ReviewRound[] // 写作⇄审校② 各轮（研究段熔断时为空——写作未启动）
  writerSpawns: number // 写手侧发数（首稿 + 修订重写）
  passed: boolean // 写作段终局
  finalReport: string // 通过稿 / 写作段熔断最后一稿 / 研究段熔断报告 / 研究员短路定位
  openIssues: string[] // 未解决项（研究段熔断时为研究段的；写作通过时为空）
  researchTokens: { prompt: number; completion: number }
  writingTokens: { prompt: number; completion: number }
  promptTokens: number
  completionTokens: number
}

// §11 起加的评测 seam：source 可注入（评测集要喂薄料/变体素材），默认原素材——既有调用零改动；
// 节号上界按实际素材推导（薄料只有 §1~§2 时，出处 §6 就该被门检判越界）
export async function runCompositeSystem(topic: string, opts?: { source?: string }): Promise<CompositeResult> {
  const source = opts?.source ?? SOURCE_MATERIAL
  const trace = new TraceCollector({
    topic,
    source,
  })
  const sectionNums = [...source.matchAll(/§(\d+)/g)].map((m) => Number(m[1]))
  const maxSection = sectionNums.length ? Math.max(...sectionNums) : 0
  const researchTokens = { prompt: 0, completion: 0 }
  const writingTokens = { prompt: 0, completion: 0 }
  // §8/§9 收数口：每发流水（角色 + 双栏账）——窗口级数据从这里收，流转图和账本不用再改代码
  const chargeR = (role: string, r: SpawnResult) => {
    researchTokens.prompt += r.promptTokens
    researchTokens.completion += r.completionTokens
    // §8/§9 收数口保留（[账] console.log 不能注释掉——baseline 对比/教程贴日志都靠它）；trace 并行收一份落盘
    console.log(`  [账] ${role}: prompt ${r.promptTokens} / completion ${r.completionTokens}${r.ok ? '' : `（失败：${(r.error ?? '').slice(0, 40)}）`}`)
    trace.spawn({ role, ...r })
  }
  const chargeW = (role: string, r: SpawnResult) => {
    writingTokens.prompt += r.promptTokens
    writingTokens.completion += r.completionTokens
    console.log(`  [账] ${role}: prompt ${r.promptTokens} / completion ${r.completionTokens}${r.ok ? '' : `（失败：${(r.error ?? '').slice(0, 40)}）`}`)
    trace.spawn({ role, ...r })
  }

  // —— 研究段第一发：研究员（纯文本组织活 tools: []；挂了短路，final 带定位——§3 模式，空手 ≠ 消息丢失）——
  const research = await spawn(researchPrompt(), {
    handoff: `原始素材（${topic}）：\n${source}`,
    tools: [],
    thinking: 'high',
    skipSessionEndHooks: true,
  })
  chargeR('研究员首发', research)

  const result: CompositeResult = {
    research,
    shapeRejections: 0,
    researchRounds: [],
    researchSpawns: 1,
    digest: research.conclusion,
    researchPassed: false,
    writingRounds: [],
    writerSpawns: 0,
    passed: false,
    finalReport: '',
    openIssues: [],
    researchTokens,
    writingTokens,
    promptTokens: 0,
    completionTokens: 0,
  }
  const settle = () => {
    result.promptTokens = researchTokens.prompt + writingTokens.prompt
    result.completionTokens = researchTokens.completion + writingTokens.completion
    // §3 落盘接上：trace 已收完所有 span（token 双栏 + 结论 + 门检/熔断判据），fire-and-forget 写 traces/{id}.json + {id}-flow.txt（不阻塞返回；失败不吞产线结果）
    trace
      .save()
      .then((p) => console.log(`  [账] trace 落盘 ${p}`))
      .catch((e) => console.log(`  [账] trace 落盘失败：${(e as Error).message}`))
    return result
  }

  if (!research.ok) {
    result.finalReport = `产线在【研究员】段失败：${research.error ?? research.conclusion}——写作与审校未启动`
    return settle()
  }

  // —— 研究段：门检（形状，免费）+ 审校①（质量，真金白银）⇄ 研究员修订 ——
  // 两级闸门共用一套修订预算（revises）：形状不过不请审校——免费的先拦，钱花在判得了的地方
  let digest = research.conclusion
  let revises = 0
  let researchIssues: string[] = []
  while (true) {
    const shapeIssues = digestCheck(digest, maxSection)
    // 免费门检：不烧 token，走 trace.event 零成本落盘点（结论文案当归因 reason 进树）
    trace.event(
      `形状门检`,
      'shape-gate',
      shapeIssues.length === 0 ? 'pass' : `reject:${shapeIssues.length}条`,
      shapeIssues.length === 0 ? '' : shapeIssues.join('\n').slice(0, 30),
    )
    let verdict: CriticVerdict
    if (shapeIssues.length === 0) {
      // 审校①：独立窗口看素材+简报，看不到研究员的过程（§6 隔离不变）
      // 审校①是判断题（只回 PASS/FAIL + 逐条意见），浅任务不空转思考——completion 大头是思考 token，墙钟≈completion÷速度
      const critic = await spawn(digestCriticPrompt(), {
        handoff: `原始素材（${topic}）：\n${source}\n\n待审简报：${digest}`,
        tools: [],
        thinking: 'off',
        skipSessionEndHooks: true,
      })
      chargeR('审校①#' + (revises + 1), critic)
      verdict = parseCriticVerdict(critic.conclusion)
      result.researchRounds.push({ output: digest, critic, verdict })
    } else {
      result.shapeRejections++
      verdict = { passed: false, issues: shapeIssues.map((s) => `[形状门检] ${s}`) }
    }
    if (verdict.passed) {
      result.researchPassed = true
      result.digest = digest
      break
    }
    researchIssues = verdict.issues
    if (revises >= MAX_REVISIONS) {
      // 研究段熔断——中间段停机，未验简报不下流（见文件头）；短路归因进 trace 树（图里画「为什么停」）
      trace.event(`研究段熔断`, 'short-circuit', `reject:研究阶段超过次数熔断，后续写作短路`)
      break
    }
    revises++
    result.researchSpawns++
    const revise = await spawn(
      [
        researchPrompt(),
        `上一版简报被打回，逐条修订：\n${verdict.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
      ].join('\n\n'),
      {
        handoff: `原始素材（${topic}）：\n${source}\n\n上一版简报：${digest}`,
        tools: [],
        thinking: 'high',
        skipSessionEndHooks: true,
      },
    )
    chargeR('研究员修订#' + revises, revise)
    digest = revise.conclusion
  }
  if (!result.researchPassed) {
    result.digest = digest // 留账：最后一版简报（不交付下游）
    result.openIssues = researchIssues
    result.finalReport = `产线在【研究段】熔断：简报 ${revises} 轮修订仍未过审（形状打回 ${result.shapeRejections} 次、质量评审 ${result.researchRounds.length} 轮）——写作段未启动。未验简报不下流：审校② 只验稿件对简报的忠实转写，验不了简报本身的错，未验物流下去只会错得更安静`
    return settle()
  }

  // —— 写作段：写手 ⇄ 审校②（一级验）——
  // criticPrompt 从 §6 import 一字不改：每段的「原始素材」= 它的直接上游交接物——
  // 简报对写作段就是源头（它已被审校① 验过，这是审校② 敢只看简报的全部前提）
  // 写手首稿是转写（简报已验过是源头），150 字周报是浅任务——不空转思考
  const first = await spawn(REPORT_TASK, {
    handoff: `研究简报：${result.digest}`,
    tools: [],
    thinking: 'off',
    skipSessionEndHooks: true,
  })
  chargeW('写手首稿', first)
  result.writerSpawns = 1
  let draft = first.conclusion
  let wRevises = 0
  while (true) {
    // 审校②也是判断题——浅任务不空转思考
    const critic = await spawn(criticPrompt(), {
      handoff: `原始素材：${result.digest}\n\n待审稿件：${draft}`,
      tools: [],
      thinking: 'off',
      skipSessionEndHooks: true,
    })
    chargeW('审校②#' + (wRevises + 1), critic)
    const verdict = parseCriticVerdict(critic.conclusion)
    result.writingRounds.push({ output: draft, critic, verdict })
    if (verdict.passed) {
      result.passed = true
      result.openIssues = []
      break
    }
    result.openIssues = verdict.issues
    if (wRevises >= MAX_REVISIONS) {
      // 写作段熔断——末端段：诚实降级交付最后一稿（§6 语义原样）；归因进 trace 树
      trace.event(`写作段熔断`, 'melt', `reject:写作阶段超过次数熔断`)
      break
    }
    wRevises++
    result.writerSpawns++
    const revise = await spawn(
      [REPORT_TASK, `上一稿被审校打回，逐条修订：\n${verdict.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`].join(
        '\n\n',
      ),
      {
        handoff: `研究简报：${result.digest}\n上一稿：${draft}`,
        tools: [],
        thinking: 'high',
        skipSessionEndHooks: true,
      },
    )
    chargeW('写手修订#' + wRevises, revise)
    draft = revise.conclusion
  }
  result.finalReport = draft
  return settle()
}

export function printCompositeResult(r: CompositeResult) {
  console.log('\n===== 组合系统 v2 账单（研究⇄审校① → 写作⇄审校②，分段验） =====')
  if (!r.research.ok) {
    console.log(
      `研究段：研究员失败短路——${(r.research.error ?? r.research.conclusion).slice(0, 60)}（写作与审校未启动）`,
    )
  } else if (!r.researchPassed) {
    console.log(
      `研究段：熔断，产线停机——形状门检打回 ${r.shapeRejections} 次（免费）+ 质量评审 ${r.researchRounds.length} 轮未过，写作段未启动`,
    )
  } else {
    console.log(`研究段：简报过审交付（形状打回 ${r.shapeRejections} 次 / 审校① ${r.researchRounds.length} 轮）`)
  }
  for (const [i, round] of r.researchRounds.entries()) {
    console.log(
      `  简报v${i + 1} → 审校① [${round.verdict.passed ? 'PASS' : `FAIL（${round.verdict.issues.length} 项）`}]: ${round.critic.conclusion.slice(0, 50)}`,
    )
  }
  for (const [i, round] of r.writingRounds.entries()) {
    console.log(
      `  第${i + 1}稿 → 审校② [${round.verdict.passed ? 'PASS' : `FAIL（${round.verdict.issues.length} 项）`}]: ${round.critic.conclusion.slice(0, 50)}`,
    )
  }
  console.log(
    `结果：${r.passed ? '通过' : r.researchPassed ? `写作段熔断（未解决 ${r.openIssues.length} 项——诚实降级交付）` : r.research.ok ? '研究段熔断，产线停机' : '研究段短路'}`,
  )
  console.log(
    `分段账：研究段 prompt ${r.researchTokens.prompt} / completion ${r.researchTokens.completion}；写作段 prompt ${r.writingTokens.prompt} / completion ${r.writingTokens.completion}`,
  )
  console.log(
    `全账：prompt ${r.promptTokens} / completion ${r.completionTokens}（研究员 ${r.researchSpawns} + 审校① ${r.researchRounds.length} + 写手 ${r.writerSpawns} + 审校② ${r.writingRounds.length} 发）`,
  )
  console.log(`\n=== 最终产出 ===\n${r.finalReport}`)
  if (!r.passed && r.openIssues.length)
    console.log(`\n未解决项：\n${r.openIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
}

// 冒烟口（花 GLM 配额）：
//   node 10-multi-agent/composite.ts
//   期望：门检首过 → 审校① 1~2 轮 PASS → 写手成稿 → 审校② 1~2 轮 PASS；
//   分段账看 v2 的经济学：审校① 多花的钱 vs 审校② 省下的素材份（§9 直接收数）
//   门检探针：researchPrompt 的输出契约行临时删掉「3~5 条要点」→ 研究员大概率交段落 →
//     门检免费打回（账单特征：形状打回 1 次、审校① 少烧一轮）——A 版「ok:true 交乱码」漏网被拦的现场版
//   薄料探针：SOURCE_MATERIAL 砍到 2 条 → 看审校① 覆盖性判据的反应（打回「覆盖不足」还是放行薄简报）——
//     对比 v1：同样薄料要等末端全链验才看见，现在写手 token 一分不花（失败前移的现场验证）
//   短路探针：researchPrompt 写成需要工具的活 → 研究员空手 → 产线短路带定位（v1 语义不变）
const isMain =
  process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  console.log(`\n【组合系统 v2】本模块真实周报生产线（分段验）\n`)
  const result = await runCompositeSystem('模块10 多Agent六节战果')
  printCompositeResult(result)
}
