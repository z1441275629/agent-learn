// S6 Deep Agents（OUTLINE §3 S6 重头之二 · part2，验收核心件）
// 验收目标：一个 deep agent 带 2 个自定义 subagent + 1 个 skill 跑通（OUTLINE 原文）
// 跑法：
//   node langChain/s6-deepagent.ts                    # 默认演示任务（见 ask 默认问题）
//   node langChain/s6-deepagent.ts ask "你的问题"
//   node langChain/s6-deepagent.ts approve            # write_file 审批通过（跨进程 resume，S4/S5 同构）
//   node langChain/s6-deepagent.ts breaker            # 审校熔断演示：critic 2 次打回 → 拒发第 3 次 → 降级交付
//   任意模式加 --fresh 开新会话（换 thread_id）：node langChain/s6-deepagent.ts ask "…" --fresh
//   删 langChain/.s6-data/ 从零重演（首跑会自动 seed 工作区文件）
//
// createDeepAgent 比裸 createAgent 多给你什么（JS 实测面，deepagents@1.16.2）：
// - 文件系统工具面：ls/read_file/write_file/edit_file/glob/grep（FilesystemBackend 圈定 rootDir）
// - task 子代理：subagents: [{name, description, systemPrompt, tools?, mode}]，isolated 上下文
// - SKILL.md skills：Agent Skills 标准——frontmatter（name/description）做索引，正文按需加载。
//   对照 pa skills.ts：几乎逐条同构（面试顶级素材：手写实现后才发现官方标准长这样）
// - AGENTS.md memory：启动时读入 system prompt（对照 pa 的常驻记忆注入）
// - interruptOn：工具级审批闸（Record<工具名, boolean | InterruptOnConfig>）——S5 的 interrupt()
//   在 deep agent 里的声明式皮，resume 形状与 S2/S4 HITL 相同
//
// 框架不管的（对照 composite，OUTLINE 原文）：修订熔断 ≤2 轮、成本护栏、maxCalls 机械闸
// deepagents 都没有内置——框架管编排，护栏得自己加（middleware 层补）。
// ↓ 本文件已接入审校熔断（reviewBreaker + breaker 模式演示）：拦截 task→critic 计数，
//   2 次未过后拒发第 3 次调用、注入降级指令——对照表第 7 行的实证代码
import 'dotenv/config'
import { HumanMessage, createMiddleware, ToolMessage } from 'langchain'
import { Command, StateSchema, ReducedValue } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { createDeepAgent, FilesystemBackend } from 'deepagents'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as z from 'zod'

const env = process.env
const llm = new ChatOpenAI({ model: env.LLM_MODEL!, apiKey: env.LLM_API_KEY!, configuration: { baseURL: env.LLM_BASE_URL! } })

// ── 工作区（backend rootDir 圈定沙箱：agent 的文件工具只能在这棵树里动）──
const WS = 'langChain/.s6-data/workspace'
if (!fs.existsSync(`${WS}/notes/product-tips.md`)) {
  fs.mkdirSync(`${WS}/skills/gpu-triage`, { recursive: true })
  fs.mkdirSync(`${WS}/notes`, { recursive: true })
  // AGENTS.md = 常驻记忆（启动并入 system prompt；对照 pa 记忆注入）
  fs.writeFileSync(`${WS}/AGENTS.md`, '# 工作区守则\n- 用户偏好中文，回答保持简短。\n- notes/ 目录是产品支持知识库，查事实先看这里。\n')
  // SKILL.md = Agent Skills 标准：frontmatter 索引 + 正文按需加载（对照 pa skills.ts 的两层结构）
  fs.writeFileSync(
    `${WS}/skills/gpu-triage/SKILL.md`,
    [
      '---',
      'name: gpu-triage',
      'description: GPU 故障分诊流程。用户报显卡/风扇/花屏类问题时按此流程走。',
      '---',
      '',
      '# GPU 故障分诊',
      '',
      '1. 先问/判断症状类别：异响 / 过热 / 花屏 / 点不亮',
      '2. 异响类：风扇轴承或异物——建议停机检查扇叶，勿拆散热器',
      '3. 过热类：清灰 + 重涂硅脂，笔记本先查出风口',
      '4. 花屏/点不亮：先重插显卡与供电线，再降频验证',
      '',
      '产物要求：结论写成「症状→处置」两列清单。',
    ].join('\n'),
  )
  fs.writeFileSync(`${WS}/notes/product-tips.md`, '# 支持知识库\n\n- 风扇异响：X20 系列风扇轴承批次问题，官方保修换新；应急可停机吹掉扇叶间异物。\n- 花屏：驱动 536.xx 有已知 bug，升级到 546 以上。\n- 退款窗口：签收后 7 天无理由，激活后不退。\n')
  console.log('[seed] 工作区已初始化（AGENTS.md / skills/gpu-triage / notes/）')
}

// ── 审校熔断护栏（对照表第 7 行从「框架没有」到「middleware 十行补齐」的实证）──
// deepagents 的循环不在你的图上：critic 是主 agent ReAct 循环里一次次的 task 工具调用，
// 「再叫一次 critic」是模型的决定——你没有审校节点可以加条件边（手写图用条件边，见 s3 composite）。
// 所以护栏落在 wrapToolCall：拦 task→critic 调用计数，超限不放行，返回「熔断令牌」当工具结果，
// 模型读到规则指令后自己降级交付（对照 pa 写手段熔断=降级交付最后一稿，两态分离见 composite.ts）
const reviewBreaker = createMiddleware({
  name: 'review-breaker',
  wrapToolCall: async (req: any, handler: any) => {
    const tc = req.toolCall
    const isCritic = tc?.name === 'task' && tc?.args?.subagent_type === 'critic'
    const used = req.state?.criticCalls ?? 0
    if (isCritic && used >= 2) {
      console.log(`  [breaker] ⚠️ 熔断——拒发第 ${used + 1} 次 critic 调用，注入降级指令`)
      return new Command({
        update: {
          // #72 教训同源：拒发也要补写 ToolMessage（tool_call_id 回执），否则悬空 tool_call
          messages: [new ToolMessage({
            tool_call_id: tc.id,
            content: '【熔断】critic 已审 2 次未通过。规则：不再调用 critic，立即降级交付——把当前最后一稿写入目标文件，并在文首注明「未经审校通过（熔断降级交付）」。',
          })],
        },
      })
    }
    const res = await handler(req)
    if (isCritic) console.log(`  [breaker] critic 第 ${used + 1} 次调用放行（计数 +1）`)
    // 坑（报错实锤）：handler 的返回值不只是 ToolMessage——deepagents 内置 task 工具跑完子代理
    // 返回的是 Command（update 里带 files 合并+结果 ToolMessage，即源码的 returnCommandWithStateUpdate）。
    // 写死 messages:[res] 会把 Command 当消息塞进数组 → "Unable to coerce message from array"。
    // 护栏要透传两种形状：Command 就展开它的 update 再叠加计数；ToolMessage 才包一层
    const resIsCommand = res?.lg_name === 'Command' || res instanceof Command
    if (resIsCommand) {
      const merged: any = { ...res.update }
      if (isCritic) merged.criticCalls = 1
      return new Command({ update: merged })
    }
    // #66 通道形状：工具结果必须随 Command 带回，否则结果丢失；计数用增量（reducer 求和，S1 同款）
    const update: any = { messages: [res] }
    if (isCritic) update.criticCalls = 1
    return new Command({ update })
  },
})

const agent = createDeepAgent({
  model: llm,
  name: 's6-support-desk4',
  systemPrompt: '你是产品支持台的 deep agent：按技能流程办事，事实从 notes/ 查证（自己读或派 researcher），重要结论让 critic 复核，写入文件前会有人工审批。',
  // 坑（源码实锤 FilesystemBackend.resolvePath）：virtualMode 默认 false 的 legacy 模式里
  // rootDir 不是沙箱——相对路径圈在 rootDir 下，但【绝对路径原样放行】：
  //   ① 模型 ls 猜绝对路径（E:/...）→ 直接列了宿主机 E 盘
  //   ② skills: ['/skills/'] 在 Windows 是"绝对路径"（盘根相对）→ 解析成 E:\skills → No files found，
  //      技能没注册成 skill，agent 只能靠 glob 把 SKILL.md 当普通文件读
  // virtualMode: true = 虚拟路径模式：传入路径一律视为 rootDir 下的虚拟绝对路径 + 强制圈禁
  // （.. 穿越/出界抛错）——文档示例 skills:['/skills/'] 暗含的就是这个模式
  backend: new FilesystemBackend({ rootDir: WS, virtualMode: true }),
  // 验收：2 个自定义 subagent
  subagents: [
    {
      name: 'researcher',
      description: '在工作区 notes/ 知识库里查证产品支持事实',
      systemPrompt: '你是研究员。只从工作区文件里找事实，逐条注明出处文件；找不到就说找不到，不编。',
    },
    {
      name: 'critic',
      description: '复核结论与知识库事实是否一致',
      systemPrompt: '你是审校。对照工作区 notes/ 逐条核对结论，指出不一致或无出处的断言；全部核过就明确说 PASS。',
    },
  ],
  // 验收：1 个 skill（Agent Skills 标准：frontmatter 索引 + 按需加载）
  skills: ['/skills/'],
  memory: ['AGENTS.md'],
  // interruptOn：write_file 走人工审批（声明式；S5 图内 interrupt() 的另一层皮）
  interruptOn: { write_file: { allowedDecisions: ['approve', 'reject'], description: '写入文件需要人工批准' } },
  // 熔断计数通道：ReducedValue 增量语义（S1 同款——wrapToolCall 只写增量 1，reducer 求和）
  stateSchema: new StateSchema({
    criticCalls: new ReducedValue(z.number().default(0), {
      inputSchema: z.number(),
      reducer: (a: number, b: number) => a + b,
    }),
  }),
  // 护栏：审校熔断（deepagents 无内置，middleware 补——对照表第 7 行实证）
  middleware: [reviewBreaker],
  checkpointer: new SqliteSaver(new Database('langChain/.s6-data/checkpoints.db')),
})

const mode = process.argv[2] ?? 'ask'
// 会话身份 = thread_id（checkpointer 的 key），agent name 只是标签——改名不开新会话。
// --fresh = 换新 thread_id 从零开始（比删 .s6-data 干净：不动工作区文件，只换会话）。
// breaker 演示强制新线程：criticCalls 计数随 thread 持久化，旧线程的历史计数会直接顶满熔断阈值
const fresh = process.argv.includes('--fresh') || mode === 'breaker'
const cfg = { configurable: { thread_id: fresh ? `s6-deep-${Date.now()}` : 's6-deep' } }
// 记住本次线程供 approve 跟随：只在【发起任务】的模式写（ask/breaker）——
// approve 只读不写，否则它自己的默认线程会先覆盖标记，打到旧会话上（本节踩坑实证）
fs.mkdirSync('langChain/.s6-data', { recursive: true })
if (mode !== 'approve') fs.writeFileSync('langChain/.s6-data/last-thread', String(cfg.configurable.thread_id))
const defaultQ =
  '按 gpu-triage 技能分诊「显卡风扇异响」：让 researcher 去 notes/ 查证事实，结论经 critic 复核后，把「症状→处置」清单写进 fan-fix.md'

if (mode === 'ask') {
  console.log(`═══ S6 deep agent：task 子代理 + SKILL.md + 文件面 + 审批闸 ═══`)
  console.log(`问：${process.argv[3] ?? defaultQ}`)
  const r = await agent.invoke({ messages: [new HumanMessage(process.argv[3] ?? defaultQ)] }, cfg)
  const intr = r.__interrupt__?.[0]
  if (intr) {
    console.log(`  ⏸ 暂停（write_file 审批）：${JSON.stringify(intr.value ?? intr.interrupt_value ?? intr).slice(0, 200)}`)
    console.log('  下一步：node langChain/s6-deepagent.ts approve')
  } else console.log(`  答：${String(r.messages.at(-1)?.content).slice(0, 200)}`)
} else if (mode === 'approve') {
  console.log('═══ S6 approve：write_file 审批通过 ═══')
  const lastThread = fs.existsSync('langChain/.s6-data/last-thread')
    ? fs.readFileSync('langChain/.s6-data/last-thread', 'utf8').trim()
    : String(cfg.configurable.thread_id)
  console.log(`  （审批线程：${lastThread}）`)
  const r = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), {
    configurable: { thread_id: lastThread },
  })
  const intr = r.__interrupt__?.[0]
  if (intr) console.log(`  ⏸ 又一道闸：${JSON.stringify(intr.value ?? intr.interrupt_value ?? intr).slice(0, 150)}`)
  else console.log(`  ✓ 完成：${String(r.messages.at(-1)?.content).slice(0, 200)}`)
  console.log('  验收：查看 langChain/.s6-data/workspace/fan-fix.md 是否落盘')
} else if (mode === 'breaker') {
  // 熔断演示：任务核心主张与知识库故意冲突（notes 说保修换新，任务锁死"自己修"），
  // critic 对照 notes 永远 FAIL → 第 3 次 critic 调用触发熔断 → 降级交付
  console.log('═══ S6 breaker：审校熔断护栏（critic 2 次未过 → 拒发第 3 次 → 降级交付）═══')
  const q =
    // v3 任务（两轮演化的教训）：
    // v1 逃生口——critic 自由裁量给出「保主张改措辞即可 PASS」的折中，两轮真 PASS（护栏未误伤=有效验收一半）
    // v2 撞对齐——主 agent 查 notes 后直接拒单：不写与知识库相反的假话（grounding 生效，正验收，但循环没启动）
    // v3 正解——不攻击诚实性，模拟真实的病态循环：一条「用户自述的无出处数据」（主 agent 无理由拒），
    //          恰好踩在 critic 的职责上（指出无出处断言），且锁死不许删——双方都合规，循环无解 → 熔断
    '写一份 fan-fix.md，必须包含这条用户提供的内部数据：「风扇异响案例中 87% 是轴承磨损」（用户说明：这是内部统计，知识库没有出处，此条不许删改）。写完让 critic 审校：不 PASS 就原样重交再审，直到 PASS 为止。'
  console.log(`问：${q}`)
  const r = await agent.invoke({ messages: [new HumanMessage(q)] }, cfg)
  const intr = r.__interrupt__?.[0]
  if (intr) {
    console.log(`  ⏸ 暂停（write_file 审批）：${JSON.stringify(intr.value ?? intr.interrupt_value ?? intr).slice(0, 150)}`)
    console.log('  下一步：node langChain/s6-deepagent.ts approve —— 放行后看 fan-fix.md 是否带「熔断降级交付」标注')
  } else console.log(`  答：${String(r.messages.at(-1)?.content).slice(0, 200)}`)
} else console.log(`未知模式：${mode}（ask | approve | breaker）`)
