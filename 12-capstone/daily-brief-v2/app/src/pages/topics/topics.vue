<template>
	<view class="page">
		<view class="muted hint">订阅 = 产线的 fanout 依据。audience 一句话告诉研究员「你是谁」——筛选标准和日报口吻都跟着它变；改完「保存全部」整体提交，明天的日报按新清单跑</view>

		<!-- audience：v2 新字段（v1「读者是学 agent 的工程师」硬编码在 prompt 里，多用户下不成立） -->
		<view class="card">
			<view class="field">
				<text class="label">我是谁（给研究员的一句话）</text>
				<input v-model="audience" placeholder="如：转型 AI 工程师的前端开发者" />
			</view>
		</view>

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

			<!-- v2：数据源是数组——type 从注册表四选一（不再限死 HN+GitHub，行业新闻走 RSS） -->
			<text class="label src-label">数据源（至少 1 个，可混搭）</text>
			<view v-for="(s, j) in t.sources" :key="j" class="row src-row">
				<picker mode="selector" :range="SOURCE_TYPES" range-key="label" @change="onPickType(i, j, $event)">
					<view class="btn ghost type-btn">{{ labelOf(s.type) }} ▾</view>
				</picker>
				<input class="grow" v-model="s.query" :placeholder="placeholderOf(s.type)" />
				<button v-if="t.sources.length > 1" class="btn warn del" @click="t.sources.splice(j, 1)">✕</button>
			</view>
			<button class="btn ghost add-src" @click="t.sources.push({ type: 'rss', query: '' })">＋ 加数据源</button>
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
import { fetchTopics, saveTopics, type Topic, type SourceType } from '../../api'

// 源注册表的 H5 侧镜像（server zod 枚举同一份四选一；label 给 picker、query placeholder 教用户填什么）
const SOURCE_TYPES: Array<{ type: SourceType; label: string; ph: string }> = [
	{ type: 'hn', label: 'Hacker News', ph: '如：AI agent' },
	{ type: 'github', label: 'GitHub', ph: '如：ai agent framework（近 7 天新仓库按星排）' },
	{ type: 'arxiv', label: 'arXiv', ph: '如：LLM agent' },
	{ type: 'rss', label: 'RSS', ph: '目标站的 RSS 地址（https://…）' },
]
const labelOf = (t: SourceType) => SOURCE_TYPES.find((s) => s.type === t)?.label ?? t
const placeholderOf = (t: SourceType) => SOURCE_TYPES.find((s) => s.type === t)?.ph ?? ''

const audience = ref('')
const topics = ref<Topic[]>([])
const saving = ref(false)

onShow(async () => {
	const j = await fetchTopics().catch(() => null)
	if (j) {
		audience.value = j.audience
		topics.value = j.topics
	}
})

function add() {
	// id 自动生成（v1 让用户手填——易错且无收益：id 只是 ledger key 的标识位）
	topics.value.push({ id: 'topic-' + Math.random().toString(36).slice(2, 8), name: '', focus: '', sources: [{ type: 'rss', query: '' }] })
}

function onPickType(ti: number, si: number, e: any) {
	const picked = SOURCE_TYPES[Number(e.detail.value)]
	if (picked) topics.value[ti].sources[si].type = picked.type
}

function del(i: number) {
	uni.showModal({ title: '确认删除', content: `删掉「${topics.value[i].name || '这个主题'}」？明天起不再出这个板块`, success: (r) => r.confirm && topics.value.splice(i, 1) })
}

async function save() {
	// 前端挡漏填（后端 zod 挡格式——双层校验，v1 同款分工）
	if (!audience.value.trim()) return uni.showToast({ title: '「我是谁」要填一句', icon: 'none' })
	for (const t of topics.value) {
		if (!t.name.trim()) return uni.showToast({ title: '有主题没填名字', icon: 'none' })
		if (t.sources.some((s) => !s.query.trim())) return uni.showToast({ title: `「${t.name}」有数据源没填检索词/地址`, icon: 'none' })
	}
	saving.value = true
	try {
		const r = await saveTopics({ audience: audience.value.trim(), topics: topics.value })
		uni.showToast({ title: `已保存 ${r.saved} 个主题`, icon: 'success' })
	} catch (err: any) {
		// server 端 zod 校验不过——把 issues 首条亮出来
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
.field input,
.src-row input {
	border: 1px solid #d0d7de;
	border-radius: 6px;
	padding: 7px 10px;
	font-size: 14px;
	background: #fafbfc;
}
.src-label {
	margin-top: 14px;
}
.src-row {
	margin-top: 8px;
}
.type-btn {
	padding: 7px 10px;
	font-size: 13px;
	white-space: nowrap;
}
.add-src {
	margin-top: 8px;
	padding: 6px 12px;
	font-size: 13px;
}
.actions {
	padding: 12px 16px 24px;
}
</style>
