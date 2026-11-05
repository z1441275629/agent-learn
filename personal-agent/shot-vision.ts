// 模块 14 · 页面体检的视觉半边：截图交给视觉档模型（glm-4.5v 一类）生成文字描述，
// 描述喂回主对话模型。这是「感知/推理分工」模式（与截图取字同构：感知用专门引擎，
// 推理留在对话模型）——主档 glm-5.3 不吃图，也不依赖「工具消息带图」这种未探测的 API 能力。
//
// 边界：视觉模型报坐标/像素值不可靠（模块 13 对照实测，PITFALLS/README 有记录）——
// 提示词明确禁止它报精确位置，布局定位交给 DOM 路线（browser_read 的元素索引）。
import type OpenAI from 'openai'
import { thinkingParams } from './models.ts'

const SYSTEM = `你看的是一张网页截图（开发中的界面）。输出两段：
1. 页面概览：整体布局与可见内容，一到两句。
2. 可见异常：空白区域、明显错位/溢出、加载失败的占位、报错弹层、样式明显不对的地方；没有就写「未见明显异常」。
规则：不要编造图中没有的东西；不要报坐标、像素值或精确尺寸（你看不准，编了会误导）。`

/** 截图 → 文字描述（不重试：描述是锦上添花，控制台才是体检的确定性载荷，失败在调用方降级） */
export async function describeScreenshot(client: OpenAI, model: string, dataUrl: string): Promise<string> {
  const res = (await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: '描述这张网页截图。' },
        ],
      },
    ],
    ...thinkingParams('off'), // 看图描述是浅任务，不付思考预算
  } as any)) as any
  const text = res?.choices?.[0]?.message?.content
  if (!text) throw new Error('视觉模型没有返回内容')
  return String(text).trim().slice(0, 1500)
}
