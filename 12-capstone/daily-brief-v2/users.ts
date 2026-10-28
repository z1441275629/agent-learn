// 模块 12 毕业项目 v2：用户系统——注册（邀请码）/登录（scrypt 慢哈希）/session（文件存储）
//
// 零依赖密码学：node:crypto scrypt（内存难，抗 GPU 爆破）——不装 bcrypt；timingSafeEqual 防时序侧信道。
// 数据全在 data/（gitignored，含密码哈希与推送 key）：users/<uid>/profile.json、invites.json、sessions.json。
// uid=randomBytes(8).hex——目录名不受用户输入控制（无路径穿越面）；username 只是显示+查重字段。
// 写操作全走串行队列（v1 emitProgress 同款）：注册/消费邀请码/写 session 都是读改写，防竞态。
import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const DIR = import.meta.dirname
// 数据目录可注入（env V2_DATA_DIR）：探针用临时目录（绝不碰真数据），部署时指数据卷挂载点
const DATA = process.env.V2_DATA_DIR ? path.resolve(process.env.V2_DATA_DIR) : path.join(DIR, 'data')
const USERS_DIR = path.join(DATA, 'users')
const INVITES = path.join(DATA, 'invites.json')
const SESSIONS = path.join(DATA, 'sessions.json')
const SESSION_TTL_MS = 30 * 86400e3

export interface Profile {
	id: string
	username: string
	pass: string // "salt:hash"（scrypt）
	sendkey?: string // Server酱（用户自助填写）
	admin: boolean
	createdAt: string
}

// ---------- 串行队列（写操作防读改写竞态） ----------
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(job: () => Promise<T>): Promise<T> {
	const run = queue.then(job, job)
	queue = run.catch(() => {})
	return run
}

// ---------- 通用 JSON 读写 ----------
async function readJSON<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as T
	} catch (err: any) {
		if (err?.code !== 'ENOENT') throw err
		return fallback
	}
}
const writeJSON = (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')

// ---------- 密码 ----------
const hashPass = (password: string): string => {
	const salt = crypto.randomBytes(16)
	const hash = crypto.scryptSync(password, salt, 64)
	return `${salt.toString('hex')}:${hash.toString('hex')}`
}
function verifyPass(password: string, stored: string): boolean {
	const [saltHex, hashHex] = stored.split(':')
	if (!saltHex || !hashHex) return false
	const expect = Buffer.from(hashHex, 'hex')
	const got = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expect.length)
	return expect.length === got.length && crypto.timingSafeEqual(expect, got)
}

// ---------- 邀请码 ----------
// 首码 bootstrap：零用户+空邀请池时，用 env BOOTSTRAP_INVITE_CODE（缺省随机生成并打印一次）
type InvitePool = Record<string, { usedBy?: string; usedAt?: string }>
async function loadInvites(): Promise<InvitePool> {
	return readJSON<InvitePool>(INVITES, {})
}
export async function createInvite(byUid: string): Promise<string> {
	return serialized(async () => {
		const pool = await loadInvites()
		const code = crypto.randomBytes(6).toString('base64url')
		pool[code] = {}
		await writeJSON(INVITES, pool)
		console.log(`[invites] 新邀请码由 ${byUid.slice(0, 8)}… 生成`)
		return code
	})
}
export async function listInvites(): Promise<InvitePool> {
	return loadInvites()
}
async function consumeInvite(code: string, uid: string): Promise<void> {
	return serialized(async () => {
		const pool = await loadInvites()
		const entry = pool[code]
		if (!entry || entry.usedBy) throw new Error('邀请码无效或已被使用')
		entry.usedBy = uid
		entry.usedAt = new Date().toISOString()
		await writeJSON(INVITES, pool)
	})
}

// ---------- 用户 ----------
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/
export async function listUsers(): Promise<Profile[]> {
	const dirs = await fs.readdir(USERS_DIR).catch(() => [] as string[])
	const users = await Promise.all(
		dirs.map((d) => readJSON<Profile | null>(path.join(USERS_DIR, d, 'profile.json'), null)),
	)
	return users.filter((u): u is Profile => !!u)
}
export async function getUser(uid: string): Promise<Profile | null> {
	return readJSON<Profile | null>(path.join(USERS_DIR, uid, 'profile.json'), null)
}

export async function register(username: string, password: string, inviteCode: string): Promise<{ user?: Profile; error?: string }> {
	if (!USERNAME_RE.test(username)) return { error: '用户名 3~32 位，只能字母/数字/_/-' }
	if (password.length < 8) return { error: '密码至少 8 位' }
	if (!inviteCode?.trim()) return { error: '请填邀请码' }
	return serialized(async () => {
		// 邀请码先验后消费（同一串行队列内=原子窗口）：码不对连用户名都不用查
		const pool = await loadInvites()
		const invite = pool[inviteCode.trim()]
		if (!invite || invite.usedBy) return { error: '邀请码无效或已被使用' }
		const users = await listUsers()
		if (users.some((u) => u.username === username)) return { error: '用户名已被占用' }
		const user: Profile = {
			id: crypto.randomBytes(8).toString('hex'),
			username,
			pass: hashPass(password),
			admin: users.length === 0, // 第一个注册的用户=运营者
			createdAt: new Date().toISOString(),
		}
		await fs.mkdir(path.join(USERS_DIR, user.id), { recursive: true })
		await writeJSON(path.join(USERS_DIR, user.id, 'profile.json'), user)
		await writeJSON(path.join(USERS_DIR, user.id, 'subscriptions.json'), { audience: '关注科技动态的读者', topics: [] })
		invite.usedBy = user.id
		invite.usedAt = new Date().toISOString()
		await writeJSON(INVITES, pool)
		console.log(`[users] 注册 ${username}（${users.length === 0 ? 'admin' : 'member'}）`)
		return { user }
	})
}

// 登录失败统一「用户名或密码不对」——不泄露用户名是否存在（防枚举）
export async function login(username: string, password: string): Promise<{ token?: string; error?: string }> {
	const users = await listUsers()
	const user = users.find((u) => u.username === username)
	if (!user || !verifyPass(password, user.pass)) return { error: '用户名或密码不对' }
	return serialized(async () => {
		const sessions = await readJSON<Record<string, { uid: string; expiresAt: number }>>(SESSIONS, {})
		const token = crypto.randomBytes(32).toString('hex')
		sessions[token] = { uid: user.id, expiresAt: Date.now() + SESSION_TTL_MS }
		// 顺手清理过期 session（懒删，不专门起定时器）
		const now = Date.now()
		for (const [t, s] of Object.entries(sessions)) if (s.expiresAt < now) delete sessions[t]
		await writeJSON(SESSIONS, sessions)
		return { token }
	})
}

export async function getSessionUser(token: string): Promise<Profile | null> {
	if (!token) return null
	const sessions = await readJSON<Record<string, { uid: string; expiresAt: number }>>(SESSIONS, {})
	const s = sessions[token]
	if (!s || s.expiresAt < Date.now()) return null
	return getUser(s.uid)
}

export async function logout(token: string): Promise<void> {
	return serialized(async () => {
		const sessions = await readJSON<Record<string, { uid: string; expiresAt: number }>>(SESSIONS, {})
		delete sessions[token]
		await writeJSON(SESSIONS, sessions)
	})
}

export async function updateProfile(uid: string, patch: { sendkey?: string }): Promise<Profile | null> {
	return serialized(async () => {
		const user = await getUser(uid)
		if (!user) return null
		if (patch.sendkey !== undefined) user.sendkey = patch.sendkey.trim() || undefined // 空串=清除
		await writeJSON(path.join(USERS_DIR, uid, 'profile.json'), user)
		return user
	})
}

// 改密码：旧密码验明正身再换（防 session 被偷后直接改密锁真主）
export async function changePassword(uid: string, oldPass: string, newPass: string): Promise<{ ok?: boolean; error?: string }> {
	if (newPass.length < 8) return { error: '新密码至少 8 位' }
	return serialized(async () => {
		const user = await getUser(uid)
		if (!user) return { error: '用户不存在' }
		if (!verifyPass(oldPass, user.pass)) return { error: '旧密码不对' }
		user.pass = hashPass(newPass)
		await writeJSON(path.join(USERS_DIR, uid, 'profile.json'), user)
		return { ok: true }
	})
}

// ---------- bootstrap：产线/server 启动前调用——首码只打印一次 ----------
export async function bootstrap(): Promise<void> {
	const users = await listUsers()
	const pool = await loadInvites()
	if (users.length > 0 || Object.keys(pool).length > 0) return
	await fs.mkdir(DATA, { recursive: true })
	const code = process.env.BOOTSTRAP_INVITE_CODE?.trim() || crypto.randomBytes(6).toString('base64url')
	pool[code] = {}
	await writeJSON(INVITES, pool)
	console.log(`[users] 零用户零邀请池——已生成首个邀请码（只打印这一次）：${code}`)
}
