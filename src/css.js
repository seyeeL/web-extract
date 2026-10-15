// 带样式 HTML 的 CSS 处理：切规则、按正文裁掉用不上的、补全地址、压空白。
//
// 站点的 CSS 动辄几百 KB，正文那一小块用到的往往不到一成。照搬 SingleFile 的几招：
// 删没命中任何元素的规则（remove-unused-styles）、删没被用到的 @font-face 和 @keyframes
// （remove-unused-fonts）、扔掉只给打印用的样式（remove-alternative-medias）、
// 一模一样的样式表只留一份（group-duplicate-stylesheets）。
// 图片、字体不转 base64，地址补成绝对地址留在原处 —— 体积是剪藏能不能存下来的关键。
//
// 不依赖 CSS 解析库：只要切出「选择器 { 声明 }」和 @ 规则的边界，正确处理字符串、
// 注释、转义和嵌套括号就够了，声明本身原样保留。

/** 从 i（引号处）跳到字符串结束之后。换行也结束字符串（CSS 里未闭合的字符串到行尾为止）。 */
function skipString(text, i) {
	const quote = text[i];
	let j = i + 1;
	while (j < text.length) {
		const ch = text[j];
		if (ch === '\\') j += 2;
		else if (ch === quote || ch === '\n') return j + 1;
		else j += 1;
	}
	return j;
}

/** 去掉注释，字符串里的「/*」不动。 */
export function stripCssComments(text) {
	const src = String(text ?? '');
	let out = '';
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			const end = skipString(src, i);
			out += src.slice(i, end);
			i = end;
		} else if (ch === '/' && src[i + 1] === '*') {
			const end = src.indexOf('*/', i + 2);
			i = end < 0 ? src.length : end + 2;
			out += ' ';
		} else if (ch === '\\') {
			out += src.slice(i, i + 2);
			i += 2;
		} else {
			out += ch;
			i += 1;
		}
	}
	return out;
}

/** 从 i（'{' 之后）找到配对的 '}'，返回它的下标；找不到返回文本长度。 */
function matchBrace(text, i) {
	let depth = 1;
	let j = i;
	while (j < text.length) {
		const ch = text[j];
		if (ch === '"' || ch === "'") {
			j = skipString(text, j);
			continue;
		}
		if (ch === '\\') j += 2;
		else {
			if (ch === '{') depth += 1;
			else if (ch === '}' && (depth -= 1) === 0) return j;
			j += 1;
		}
	}
	return text.length;
}

// 里面装的是普通规则、要往里递归裁的 @ 规则
const GROUP_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document', 'scope', 'starting-style']);

/**
 * CSS 文字 → 规则列表：
 * - { type: 'rule', prelude, body }：普通规则，body 是声明原文（可能带原生嵌套）
 * - { type: 'group', name, prelude, items }：@media / @supports 这类，items 是里面的规则
 * - { type: 'at', name, prelude, body }：@font-face / @keyframes 这类带块的
 * - { type: 'stmt', text }：分号结尾的 @import / @charset / @layer a, b;
 * 输入应该已经去过注释。
 */
export function parseCss(text, depth = 0) {
	const src = String(text ?? '');
	const items = [];
	let i = 0;
	while (i < src.length) {
		// 读到 { 或 ; 为止是 prelude；括号里的 ; 不算（url(a;b)、[title=";"]）
		let j = i;
		let parens = 0;
		while (j < src.length) {
			const ch = src[j];
			if (ch === '"' || ch === "'") {
				j = skipString(src, j);
				continue;
			}
			if (ch === '\\') {
				j += 2;
				continue;
			}
			if (ch === '(' || ch === '[') parens += 1;
			else if ((ch === ')' || ch === ']') && parens > 0) parens -= 1;
			else if (parens === 0 && (ch === '{' || ch === ';' || ch === '}')) break;
			j += 1;
		}
		const prelude = src.slice(i, j).trim();
		const stop = src[j];
		if (stop === '{') {
			const end = matchBrace(src, j + 1);
			const body = src.slice(j + 1, end);
			if (prelude.startsWith('@')) {
				const name = (prelude.match(/^@([-\w]+)/)?.[1] ?? '').toLowerCase();
				// 嵌套深度封顶：恶意 CSS 套几万层 @media 会把递归栈打爆
				if (GROUP_AT_RULES.has(name) && depth < 32) {
					items.push({ type: 'group', name, prelude, items: parseCss(body, depth + 1) });
				} else {
					items.push({ type: 'at', name, prelude, body });
				}
			} else if (prelude) {
				items.push({ type: 'rule', prelude, body });
			}
			i = end + 1;
		} else if (stop === ';') {
			if (prelude) items.push({ type: 'stmt', text: prelude });
			i = j + 1;
		} else {
			// 多出来的 }，或者文本到头了
			if (prelude && stop === undefined && prelude.startsWith('@')) items.push({ type: 'stmt', text: prelude });
			i = j + 1;
		}
	}
	return items;
}

/** 按顶层逗号切开（括号、方括号、字符串里的逗号不算）。 */
export function splitSelectors(prelude) {
	const parts = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	const src = String(prelude ?? '');
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			i = skipString(src, i);
			continue;
		}
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '(' || ch === '[') depth += 1;
		else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1;
		else if (ch === ',' && depth === 0) {
			parts.push(src.slice(start, i).trim());
			start = i + 1;
		}
		i += 1;
	}
	parts.push(src.slice(start).trim());
	return parts.filter(Boolean);
}

// 伪元素（::before、::-webkit-scrollbar、::part(x)）和老写法的单冒号伪元素
const PSEUDO_ELEMENTS = /::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)(?![\w-])/gi;
// 带厂商前缀的单冒号伪类（:-webkit-autofill、:-moz-focusring）
const VENDOR_PSEUDO = /:-[\w-]+(?:\([^)]*\))?/g;
// 跟交互状态有关的伪类：存下来的页面上元素一直在，只是此刻没被悬停 / 聚焦
const STATE_PSEUDO = /:(?:hover|active|focus|focus-within|focus-visible|visited|link|any-link|target|target-within|checked|indeterminate|default|disabled|enabled|valid|invalid|in-range|out-of-range|required|optional|read-only|read-write|placeholder-shown|autofill|user-invalid|user-valid|fullscreen|modal|popover-open|open|closed|playing|paused|current|past|future|local-link|defined|blank)(?![\w-])/gi;

/**
 * 选择器里去掉伪元素和状态伪类，剩下的部分拿去 querySelector。
 * `a:hover > span::after` 对应的元素就是 `a > span` 命中的那些。
 */
export function matchableSelector(selector) {
	let out = String(selector ?? '')
		.replace(PSEUDO_ELEMENTS, '')
		.replace(VENDOR_PSEUDO, '')
		.replace(STATE_PSEUDO, '')
		.trim();
	if (!out) return '*';
	if (/[>+~]$/.test(out)) out += ' *';
	return out;
}

/** 规则列表里，只给打印用的 @media（print、print and (...)）。 */
function printOnly(prelude) {
	const query = prelude.replace(/^@media\s*/i, '').trim().toLowerCase();
	return splitSelectors(query).every((q) => /^(only\s+)?print\b/.test(q));
}

/**
 * 按选择器裁规则。matches(selector) 返回 true / false；认不出的选择器（引擎不支持、
 * 写法非法）返回 null，一律当命中留着 —— 宁可多留几条，也别把样式裁坏。
 * 一条规则里没命中的那几个选择器也去掉，只留命中的。
 */
export function pruneRules(items, matches) {
	const out = [];
	for (const item of items) {
		if (item.type === 'rule') {
			const kept = splitSelectors(item.prelude).filter((sel) => matches(sel) !== false);
			if (kept.length) out.push({ ...item, prelude: kept.join(',') });
		} else if (item.type === 'group') {
			if (item.name === 'media' && printOnly(item.prelude)) continue;
			const inner = pruneRules(item.items, matches);
			if (inner.length) out.push({ ...item, items: inner });
		} else if (item.type === 'at') {
			// @page 只管打印
			if (item.name !== 'page') out.push(item);
		} else if (item.type === 'stmt') {
			if (!/^@charset\b/i.test(item.text)) out.push(item);
		}
	}
	return out;
}

/** 所有留下来的普通规则的声明，拼成一段（小写），用来判断字体、动画有没有被用到。 */
function declarationCorpus(items, acc = []) {
	for (const item of items) {
		if (item.type === 'rule') acc.push(item.body);
		else if (item.type === 'group') declarationCorpus(item.items, acc);
	}
	return acc;
}

function fontFamilyOf(body) {
	const match = String(body).match(/font-family\s*:\s*([^;]+)/i);
	return match ? match[1].trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase() : '';
}

function keyframesName(prelude) {
	return String(prelude).replace(/^@[-\w]*keyframes\s*/i, '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

/**
 * 删掉没被用到的 @font-face 和 @keyframes。判断是粗的：名字在留下的声明里出现过就算用到
 * （写在 CSS 变量里的 `--font: "Foo"` 也算），extra 是正文行内 style 的文字。
 */
export function pruneUnusedAtRules(items, extra = '') {
	const corpus = `${declarationCorpus(items).join('\n')}\n${extra}`.toLowerCase();
	const used = (name) => {
		if (!name) return true;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(corpus);
	};
	const walk = (list) => {
		const out = [];
		for (const item of list) {
			if (item.type === 'at' && item.name === 'font-face') {
				if (used(fontFamilyOf(item.body))) out.push(item);
			} else if (item.type === 'at' && /keyframes$/.test(item.name)) {
				if (used(keyframesName(item.prelude))) out.push(item);
			} else if (item.type === 'group') {
				const inner = walk(item.items);
				if (inner.length) out.push({ ...item, items: inner });
			} else {
				out.push(item);
			}
		}
		return out;
	};
	return walk(items);
}

/**
 * 按顶层分号切声明（括号、字符串里的分号不算）。body 里有原生嵌套（带 { 的）返回 null，
 * 不去动它。
 */
function splitDeclarations(body) {
	const src = String(body ?? '');
	const out = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			i = skipString(src, i);
			continue;
		}
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '{' || ch === '}') return null;
		if (ch === '(' || ch === '[') depth += 1;
		else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1;
		else if (ch === ';' && depth === 0) {
			out.push(src.slice(start, i));
			start = i + 1;
		}
		i += 1;
	}
	out.push(src.slice(start));
	return out.filter((d) => d.trim());
}

function mapRules(items, fn) {
	return items.map((item) => {
		if (item.type === 'rule') return fn(item);
		if (item.type === 'group') return { ...item, items: mapRules(item.items, fn) };
		return item;
	});
}

/**
 * 删掉没人引用的 CSS 变量声明（SingleFile 的「unneeded declarations」）。组件库喜欢在
 * :root / body 上一口气定义几百个变量（微信的 weui 一套就 7 KB），正文用到的没几个。
 *
 * 「有人引用」按整份 CSS 加行内 style 里出现过 var(--名字) 算，变量值里引用别的变量也算 ——
 * 粗一点，但不会把还在用的删掉。
 */
export function pruneUnusedVariables(items, extra = '') {
	const text = `${serializeCss(items)}\n${extra}`;
	const used = new Set();
	for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(match[1]);
	return mapRules(items, (rule) => {
		const decls = splitDeclarations(rule.body);
		if (!decls) return rule;
		const kept = decls.filter((decl) => {
			const name = decl.trim().match(/^(--[\w-]+)\s*:/)?.[1];
			return !name || used.has(name);
		});
		return kept.length === decls.length ? rule : { ...rule, body: kept.join(';') };
	}).filter((item) => item.type !== 'rule' || item.body.trim());
}

/**
 * 一字不差的规则（连同外面套的 @media）只留最后一条。同一套组件样式被几个样式表各带
 * 一份，公众号页面上同一条 7 KB 的变量定义出现了五次。留最后一条不改变层叠结果：
 * 前面那几条能生效的地方，最后这条都会再盖一遍同样的值。
 */
export function dedupeRules(items) {
	const keys = items.map((item) => serializeCss([item]));
	const last = new Map();
	keys.forEach((key, index) => last.set(key, index));
	return items
		.filter((_, index) => last.get(keys[index]) === index)
		.map((item) => (item.type === 'group' ? { ...item, items: dedupeRules(item.items) } : item));
}

/** 压空白：字符串原样，其余连续空白并成一个，{ } ; , 两边的空白去掉。 */
export function minifyCss(text) {
	const src = String(text ?? '');
	let out = '';
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			const end = skipString(src, i);
			out += src.slice(i, end);
			i = end;
			continue;
		}
		if (/\s/.test(ch)) {
			while (i < src.length && /\s/.test(src[i])) i += 1;
			const prev = out[out.length - 1];
			const next = src[i];
			if (out && next !== undefined && !'{};,'.includes(prev) && !'{};,'.includes(next)) out += ' ';
			continue;
		}
		if (ch === '\\') {
			out += src.slice(i, i + 2);
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/** 规则列表 → CSS 文字（压过空白）。 */
export function serializeCss(items) {
	return items
		.map((item) => {
			if (item.type === 'rule') return `${minifyCss(item.prelude)}{${minifyCss(item.body).replace(/;$/, '')}}`;
			if (item.type === 'group') return `${minifyCss(item.prelude)}{${serializeCss(item.items)}}`;
			if (item.type === 'at') return `${minifyCss(item.prelude)}{${minifyCss(item.body)}}`;
			return `${minifyCss(item.text)};`;
		})
		.join('');
}

const CSS_HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** url(...) 里的相对地址按样式表自己的地址补全（不是按页面地址）。data: 和锚点不动。 */
export function absolutizeCssUrls(text, base) {
	if (!/^https?:\/\//i.test(String(base ?? ''))) return String(text ?? '');
	return String(text ?? '').replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (whole, quote, url) => {
		const raw = url.trim();
		if (!raw || raw.startsWith('#') || CSS_HAS_SCHEME.test(raw)) return whole;
		try {
			return `url(${quote}${new URL(raw, base).toString()}${quote})`;
		} catch {
			return whole;
		}
	});
}

/**
 * 样式表里顶层的 @import，按出现顺序：{ text（整句）, url, media }。
 * `@import url(a.css) screen;`、`@import "a.css";` 两种写法都认。
 */
export function findImports(text) {
	const out = [];
	for (const item of parseCss(stripCssComments(text))) {
		if (item.type !== 'stmt' || !/^@import\b/i.test(item.text)) continue;
		const match = item.text.match(/^@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*(.*)$/is);
		if (!match) continue;
		out.push({ text: item.text, url: (match[2] ?? match[4] ?? '').trim(), media: (match[5] ?? '').trim() });
	}
	return out;
}

/**
 * 整段 CSS → 裁好压好的 CSS。
 * @param {string} css 已经展开 @import、补全过地址的 CSS
 * @param {(selector: string) => boolean | null} matches 见 pruneRules
 * @param {string} [inlineStyles] 正文行内 style 的文字，判断字体有没有被用到时一起看
 */
export function shrinkCss(css, matches, inlineStyles = '') {
	const items = parseCss(stripCssComments(css));
	const pruned = pruneUnusedAtRules(pruneRules(items, matches), inlineStyles);
	return serializeCss(dedupeRules(pruneUnusedVariables(pruned, inlineStyles)));
}
