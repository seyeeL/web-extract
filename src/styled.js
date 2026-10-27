// 带样式的 HTML（--html）在 Node 这一侧的活：抓样式表、展开 @import、按正文裁 CSS、
// （可选）把图片落到本地目录，最后拼成一个能单独打开的 HTML 文件。
//
// 页面那一侧的材料（正文 + 祖先骨架、样式表清单）由 ./snapshot.js 给出：静态抓取时在
// linkedom 里跑，浏览器模式时注进页面跑，两条路交过来的东西长得一样。
//
// 图片默认留远程地址，不转 base64（SingleFile 那样一张图就能把文件撑到几 MB）。可是
// 豆瓣、微博这类站点有防盗链，小红书的图片地址带签名、过几天就失效，离开原站打不开，
// 所以给了三条路：assetsDir 把图片下载到 HTML 旁边的目录里、用相对路径引用，HTML 本身仍然很小；
// embedImages 塞进 HTML 当 data: URI，文件大，但只有一个，手机上传来传去方便；
// uploadImage 转存到自己的图床（./image-host.js），HTML 小、单文件、图片地址长期有效。

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseHTML } from 'linkedom';

import { absolutizeCssUrls, findImports, matchableSelector, shrinkCss } from './css.js';
import { ruleFor } from './site-rules.js';
import { SNAPSHOT_CAROUSEL_CLASS, SNAPSHOT_CHAIN_ATTR, SNAPSHOT_FIXED_ATTR, SNAPSHOT_META_CLASS } from './snapshot.js';

// 单个样式表、全部样式表、@import 层数、样式表个数的上限：防一个页面引几百个 CSS
// 或者 @import 套娃把抓取拖死
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_CSS_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 5;
const MAX_SHEETS = 100;
// 样式表是一个个按顺序抓的，单个 15 秒超时乘上一百个就是二十多分钟。整体给一个预算，
// 超了后面的就不抓了（页面里读到过 cssRules 的仍然用那份）
const CSS_BUDGET_MS = 60_000;
// 图片落本地时的上限
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
// 图片塞进 HTML 时更紧：单张 5 MB，加起来 30 MB，超了的留远程地址
export const MAX_EMBED_BYTES = 5 * 1024 * 1024;
export const MAX_EMBED_TOTAL = 30 * 1024 * 1024;
// 小红书一条热门笔记几百条评论，每条一个头像
const MAX_ASSETS = 1000;
const ASSET_CONCURRENCY = 6;

const IMAGE_EXT = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/svg+xml': 'svg',
	'image/bmp': 'bmp',
	'image/x-icon': 'ico',
	'image/vnd.microsoft.icon': 'ico',
};

// 只存正文时补的几条（整页存时一条都不加，原样就是原站的样子）：
// 骨架上的祖先不许把正文截掉，图片别撑出屏幕，出处那行的间距。
// 骨架那几层的固定高度、overflow:hidden 是给「整屏 + 内部滚动」布局用的，正文离开了
// 那套 JS，留着它们正文就被截在一屏里
const FIX_CSS = [
	`[${SNAPSHOT_CHAIN_ATTR}]{height:auto!important;max-height:none!important;min-height:0!important;overflow:visible!important}`,
	`[${SNAPSHOT_FIXED_ATTR}]{position:relative!important;inset:auto!important;transform:none!important}`,
	'img,video{max-width:100%}',
	// 出处那一行：字体颜色跟站点，只管间距和淡一点
	`.${SNAPSHOT_META_CLASS}{margin:0 0 1.2em;padding:0 0 .6em;border-bottom:1px solid rgba(127,127,127,.25)}`,
	`.${SNAPSHOT_META_CLASS} h1{margin:0 0 .4em;font-size:1.6em;line-height:1.3}`,
	`.${SNAPSHOT_META_CLASS} p{margin:0;font-size:.9em;opacity:.65}`,
	`.${SNAPSHOT_META_CLASS} a{color:inherit}`,
].join('');

// 换成纯 CSS 的图片轮播（snapshot.js 的 snapCarousels）：第 k 个 radio 没选中就把第 k 张藏起来，
// 箭头、页码、圆点浮在图上。规则按张数生成，到页面上最多那个轮播的张数为止
function carouselCss(max) {
	const c = `.${SNAPSHOT_CAROUSEL_CLASS}`;
	const rules = [
		`${c}{position:relative}`,
		`${c}>${c}-radio{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}`,
		`${c}>.swiper-wrapper{transform:none!important;transition:none!important}`,
		`${c}-slide{position:relative}`,
		`${c}-prev,${c}-next{position:absolute;top:50%;z-index:5;width:32px;height:32px;margin-top:-16px;border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.25);color:#333;font:26px/29px sans-serif;text-align:center;cursor:pointer;user-select:none}`,
		`${c}-prev{left:12px}`,
		`${c}-next{right:12px}`,
		`${c}-count{position:absolute;top:12px;right:12px;z-index:5;padding:2px 8px;border-radius:10px;background:rgba(0,0,0,.45);color:#fff;font:12px/18px sans-serif}`,
		`${c}-dots{position:absolute;left:50%;bottom:12px;z-index:5;display:flex;gap:6px;padding:5px 7px;border-radius:9px;background:rgba(0,0,0,.28);transform:translateX(-50%)}`,
		`${c}-dots label{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.5);cursor:pointer}`,
		`${c}-dots label.on{background:#fff}`,
	];
	for (let k = 1; k <= max; k += 1) {
		rules.push(`${c}>${c}-radio:nth-of-type(${k}):not(:checked)~.swiper-wrapper>${c}-slide:nth-child(${k}){display:none!important}`);
	}
	return rules.join('');
}

function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** 字节 → 文本：响应头的 charset，再看 @charset，都没有按 UTF-8。 */
function decodeCss(bytes, contentType = '') {
	let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? '';
	if (!charset) {
		const head = new TextDecoder('latin1').decode(bytes.subarray(0, 128));
		charset = /^@charset\s+["']([\w.:-]+)["']/i.exec(head)?.[1] ?? '';
	}
	try {
		return new TextDecoder(charset || 'utf-8').decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

/** 读响应体，超过上限就断开。 */
async function readLimited(res, maxBytes) {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel();
		throw new Error(`太大（${declared} 字节）`);
	}
	const reader = res.body?.getReader();
	if (!reader) return new Uint8Array(await res.arrayBuffer());
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`太大（超过 ${maxBytes} 字节）`);
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

async function fetchBytes(url, { fetchImpl, userAgent, referer, timeoutMs, maxBytes, accept }) {
	const res = await fetchImpl(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			...(userAgent ? { 'user-agent': userAgent } : {}),
			...(referer ? { referer } : {}),
			accept,
		},
	});
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`HTTP ${res.status}`);
	}
	return { bytes: await readLimited(res, maxBytes), type: res.headers.get('content-type') ?? '' };
}

/**
 * 页面给的样式表清单 → 一整段 CSS（@import 展开、url() 补全、print 样式扔掉、重复的只留一份）。
 * 抓不到的样式表跳过，记进 warnings；页面里读到过 cssRules 的用那份兜底。
 */
export async function collectCss(sheets, options = {}) {
	const warnings = [];
	const seen = new Set();
	let total = 0;
	let count = 0;
	const deadline = Date.now() + (options.budgetMs ?? CSS_BUDGET_MS);
	const fetchOpts = {
		fetchImpl: options.fetchImpl ?? globalThis.fetch,
		userAgent: options.userAgent,
		referer: options.referer,
		timeoutMs: options.timeoutMs ?? 15_000,
		maxBytes: MAX_SHEET_BYTES,
		accept: 'text/css,*/*;q=0.1',
	};

	const wrapMedia = (css, media) => {
		const m = String(media ?? '').trim();
		if (!m || /^(all|screen)$/i.test(m)) return css;
		if (/^(only\s+)?print\b/i.test(m) && !m.includes(',')) return '';
		return `@media ${m}{${css}}`;
	};

	// 展开一段 CSS 里的 @import：被引的那份按它自己的地址补全 url()，再顶替那句 @import
	const expand = async (text, base, depth) => {
		let css = absolutizeCssUrls(text, base);
		for (const imp of findImports(text)) {
			let inner = '';
			let url = '';
			try {
				url = new URL(imp.url, base).toString();
			} catch {
				// 地址拼不出来，这句 @import 去掉
			}
			if (url && /^https?:/i.test(url) && depth < MAX_IMPORT_DEPTH && count < MAX_SHEETS && !seen.has(url) && Date.now() < deadline) {
				seen.add(url);
				count += 1;
				try {
					const { bytes, type } = await fetchBytes(url, fetchOpts);
					total += bytes.byteLength;
					if (total > MAX_TOTAL_CSS_BYTES) throw new Error('样式总量超过上限');
					inner = wrapMedia(await expand(decodeCss(bytes, type), url, depth + 1), imp.media);
				} catch (err) {
					warnings.push(`样式表 ${url} 没抓到（${err.message}）`);
				}
			}
			// findImports 拿到的是去过注释的那句，原文里可能夹着注释对不上；对不上就保留原句，
			// 浏览器打开时自己去拉
			const absolute = absolutizeCssUrls(imp.text, base);
			css = css.includes(`${absolute};`) ? css.replace(`${absolute};`, () => inner) : css;
		}
		return css;
	};

	const parts = [];
	for (const sheet of sheets ?? []) {
		if (count >= MAX_SHEETS) {
			warnings.push(`样式表超过 ${MAX_SHEETS} 个，后面的没收`);
			break;
		}
		count += 1;
		let css = '';
		if (sheet.href) {
			if (seen.has(sheet.href)) continue;
			seen.add(sheet.href);
			try {
				if (Date.now() >= deadline) throw new Error('抓样式表超过总时限');
				const { bytes, type } = await fetchBytes(sheet.href, fetchOpts);
				total += bytes.byteLength;
				if (total > MAX_TOTAL_CSS_BYTES) throw new Error('样式总量超过上限');
				css = await expand(decodeCss(bytes, type), sheet.href, 1);
			} catch (err) {
				if (sheet.fallback) css = absolutizeCssUrls(sheet.fallback, sheet.href);
				else warnings.push(`样式表 ${sheet.href} 没抓到（${err.message}）`);
			}
		} else if (sheet.text) {
			// 内联样式表一模一样的（同一个组件渲染了几次）只留一份
			const key = `inline:${sheet.text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			total += sheet.text.length;
			css = await expand(sheet.text, sheet.base, 1);
		}
		const wrapped = wrapMedia(css, sheet.media);
		if (wrapped.trim()) parts.push(wrapped);
	}
	return { css: parts.join('\n'), warnings };
}

/** 文档里的元素有没有命中这个选择器。引擎不认识的写法返回 null（当命中留着）。 */
function selectorMatcher(doc) {
	const cache = new Map();
	return (selector) => {
		// :host 只在 shadow DOM 里生效，存下来的是普通文档，一条也命中不了
		if (/(^|[\s>+~(,]):host\b/.test(selector)) return false;
		const key = matchableSelector(selector);
		if (cache.has(key)) return cache.get(key);
		let hit;
		try {
			hit = doc.querySelector(key) !== null;
		} catch {
			hit = null;
		}
		cache.set(key, hit);
		return hit;
	};
}

/**
 * 下载图片，返回 原地址 → 新地址 的对照表。失败的不在表里（HTML 里留远程地址）。
 * 给了 upload 就传到图床，新地址是图床给的；给了 dir 就存成文件，新地址是 href 下的相对路径；
 * embed 为真就不落盘，新地址是 data: URI。
 */
async function downloadAssets(urls, { dir, href, embed = false, upload, referer, fetchImpl, userAgent, timeoutMs }) {
	const map = new Map();
	const warnings = [];
	let embedded = 0;
	const list = Array.from(new Set(urls)).filter((u) => /^https?:\/\//i.test(u));
	if (list.length > MAX_ASSETS) warnings.push(`图片超过 ${MAX_ASSETS} 张，后面的留远程地址`);
	const queue = list.slice(0, MAX_ASSETS);
	let made = false;
	const worker = async () => {
		for (;;) {
			const url = queue.shift();
			if (!url) return;
			try {
				const { bytes, type } = await fetchBytes(url, {
					fetchImpl,
					userAgent,
					referer,
					timeoutMs: timeoutMs ?? 30_000,
					maxBytes: embed ? MAX_EMBED_BYTES : MAX_ASSET_BYTES,
					accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
				});
				const mime = type.split(';')[0].trim().toLowerCase();
				const ext = IMAGE_EXT[mime];
				// 不是图片（防盗链给的 HTML 报错页、418 的那几个字节）就别存
				if (!ext) throw new Error(`不是图片（${mime || '没有类型'}）`);
				if (upload) {
					const remote = await upload(bytes, { mime, ext, url });
					if (!/^https?:\/\//i.test(String(remote ?? ''))) throw new Error('图床没给回地址');
					map.set(url, remote);
					continue;
				}
				if (embed) {
					if (embedded + bytes.byteLength > MAX_EMBED_TOTAL) throw new Error('塞进 HTML 的图片总量超过上限');
					embedded += bytes.byteLength;
					map.set(url, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
					continue;
				}
				const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`;
				if (!made) {
					mkdirSync(dir, { recursive: true });
					made = true;
				}
				writeFileSync(join(dir, name), bytes);
				map.set(url, `${href.replace(/\/+$/, '')}/${name}`);
			} catch (err) {
				warnings.push(`图片 ${url} 没存下来（${err.message}）`);
			}
		}
	};
	await Promise.all(Array.from({ length: ASSET_CONCURRENCY }, worker));
	return { map, warnings };
}

// url() 里的字体不下载（跨域字体要 CORS，存到本地反而能用，但一套字体几 MB，不值）
const FONT_EXT = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i;
const CSS_URL = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi;

/** CSS 文字里引用的图片地址（绝对地址，不含字体）。 */
function cssImageUrls(text) {
	return Array.from(String(text ?? '').matchAll(CSS_URL), (m) => m[2]).filter((url) => !FONT_EXT.test(url));
}

/** CSS 里存到本地的那些地址换成相对路径。 */
function replaceCssUrls(text, map) {
	return String(text ?? '').replace(CSS_URL, (whole, quote, url) => {
		const local = map.get(url);
		return local ? `url(${quote}${local}${quote})` : whole;
	});
}

/** 正文里引用到的图片地址：<img src / srcset>、<source srcset>、<video poster>。 */
function imageUrls(doc) {
	const urls = [];
	for (const img of Array.from(doc.querySelectorAll('img[src]'))) urls.push(img.getAttribute('src'));
	for (const el of Array.from(doc.querySelectorAll('video[poster]'))) urls.push(el.getAttribute('poster'));
	return urls.filter(Boolean);
}

/**
 * 页面侧材料 → 完整的 HTML 文件。
 * @param {ReturnType<import('./snapshot.js').snapshotDocument>} snap
 * @param {{userAgent?: string, timeoutMs?: number, fetchImpl?: typeof fetch,
 *   assetsDir?: string, assetsHref?: string, embedImages?: boolean,
 *   uploadImage?: (bytes: Uint8Array, info: {mime: string, ext: string, url: string}) => Promise<string>,
 *   now?: Date}} [options]
 *   assetsDir：图片下载到这个目录；assetsHref：HTML 里引用它们用的相对路径；
 *   embedImages：图片塞进 HTML；uploadImage：图片转存到图床，返回图床上的地址（见 ./image-host.js）。
 *   三个给一个就行，同时给了按 uploadImage、assetsDir、embedImages 的顺序取第一个
 * @returns {Promise<{html: string, warnings: string[], stats: object}>}
 */
export async function buildStyledHtml(snap, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const rule = ruleFor(snap.url);
	// 图片和样式表都按原页面的身份去要：防盗链看 Referer（微博要 weibo.com 的）
	const referer = rule?.imageReferer || snap.url;
	const { css: rawCss, warnings: cssWarnings } = await collectCss(snap.sheets, {
		fetchImpl,
		userAgent: options.userAgent,
		referer: snap.url,
		timeoutMs: options.timeoutMs,
	});
	// 页面那边说的话（评论加载到哪了）排在前面
	const warnings = [...(snap.notes ?? []), ...cssWarnings];

	// 拿最终那棵树来判断规则命中没有：<html> 的属性（主题类名）也算进去
	const attrs = Object.entries(snap.htmlAttrs ?? {})
		.filter(([name]) => /^[\w:-]+$/.test(name))
		.map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
		.join('');
	const { document: doc } = parseHTML(`<!DOCTYPE html><html${attrs}><head></head>${snap.body}</html>`);

	const inlineStyles = Array.from(doc.querySelectorAll('[style]'))
		.map((el) => el.getAttribute('style'))
		.join('\n');
	let css = shrinkCss(rawCss, selectorMatcher(doc), inlineStyles);

	let assetStats = null;
	const upload = typeof options.uploadImage === 'function' ? options.uploadImage : null;
	if (upload || options.assetsDir || options.embedImages) {
		const styled = Array.from(doc.querySelectorAll('[style]'));
		const cssImages = [css, ...styled.map((el) => el.getAttribute('style'))].flatMap(cssImageUrls);
		const { map, warnings: assetWarnings } = await downloadAssets([...imageUrls(doc), ...cssImages], {
			upload,
			dir: options.assetsDir,
			href: options.assetsHref ?? options.assetsDir ?? '',
			embed: !upload && !options.assetsDir && options.embedImages === true,
			referer,
			fetchImpl,
			userAgent: options.userAgent,
			timeoutMs: options.timeoutMs,
		});
		warnings.push(...assetWarnings);
		for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
			const local = map.get(img.getAttribute('src'));
			if (!local) continue;
			img.setAttribute('src', local);
			// srcset 里是别的尺寸的远程地址，浏览器会优先挑它，本地那张就白存了
			img.removeAttribute('srcset');
			img.removeAttribute('sizes');
		}
		for (const el of Array.from(doc.querySelectorAll('picture source[srcset]'))) el.remove();
		for (const el of Array.from(doc.querySelectorAll('video[poster]'))) {
			const local = map.get(el.getAttribute('poster'));
			if (local) el.setAttribute('poster', local);
		}
		// CSS 里的背景图、图标 sprite（豆瓣首页的 logo、导航都是背景图）
		css = replaceCssUrls(css, map);
		for (const el of styled) el.setAttribute('style', replaceCssUrls(el.getAttribute('style'), map));
		assetStats = { saved: map.size };
	}

	const carousels = Array.from(doc.querySelectorAll(`.${SNAPSHOT_CAROUSEL_CLASS} > .swiper-wrapper`));
	const maxSlides = Math.max(0, ...carousels.map((el) => el.children.length));

	const head = [
		'<meta charset="utf-8">',
		// 正文里的脚本已经删干净了，这一行是保险：漏网的事件属性、javascript: 地址也跑不起来
		`<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`,
		// 不带 Referer：多数图床认「没有 Referer」放行，认「别的站的 Referer」拒绝
		'<meta name="referrer" content="no-referrer">',
		snap.viewport ? `<meta name="viewport" content="${escapeHtml(snap.viewport)}">` : '',
		`<title>${escapeHtml(snap.title)}</title>`,
		snap.url ? `<link rel="canonical" href="${escapeHtml(snap.url)}">` : '',
		snap.title ? `<meta property="og:title" content="${escapeHtml(snap.title)}">` : '',
		snap.siteName ? `<meta property="og:site_name" content="${escapeHtml(snap.siteName)}">` : '',
		snap.author ? `<meta name="author" content="${escapeHtml(snap.author)}">` : '',
		snap.publishedAt ? `<meta property="article:published_time" content="${escapeHtml(snap.publishedAt)}">` : '',
		'<meta name="generator" content="web-extract">',
		// </style 出现在 CSS 里会提前把 <style> 关掉，后面的东西就成了 HTML
		css ? `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>` : '',
		snap.mode === 'article' ? `<style>${FIX_CSS}</style>` : '',
		maxSlides ? `<style>${carouselCss(maxSlides)}</style>` : '',
	].filter(Boolean).join('\n');

	const saved = (options.now ?? new Date()).toISOString();
	const html = [
		'<!DOCTYPE html>',
		`<!-- saved by web-extract from ${String(snap.url).replace(/--/g, '%2D%2D')} at ${saved} -->`,
		`<html${attrs}>`,
		`<head>\n${head}\n</head>`,
		doc.body.outerHTML,
		'</html>',
		'',
	].join('\n');

	return {
		html,
		warnings,
		stats: {
			cssBefore: rawCss.length,
			cssAfter: css.length,
			bytes: Buffer.byteLength(html),
			...(assetStats ?? {}),
		},
	};
}
