<script setup lang="ts">
import type { SkillInfo } from '../../types'

defineProps<{ skills: SkillInfo[] }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="skill-backdrop" @click="emit('close')"></div>
  <div class="skill-panel">
    <div class="panel-head">
      <strong>技能（{{ skills.length }}）</strong>
      <button class="ghost" @click="emit('close')">关闭</button>
    </div>
    <p class="hint">
      技能是沉淀的固定流程：用户消息命中技能的触发词（frontmatter 的 triggers）时，工作台自动把技能正文加载进上下文；没命中时靠 agent 调 use_skill 加载。
      技能放 personal-agent/skills/ 下——单文件 skills/&lt;名字&gt;.md，或有支撑文件的文件夹 skills/&lt;名字&gt;/SKILL.md。
    </p>
    <ul v-if="skills.length" class="skill-list">
      <li v-for="s in skills" :key="s.name">
        <span class="name">{{ s.name }}</span>
        <span class="sub">{{ s.description }}</span>
      </li>
    </ul>
    <p v-else class="empty">还没有技能——往 skills/ 放 SKILL.md 即被识别。</p>
  </div>
</template>

<style scoped>
.skill-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.skill-panel {
  position: absolute;
  top: 8px;
  left: 18px;
  z-index: 31;
  width: min(460px, calc(100% - 36px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 8px 28px rgb(0 0 0 / 12%);
  padding: 12px 14px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
}

.hint {
  margin: 6px 0 8px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

.skill-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.skill-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 13px;
}

.skill-list .name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-list .sub {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.ghost {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--muted);
  border-radius: 8px;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.empty {
  font-size: 13px;
  color: var(--muted);
  text-align: center;
  padding: 18px 0;
}
</style>
