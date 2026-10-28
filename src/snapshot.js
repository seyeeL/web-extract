// 带样式的 HTML（--html）在页面这一侧要做的事：要存的那棵 <body>，加上页面用到的样式表清单。
//
// 两种存法：
// - 整页（默认）：<body> 整个拷一份，只去掉广告、脚本和看不见的元素。站点的导航、侧栏、
//   评论区都在，长得和原页面一样
// - 只存正文（articleOnly）：正文 + 祖先骨架。正文离开原来的祖先，`.article .post p` 这种
//   后代选择器就全落空了，样式也就没了，所以把正文到 <body> 之间的每一层祖先浅拷贝一份
//   （只留标签和属性，不要兄弟节点）套回去，站点 CSS 照旧命中
//
// 样式表在这里只收清单，不在页面里拉：跨域的 <link> 读不到 cssRules，fetch 又受 CORS 管，
// 交给 Node 那边去抓、去裁。CSS-in-JS 用 insertRule 塞进去的规则在 <style> 的文字里看不到，
// 只能从 cssRules 读出来。
//
// 浏览器模式会把这个文件和 extract.js 等拼成一段脚本注进页面，import 只能写单行，
// 顶层名字不能和那几个文件撞。

import { baseUrlFor, extractArticle } from './extract.js';
import { adSelectorsFor, ruleFor } from './site-rules.js';

// 骨架上每一层祖先都挂这个属性：Node 那边按它压掉固定高度、overflow:hidden，
// 不然 SPA 的「整屏高 + 内部滚动」布局会把正文截掉
export const SNAPSHOT_CHAIN_ATTR = 'data-web-extract-chain';
// 祖先在页面上是 position: fixed / sticky 的（知识星球的主题详情是个浮层）
export const SNAPSHOT_FIXED_ATTR = 'data-web-extract-fixed';
// 正文上面那行「标题 / 作者 · 时间 · 原文」的类名
export const SNAPSHOT_META_CLASS = 'web-extract-meta';
// 换成纯 CSS 轮播的图片轮播（Swiper）挂这个类名，Node 那边看到它才补轮播的样式
export const SNAPSHOT_CAROUSEL_CLASS = 'web-extract-carousel';

// 懒加载图片放真地址的属性，和 html2md 认的一样
const SNAP_LAZY_SRC = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src'];
const SNAP_LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
// 页面上的地址属性，离开原站要补成绝对地址
const SNAP_URL_ATTRS = { a: ['href'], img: ['src'], video: ['poster', 'src'], source: ['src'], audio: ['src'] };
const SNAP_HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SNAP_MEDIA_TAGS = new Set(['img', 'video', 'audio', 'source']);
// 出处那一行能直接塞进去当第一个孩子的容器（ul、table、p 里塞个 div 就坏了）
const SNAP_FLOW_TAGS = new Set(['DIV', 'ARTICLE', 'MAIN', 'SECTION', 'BODY']);
// 能执行脚本、嵌别的页面的东西，存下来的页面里都不留
const SNAP_UNSAFE_TAGS = 'script,noscript,iframe,frame,frameset,object,embed,applet,base,meta,link,template,portal';
// 只存正文时连表单一起删（正文里的表单是噪声）；整页存时表单是页面长相的一部分，
// 留着但去掉提交地址（头上的 CSP 也禁了提交）
const SNAP_FORM_ATTRS = ['action', 'method', 'target'];

// 广告：class / id 里有这些词（按 - _ 空格切开的整词，不会误中 header、download 这类）
const SNAP_AD_WORDS = /(^|[\s_-])(ad|ads|adv|advert|adverts|advertisement|advertising|adsbygoogle|adslot|adbox|adunit|adwrap|adcontainer|sponsor|sponsored|sponsorship)([\s_-]|$)/i;
// 广告联盟的固定写法
const SNAP_AD_SELECTORS = 'ins.adsbygoogle,[id^="div-gpt-ad"],[id^="google_ads"],[data-ad-slot],[data-ad-client],[data-ad-unit],amp-ad,amp-embed';
const SNAP_SVG_NS = 'http://www.w3.org/2000/svg';

function snapAbsolute(value, base) {
	const raw = String(value ?? '').trim();
	if (!raw || raw.startsWith('#') || SNAP_HAS_SCHEME.test(raw) || !/^https?:\/\//i.test(base)) return raw;
	try {
		return new URL(raw, base).toString();
	} catch {
		return raw;
	}
}

/** srcset 里每一项的地址补成绝对地址（「a.jpg 1x, b.jpg 2x」）。 */
function snapSrcset(value, base) {
	return String(value ?? '')
		.split(/,\s+/)
		.map((item) => {
			const [url, ...rest] = item.trim().split(/\s+/);
			return [snapAbsolute(url, base), ...rest].join(' ');
		})
		.join(', ');
}

/** 行内 style 里的 url(...) 补成绝对地址。 */
export function snapStyleUrls(css, base) {
	return String(css ?? '').replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, quote, url) => {
		const next = snapAbsolute(url, base);
		return next === url ? whole : `url(${quote}${next}${quote})`;
	});
}

function snapIsPlaceholder(src) {
	const value = String(src ?? '').trim();
	return !value || value.startsWith('data:') || value === 'about:blank';
}

/**
 * 正文和骨架过一遍：去掉能跑脚本的东西，补全地址，懒加载图片换成真地址。
 * 就地改，node 是克隆体，不会碰到页面本身。
 */
export function snapSanitize(node, base, { keepForms = false } = {}) {
	for (const el of Array.from(node.querySelectorAll(keepForms ? SNAP_UNSAFE_TAGS : `${SNAP_UNSAFE_TAGS},form`))) el.remove();
	if (keepForms) {
		for (const form of Array.from(node.querySelectorAll('form'))) {
			for (const name of SNAP_FORM_ATTRS) form.removeAttribute(name);
		}
	}
	const elements = [node, ...Array.from(node.querySelectorAll('*'))];
	for (const el of elements) {
		for (const name of el.getAttributeNames?.() ?? []) {
			const lower = name.toLowerCase();
			const value = el.getAttribute(name) ?? '';
			// onclick / onload 这类事件属性；href="javascript:…"（含 SVG 的 xlink:href）
			if (lower.startsWith('on')) el.removeAttribute(name);
			else if (/(^|:)(href|src|action|formaction|xlink:href)$/.test(lower) && /^\s*(javascript|vbscript):/i.test(value)) {
				el.removeAttribute(name);
			} else if (lower === 'style' && value.includes('url(')) {
				el.setAttribute(name, snapStyleUrls(value, base));
			}
		}
		const tag = el.nodeName.toLowerCase();
		// crossorigin 让浏览器按 CORS 去要图：小红书的图都带着它，xhscdn 回 Access-Control-Allow-Origin
		// 所以原页面没事；可图片转存到自己的 OSS（没配 CORS）后就全裂了。它只对脚本读像素有用，
		// 存下来的页面不跑脚本，去掉
		if (SNAP_MEDIA_TAGS.has(tag)) el.removeAttribute('crossorigin');
		for (const name of SNAP_URL_ATTRS[tag] ?? []) {
			const value = el.getAttribute(name);
			if (value) el.setAttribute(name, snapAbsolute(value, base));
		}
		if (tag === 'img') {
			if (snapIsPlaceholder(el.getAttribute('src'))) {
				const lazy = SNAP_LAZY_SRC.map((name) => el.getAttribute(name)).find((v) => v && !snapIsPlaceholder(v));
				if (lazy) el.setAttribute('src', snapAbsolute(lazy, base));
			}
			const lazySet = SNAP_LAZY_SRCSET.map((name) => el.getAttribute(name)).find(Boolean);
			if (lazySet && !el.getAttribute('srcset')) el.setAttribute('srcset', lazySet);
		}
		if ((tag === 'img' || tag === 'source') && el.getAttribute('srcset')) {
			el.setAttribute('srcset', snapSrcset(el.getAttribute('srcset'), base));
		}
	}
	// HTML 注释：体积，也可能夹着条件注释
	const comments = [];
	const walk = (parent) => {
		for (const child of Array.from(parent.childNodes ?? [])) {
			if (child.nodeType === 8) comments.push(child);
			else if (child.nodeType === 1) walk(child);
		}
	};
	walk(node);
	for (const comment of comments) comment.remove();
	return node;
}

/** 一个样式表对象的规则文字。跨域读不到时返回 null。 */
function snapSheetRules(sheet) {
	try {
		const rules = sheet?.cssRules;
		if (!rules) return null;
		return Array.from(rules).map((rule) => rule.cssText).join('\n');
	} catch {
		return null;
	}
}

/**
 * 页面上的样式表，按文档顺序：
 * - `<link rel=stylesheet>` 给地址，Node 那边去抓原文（读 cssRules 再拼回去会丢掉浏览器
 *   不认识的写法，比如别的浏览器的私有前缀）；页面里读得到 cssRules 的顺手带上，抓不到时兜底
 * - `<style>` 给文字；文字是空的但 cssRules 有东西，就是 CSS-in-JS 用 insertRule 塞的，读 cssRules
 * - adoptedStyleSheets 只能读 cssRules
 */
export function snapStylesheets(doc, base) {
	const sheets = [];
	for (const el of Array.from(doc.querySelectorAll('link[rel], style'))) {
		if (el.closest?.('svg')) continue;
		const media = (el.getAttribute('media') ?? '').trim();
		if (el.nodeName === 'LINK') {
			const rel = ` ${(el.getAttribute('rel') ?? '').toLowerCase()} `;
			// 备选样式表（rel="alternate stylesheet"）默认不生效
			if (!rel.includes(' stylesheet ') || rel.includes(' alternate ') || el.hasAttribute('disabled')) continue;
			const href = snapAbsolute(el.getAttribute('href'), base);
			if (!/^https?:\/\//i.test(href)) continue;
			sheets.push({ href, media, fallback: snapSheetRules(el.sheet) });
		} else {
			const text = el.textContent ?? '';
			const rules = text.trim() ? null : snapSheetRules(el.sheet);
			if (text.trim() || rules) sheets.push({ text: text.trim() ? text : rules, base, media });
		}
	}
	for (const sheet of Array.from(doc.adoptedStyleSheets ?? [])) {
		const text = snapSheetRules(sheet);
		if (text) sheets.push({ text, base, media: '' });
	}
	return sheets;
}

/** 元素的属性表（给 <html> 用：lang、class、主题这类 data-*，站点 CSS 常挂在上面）。 */
function snapAttrs(el) {
	const out = {};
	for (const name of el?.getAttributeNames?.() ?? []) {
		if (name.toLowerCase().startsWith('on')) continue;
		out[name] = el.getAttribute(name) ?? '';
	}
	return out;
}

/** 浏览器里看得到计算样式时，标出 fixed / sticky 的祖先。linkedom 里没有，跳过。 */
function snapIsFixed(el) {
	try {
		const view = el.ownerDocument?.defaultView;
		if (!view?.getComputedStyle) return false;
		return /^(fixed|sticky)$/.test(view.getComputedStyle(el).position);
	} catch {
		return false;
	}
}

/**
 * 祖先的浅拷贝。<form> 这类会被 snapSanitize 整棵删掉的标签换成 <div>（ASP.NET 的页面
 * 整个 body 都包在一个 <form> 里，原样留着正文会跟着一起没）。
 */
function snapShell(doc, el) {
	if (!el.matches?.(`${SNAP_UNSAFE_TAGS},form`)) return el.cloneNode(false);
	const div = doc.createElement('div');
	for (const [name, value] of Object.entries(snapAttrs(el))) div.setAttribute(name, value);
	return div;
}

/**
 * 正文里 <use href="#icon-x"> 引用的 SVG 图标定义（sprite）在页面别处，不在正文里，
 * 原样存下来图标就是空的。按 id 把被引用的那几个找出来，装进一个不显示的 <svg> 带上。
 */
function snapSvgSprites(doc, body) {
	const ids = new Set();
	for (const use of Array.from(body.querySelectorAll('use'))) {
		const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
		if (ref.startsWith('#') && ref.length > 1) ids.add(ref.slice(1));
	}
	const defs = [];
	for (const id of ids) {
		if (body.querySelector(`[id="${id.replace(/["\\]/g, '')}"]`)) continue;
		const found = doc.getElementById?.(id);
		if (found) defs.push(found.cloneNode(true));
	}
	if (!defs.length) return;
	const holder = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	holder.setAttribute('style', 'display:none');
	holder.setAttribute('aria-hidden', 'true');
	for (const def of defs) holder.appendChild(def);
	body.appendChild(holder);
}

function snapText(el) {
	return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 正文上面的一行出处：作者 · 时间 · 原文链接，正文里没有标题时再加一个标题。
 * 站点规则为了 markdown 干净，常把作者、时间、头像从正文里删掉（它们另有字段）；
 * 可存下来的 HTML 只有正文，不补上就不知道是谁、什么时候写的。
 * 放在骨架最里层、正文前面，字体颜色跟着站点走。
 *
 * 标题是拿正文开头凑的（微博、豆瓣广播、推文）就不加，不然正文开头读两遍。
 */
function snapMetaBlock(doc, article, root) {
	const box = doc.createElement('div');
	box.setAttribute('class', SNAPSHOT_META_CLASS);
	const title = String(article.title ?? '').trim();
	const fromBody = ruleFor(article.url)?.titleFromBody === true;
	const headings = root ? Array.from(root.querySelectorAll('h1,h2')) : [];
	const hasTitle = headings.some((h) => {
		const text = snapText(h);
		return text && (title.includes(text) || text.includes(title));
	});
	if (title && !fromBody && !hasTitle) {
		const h1 = doc.createElement('h1');
		h1.appendChild(doc.createTextNode(title));
		box.appendChild(h1);
	}
	const line = doc.createElement('p');
	const bits = [article.author, article.publishedAt].map((v) => String(v ?? '').trim()).filter(Boolean);
	if (bits.length) line.appendChild(doc.createTextNode(bits.join(' · ')));
	if (/^https?:\/\//i.test(article.url ?? '')) {
		if (bits.length) line.appendChild(doc.createTextNode(' · '));
		const link = doc.createElement('a');
		link.setAttribute('href', article.url);
		link.appendChild(doc.createTextNode(article.siteName || '原文'));
		line.appendChild(link);
	}
	if (line.childNodes.length) box.appendChild(line);
	return box.childNodes.length ? box : null;
}

/**
 * 把清洗过的正文套回祖先骨架。anchor 是正文在页面上的位置：
 * - 不是拼出来的（wrapped 为假）：anchor 就是正文那个元素，正文顶替它，骨架从它父节点往上搭
 * - 拼出来的：anchor 是那几块的共同祖先，拼好的容器放进它的浅拷贝里
 * 返回 <body> 的浅拷贝（已经套好）。定位不出来就只有 <body> 一层。
 */
export function snapSkeleton(doc, article) {
	const body = doc.body ?? doc.documentElement;
	// 默认规则什么都没认出来时正文就是整个 <body>：它自己就是最外层，不用再套
	if (article.root?.nodeName === 'BODY') {
		const meta = snapMetaBlock(doc, article, article.root);
		if (meta) article.root.insertBefore(meta, article.root.firstChild);
		article.root.setAttribute(SNAPSHOT_CHAIN_ATTR, '');
		return article.root;
	}
	let chain = [];
	let node = article.wrapped ? article.anchor : article.anchor?.parentElement;
	while (node && node !== body && node !== doc.documentElement) {
		chain.push(node);
		node = node.parentElement;
	}
	// anchor 不在 body 里（定位失败、或者本身就是 body）
	if (node !== body) chain = [];
	let inner = article.root;
	const meta = snapMetaBlock(doc, article, article.root);
	if (meta && inner) {
		// 出处放进正文容器里当第一个孩子：宽度、内边距跟着正文走。放在正文外面的话，
		// 正文容器的父节点常是整屏宽的，或者是 flex 横排（公众号），出处会跑到左边去
		if (SNAP_FLOW_TAGS.has(inner.nodeName)) {
			// 往里走到正文真正排版的那层：限宽、留白常常挂在里面几层（少数派是
			// article > .article-body > … > .article__main__content）。每层挑文字最多的孩子，
			// 它占了九成以上的字才往下走，正文分散在几个孩子里就停在这层
			let box = inner;
			for (let depth = 0; depth < 12; depth += 1) {
				const total = snapText(box).length;
				const kids = Array.from(box.children ?? []).filter((kid) => SNAP_FLOW_TAGS.has(kid.nodeName));
				const best = kids.reduce((a, b) => (snapText(b).length > snapText(a).length ? b : a), kids[0]);
				if (!best || !total || snapText(best).length < total * 0.9) break;
				// 标题在这一层别的孩子里（overreacted 的 h1 和日期在正文块外面）就停：
				// 再往里走出处会跑到标题下面去
				const others = Array.from(box.children ?? []).filter((kid) => kid !== best);
				if (others.some((kid) => kid.nodeName === 'H1' || kid.querySelector?.('h1'))) break;
				box = best;
			}
			box.insertBefore(meta, box.firstChild);
		} else {
			const pair = doc.createDocumentFragment();
			pair.appendChild(meta);
			pair.appendChild(inner);
			inner = pair;
		}
	}
	for (const el of chain) {
		const shell = snapShell(doc, el);
		shell.setAttribute(SNAPSHOT_CHAIN_ATTR, '');
		if (snapIsFixed(el)) shell.setAttribute(SNAPSHOT_FIXED_ATTR, '');
		if (inner) shell.appendChild(inner);
		inner = shell;
	}
	const bodyShell = body ? body.cloneNode(false) : doc.createElement('body');
	bodyShell.setAttribute(SNAPSHOT_CHAIN_ATTR, '');
	if (inner) bodyShell.appendChild(inner);
	return bodyShell;
}

/** 是不是广告：class / id 里有广告词，或者是广告联盟的固定写法。 */
function snapIsAd(el, extra) {
	if (el.matches?.(SNAP_AD_SELECTORS)) return true;
	if (extra && el.matches?.(extra)) return true;
	const cls = el.getAttribute?.('class') ?? '';
	return SNAP_AD_WORDS.test(`${typeof cls === 'string' ? cls : ''} ${el.getAttribute?.('id') ?? ''}`);
}

/**
 * 页面和克隆体结构一样，两边一起往下走，在浏览器里（看得到计算样式时）收两样东西：
 * - display: none 的元素（SingleFile 的 remove-hidden-elements）：折叠的菜单、没弹出来的
 *   登录框、各种占位，存下来也看不见。<svg> 整棵不碰（图标 sprite 本来就是 display:none，
 *   删了图标就空了）
 * - <iframe> 在页面上实际占多大，换占位块时照这个尺寸
 * linkedom 里没有计算样式，什么也不收。
 */
function snapWalkLive(live, clone) {
	const view = live.ownerDocument?.defaultView;
	const hidden = [];
	const frames = new Map();
	if (!view?.getComputedStyle) return { hidden, frames };
	const walk = (a, b) => {
		const liveKids = Array.from(a.children ?? []);
		const cloneKids = Array.from(b.children ?? []);
		for (let i = 0; i < liveKids.length && i < cloneKids.length; i += 1) {
			const el = liveKids[i];
			if (el.namespaceURI === SNAP_SVG_NS) continue;
			let display = '';
			try {
				display = view.getComputedStyle(el).display;
			} catch {
				display = '';
			}
			if (display === 'none') {
				hidden.push(cloneKids[i]);
				continue;
			}
			if (el.nodeName === 'IFRAME') {
				const box = el.getBoundingClientRect?.();
				if (box?.width && box?.height) frames.set(cloneKids[i], [Math.round(box.width), Math.round(box.height)]);
			}
			walk(el, cloneKids[i]);
		}
	};
	walk(live, clone);
	return { hidden, frames };
}

/**
 * <iframe> 换成一样大的空块。iframe 本身不能留（能跑别人的页面），可直接删的话靠它撑起来的
 * 版面会塌：豆瓣首页那一大块背景图的高度就是右边登录框 iframe 撑的，删了整块缩成一条。
 * 尺寸优先用浏览器里量到的，其次 width / height 属性，都没有按 iframe 默认的 300×150。
 */
function snapFramePlaceholders(doc, clone, measured) {
	for (const frame of Array.from(clone.querySelectorAll('iframe,frame,embed,object'))) {
		const size = measured.get(frame);
		const attr = (name, fallback) => {
			const value = String(frame.getAttribute(name) ?? '').trim();
			if (/^\d+$/.test(value)) return `${value}px`;
			return /^\d+(\.\d+)?(px|%|em|rem|vw|vh)$/.test(value) ? value : fallback;
		};
		const width = size ? `${size[0]}px` : attr('width', '300px');
		const height = size ? `${size[1]}px` : attr('height', '150px');
		const box = doc.createElement('div');
		for (const name of ['id', 'class']) {
			const value = frame.getAttribute(name);
			if (value) box.setAttribute(name, value);
		}
		box.setAttribute('data-web-extract-frame', '');
		box.setAttribute('style', `${frame.getAttribute('style') ?? ''};display:inline-block;width:${width};height:${height};max-width:100%;vertical-align:top`);
		frame.replaceWith(box);
	}
}

/**
 * 整页存：<body> 整个拷一份，去掉看不见的元素和广告。规则的 prepare 也跑一遍
 * （豆瓣广播的配图在静态 HTML 里只是脚本里的 JSON，脚本马上要删）。
 */
export function snapFullBody(doc, rule, url = '') {
	const live = doc.body ?? doc.documentElement;
	const clone = live.cloneNode(true);
	const { hidden, frames } = snapWalkLive(live, clone);
	for (const el of hidden) el.remove();
	if (typeof rule?.prepare === 'function') {
		try {
			rule.prepare(clone);
		} catch {
			// 补不出来就当没有
		}
	}
	const extra = adSelectorsFor(url).join(',');
	for (const el of Array.from(clone.querySelectorAll('[class],[id],ins,amp-ad,amp-embed,[data-ad-slot],[data-ad-client],[data-ad-unit]'))) {
		// 外层已经当广告删掉了的，里面的不用再看
		if (!clone.contains(el)) continue;
		if (snapIsAd(el, extra)) el.remove();
	}
	// 放在删广告之后：广告位的 iframe 连同外面那层一起没了，不用占位
	snapFramePlaceholders(doc, clone, frames);
	return clone;
}

/**
 * 图片轮播（Swiper）换成不用 JS 也能翻的版本。存下来的页面不许跑脚本（头上有 CSP），
 * 原来那套靠 JS 挪 transform，只能停在当时那一张。
 *
 * 做法是单选框 + label：每张图前面放一个隐藏的 radio，左右箭头和圆点都是指向别的 radio 的
 * label，点了就切过去；Node 那边补的 CSS 按「第 k 个 radio 没选中 → 第 k 张藏起来」显示当前那张。
 * 箭头、页码、圆点放进每一张里，跟着那张一起显示，不用再按序号写规则。
 *
 * loop 模式首尾复制出来的那几张（swiper-slide-duplicate）去掉，按 data-swiper-slide-index 排回原顺序。
 * 站点自己的箭头、页码要 JS 才动，在规则的 styledDrop 里删。
 */
export function snapCarousels(doc, body) {
	let n = 0;
	for (const wrapper of Array.from(body.querySelectorAll('.swiper-wrapper'))) {
		const box = wrapper.parentElement;
		if (!box || box.classList?.contains(SNAPSHOT_CAROUSEL_CLASS)) continue;
		const all = Array.from(wrapper.children).filter((el) => el.classList?.contains('swiper-slide'));
		if (!all.length) continue;
		const order = (el) => Number(el.getAttribute('data-swiper-slide-index') ?? NaN);
		// 当前那张：loop 模式下停在复制品上时，按它的序号找回真的那张
		const activeEl = all.find((el) => el.classList.contains('swiper-slide-active'));
		const slides = all.filter((el) => !el.classList.contains('swiper-slide-duplicate'));
		if (slides.every((el) => Number.isFinite(order(el)))) slides.sort((a, b) => order(a) - order(b));
		let active = slides.indexOf(activeEl);
		if (active < 0 && activeEl) active = slides.findIndex((el) => order(el) === order(activeEl));
		if (active < 0) active = 0;

		// 只留真的那几张，transform 去掉（停在哪张由 CSS 管）
		while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
		for (const slide of slides) wrapper.appendChild(slide);
		const style = String(wrapper.getAttribute('style') ?? '')
			.split(';')
			.filter((decl) => decl.trim() && !/^\s*(transform|transition-duration)\s*:/i.test(decl))
			.join(';');
		if (style) wrapper.setAttribute('style', style);
		else wrapper.removeAttribute('style');
		for (const name of ['swiper-button-prev', 'swiper-button-next', 'swiper-pagination', 'swiper-scrollbar']) {
			for (const el of Array.from(box.parentElement?.querySelectorAll(`.${name}`) ?? [])) el.remove();
		}
		if (slides.length < 2) continue;

		n += 1;
		const id = (i) => `web-extract-c${n}-${i + 1}`;
		box.classList.add(SNAPSHOT_CAROUSEL_CLASS);
		const label = (i, cls, text, title) => {
			const el = doc.createElement('label');
			el.setAttribute('for', id(i));
			el.setAttribute('class', cls);
			if (title) el.setAttribute('title', title);
			if (text) el.appendChild(doc.createTextNode(text));
			return el;
		};
		slides.forEach((slide, i) => {
			const radio = doc.createElement('input');
			radio.setAttribute('type', 'radio');
			radio.setAttribute('name', `web-extract-c${n}`);
			radio.setAttribute('id', id(i));
			radio.setAttribute('class', `${SNAPSHOT_CAROUSEL_CLASS}-radio`);
			radio.setAttribute('aria-label', `第 ${i + 1} 张`);
			if (i === active) radio.setAttribute('checked', '');
			box.insertBefore(radio, wrapper);

			slide.classList.add(`${SNAPSHOT_CAROUSEL_CLASS}-slide`);
			// 藏起来的那几张是懒加载的话，点过去才开始下，要白一会儿
			for (const img of Array.from(slide.querySelectorAll('img[loading]'))) img.removeAttribute('loading');
			if (i > 0) slide.appendChild(label(i - 1, `${SNAPSHOT_CAROUSEL_CLASS}-prev`, '‹', '上一张'));
			if (i < slides.length - 1) slide.appendChild(label(i + 1, `${SNAPSHOT_CAROUSEL_CLASS}-next`, '›', '下一张'));
			const count = doc.createElement('span');
			count.setAttribute('class', `${SNAPSHOT_CAROUSEL_CLASS}-count`);
			count.appendChild(doc.createTextNode(`${i + 1}/${slides.length}`));
			slide.appendChild(count);
			const dots = doc.createElement('span');
			dots.setAttribute('class', `${SNAPSHOT_CAROUSEL_CLASS}-dots`);
			slides.forEach((_, j) => dots.appendChild(label(j, j === i ? 'on' : '', '', `第 ${j + 1} 张`)));
			slide.appendChild(dots);
		});
	}
	return n;
}

/** 规则里 styledDrop 点名的元素（站点自己那套要 JS 的控件）删掉。 */
function snapStyledDrop(body, rule) {
	for (const selector of rule?.styledDrop ?? []) {
		try {
			for (const el of Array.from(body.querySelectorAll(selector))) el.remove();
		} catch {
			// 选择器写错了不影响别的
		}
	}
}

/**
 * 取材料之前在活页面上要做的事（规则的 expand）：小红书把评论翻到底、把楼中楼点开。
 * 只在浏览器模式下跑（静态 HTML 里没有能点的东西）。返回一句说明，没做什么返回空串。
 */
export async function snapExpand(doc, url = '', options = {}) {
	const rule = ruleFor(url);
	if (typeof rule?.expand !== 'function') return '';
	try {
		return String((await rule.expand(doc, options)) ?? '');
	} catch (err) {
		return `展开评论时出错，存下已经出来的部分（${err?.message ?? err}）`;
	}
}

/**
 * 带样式 HTML 的页面侧材料：元信息、<html> 的属性、要存的 <body>、样式表清单。
 * 返回的都是字符串和普通对象，能直接 JSON 化从页面里带出来。
 * @param {{withReplies?: boolean, articleOnly?: boolean}} [options] articleOnly：只存正文
 *   （正文 + 祖先骨架），不给就整页存
 */
export function snapshotDocument(doc, url = '', options = {}) {
	const article = extractArticle(doc, url, { withReplies: options.withReplies === true, styled: true });
	// 相对地址按 <base href> 补（知识星球是 <base href="/">，样式表写成 styles-xxx.css）
	const base = baseUrlFor(doc, url || article.url);
	const articleOnly = options.articleOnly === true;
	const rule = ruleFor(article.url);
	const body = articleOnly ? snapSkeleton(doc, article) : snapFullBody(doc, rule, article.url);
	snapStyledDrop(body, rule);
	snapCarousels(doc, body);
	snapSvgSprites(doc, body);
	snapSanitize(body, base, { keepForms: !articleOnly });
	const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
	return {
		mode: articleOnly ? 'article' : 'full',
		url: article.url,
		title: article.title,
		author: article.author,
		publishedAt: article.publishedAt,
		siteName: article.siteName,
		htmlAttrs: snapAttrs(doc.documentElement),
		viewport,
		body: body.outerHTML,
		sheets: snapStylesheets(doc, base),
	};
}
