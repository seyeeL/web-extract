import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';

import { styledHtml } from '../src/node.js';
import { snapshotDocument } from '../src/snapshot.js';

const PAGE = `<!DOCTYPE html><html lang="zh-CN" class="theme-light" onclick="x()"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>样例文章 - 样例站</title>
<meta property="og:site_name" content="样例站">
<meta name="author" content="某某">
<meta property="article:published_time" content="2026-08-01">
<link rel="stylesheet" href="/css/site.css">
<link rel="stylesheet" href="/css/print.css" media="print">
<link rel="alternate stylesheet" href="/css/alt.css">
<style>.post .body p{line-height:1.8}.sidebar{width:300px}</style>
<style>.post .body p{line-height:1.8}.sidebar{width:300px}</style>
</head><body class="page">
<nav class="navbar"><a href="/">首页</a></nav>
<div id="layout" class="layout"><aside class="sidebar">侧栏</aside>
<main class="post" style="background:url(/img/bg.png)">
<article class="body">
<h1>样例文章</h1>
<p onmouseover="evil()">第一段正文，写得足够长，让默认规则认得出这是正文而不是导航。这里再多写几句凑够字数。</p>
<p>第二段正文，带<a href="javascript:alert(1)">坏链接</a>和<a href="/ref">站内链接</a>。同样多写几句，保证段落文字量够。</p>
<p><img src="data:image/gif;base64,R0lGOD" data-src="/img/a.jpg" alt="图"><svg aria-hidden="true"><use href="#icon-star"></use></svg></p>
<script>alert(1)</script>
</article>
</main></div>
<svg style="display:none"><symbol id="icon-star"><path d="M0 0"></path></symbol></svg>
</body></html>`;

const SHEETS = {
	'https://example.com/css/site.css': `@import url("parts/base.css");
.post .body p{color:#333}
.post .body a:hover{color:red}
.sidebar{float:left}
.unused-widget{display:none}
@font-face{font-family:Brand;src:url(../fonts/brand.woff2)}
@font-face{font-family:Nobody;src:url(../fonts/nobody.woff2)}
.post h1{font-family:Brand;background:url(../img/h.png)}
x{content:"</style><script>alert(1)</script>"}`,
	'https://example.com/css/parts/base.css': 'body.page{margin:0;background:url(bg2.png)}.never{a:b}',
	'https://example.com/css/print.css': '.post{color:black}',
	'https://example.com/css/alt.css': '.post{color:green}',
};

/** 假的 fetch：样式表按表给，图片给几个字节的 jpeg，别的 404。记下要过哪些地址。 */
function fakeFetch(log = []) {
	return async (url, init = {}) => {
		log.push({ url: String(url), referer: init.headers?.referer });
		const css = SHEETS[String(url)];
		if (css !== undefined) return new Response(css, { headers: { 'content-type': 'text/css' } });
		if (String(url).endsWith('.jpg')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
		if (String(url).endsWith('.gif')) return new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } });
		return new Response('nope', { status: 404 });
	};
}

test('带样式 HTML：正文套回祖先骨架，站点 CSS 照旧命中', async () => {
	const { html, warnings } = await styledHtml(PAGE, 'https://example.com/post/1', { fetchImpl: fakeFetch() });
	assert.deepEqual(warnings, []);
	const { document } = parseHTML(html);
	// 骨架：body > #layout > main.post > article.body，侧栏、导航不在
	const article = document.querySelector('body.page > #layout > main.post > article.body');
	assert.ok(article, '正文的祖先一层层都在');
	assert.equal(document.querySelector('.sidebar'), null);
	assert.equal(document.querySelector('nav'), null);
	assert.equal(document.documentElement.getAttribute('lang'), 'zh-CN');
	assert.equal(document.documentElement.getAttribute('class'), 'theme-light');
	assert.equal(document.documentElement.getAttribute('onclick'), null);

	const css = document.querySelector('style').textContent;
	// 用到的留下，用不到的裁掉
	assert.match(css, /\.post \.body p\{color:#333\}/);
	assert.match(css, /\.post \.body a:hover\{color:red\}/, ':hover 规则按去掉 :hover 之后能不能命中算');
	assert.doesNotMatch(css, /\.sidebar|unused-widget|\.never/);
	// @import 展开，url() 按各自样式表的地址补全
	assert.match(css, /body\.page\{margin:0;background:url\(https:\/\/example\.com\/css\/parts\/bg2\.png\)\}/);
	assert.match(css, /url\(https:\/\/example\.com\/img\/h\.png\)/);
	// 字体只留被用到的，地址补全不转 base64
	assert.match(css, /font-family:Brand;src:url\(https:\/\/example\.com\/fonts\/brand\.woff2\)/);
	assert.doesNotMatch(css, /Nobody/);
	// 打印样式表、备选样式表不要；一模一样的内联样式表只留一份
	assert.doesNotMatch(css, /color:black|color:green/);
	assert.equal(css.match(/line-height:1\.8/g).length, 1);
	// </style 不能把 <style> 提前关掉
	assert.doesNotMatch(html, /<\/style><script>/);
	assert.equal(document.querySelectorAll('script').length, 0);
});

test('带样式 HTML：脚本、事件属性、javascript: 地址都不留，懒加载图换真地址，SVG 图标带上定义', async () => {
	const { html } = await styledHtml(PAGE, 'https://example.com/post/1', { fetchImpl: fakeFetch() });
	const { document } = parseHTML(html);
	assert.doesNotMatch(html, /onmouseover|evil\(\)|javascript:/);
	assert.match(html, /Content-Security-Policy" content="script-src 'none'/);
	assert.equal(document.querySelector('article img').getAttribute('src'), 'https://example.com/img/a.jpg');
	assert.equal(document.querySelector('a[href="https://example.com/ref"]').textContent, '站内链接');
	assert.equal(document.querySelector('main').getAttribute('style'), 'background:url(https://example.com/img/bg.png)');
	// 图标 <svg> 留着（带 aria-hidden 也留），sprite 里被引用的那个 symbol 一起带上
	assert.ok(document.querySelector('article svg use'));
	assert.ok(document.querySelector('symbol#icon-star'));
	// 元信息
	assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/post\/1">/);
	assert.match(html, /<meta name="author" content="某某">/);
	assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
	assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test('带样式 HTML：出处那行放在正文容器里；正文自带标题就不再加标题', async () => {
	const { html } = await styledHtml(PAGE, 'https://example.com/post/1', { fetchImpl: fakeFetch() });
	const { document } = parseHTML(html);
	const meta = document.querySelector('article.body > .web-extract-meta');
	assert.ok(meta, '出处是正文容器的第一个孩子');
	assert.equal(meta.querySelector('h1'), null, '正文里已经有 <h1>样例文章</h1>');
	assert.match(meta.textContent, /某某 · 2026-08-01 · 样例站/);
});

test('带样式 HTML：样式表抓不到记 warning，不拖垮整次；页面里读到过 cssRules 的拿来兜底', async () => {
	const snap = snapshotDocument(parseHTML(PAGE).document, 'https://example.com/post/1');
	assert.deepEqual(snap.sheets.map((s) => s.href ?? 'inline'), [
		'https://example.com/css/site.css',
		'https://example.com/css/print.css',
		'inline',
		'inline',
	]);
	const { html, warnings } = await styledHtml(PAGE, 'https://example.com/post/1', {
		fetchImpl: async () => new Response('', { status: 500 }),
	});
	assert.ok(warnings.some((w) => /site\.css 没抓到（HTTP 500）/.test(w)));
	assert.match(html, /line-height:1\.8/, '内联样式表不用抓');
});

test('带样式 HTML：--assets 把图片存到本地、用相对路径引用；不是图片的不存', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'web-extract-assets-'));
	try {
		const log = [];
		const page = PAGE.replace('</article>', '<p><img src="/img/blocked.gif"></p></article>');
		const { html, warnings, stats } = await styledHtml(page, 'https://example.com/post/1', {
			fetchImpl: fakeFetch(log),
			assetsDir: join(dir, 'files'),
			assetsHref: 'files',
		});
		const { document } = parseHTML(html);
		const [first, second] = Array.from(document.querySelectorAll('article img')).map((img) => img.getAttribute('src'));
		assert.match(first, /^files\/[0-9a-f]{16}\.jpg$/);
		assert.equal(second, 'https://example.com/img/blocked.gif', '防盗链回的 HTML 不当图片存，留远程地址');
		assert.equal(stats.saved, 1);
		assert.ok(warnings.some((w) => /blocked\.gif 没存下来（不是图片/.test(w)));
		assert.deepEqual(readdirSync(join(dir, 'files')), [first.slice('files/'.length)]);
		// 图片按原页面的身份去要
		assert.equal(log.find((e) => e.url.endsWith('a.jpg')).referer, 'https://example.com/post/1');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('带样式 HTML：没有可存的图就不建目录', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'web-extract-assets-'));
	try {
		const page = PAGE.replace(/<p><img[^>]*>/, '<p>');
		await styledHtml(page, 'https://example.com/post/1', { fetchImpl: fakeFetch(), assetsDir: join(dir, 'files') });
		assert.equal(existsSync(join(dir, 'files')), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('带样式 HTML：正文是整个 <body> 时不套第二层 body；祖先是 <form> 换成 <div> 不连正文一起删', async () => {
	const bare = '<!DOCTYPE html><html><head><title>短</title></head><body class="b"><span>就几个字</span></body></html>';
	const { html } = await styledHtml(bare, 'https://example.com/x', { fetchImpl: fakeFetch() });
	assert.equal(html.match(/<body/g).length, 1);
	assert.match(html, /<body[^>]* class="b"/);

	const aspnet = PAGE.replace('<div id="layout" class="layout">', '<form id="aspnetForm" action="/x"><div id="layout" class="layout">').replace('</main></div>', '</main></div></form>');
	const { html: out } = await styledHtml(aspnet, 'https://example.com/post/1', { fetchImpl: fakeFetch() });
	const { document } = parseHTML(out);
	assert.equal(document.querySelector('form'), null);
	assert.ok(document.querySelector('div#aspnetForm > #layout article.body p'));
});
