// 技能路由：可用技能索引（发现用——前端「技能」面板展示 name+description；正文由 agent 对话里调 use_skill 加载）
import Router from '@koa/router'
import { json } from '../http.ts'
import { skills } from '../state.ts'

export const router = new Router()

router.get('/api/skills', async (ctx) => {
  return json(ctx, 200, { skills: await skills.index() })
})
