// 模型目录 + 思考档位（UI 下拉框数据源）；asrModel = 大模型转写可用与否（语音引擎选项的依据）
import Router from '@koa/router'
import { json } from '../http.ts'
import { DEFAULT_MODEL_ID, MODELS, THINKING_LEVELS } from '../../models.ts'
import { ASR } from '../state.ts'

export const router = new Router()

router.get('/api/models', async (ctx) => {
  return json(ctx, 200, {
    models: MODELS.map(({ id, label, model, vision }) => ({ id, label, model, vision })),
    defaultModelId: DEFAULT_MODEL_ID,
    thinkingLevels: THINKING_LEVELS,
    asrModel: ASR?.model ?? null,
  })
})
