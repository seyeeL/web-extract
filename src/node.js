// Node 侧：抓 HTML、按字符集解码、用 linkedom 建一棵离线 DOM，再交给提取逻辑。
//
// 只拿得到服务端直出的 HTML。正文靠 JS 渲染的站点（X、小红书、微博）这里会抓空，
// 得走 ./browser.js 起真浏览器。

import { parseHTML } from 'linkedom';
import { dumpCandidates } from './dump.js';
import { extractDocument } from './result.js';

export const DEFAULT_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// 公众号链接不带微信 UA 常拿到「环境异常」验证页
export const WECHAT_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
	'(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002832) NetType/WIFI Language/zh_CN';

// 正常文章页很少过 5 MB。上限是防一个链接指到几百兆的文件把内存吃光
export const MAX_HTML_BYTES = 20 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 字节 → 字符串。先看响应头的 charset，没有再从文档开头的 <meta> 里找。
 * 国内老站点 GBK 的不少，一律按 UTF-8 解会满屏乱码。认不出的编码名退回 UTF-8。
 */
export function decodeHtml(bytes, contentType = '') {
	const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? '';
	if (!charset) {
		// 只为找 meta，按单字节解开头一段就够，不会因为多字节编码出错
		const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
		charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? '';
	}
	try {
		return new TextDecoder(charset || 'utf-8').decode(buf);
	} catch {
		return new TextDecoder('utf-8').decode(buf);
	}
}

/** 按块读响应体，超过上限立刻断开，不等整个文件下完。 */
async function readCapped(res, maxBytes) {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel();
		throw new Error(`页面太大（${declared} 字节，上限 ${maxBytes}）`);
	}
	if (!res.body) return new Uint8Array(await res.arrayBuffer());
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`页面太大（超过 ${maxBytes} 字节）`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * 抓一个页面的 HTML。返回的 url 是跟完重定向之后的地址 —— 短链（t.co、xhslink）
 * 要用落地地址才匹配得上站点规则。
 */
export async function fetchHtml(url, {
	userAgent = DEFAULT_UA,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	maxBytes = MAX_HTML_BYTES,
	fetchImpl = globalThis.fetch,
} = {}) {
	const parsed = new URL(url);
	if (!/^https?:$/.test(parsed.protocol)) throw new Error(`只支持 http / https 地址：${url}`);
	let res;
	try {
		res = await fetchImpl(parsed.toString(), {
			redirect: 'follow',
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				'user-agent': userAgent,
				accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
				'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
			},
		});
	} catch (err) {
		// Node 的 fetch 只报一句「fetch failed」，真正的原因（DNS、连接被断、证书）在 cause 里
		const cause = err?.cause?.code || err?.cause?.message || '';
		const reason = err?.name === 'TimeoutError' ? `${timeoutMs} 毫秒超时` : cause || err?.message;
		throw new Error(`抓取失败（${reason}）：${parsed}`);
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`HTTP ${res.status}：${parsed}`);
	}
	const type = res.headers.get('content-type') ?? '';
	if (type && !/html|xml/i.test(type)) {
		await res.body?.cancel();
		throw new Error(`不是 HTML 页面（${type}）：${parsed}`);
	}
	const bytes = await readCapped(res, maxBytes);
	return { html: decodeHtml(bytes, type), url: res.url || parsed.toString() };
}

/** HTML 字符串 → linkedom 文档。 */
export function parseDocument(html) {
	return parseHTML(String(html ?? '')).document;
}

/**
 * HTML 字符串 → 提取结果。url 决定命中哪条站点规则，本地文件也最好带上原始地址。
 * @param {{withReplies?: boolean, plain?: boolean}} [options]
 */
export function extractHtml(html, url = '', options = {}) {
	return extractDocument(parseDocument(html), url, options);
}

/** HTML 字符串 → 正文候选容器列表（调试「正文在哪」用）。 */
export function dumpHtml(html) {
	return dumpCandidates(parseDocument(html));
}

/**
 * URL → 提取结果，静态抓取。
 * @param {{withReplies?: boolean, plain?: boolean, userAgent?: string, timeoutMs?: number, maxBytes?: number}} [options]
 */
export async function extractUrl(url, options = {}) {
	const page = await fetchHtml(url, options);
	return extractHtml(page.html, page.url, options);
}
