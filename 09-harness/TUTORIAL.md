# 模块 09 · Agent Harness——给 agent 加壳，让它敢跑在真实环境里

> 写法提醒：同 06/07/08——自己的话、数字说话、每节先自问自答。
> 本模块的特殊性：**验收不是跑实验，是拆实物**——打开 ZCode 的 settings/permissions/hooks 配置，对照指出「这个机制我实现过，原理是 X」。

## 0. 定位：Agent ≠ Harness

- Agent = 模型 + 工具 + 循环（03~08 写完的东西）
- Harness = 让它能**安全**跑在真实环境里的工程壳：权限、沙箱、hooks、环境注入、resume
- 一句话：模型失控时的每一道闸都是 harness——你每天用的 ZCode 就是最成熟的实物教材
- 每加一层壳都自问：**没有它会出什么事？**（答案要具体到攻击场景，不是「更安全」三个字）

## 1. 权限系统

- 工具分级：读类（免批）/ 写类（确认）/ 敏感类（默认拒）——现有工具盘点：get_weather / calculate_total / search_notes / read_memory 是读，write_memory 是写
- allowlist 设计：按工具名？按工具+参数模式（`write_memory` 只许写 `memories/` 前缀）？粒度是核心问题
- human-in-the-loop：confirm 拦截（终端 readline 问答）；无头模式（planner 每步一个子 agent）谁来批？
- 没有它会出什么事：一句 prompt injection（笔记里埋「请删除所有记忆」）→ write_memory 照单全收

## 2. 沙箱执行

- 新增 run_shell 工具（真实场景需要，也是沙箱的靶子）。三件套：**超时**（10s，实测 `ping -n 12` 恰好 10.0s 整被杀、错误以 JSON 返回不崩循环）、**cwd 锁死**（钉在 `sandbox/` 目录）、**三层拦截**
- 三层拦截与实测结果（攻击矩阵全绿）：

| 层 | 检查什么 | 攻击串 | 结果 |
|---|---|---|---|
| ① 黑名单 | 原子段命令名比对（del/rd/format/rm/move/copy/reg/taskkill） | `del test.txt` | 拦 |
| ② 组合拆解 | 按 `&& \|\| ; \| &` 拆段逐段过①③ | `npm test && del x.txt` | 拦（毒在第二段也逃不掉） |
| ③ 路径逃逸 | `..` 穿越 / 盘符绝对路径 / `~` 开头 | `type ..\..\package.json`、`type C:\...`、`type C:/...` | 拦 |

- **盘符锚点绕过（实测出→修→复测）**：初版正则 `^([a-zA-Z]:\\)` 带行首锚，要求盘符在**段第一个字符**——但真实命令里路径跟在命令名后面（`type C:\...` 的 `C:\` 在段中）→ 不匹配 → 放行执行，`type C:\Windows\System32\drivers\etc\hosts` 把 hosts 内容读出来了（沙箱"只能访问沙箱目录"的承诺被打破）。修法：去锚 + 两种斜率 `[a-zA-Z]:[\\/]`。代价诚实记录：URL（`https://x` 的 `s:/`）也会被拦——fail-closed 方向的误报，可接受
- **换行分隔实测未遂**：`echo A\ndel canary.txt` 喂进去，canary 文件存活——本机 cmd 的 exec 没按换行执行第二行。**平台行为 ≠ 设计保证**：今天没绕过不代表换行永远安全，拆分字符类里补 `\n\r` 是零成本加固
- **权限 × 沙箱 = 两层串联，各司其职**（§1×§2 合体验收）：`echo hi && del x.txt` → 权限层 glob `echo *`（`^echo .*$`）**形状匹配 → 放行**（没说错，形状确实对）→ dispatch 落到 impl → 沙箱拆段发现 del → **拦**。最终错误是「命令被沙箱拦截」而非权限拒绝——两层各自干了各自的活。反面教训：参数级匹配两次实现错（把规则串/模式串喂给 inspectCommand、极性反成"越危险越放行"）——**复用现成函数前先对齐「输入是什么、回答什么问题」**：inspectCommand 输入命令、回答"危险吗"；参数匹配输入模式×实参、回答"长得像吗"——对不上就永远调不对
- **路径检查的三级梯子**（真实项目的答案）：字符串扫字面量（本版，便宜但可绕）→ resolve + 前缀比对（`path.resolve(SANDBOX_DIR, arg)` 消掉 `..` 和符号链接后检查是否还在沙箱内——07 pathIsInDir 就是它，语义级）→ **OS 级隔离**（namespace/seccomp、macOS Seatbelt、容器、Windows AppContainer/受限令牌——进程物理上摸不到目录外，绕过从"换个写法"升级成"打破内核边界"，ZCode 的沙箱在这层）
- 拦截哲学：拒绝要**大声 + 给理由**——错误信息喂给模型，它看得懂还能换命令重试；静默失败是在训练模型"换个姿势再试"。已知绕过诚实清单：`$(...)` 命令替换、反引号、变量拼接、引号混淆——真防住要 shell 解析成 AST 再判，教学版认清边界，不假装安全
- 没有它会出什么事：模型一次幻觉命令 + 无超时 = 进程挂死或文件没了；无拦截 = confirm 弹的是盲盒（人只会无脑 y）

## 3. Hooks：工具调用前后的拦截器

- pre-hook：改写参数 / 拒绝调用（权限系统的执行点其实就是 pre-hook 的一种）
- post-hook：审计日志（07 appendAudit / 08 job-audit 都是它的实例）/ 结果改写（截断就是 post-hook）
- **核心问题：hooks 和权限谁先谁后？**（先权限后 hook = hook 只见合法调用；先 hook 后权限 = hook 能改参数救权限——想清楚你要哪个）

## 4. 环境注入：模型怎么「知道自己在哪」

- 机制是第三次复用同一根管子：07 记忆索引常驻 → 08 计划常驻（systemExtra）→ 09 环境常驻——`createAgent` 里 env 块拼进 system，对照 ZCode/Claude Code 的 environment_details（cwd/git/文件树/时钟）
- `collectEnv` 采四样：**真实时钟**、OS/shell 方言、沙箱绝对路径+文件树、git 分支与脏文件数（`Promise.all` 并行——git status 在 Windows 上约百 ms，planner 每步都付）
- **UTC 双重坑（实测出→修→复测）**：`toISOString()` 是 UTC——时间差 8 小时只是表症，真正的阴招是它和 `getDay()`（本地星期）混用：本地 0~8 点之间日期还是**昨天**，注入块会输出「10-17 星期日」这种日期星期互相打架的鬼话。修法：全本地 getter（getFullYear/getMonth+1/getDate/getHours/getMinutes）+ padStart 补零
- 反面教材顺手埋掉：抽取提示词硬编码「今天是2026年」——绝对时间也会腐烂（PITFALLS #19 的变体），改成动态 `new Date()`；同理 run_shell 的乱码（cmd 输出 GBK、Node 按 UTF-8 解码）用**混合解码**修：`encoding:'buffer'` 拿原始字节 → 先严格 UTF-8（fatal）解不动按 GBK 兜底；`chcp 65001` 在无控制台的管道会话实测无效，弃
- **时机推导（可推导不实验）**：会话开始注入一次 vs 每轮重注入，在无提示词缓存下 token 成本**完全相同**——system 块不管变不变，每次请求都原样重发。真实差异是新鲜度（一次注入会过期：文件树变了模型不知道、跨小时会话时钟是旧的）vs 确定性+缓存友好（有缓存的供应商那里，每轮刷新 = 缓存失效反而更贵）。教学版选一次注入
- **staleness 是真金白银的代价**：同一会话里先问沙箱有什么 → 建新文件 → 再问，模型还报旧清单——一次注入的过期肉眼可见；Claude Code 的 environment_context 带时钟且周期刷新 = 两头都要就付两头的钱
- **知识归属地框架（本节最大收获）**：知识要放进它被消费的地方——用户事实放记忆（问答时检索）、环境事实放注入（每次开场就在场）、开发者的坑放 PITFALLS（只有我自己看）。案例：模型每次会话都先 `ls` 失败再 `dir`（每次白付一轮失败调用，好在 GBK 修复后错误信息可读、模型能自救）——「这台机器没有 ls」是环境事实，写进注入块一行，开场就知道
- 个人高频坑点名（async/catch 家族三连）：askHuman 的 `return false`（promise 永不结算）、runSessionEndHooks 的同步 catch（异步 rejection 逃逸）、getSandboxTree 的 `return` 没 `await`（catch 接不住 rejection）——同一个根：**try/catch 管得住语句的同步执行，await 进了 try，catch 才有得接**

## 5. 会话持久化与 resume

- 06 双账本在此闭环：ledger 只增不删、view 可派生——**ledger 天生就是存储**。落盘落 ledger，恢复 = 逐条重放 `add()`（双写），view 自动重建。08 的 plan-checkpoint 只是雏形（status 在 schema 里，序列化即检查点），§5 补的是对话本身
- resume 三边界（全部可推导，不花实验预算）：① **tool_call_id 配对**——assistant 的 tool_calls 和 tool 结果在 ledger 里天然有序成对，原样重放就是合法历史，API 收的是「历史事实」，不重执行、不重扣费；② **环境已变**——历史工具结果是当时的事实保留，但 system 里的环境块（时钟/文件树）必须重采刷新（refreshEnvBlock），否则模型拿上次的时钟继续推理，§4 白做；③ **maxSteps 重起算**——历史长度的账归 ensureBudget 的压缩管，不归 step 管
- **每步 checkpoint**：agentLoop 每步工具结果落盘一次，崩溃损失 = 最多一步。08 的教训在此兑现：检查点要存「进行到哪」，不是只存「跑完的」
- **原子写（torn write，先实测出洞再修）**：全量覆写 `id.json` 死在半路 = 好档陪葬——§5 卖「中途被杀也能恢复」，死在最后一笔写上等于卖点破功。修法 tmp + rename：同卷 rename 是**指针互换，不是「先删后改名」**——后者有「文件不存在」的中间窗口，前者任何时刻要么完整旧档、要么完整新档（Windows 上 libuv 走 MoveFileEx 替换已存在目标，实测：rename 后内容为 tmp 的新档、tmp 名字消失）。.tmp 是替死鬼：写一半被杀毁的是它，最坏留个孤儿，读取只认 id.json
- **形状校验（实测坐实）**：`JSON.parse` 成功 ≠ 是账本——盘上内容是 `"hello"` 时返回字符串，`.length === 5` 骗过 `!ledger?.length` 守卫，重放循环把 `h`、`e`、`l` 当消息喂 `ctx.add`。修法一行 `Array.isArray`。原则：**读回来的数据也是外部输入**——和 parseModelJson 剥围栏、B 策略查 {error} 同族，这是「模型输出不可信」落在磁盘上的版本
- **状态派生 vs 状态存储（本节最大设计课）**：会话「完成/中断」从 ledger 尾巴派生——末条纯 assistant = 已完成；tool / user / 带工具 assistant 尾巴 = 中断。单独的状态文件 = 和账本之间留同步缝，**刚用原子写堵上的洞，别自己再挖**。maxSteps 中止的尾巴恰是 tool（中止分支的 return 值没有 ctx.add——错误是给调用方的，不是历史的一部分），这个不对称正是「尾巴派生」的成立条件。自己实现的三连坑（都实测出→修→复测）：空账本崩（判了 `!lastMsg` 没 return，后面照样取 `lastMsg.role`）；梯子漏格（user 尾巴误报损坏）——**分类穷举靠一正一反的二分，不靠逐个枚举，枚举永远漏格**；`String(undefined)` 是字符串 `'undefined'`（真值），`||` 回落分支是死的
- **信封格式与格式演进**：要加标题字段时裸数组装不下 → `{title?, ledger}`。**存储格式一旦发布就有兼容性债务**：readSessionDoc 双形状分派、读时迁移不改盘，这条兼容分支是永久债务——要活到所有老档被覆写成新格式为止
- **标题三层（拆三方的做法）**：L1 首条 user 截断（派生，零成本）< L2 会话结束模型摘要（session-end hook 挂载点的第四次复用，留白）< L3 用户改名（存信封字段，用户改过的永远赢）。**标题保全**：每步 checkpoint 都调 saveSession，`title ?? existing` 读-改-写——否则无标题信封会把用户的改名冲掉（微缩版同步缝）。灵魂探针：rename 后 resume（信封被每步覆写 N 次），标题还是用户改的那个才算生效
- **归档 = 挪窝**：`sessions/archive/` 子目录 + rename（又是原子挪）——归档是人的决定（不可派生，真得存），但**文件系统即状态**，没有第二份账要对齐。历史列表的「去重」真实含义是**过滤 .tmp 替死鬼**
- 顺手两笔接口清账：agentLoop 参数膨胀出现 `undefined` 洞（`(ctx, 8, undefined, sid)`）→ 配置对象化——**主题参数保持位置参数，可选项进对象**；onToolCall 没并进 post-hook——**post-hook 只见真执行了的调用**（被 pre/权限拒的在它前面就 return 了），观察者连拒绝也上报，覆盖面不同不算冗余；且注册表生命周期是进程级、参数是栈级（「谁注册谁注销」还没实现，记在账上）
- **已知边界（2026-10-18 记账，未实施）：planner 的中断恢复**——plan-checkpoint.json 是 08 传下来的**写-only 存档**（没有任何代码读它）：中断时计划状态活着，但 stepResults（步间交接的命脉）只在内存、正在跑的子 agent 不落盘、`running` 残留态没人复位。补法两层：**L1 计划级恢复 ~35 行**——checkpoint 从裸 Plan 变 `{plan, stepResults}` 信封（格式演进二刷）+ 启动读档：running→pending、done 跳过、Map 还原（「done 绝不重跑」的 08 金笔记在此兑现——非幂等副作用翻倍）；**L2 步骤级续跑可选**——runStep 传 `sessionId`，中断的步骤用 §5 的 resume 从半截账本续。L1 的真实意义：§5 资产第一次喂回 08 层，「累积式不丢旧能力」的验收

## 6. 后台任务（08 已交付大半，别重建）

- cron.ts 全家：setTimeout 链防堆叠、fire 全兜异常、审计日志、补跑水位线——本模块零新增，08 的资产原样上岗
- §7 拆出的对照结论：ZCode 的 tasks-index.sqlite（+ setting.json 的 taskAutoArchiveEnabled）是**任务列表/后台任务的管理**——记录、归档、展示；不是**定时调度**。我的是调度（cron 语义），它的是管理（queue/history 语义）——两者正交，它没做调度那半，我的超出项
- 钩子粒度错位的老账在此结清（08 金笔记①）：「会话结束」钩子遇到「一个任务 = N 次会话」（planner 每步一个子 agent）就错位——B 策略在 planner 模式下被抽取 N 遍。生产答案：钩子粒度跟任务边界对齐（executePlan 尾部抽一次），教学答案：planner 用 A 策略绕开
- 没有定时调度会出什么事（§0 句式）：补跑水位线和防堆叠就不是人肉能盯的——错过的任务要么丢（无水位线）要么雪崩（无防堆叠）

## 7. 验收：拆实物（ZCode + Claude Code 双参照系）

- **拆法本身是一课**：安装目录（D:\software\ZCode）只有 Electron 壳（exe + chromium dll）——用户配置在 `~/.zcode`，内部分层：v2/setting.json（应用 UI 设置：窗口/语言/任务自动归档）、v2/config.json（供应商与模型目录）、cli/config.json（插件 + MCP——我的 04-mcp 实验服务器就挂在上面）、db.sqlite。工具就是 ls / grep / strings——**黑盒考古：看它在盘上留下了什么**
- **权限（找了一圈的结论）**：ZCode 全目录扫 permissions 零命中（连 db 的 strings 都没有）——它把权限收进 UI 的模式选择，文件层不可编程。参照系换 Claude Code：settings.json 里 `permissions: { defaultMode: "auto", allow: [...], deny: [...] }`——**两层结构：权限模式（粗粒度，管「要不要问你」）叠在 allowlist（`Bash(git diff:*)` 规则，管「哪些免问」）之上**。我的 permissions.json 是 allowlist 层的直系教学版；验收当天顺手把模式层也补上了（`PERMISSION_MODE` 走 .env——**模式只替换「问」这一个动作，不拆闸**：deny/pre-hook/沙箱照跑，run_shell 是 auto 的例外——教学沙箱有已知绕过，没有补位层的段不放宽；对照 Claude 的 acceptEdits 自动批编辑不批 Bash，同一个判断）
- **hooks**：真身藏在插件里（mimosa 的 hooks.json）：PreToolUse/PostToolUse + matcher 正则（`"Edit|Write|MultiEdit"`）+ 外部进程（node 脚本）+ timeoutMs + statusMessage。对我的 §3 有三条真差距：① matcher 在**注册期**声明管哪些工具，我的钩子对所有工具跑、运行期自己写 if；② 钩子是外部进程，崩了挂了不伤主循环，我是同进程回调；③ **hook 超时（timeoutMs: 120000）我没有**——runPreHooks 无限 await，一个挂死的钩子能让整个循环陪葬（加固清单头号候选）
- **定时任务**：三方对照——ZCode 零命中（JSON + db 全扫）；Claude 有（durable cron 写 scheduled_tasks.json，没建过就没有文件）；我有（08 cron.ts）。**08 是少数超出 ZCode 的地方**（防堆叠/补跑水位线/审计）。ZCode 的 tasks-index.sqlite + taskAutoArchiveEnabled 是任务列表/后台任务**管理**，不是定时**调度**——§6 对照的正主
- **会话存储**：Claude = `projects/<项目>/<uuid>.jsonl`，一行一条消息**纯追加**（拆到一盘 521 行的转写 = 521 条消息逐条 append）——§5 评审时那句「生产答案是 append-only journal、不是每步全量重写」的实物证据；ZCode = `sess_<uuid>/agent_<uuid>/` 目录树（一会话多 agent 各一档，metadata.json 与 output.txt 分两个文件）——正好对应我的两个简化：planner 子 agent 没分档、信封把元数据和正文合一文件
- **环境注入**：environment_context 带时钟且周期刷新——§4 已对照（两头都要就付两头的钱）
- **沙箱**：不在本轮拆出的面上，§2 已有结论——它的沙箱在路径检查三级梯子的最上层（OS 级隔离），我的三层拦截是梯子第一级
- **计分（骨架问题的直接回答）**：五层里权限/钩子/注入/存储四层对上原型，cron 反超 ZCode。我缺的：权限模式层、hook 超时、进程隔离、append-only 存储；它多的是 UI 化和产品完整度——**我多的是每一层都亲手写过一遍**
- 彩蛋收尾：Claude 参照系的 settings.json 里 `ANTHROPIC_BASE_URL` 指向本地 magpie 代理、路由到 GLM-5.3——**Agent ≠ Harness（§0）的活教材：壳是 Claude Code，模型可插拔**
- 诚实边界：拆的是本地可见的 JSON 文本层 + db strings——结论措辞是「本地可见面内没有」，不是「产品没有」

## 8. 一句话总结（必填，用你自己的话）
我写的：harness是给agent加边界，例如 权限（安全、防范危险命令、沙箱限制命令范围）、钩子（改写工具参数、工具输出审计、会话结束总结会话标题、总结需要记忆的内容等）、环境注入（注入当前时间、系统信息、工作区信息）、任务存档（接着会话聊、失败重试）

AI建议的：「加边界」这个框架，罩得住权限和沙箱，罩不住另外两层。 边界是「拦」——权限拦不该做的、沙箱拦不该碰的。但环境注入是「给」——补上模型本来没有的感知（时钟、方言、文件树）；存档是「续」——给会话续命。它们不是限制 agent，是供给 agent。§0 的自问句其实是双向的：「没有它会出什么事」——没有权限是失控，没有注入是失明，没有存档是失忆。
harness = 模型和真实世界之间的全部工程层——既有闸（拦住不该做的），也有桥（补上本来没有的）

## 附：本模块踩的坑

见仓库根 [PITFALLS.md](../PITFALLS.md) 的 [09] 标签条目。
