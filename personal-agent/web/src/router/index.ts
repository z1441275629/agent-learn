// vue-router：会话 id 进 URL（/chat/:id 刷新定位）+ 记忆/知识库/技能独立管理页。
// history 模式深链由服务端 SPA fallback 支撑（app.ts 静态中间件，非 /api 无扩展名 GET 回 index.html）
import { createRouter, createWebHistory } from 'vue-router'
import ChatPane from '../components/chat/ChatPane.vue'
import OcrPane from '../components/ocr/OcrPane.vue'
import MemoryPage from '../pages/MemoryPage.vue'
import KbPage from '../pages/KbPage.vue'
import SkillsPage from '../pages/SkillsPage.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    // /chat 与 /chat/:id 合一条可选参数记录：同一组件实例，keep-alive include 才能命中
    { path: '/chat/:id?', name: 'chat', component: ChatPane },
    { path: '/memory', name: 'memory', component: MemoryPage },
    { path: '/kb', name: 'kb', component: KbPage },
    { path: '/skills', name: 'skills', component: SkillsPage },
    { path: '/ocr', name: 'ocr', component: OcrPane },
    { path: '/', redirect: '/chat' },
    { path: '/:pathMatch(.*)*', redirect: '/chat' },
  ],
})

export default router
