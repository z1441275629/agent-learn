# personal-agent · 个人 Agent 工作台

三阶段（见仓库根 `PHASE3.md`）的宿主项目：能力长在真实日用场景上，不做孤立练习。

## 已有能力

### 截图取字（模块 13 · 多模态第一件）

Win+Shift+S 截图 → 页面 Ctrl+V 粘贴 → 逐行文字 + 中文翻译，**点一行复制一行**、悬停看原文在图中位置。

- OCR：本地 tesseract（chi_sim 模型，含拉丁字母）——免费、离线、带逐行坐标
- 翻译：文本 LLM（非中文行才翻，中文原样保留；失败不阻塞 OCR）
- 语言包自愈：首次运行从 `node_modules/@tesseract.js-data/` 拷到 `.tessdata/`（gitignored）

### 两条识别引擎（模块 13 对照作业）

页面上「本地 / AI 识别」可切换（选择记在 localStorage）。两边输出同一 `OcrResult` 结构，
差异是结构性的，不是谁替代谁：

| | 本地 tesseract | AI 识别（视觉 LLM） |
|---|---|---|
| 字符准确 | 清晰截图很稳 | 可能编字/漏行 |
| 版式理解 | 弱（按行切） | 强（能合并断行、忽略页眉） |
| 坐标/置信度 | 有（=点行定位、低置信提示） | **无**——LLM 报坐标幻觉严重，不伪造 |
| 成本/离线 | 免费离线 | 按图计费、依赖配额 |

AI 引擎配置（缺省沿用备用档 = GLM 视觉，模型默认 `glm-4.5v`）：

```bash
LLM_VISION_BASE_URL=...   # 缺省 LLM_BACKUP_BASE_URL → LLM_BASE_URL
LLM_VISION_MODEL=glm-4.5v
LLM_VISION_API_KEY=...    # 缺省 LLM_BACKUP_API_KEY → LLM_API_KEY
```

AI 失败（配额/网络/输出不合规重试后）返回 502，UI 提示切回本地——AI 挂不拖累本地路线。

```bash
node personal-agent/server.ts     # → http://127.0.0.1:8798
node personal-agent/probe.ts      # 零 token 探针
```

环境变量：`PA_PORT`（默认 8798）、`PA_HOST`（默认 127.0.0.1，只本机）。

> 选型记录：视觉 LLM（火山 Coding Plan / GLM）2026-11-03 实测均不可用或撞配额；
> 且 OCR 是确定性任务，本地引擎比 LLM 更准更省——LLM 只做它擅长的翻译。
