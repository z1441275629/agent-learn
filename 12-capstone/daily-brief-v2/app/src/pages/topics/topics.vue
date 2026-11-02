<template>
	<view class="page">
		<view class="muted hint">勾话题就行，源已经配好。「我是谁」一句话决定研究员怎么筛、日报用什么口吻；改完保存，明天的日报按新清单跑</view>

		<!-- audience：v2 字段（v1 读者人设硬编码在 prompt 里，多用户下不成立） -->
		<view class="card">
			<view class="field" style="margin-top: 0">
				<text class="label">我是谁（给研究员的一句话）</text>
				<input v-model="audience" placeholder="如：转型 AI 工程师的前端开发者" />
			</view>
		</view>

		<!-- 预置话题 chips 多选：用户只管「关注什么」，源是运营者 curated（RSS 全部实测可拉才入库） -->
		<view class="card">
			<text class="card-title">关注哪些话题？</text>
			<view class="chips">
				<view v-for="p in presets" :key="p.id" :class="['chip', picked(p.id) ? 'on' : '']" @click="toggle(p)">
					<text>{{ picked(p.id) ? '✓ ' : '' }}{{ p.name }}</text>
				</view>
			</view>
			<view class="field">
				<text class="label">没有想要的？输入话题名自己加</text>
				<view class="row">
					<input class="grow" v-model="customName" placeholder="如：量子计算 / quantum computing" @confirm="addCustom" />
					<button class="btn" @click="addCustom">添加</button>
				</view>
			</view>
			<text class="muted tip">自定义话题自动配 Hacker News / GitHub / arXiv 检索源（英文关键词效果好）；中文资讯勾上面的预置话题</text>
		</view>

		<!-- 已选清单：预置+自定义混排；展开可微调 focus（默认用预设的，不动也行） -->
		<view v-if="topics.length" class="card">
			<text class="card-title">已选 {{ topics.length }} 个话题</text>
			<view v-for="(t, i) in topics" :key="t.id" class="topic-item">
				<view class="row topic-head" @click="expanded = expanded === t.id ? '' : t.id">
					<text class="topic-name">{{ t.name }}</text>
					<text class="muted src-badge">{{ srcCount(t) }}</text>
					<view class="grow"></view>
					<text class="muted">{{ expanded === t.id ? '▲' : '▼' }}</text>
					<text class="del" @click.stop="del(i)">✕</text>
				</view>
				<view v-if="expanded === t.id" class="topic-body">
					<view class="field">
						<text class="label">关注点（给研究员的提示，可不改）</text>
						<input v-model="t.focus" placeholder="一句话：这个话题重点看什么" />
					</view>
					<text class="muted src-list">{{ t.sources.map(srcLabel).join(' · ') }}</text>
				</view>
			</view>
		</view>

		<view class="row actions">
			<button class="btn grow" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存全部' }}</button>
		</view>
	</view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { ref } from 'vue'
import { fetchTopics, saveTopics, fetchPresets, type Topic, type TopicPreset, type SourceSpec } from '../../api'

const audience = ref('')
const topics = ref<Topic[]>([])
const presets = ref<TopicPreset[]>([])
const customName = ref('')
const expanded = ref('')
const saving = ref(false)

onShow(async () => {
	const [j, p] = await Promise.all([
		fetchTopics().catch(() => null),
		fetchPresets().catch(() => null),
	])
	if (j) {
		audience.value = j.audience
		topics.value = j.topics
	}
	if (p) presets.value = p.presets
})

const picked = (id: string) => topics.value.some((t) => t.id === id)

// 勾/取消预置话题：源从 preset 拷贝（防后续编辑 preset 串改已存订阅）
function toggle(p: TopicPreset) {
	const i = topics.value.findIndex((t) => t.id === p.id)
	if (i >= 0) topics.value.splice(i, 1)
	else topics.value.push({ id: p.id, name: p.name, focus: p.focus, sources: p.sources.map((s) => ({ ...s })) })
}

// 自定义话题自动配源（presets.ts autoSourcesFor 的 H5 镜像）：三检索源直配话题名——用户不需要知道什么是「源」
const autoSources = (name: string): SourceSpec[] => [
	{ type: 'hn', query: name },
	{ type: 'github', query: name },
	{ type: 'arxiv', query: name },
]
function addCustom() {
	const name = customName.value.trim()
	if (!name) return uni.showToast({ title: '先填话题名', icon: 'none' })
	if (topics.value.some((t) => t.name === name)) {
		customName.value = ''
		return uni.showToast({ title: '已经在清单里了', icon: 'none' })
	}
	topics.value.push({ id: 'custom-' + Math.random().toString(36).slice(2, 8), name, focus: `关于「${name}」的最新动态`, sources: autoSources(name) })
	customName.value = ''
}

const srcLabel = (s: SourceSpec) => ({ hn: 'HN', github: 'GitHub', arxiv: 'arXiv', rss: 'RSS' }[s.type] ?? s.type)
const srcCount = (t: Topic) => `${t.sources.length} 源`

function del(i: number) {
	uni.showModal({ title: '确认删除', content: `删掉「${topics.value[i].name}」？明天起不再出这个板块`, success: (r) => r.confirm && topics.value.splice(i, 1) })
}

async function save() {
	if (!audience.value.trim()) return uni.showToast({ title: '「我是谁」要填一句', icon: 'none' })
	saving.value = true
	try {
		const r = await saveTopics({ audience: audience.value.trim(), topics: topics.value })
		uni.showToast({ title: r.saved ? `已保存 ${r.saved} 个主题` : '已保存（还没选话题，明天会跳过）', icon: 'none' })
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
	display: block;
	padding: 12px 16px 0;
	line-height: 1.6;
}
.card-title {
	font-weight: 600;
	display: block;
}
/* chips 云：流式换行，选中态主色描边+浅底 */
.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	margin-top: 14px;
}
.chip {
	padding: 8px 14px;
	border: 1px solid #d0d7de;
	border-radius: 999px;
	background: #fafbfc;
	font-size: 14px;
	color: #24292f;
}
.chip.on {
	border-color: #1f6feb;
	background: #ddf4ff;
	color: #1f6feb;
	font-weight: 600;
}
.tip {
	display: block;
	margin-top: 10px;
	line-height: 1.6;
}
.topic-item {
	border-bottom: 1px dashed #eaeef2;
	margin-top: 12px;
	padding-bottom: 4px;
}
.topic-item:last-child {
	border-bottom: none;
}
.topic-head {
	cursor: pointer;
}
.topic-name {
	font-size: 15px;
}
.src-badge {
	background: #f0f2f5;
	border-radius: 10px;
	padding: 2px 8px;
	font-size: 12px;
}
.del {
	color: #d1242f;
	padding: 2px 6px;
	font-size: 15px;
}
.topic-body {
	padding: 2px 0 8px;
}
.src-list {
	display: block;
	margin-top: 10px;
	word-break: break-all;
}
.actions {
	padding: 12px 16px 24px;
}
</style>
