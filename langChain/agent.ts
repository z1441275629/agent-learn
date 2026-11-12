import {
  createAgent,
  tool,
  createMiddleware,
  toolRetryMiddleware,
  modelRetryMiddleware,
  humanInTheLoopMiddleware,
} from 'langchain'
import { StateSchema } from '@langchain/langgraph'
import { createSubAgentMiddleware } from 'deepagents'
import * as z from 'zod'
import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'

const env = process.env
const fromEnv = (p: 'LLM_' | 'LLM_LIGHT_' | 'LLM_BACKUP_') =>
  new ChatOpenAI({
    model: env[`${p}MODEL`]!,
    apiKey: env[`${p}API_KEY`] ?? env.LLM_API_KEY, // 小档缺省共用主 key；备用档跨平台必须自己的 key
    configuration: { baseURL: env[`${p}BASE_URL`] },
  })
const main = fromEnv('LLM_'),
  light = fromEnv('LLM_LIGHT_'),
  backup = fromEnv('LLM_BACKUP_')

var search = tool(({ query }) => `搜索结果: ${query}`, {
  name: 'search',
  description: '搜索信息',
  schema: z.object({ query: z.string() }),
})

const Answer = z.object({ summary: z.string(), confidence: z.number() })

const MyState = new StateSchema({
  userId: z.string(),
  callCount: z.number().default(0),
})

const stateMiddleware = createMiddleware({
  name: 'StateExtension',
  stateSchema: MyState,
})

var agent = createAgent({
  // model: 'baseten:zai-org/GLM-5.2',
  model: main,
  tools: [search],
  systemPrompt: '你是一个 AI 助手，帮助用户搜索信息。',
  responseFormat: Answer,
  middleware: [
    stateMiddleware,
    modelRetryMiddleware({ maxRetries: 3 }),
    toolRetryMiddleware({ maxRetries: 2 }),
    humanInTheLoopMiddleware({ interruptOn: { writeFile: true } }),
    // createSubAgentMiddleware({
    //   // defaultModel: 'anthropic:claude-sonnet-4-6',
    //   defaultModel: main,
    //   defaultTools: [],
    //   subagents: [
    //     {
    //       name: 'researcher',
    //       description: '一个研究子代理，专门用于搜索和总结信息。',
    //       systemPrompt: '你是一个研究子代理，专门用于搜索和总结信息。请根据用户的查询，使用搜索工具获取相关信息，并提供简明的总结。',
    //       tools: [search],
    //       model: backup,
    //       middleware: [],
    //     },
    //   ],
    // }),
  ],
  name: 'first-langchain-agent',
})

const result = await agent.invoke({
  messages: [{ role: 'user', content: '什么是人工智能？' }],
  // 这两个是定义的state数据
  userId: 'user1',
  callCount: 0,
})
console.log(result.structuredResponse) // { summary: ..., confidence: ... }
