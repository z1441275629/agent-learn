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
    <el-menu mode="horizontal" router :ellipsis="false" :default-active="active" class="nav">
      <el-menu-item v-for="it in items" :key="it.path" :index="it.path">{{ it.label }}</el-menu-item>
    </el-menu>
  </header>
</template>

<style scoped>
/* 顶栏布局此前压根没写（.header 无定义）——标题与菜单裸排没间距。48px 单行：
   菜单高度变量与顶栏同高，选中态下划线正好压在顶栏底边线上 */
.header {
  display: flex;
  align-items: center;
  gap: 20px;
  height: 48px;
  padding: 0 20px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}

.brand {
  font-weight: 700;
  font-size: 15px;
  white-space: nowrap;
  letter-spacing: 0.5px;
  padding-right: 18px;
  border-right: 1px solid var(--line);
}

/* hover 用中性浅灰（EP 默认是极浅蓝，跟选中蓝同色相分不开）；选中 = 蓝字+蓝下划线 */
.nav {
  border-bottom: none;
  background: transparent;
  --el-menu-horizontal-height: 48px;
  --el-menu-hover-bg-color: #f3f4f6;
  --el-menu-active-color: var(--accent);
}
</style>
