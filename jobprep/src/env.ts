// env 读取链：jobprep/.env 优先，回落仓库根 ../.env（密钥保持单一来源——pa 同款纪律）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url)) // src/
export const PROJECT_ROOT = path.resolve(here, '..') // jobprep/
export const REPO_ROOT = path.resolve(PROJECT_ROOT, '..') // 仓库根（题库/PITFALLS 在这里）

config({ path: path.join(PROJECT_ROOT, '.env') })
config({ path: path.join(REPO_ROOT, '.env') }) // dotenv 不覆盖已设键——本地优先语义

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`缺少环境变量 ${name}（放 jobprep/.env 或仓库根 .env，参考 .env.example）`)
  return v
}

export const env = {
  get model() {
    return need('LLM_MODEL')
  },
  get apiKey() {
    return need('LLM_API_KEY')
  },
  get baseURL() {
    return need('LLM_BASE_URL')
  },
  get port() {
    return Number(process.env.JOBPREP_PORT || 8790)
  },
}
