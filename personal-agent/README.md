# personal-agent · 个人 Agent 工作台

三阶段（见仓库根 `PHASE3.md`）的宿主项目：能力长在真实日用场景上，不做孤立练习。

## 已有能力

### 截图取字（模块 13 · 多模态第一件）

Win+Shift+S 截图 → 页面 Ctrl+V 粘贴 → 逐行文字 + 中文翻译，**点一行复制一行**、悬停看原文在图中位置。

- OCR：本地 tesseract（chi_sim 模型，含拉丁字母）——免费、离线、带逐行坐标
- 翻译：文本 LLM（非中文行才翻，中文原样保留；失败不阻塞 OCR）
- 语言包自愈：首次运行从 `node_modules/@tesseract.js-data/` 拷到 `.tessdata/`（gitignored）

```bash
node personal-agent/server.ts     # → http://127.0.0.1:8798
node personal-agent/probe.ts      # 零 token 探针
```

环境变量：`PA_PORT`（默认 8798）、`PA_HOST`（默认 127.0.0.1，只本机）。

> 选型记录：视觉 LLM（火山 Coding Plan / GLM）2026-11-03 实测均不可用或撞配额；
> 且 OCR 是确定性任务，本地引擎比 LLM 更准更省——LLM 只做它擅长的翻译。
