<template>
	<view class="page">
		<view class="muted hint">订阅清单 = 产线的 fanout 依据（07 文件型记忆的应用版）：改完点「保存全部」整体提交，明天的日报按新清单跑</view>

		<view v-for="(t, i) in topics" :key="i" class="card">
			<view class="row">
				<text class="card-title">{{ t.name || '（新主题）' }}</text>
				<view class="grow"></view>
				<button class="btn warn del" @click="del(i)">删除</button>
			</view>
			<view class="field">
				<text class="label">主题名（中文）</text>
				<input v-model="t.name" placeholder="如：AI Agent 工程" />
			</view>
			<view class="field">
				<text class="label">关注点（给研究员的提示）</text>
				<input v-model="t.focus" placeholder="如：agent 框架、多 agent 编排" />
			</view>
			<view class="field">
				<text class="label">HN 检索词</text>
				<input v-model="t.hnQuery" placeholder="如：AI agent" />
			</view>
			<view class="field">
				<text class="label">GitHub 检索词（近 7 天新建仓库按星排）</text>
				<input v-model="t.githubQuery" placeholder="如：ai agent framework" />
			</view>
			<view v-if="t.id" class="muted">id: {{ t.id }}（已有主题，改 id 需谨慎——它只是标识）</view>
		</view>

		<view class="row actions">
			<button class="btn ghost" @click="add">＋ 新增主题</button>
			<button class="btn grow" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存全部' }}</button>
		</view>
	</view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { ref } from 'vue'
import { fetchTopics, saveTopics, type Topic } from '../../api'

const topics = ref<Topic[]>([])
const saving = ref(false)

onShow(async () => {
	const j = await fetchTopics().catch(() => null)
	if (j) topics.value = j.topics
})

function add() {
	// id 留空让用户填（英文 kebab-case，server 端 zod 再校验一层）
	topics.value.push({ id: '', name: '', focus: '', hnQuery: '', githubQuery: '' })
}

function del(i: number) {
	uni.showModal({ title: '确认删除', content: `删掉「${topics.value[i].name || topics.value[i].id}」？明天起不再出这个板块`, success: (r) => r.confirm && topics.value.splice(i, 1) })
}

async function save() {
	const missing = topics.value.find((t) => !t.id || !t.name || !t.hnQuery || !t.githubQuery)
	if (missing) return uni.showToast({ title: '有主题缺必填项（id/主题名/HN/GitHub 检索词）', icon: 'none' })
	saving.value = true
	try {
		const r = await saveTopics(topics.value)
		uni.showToast({ title: `已保存 ${r.saved} 个主题`, icon: 'success' })
	} catch (err: any) {
		// server 端 zod 校验不过——把 issues 首条亮出来（前后端双层校验：前端挡漏填，后端挡格式）
		uni.showModal({ title: '保存被拒', content: String(err?.issues?.[0]?.message ?? err?.message ?? err).slice(0, 80), showCancel: false })
	} finally {
		saving.value = false
	}
}
</script>

<style>
.hint {
	padding: 12px 16px 0;
}
.card-title {
	font-weight: 600;
}
.del {
	padding: 2px 10px;
	font-size: 12px;
}
.field {
	margin-top: 10px;
}
.label {
	display: block;
	font-size: 12px;
	color: #57606a;
	margin-bottom: 4px;
}
.field input {
	border: 1px solid #d0d7de;
	border-radius: 6px;
	padding: 7px 10px;
	font-size: 14px;
	background: #fafbfc;
}
.actions {
	padding: 12px 16px 24px;
}
</style>
