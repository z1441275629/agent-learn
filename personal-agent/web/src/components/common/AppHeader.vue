<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// /chat/:id 也应高亮「对话」——把任意 /chat/* 折叠到 /chat
const active = computed(() => (route.path.startsWith('/chat') ? '/chat' : route.path))

const items = [
  { path: '/chat', label: '对话' },
  { path: '/memory', label: '记忆' },
  { path: '/kb', label: '知识库' },
  { path: '/skills', label: '技能' },
  { path: '/ocr', label: '截图取字' },
]
</script>

<template>
  <header class="header">
    <div class="brand">个人 Agent 工作台</div>
    <el-menu mode="horizontal" router :default-active="active" class="nav">
      <el-menu-item v-for="it in items" :key="it.path" :index="it.path">{{ it.label }}</el-menu-item>
    </el-menu>
  </header>
</template>

<style scoped>
.brand {
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
}

.nav {
  border-bottom: none;
}
</style>
