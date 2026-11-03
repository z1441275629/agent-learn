# AI 行业缩写速查字典

> 定位：面试准备 + 日常查阅两用。每条给「全称 + 一句话说明」，并在关键条目上标注 🎯（面试常考）或 ⚡（你写 agent 时会直接用到）。
> 用法：日常遇到直接 Ctrl+F 搜缩写；面试前通读一遍 🎯 条目。分类按「从模型原理 → 到工程落地」的顺序排列。
> 开始日期：2026-11-02。

---

## 一、模型与架构

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 LLM | Large Language Model | 大语言模型，基于 Transformer 的"预测下一个 token"模型 |
| 🎯 SLM | Small Language Model | 小语言模型，几亿~几十亿参数，便宜快，agent 简单子任务的分工选择 |
| 🎯 AGI | Artificial General Intelligence | 通用人工智能，能像人一样处理任意智力任务的假想 AI |
| 🎯 Transformer | （架构名） | "注意力机制"奠基架构，2017 年 Google 论文提出，所有 LLM 的地基 |
| 🎯 GPT | Generative Pre-trained Transformer | OpenAI 的模型系列，生成式预训练 Transformer |
| BERT | Bidirectional Encoder Representations from Transformers | 双向编码器模型，理解型任务的代表（非生成） |
| 🎯 MoE | Mixture of Experts | 混合专家：把一个大模型拆成多个"专家"，每次只激活其中几个——省算力、扩参数 |
| 🎯 KV Cache | Key-Value Cache | 缓存注意力里历史 token 的 K/V 矩阵，推理加速的根基（→ 见 LLM_FUNDAMENTALS ⑤） |
| MHA | Multi-Head Attention | 多头注意力：多组 QKV 并行，各学一种关注模式 |
| MQA | Multi-Query Attention | 多头共享一组 K/V，省显存、快，略损质量 |
| 🎯 GQA | Grouped-Query Attention | 分组查询注意力：MQA 与 MHA 的折中，主流模型的标配 |
| MLA | Multi-head Latent Attention | DeepSeek 提出的注意力压缩方案，大幅压低 KV Cache 显存 |
| 🎯 RoPE | Rotary Position Embedding | 旋转位置编码：用旋转矩阵编码位置，长文本外推能力强，主流选择 |
| ALiBi | Attention with Linear Biases | 线性偏置位置编码，另一种长上下文方案 |
| SWA | Sliding Window Attention | 滑动窗口注意力：只关注附近 token，省算力 |
| FlashAttention | （加速技术） | 不存完整注意力矩阵、IO 优化的注意力实现，训练/推理显著提速 |
| 🎯 BPE | Byte Pair Encoding | 字节对编码，最常见的分词算法（→ LLM_FUNDAMENTALS ①） |
| Embedding | （嵌入） | 把 token/文本映射成向量，语义相似则向量近（→ ②） |
| 🎯 Context Window | 上下文窗口 | 模型一次能"看见"的 token 数上限，agent 的稀缺资源 |

## 二、训练、微调与对齐

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 SFT | Supervised Fine-Tuning | 监督微调：用「指令→回答」数据教模型变成助手（→ 训练三段论④） |
| IFT | Instruction Fine-Tuning | 指令微调，SFT 的常见说法（本质同义） |
| 🎯 RLHF | Reinforcement Learning from Human Feedback | 人类反馈强化学习：用人类偏好训练奖励模型再强化，让模型"讨人喜欢" |
| RLAIF | RL from AI Feedback | 用 AI 而非人类做反馈的 RLHF 变体 |
| 🎯 DPO | Direct Preference Optimization | 直接偏好优化：不训奖励模型，直接用偏好对优化——比 RLHF 简单便宜，主流微调路线 |
| PPO | Proximal Policy Optimization | 近端策略优化：RLHF 常用的强化学习算法 |
| GRPO | Group Relative Policy Optimization | 组相对策略优化：DeepSeek-R1 用的强化算法，免去价值模型，推理模型标配 |
| RM | Reward Model | 奖励模型：给模型输出打"好坏分"，RLHF 的核心组件 |
| 🎯 LoRA | Low-Rank Adaptation | 低秩适配：只训练少量参数就微调大模型，主流高效微调方案 |
| QLoRA | Quantized LoRA | 量化版 LoRA，单卡也能微调大模型 |
| PEFT | Parameter-Efficient Fine-Tuning | 参数高效微调总称（LoRA、Adapter、Prompt Tuning 都属于） |
| 🎯 RAG | Retrieval-Augmented Generation | 检索增强生成：先检索再生成，"开卷考试"（→ 三、RAG） |
| KD | Knowledge Distillation | 知识蒸馏：大模型教小模型，压缩模型常用 |
| 🎯 CoT | Chain-of-Thought | 思维链：让模型"先想后答"，推理能力的核心手段 |
| ToT | Tree of Thoughts | 思维树：多分支搜索的推理框架 |
| 🎯 ICL | In-Context Learning | 上下文学习：模型通过看示例（few-shot）学会新任务，不更新参数 |
| Zero-shot / Few-shot | （零样本/少样本） | 不给示例 / 给几个示例就让模型干活 |
| Backprop | Backpropagation | 反向传播：训练时梯度从输出层往回传，更新参数 |

## 三、RAG 与检索

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 RAG | Retrieval-Augmented Generation | 检索增强生成：知识库切片→向量化→检索→生成（→ 02 模块） |
| Agentic RAG | 智能体化 RAG | 把"检索"变成模型可多次调用的工具，多跳查询、动态决定检索策略 |
| CRAG | Corrective RAG | 检索结果质量差时触发修正（重新检索/换源/放弃） |
| Self-RAG | Self-Reflective RAG | 让模型自评"是否需要检索、检索质量、回答是否忠实" |
| GraphRAG | Graph RAG | 用知识图谱组织文档关系，适合全局性问题（微软提出） |
| 🎯 BM25 | Best Matching 25 | 经典关键词检索算法，精确匹配强（型号代号、人名） |
| TF-IDF | Term Frequency–Inverse Document Frequency | 词频-逆文档频率，基础检索权重算法 |
| 🎯 RRF | Reciprocal Rank Fusion | 倒数排名融合：把多路检索结果按排名合并，无需调权重 |
| 🎯 Rerank | （重排序） | 用 cross-encoder 对粗召回结果精排（→ INTERVIEW_QA 3.3） |
| Bi-Encoder | （双编码器） | query/文档分别编码成向量，快、可离线建索引，精度有限 |
| Cross-Encoder | （交叉编码器） | query/文档拼接一起过模型，准，但慢，只能做精排 |
| Chunking | （切片） | 把长文档切成小块再向量化（→ 3.1 决策表） |
| 🎯 Vector DB | Vector Database | 向量数据库（FAISS/Milvus/Qdrant…），存 embedding 做相似检索 |
| HNSW | Hierarchical Navigable Small World | 图结构的 ANN 索引，主流向量检索算法 |
| ANN | Approximate Nearest Neighbor | 近似最近邻检索：牺牲精度换速度 |
| MMR | Maximal Marginal Relevance | 最大边际相关：去重 + 保多样性，摘要/检索去重常用 |
| Semantic Search | 语义搜索 | 按"意思"而非"字面"检索，向量检索的日常叫法 |
| Hybrid Search | 混合检索 | BM25 + 向量检索融合（→ 3.2） |

## 四、推理与性能

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 TTFT | Time to First Token | 首 token 延迟：用户感知"快不快"的指标，prefill 阶段决定 |
| TPOT | Time Per Output Token | 每输出一个 token 的耗时，decode 阶段决定 |
| TPS | Tokens Per Second | 每秒生成 token 数，吞吐指标 |
| Prefill / Decode | （预填充/解码） | 处理输入（并行）与逐 token 生成（串行）两个阶段（→ ⑤） |
| 🎯 Prompt Caching | 提示词缓存 | 缓存未变前缀的 KV Cache，长会话省 50%+ 成本（→ 1.1） |
| Speculative Decoding | 推测解码 | 小模型先猜、大模型验证，加速生成 |
| Continuous Batching | 连续批处理 | 边生成边加入新请求，提高吞吐，vLLM 的核心 |
| PagedAttention | （分页注意力） | vLLM 提出的 KV Cache 显存管理，类似操作系统的分页 |
| vLLM | （推理引擎） | 高性能开源推理服务框架 |
| TGI | Text Generation Inference | HuggingFace 的推理服务框架 |
| GGUF | GPT-Generated Unified Format | llama.cpp 的量化模型格式 |
| ONNX | Open Neural Network Exchange | 跨框架模型交换格式 |
| 🎯 Quantization | （量化） | 把权重精度从 FP16 降到 INT8/INT4，省显存换速度（→ 硬件章） |
| PTQ | Post-Training Quantization | 训练后量化，免训练，主流方式 |
| QAT | Quantization-Aware Training | 量化感知训练：训练时就考虑量化误差 |
| AMP | Automatic Mixed Precision | 自动混合精度训练：FP16/BF16 混用，显存减半、速度翻倍 |
| 🎯 FP16 / BF16 / FP8 / INT8 / INT4 | （精度格式） | 半精度/脑浮点/8位浮点/8位/4位整型，精度越低越省显存越快 |
| GPU VRAM | GPU Video RAM | 显卡显存，决定了单卡能跑多大的模型/多长的上下文 |

## 五、Agent 与工具

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 Agent | （智能体） | LLM + 工具 + 循环 + 终止条件 的编排系统（→ README 五层定位） |
| 🎯 Harness | （运行框架） | Agent 的"整台车"：权限、沙箱、hooks、环境注入（→ 09 模块） |
| 🎯 MCP | Model Context Protocol | 模型上下文协议：工具/资源/提示的标准化接入协议，JSON-RPC 2.0（→ 04 模块） |
| 🎯 Function Calling | 函数调用 | 模型输出"调用哪个工具、什么参数"的结构化 JSON（→ 01 模块） |
| Tool Use | 工具使用 | function calling 的通用说法 |
| 🎯 ReAct | Reasoning + Acting | 推理+行动交替的 agent 范式（先想→行动→看结果→再想） |
| Plan-and-Execute | 计划-执行 | 先规划步骤再逐条执行，长任务 agent 常用 |
| 🎯 Structured Output | 结构化输出 | 保证输出符合 JSON Schema，底层是 constrained decoding（→ 1.5） |
| Constrained Decoding | 约束解码 | 解码时屏蔽非法 token，结构上不可能出错 |
| JSON-RPC | JSON Remote Procedure Call | 基于 JSON 的远程调用协议，MCP 的底层 |
| SSE | Server-Sent Events | 服务端推送流，流式输出的主要传输方式（→ 4.1） |
| HITL | Human-in-the-Loop | 人在回路：危险操作插入人工确认，harness 权限层 |
| 🎯 Router | （路由） | 按任务类型分发给不同模型/工具组（简单任务小模型→省成本） |
| Planner / Executor | 规划器/执行器 | 任务拆解与执行的角色分工 |
| Handoff | （交接） | 多 agent 之间传递任务控制权 |
| Supervisor | （主管） | 多 agent 编排里的"老板"，调度子 agent |
| Critic / Verifier | 评判器/验证器 | 校验模型输出的一层，压幻觉的关键（→ 1.4） |
| 🎯 Eval | Evaluation | 评测：用测试集量化 agent 好坏，没有 eval 的 agent 是玄学 |
| Golden Set | （金标准集） | 人工标注的测试用例集，eval 的核心资产 |
| Prompt Injection | 提示注入 | 恶意指令藏在输入里操纵模型（→ MCP 安全隐患） |
| OOD | Out-of-Distribution | 分布外：遇到训练/测试范围之外的输入 |
| Sandbox | （沙箱） | 隔离执行环境，限制 agent 的爆炸半径 |
| 🎯 Context Engineering | 上下文工程 | 设计"什么信息、何时、以什么形式、占多少预算"进入窗口（→ 6.4） |
| Prompt Engineering | 提示工程 | 优化单条指令的表达 |
| System Prompt | 系统提示 | 最高优先级指令，常驻上下文 |
| Scratchpad | （草稿区） | 给模型临时计算/推理的中间空间 |
| Trace | （追踪） | 一次请求的全链路记录，可观测性的单位 |
| OTel | OpenTelemetry | 开源可观测性标准协议（tracing 的传输规范） |

## 六、评测与指标

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 MMLU | Massive Multitask Language Understanding | 大学水平多学科知识选择题，最知名的综合评测 |
| GSM8K | Grade School Math 8K | 小学数学应用题 8K 道，推理能力基准 |
| HumanEval | （代码生成基准） | OpenAI 出的代码生成评测：给函数签名写实现 |
| MBPP | Mostly Basic Python Problems | 基础 Python 编程评测集 |
| HELM | Holistic Evaluation of Language Models | 斯坦福的全方位模型评测框架 |
| ARC | AI2 Reasoning Challenge | 科学常识推理题，难基准 |
| BigBench | Beyond the Imitation Game Benchmark | 跨 200+ 任务的综合评测集 |
| IFEval | Instruction-Following Evaluation | 指令遵循能力专项评测 |
| 🎯 LLM-as-a-Judge | （LLM 当裁判） | 用另一个 LLM 给输出打分/比较，快但有权衡（→ 3.4） |
| BLEU | Bilingual Evaluation Understudy | 机器翻译/生成的传统指标（看 n-gram 重合） |
| ROUGE | Recall-Oriented Understudy for Gisting Evaluation | 摘要评测指标 |
| RAGAS | RAG Assessment | RAG 专项评测框架（忠实度/相关性等） |
| 🎯 Hit Rate | 命中率 | 正确答案有没有被检索召回，RAG 检索层核心指标 |
| 🎯 MRR | Mean Reciprocal Rank | 正确结果排名的倒数均值，检索排序质量 |
| NDCG | Normalized Discounted Cumulative Gain | 考虑排序位置的检索质量指标 |
| PPL | Perplexity | 困惑度：模型对文本"惊讶"程度，越低越好 |
| F1 | （F1 分数） | 精确率与召回率的调和平均 |
| P95 / P99 | （百分位延迟） | 95%/99% 请求的延迟，衡量尾延迟体验 |
| QPS / RPS | Queries / Requests Per Second | 每秒请求数，吞吐指标 |
| AUC | Area Under the Curve | ROC 曲线下面积，二分类评估指标 |

## 七、多模态与语音

| 缩写 | 全称 | 说明 |
|---|---|---|
| VLM | Vision-Language Model | 视觉语言模型：能看图 + 文字的模型 |
| MLLM | Multimodal Large Language Model | 多模态大语言模型（VLM 的广义说法） |
| 🎯 TTS | Text-to-Speech | 语音合成 |
| 🎯 ASR | Automatic Speech Recognition | 语音识别（STT：Speech-to-Text 同义） |
| OCR | Optical Character Recognition | 文字识别，图片里抽文字 |
| CLIP | Contrastive Language-Image Pre-training | OpenAI 的图文对齐模型，多模态地基 |
| ViT | Vision Transformer | 把 Transformer 用在图像上 |
| DiT | Diffusion Transformer | 用 Transformer 做扩散模型，Sora 的地基 |
| CFG | Classifier-Free Guidance | 无分类器引导：控制扩散生成"贴合提示词"的程度 |
| GAN | Generative Adversarial Network | 生成对抗网络：生成器 vs 判别器博弈 |

## 八、框架、库与平台

| 缩写 | 全称 | 说明 |
|---|---|---|
| LangChain / LlamaIndex | （框架） | 最主流的 LLM 应用开发框架（你手写过底层，看得穿它封装了什么） |
| DSPy | Declarative Self-improving Language Programs | 声明式"编程+优化 prompt"框架，prompt 当代码 |
| AutoGen / CrewAI | （多 agent 框架） | 微软/社区的编排式多 agent 框架 |
| HF | Hugging Face | 最大的模型/数据集社区 |
| TRL | Transformer Reinforcement Learning | HF 的强化对齐训练库 |
| LiteLLM | （统一网关） | 统一各家 LLM API 的代理层 |
| Ollama | （本地运行） | 本地跑开源模型的工具 |
| OpenRouter | （聚合网关） | 一家 API 调多模型的聚合服务 |
| K8s | Kubernetes | 容器编排平台（生产部署常客） |
| SDK | Software Development Kit | 软件开发工具包（agent 客户端对接模型用） |
| API | Application Programming Interface | 应用程序接口 |
| CLI | Command-Line Interface | 命令行工具 |
| CI/CD | Continuous Integration / Continuous Delivery | 持续集成/持续交付 |

## 九、火山方舟与云平台（你天天用的）

| 缩写 | 全称 | 说明 |
|---|---|---|
| 🎯 EP | Endpoint | 方舟接入点（ep-xxx），部署模型后拿到的调用地址 |
| AK / SK | Access Key / Secret Key | 云平台访问密钥（身份证 + 密码） |
| TOS | （火山对象存储） | 火山引擎的对象存储服务（类似 S3），自定义模型从 TOS 导入 |
| Agent Plan / Coding Plan | （套餐） | 方舟的按席位订阅套餐，配额轮换 APIKey |
| SSO | Single Sign-On | 单点登录（arkcli 登录的通道之一） |
| IAM | Identity and Access Management | 云平台的身份与权限管理 |
| VPC | Virtual Private Cloud | 私有网络环境 |
| IaaS / PaaS / SaaS | Infrastructure / Platform / Software as a Service | 基础设施/平台/软件即服务 |

## 十、硬件与计算

| 缩写 | 全称 | 说明 |
|---|---|---|
| GPU / TPU / NPU | Graphics / Tensor / Neural Processing Unit | 图形/张量/神经网络处理器 |
| VRAM | Video RAM | 显存（决定单卡能跑多大模型） |
| HBM | High Bandwidth Memory | 高带宽内存，AI 加速卡的显存类型 |
| CUDA | Compute Unified Device Architecture | NVIDIA 的并行计算平台 |
| TFLOPS | Tera Floating-point Operations Per Second | 每秒万亿次浮点运算，算力单位 |
| TOPS | Tera Operations Per Second | 每秒万亿次整数运算（端侧 NPU 常用） |

---

## 附：面试必背 Top 15（背到脱口而出）

1. **LLM = 预测下一个 token 的函数**（一切能力的来源）
2. **RAG = 开卷考试**（知识更新靠塞上下文，不靠重训）
3. **Function Calling = 模型表达要调用工具，执行权永远在代码**
4. **Agent = Function Calling 放进循环**（调用→回填→再决策→终止）
5. **MCP = 工具接入的 USB-C 标准**（JSON-RPC，解决 M×N 集成）
6. **KV Cache = 缓存历史 K/V 矩阵，推理加速的根基**
7. **Prompt Caching = KV Cache 前缀复用产品化，消息只能追加不能重写**
8. **Lost in the Middle = 注意力是竞争性资源，关键信息放两端**
9. **RLHF = 人类偏好强化，副作用是模型爱说漂亮话**
10. **LoRA = 只训少量参数微调大模型**
11. **Rerank = cross-encoder 精排，bi-encoder 粗筛**
12. **TTFT = 用户感知快慢的指标，prefill 决定**
13. **Eval = 没有评测集的 agent 是玄学**
14. **Context Engineering = 设计上下文的进出策略，不是文案优化**
15. **Multi-Agent 的真实收益 = 上下文隔离 + 并行，不是更聪明**

---

> 维护约定：遇到新缩写且查过含义的，直接追加到对应分类；面试前通读「必背 Top 15」。这份字典和 INTERVIEW_QA.md、LLM_FUNDAMENTALS.md 互相引用。
