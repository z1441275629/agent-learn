// 技能状态：可用技能索引（name+description）、面板开关
//
// 技能的加载执行是对话里 agent 调 use_skill 做的事（工具痕迹里能看到「加载技能」）；
// 这里只负责展示「有哪些技能可用」，跟 useKb 一个形状。

import { ref } from 'vue'
import { listSkills } from '../api'
import type { SkillInfo } from '../types'
import { toast } from '../utils/toast'

export function useSkills() {
  const skills = ref<SkillInfo[]>([])
  const open = ref(false)

  async function load(): Promise<void> {
    try {
      skills.value = await listSkills()
    } catch (e: any) {
      toast('技能加载失败：' + (e?.message ?? e))
    }
  }

  function toggle(): void {
    open.value = !open.value
    if (open.value) void load()
  }

  return { skills, open, load, toggle }
}
