# 求职备战内容产出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出面试题库批 1（LLM 基础 + RAG 两章，用户试读）并完成 AI 版简历升级（两份文件）。

**Architecture:** 纯 markdown 内容写作，零代码。题库入 `docs/interview/`（公开提交），简历改 `resume/`（gitignored，永不提交）。题目内容不可在计划里预写（写了就是成品），计划锁定：文件结构、每章必考覆盖点、每题格式模板、题数与档位配比、可执行的校验命令。

**Tech Stack:** markdown；校验用 git bash（grep/ls/git）。

**Spec:** docs/superpowers/specs/2026-11-15-interview-bank-and-resume-design.md

## Global Constraints

- EVIDENCE 四条（spec「约束」节，适用于简历）：①只写有佐证的表述，无基准不讲幅度 ②多租户 v2 不写成生产经验 ③不绑定模型品牌名（简历内）④数字一律实测重盘
- PII：`resume/` 永不入库；`docs/interview/` 提交前必跑 PII 扫描
- 每章 8~12 题，必背约 6 成；中文夹英文术语
- 每题格式（锁定，两处一致）：
  ```markdown
  ### Q1. 题目【必背★|进阶】
  **背诵版**：要点式，面试可口述，100~200 字
  **追问**：Q：高频追问 → 一句话答
  ```
- 骨架文件创建后立即单独提交（用户既定偏好，信息注明待验证/待填充）

## Review Focus

内容项目无运行时测试，以下为最可能翻车的五种失效模式及对应校验（挂到所属任务）：

1. **题库泄 PII**（真名/手机号/邮箱混进公开文档）→ Task 2/3 提交前 grep 扫描
2. **简历沿用旧数字口径**（64 条/2.3 万行/164 提交等 11-10 旧值）→ Task 4 实测命令逐条出数，Task 5/6 只准引用 Task 4 的表
3. **背诵版超长背不动**（>200 字/题）→ Task 2/3 校验步：抽查每章前 3 题字数
4. **必背/进阶失衡**（必背 <50% 或 >70%）→ Task 2/3 校验步：grep 计数
5. **简历把 v2 多租户/无基准优化写成硬成果**→ Task 5/6 校验步：grep「多租户」「v2」「提升 X%」类表述

---

### Task 1: 题库骨架 + README 索引

**Files:**
- Create: `docs/interview/README.md`（索引表：9 章 × 一句话主题 × 状态列）
- Create: `docs/interview/01-llm-basics.md` ~ `09-project-deep-dive.md`（仅章节标题 + 主题行占位）

**Interfaces:**
- Produces: 9 个章节文件名，后续任务按序填充；README 状态列随各章完成更新为「已写」

- [ ] **Step 1: 创建 README + 9 个占位章节文件**（每章文件头含：章名、本章覆盖点一行、状态「待填充」）
- [ ] **Step 2: 校验**：`ls docs/interview/` 应有 10 个文件
- [ ] **Step 3: Commit**（注明骨架待填充）：`git add docs/interview && git commit`

### Task 2: 第 1 章 LLM 基础与 API

**Files:**
- Modify: `docs/interview/01-llm-basics.md`

**Interfaces:**
- Consumes: Task 1 的文件与格式模板（Global Constraints）
- Produces: 已完成的第 1 章（README 状态列同步）

必考覆盖点（每点至少 1 题，缺一即返工）：token 与上下文窗口 / temperature 等采样参数 / 结构化输出 / 流式（SSE）/ 多模态 / 幻觉成因与缓解 / 模型选型（含国产生态一句）

- [ ] **Step 1: 写全章 8~12 题**（按格式模板；必背约 6 成）
- [ ] **Step 2: 校验**：题数 `grep -c '^### Q'`；必背占比 `grep -c '必背★'`；PII 扫描 `grep -nE '1[3-9][0-9]{9}|@[a-z]+\.(com|cn)|赵德升' docs/interview/01-llm-basics.md` 应零命中
- [ ] **Step 3: Commit**，README 状态列更新

### Task 3: 第 2 章 RAG 与检索

**Files:**
- Modify: `docs/interview/02-rag.md`

同 Task 2 步骤模板。必考覆盖点：chunking 策略 / 嵌入模型与向量库 / 混合检索（BM25+向量）/ rerank / RAG 评估 / 微调 vs RAG vs prompt 选型

- [ ] **Step 1-3: 同 Task 2**（写全章 → 校验 → Commit）

### Task 4: 简历数字重盘（事实表）

**Files:**
- Create: `resume/facts.md`（gitignored，记录数字与实测命令出处）

**Interfaces:**
- Produces: 实测数字表，Task 5/6 唯一合法数字来源

- [ ] **Step 1: 跑实测**：`git rev-list --count HEAD`（提交数）；`ls reviews/*.md | wc -l`（复盘篇数）；`ls blogs/`（博客 4 篇验证）；`git ls-files '*.ts' '*.vue' | xargs wc -l | tail -1`（TS 行数）；`git ls-files '*test*' | grep -c test`（测试文件数，注明口径 personal-agent 16 套件 + jobprep 新增）；langChain/OUTLINE.md 查 S 完成度
- [ ] **Step 2: 事实表落盘 resume/facts.md**（每条数字附命令；PITFALLS=76 已核）
- [ ] **Step 3: 校验**：`git status` 不应出现 resume/facts.md（gitignore 生效）

### Task 5: resume.md（详细版）升级

**Files:**
- Modify: `resume/resume.md`

按 spec「简历设计」7 点结构改写；数字只引 Task 4 表；工作经历/教育取自 resume/赵德升-高级前端-v2.md。

- [ ] **Step 1: 改写全文**（龙虾进工作经历、jobprep 第三项目、框架实战技能行、摘要三段式）
- [ ] **Step 2: 校验**：`grep -nE '64 条|2\.3 万|164 次' resume/resume.md` 零命中（旧口径清零）；`grep -n '多租户'` 零命中；品牌名扫描
- [ ] **Step 3: 校验**：`git status` 不含 resume/

### Task 6: resume-1page.md 同步升级

**Files:**
- Modify: `resume/resume-1page.md`

同 Task 5 口径压缩到一页；尾部删减说明注释保留并更新（新增条目：龙虾/工作经历压缩/jobprep 的取舍）。

- [ ] **Step 1-3: 同 Task 5 步骤模板**

### Task 7+（批 2，gate：用户试读批 1 格式认可后启动）

第 3~9 章逐章任务，步骤同 Task 2 模板，各章覆盖点锁定于 spec「题库设计」节。**第 9 章追加用户校验门：龙虾部分只写「落地经验+转向动机」叙事（用户自评黑盒/提示词层调优，spec 已拍板 #6），成稿必须经用户确认事实后才算完成**。收尾任务：README 全量状态更新 + 总题数核对（90~100）。

---

## 执行方式

内容写作任务，上下文（用户背景/项目事实/EVIDENCE 纪律）全在主会话——**native 执行**（superpowers:executing-plans，本人逐任务写），批 1 完成即到用户试读 gate。
