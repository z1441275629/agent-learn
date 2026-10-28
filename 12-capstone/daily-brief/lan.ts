// 局域网地址探测——Server酱通知链接用（server.ts 启动打印同一份）
//
// 为什么自动探测：热点/路由一换 IP 就漂移，.env 钉死撑不住（2026-10-28 实录：钉死 192.168.19.x，
// 换个人热点秒变死链）。发送时刻探测当前 IP，天然跟随网络。
// 钉死逃生门 BRIEF_PUBLIC_URL 仍优先——走内网穿透固定域名时用它。
//
// 探测策略：非内部 IPv4 只有一个 → 直接用它（段无关——个人热点有 172.20.10.x（iPhone）也有
// 10.190.x，先验「哪个段」是猜，先验「单网卡单地址」是事实）；多个 → 按 RFC1918 私网段挑
// （排除公网/虚拟网卡的干扰，VMware/Hyper-V 虚拟网卡若抢先，钉死可覆盖——不做网卡优选的过度工程）
import os from 'node:os'

const RFC1918 = (ip: string) => /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^192\.168\./.test(ip)

export function lanIPv4(): string | null {
	const ips = Object.values(os.networkInterfaces())
		.flat()
		.filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
		.map((n) => n.address)
	if (ips.length === 1) return ips[0]
	return ips.find((ip) => RFC1918(ip)) ?? null
}

// 通知链接解析优先级：BRIEF_PUBLIC_URL 钉死 > 自动探测（当前 IP + BRIEF_PORT）> null（不带链接）
// 返回值不带尾斜杠——钉死时尊重用户写的原文
export function publicURL(): string | null {
	const pinned = process.env.BRIEF_PUBLIC_URL?.trim()
	if (pinned) return pinned
	const ip = lanIPv4()
	if (!ip) return null
	return `http://${ip}:${Number(process.env.BRIEF_PORT || 8787)}`
}
