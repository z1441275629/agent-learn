<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listSkills } from '../api'
import type { SkillInfo } from '../types'
import { toast } from '../utils/toast'

defineOptions({ name: 'SkillsPage' })

const skills = ref<SkillInfo[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    skills.value = await listSkills()
  } catch (e: any) {
    toast('技能加载失败：' + (e?.message ?? e))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h2>技能</h2>
      <span class="desc">对话里 agent 经 use_skill 加载执行；此处为可用技能索引（只读）。</span>
    </header>
    <el-skeleton v-if="loading" :rows="4" animated class="skeleton" />
    <el-empty v-else-if="!skills.length" description="skills/ 目录下还没有 SKILL.md 技能文档" />
    <div v-else class="grid">
      <el-card v-for="s in skills" :key="s.name" class="card" shadow="hover">
        <template #header><b>{{ s.name }}</b></template>
        <span class="desc-text">{{ s.description }}</span>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 20px 28px;
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}
.page-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.page-head h2 {
  margin: 0;
  font-size: 17px;
}
.desc {
  font-size: 13px;
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.desc-text {
  font-size: 13px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.skeleton {
  padding: 8px 0;
}
</style>
