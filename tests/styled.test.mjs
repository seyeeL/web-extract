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

test('只存正文：正文套回祖先骨架，站点 CSS 照旧命中', async () => {
	const { html, warnings } = await styledHtml(PAGE, 'https://example.com/post/1', { fetchImpl: fakeFetch(), articleOnly: true });
	assert.deepEqual(warnings, []);
	const { document } = parseHTML(html);
	// 骨架：body > #layout > main.post > article.body，侧栏、导航不在
	const article = document.querySelector('body.page > #layout > main.post > article.body');
	assert.ok(article, '正文的祖先一层层都在');
	assert.ok(!document.querySelector('.sidebar'));
	assert.ok(!document.querySelector('nav'));
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

test('只存正文：出处那行放在正文容器里；正文自带标题就不再加标题', async () => {
	const { html } = await styledHtml(PAGE, 'https://example.com/post/1', { fetchImpl: fakeFetch(), articleOnly: true });
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

test('只存正文：正文是整个 <body> 时不套第二层 body；祖先是 <form> 换成 <div> 不连正文一起删', async () => {
	const bare = '<!DOCTYPE html><html><head><title>短</title></head><body class="b"><span>就几个字</span></body></html>';
	const { html } = await styledHtml(bare, 'https://example.com/x', { fetchImpl: fakeFetch(), articleOnly: true });
	assert.equal(html.match(/<body/g).length, 1);
	assert.match(html, /<body[^>]* class="b"/);

	const aspnet = PAGE.replace('<div id="layout" class="layout">', '<form id="aspnetForm" action="/x"><div id="layout" class="layout">').replace('</main></div>', '</main></div></form>');
	const { html: out } = await styledHtml(aspnet, 'https://example.com/post/1', { fetchImpl: fakeFetch(), articleOnly: true });
	const { document } = parseHTML(out);
	assert.ok(!document.querySelector('form'));
	assert.ok(document.querySelector('div#aspnetForm > #layout article.body p'));
});

test('整页存（默认）：导航、侧栏都在，广告删掉，表单留着但去掉提交地址', async () => {
	const page = PAGE
		.replace('<aside class="sidebar">侧栏</aside>', '<aside class="sidebar">侧栏<div class="ad-slot">买它</div><ins class="adsbygoogle" data-ad-client="ca-pub-1"></ins></aside><form action="/search" method="get"><input name="q"></form><div class="header-download">下载客户端</div>');
	const { html } = await styledHtml(page, 'https://example.com/post/1', { fetchImpl: fakeFetch() });
	const { document } = parseHTML(html);
	assert.ok(document.querySelector('nav.navbar'), '导航留着');
	assert.match(document.querySelector('aside.sidebar').textContent, /侧栏/);
	assert.ok(!document.querySelector('.ad-slot'));
	assert.ok(!document.querySelector('ins'));
	assert.doesNotMatch(html, /买它/);
	assert.ok(document.querySelector('.header-download'), 'download 里的 ad 不是整词，不算广告');
	const form = document.querySelector('form');
	assert.ok(form && form.querySelector('input[name="q"]'));
	assert.equal(form.getAttribute('action'), null);
	assert.match(html, /form-action 'none'/);
	// 侧栏在页面上，它的样式也留着；脚本照样删干净
	assert.match(document.querySelector('style').textContent, /\.sidebar\{float:left\}/);
	assert.ok(!document.querySelector('script'));
	assert.doesNotMatch(html, /onmouseover|javascript:/);
	// 整页存不补出处那行，也不加只存正文时的修正样式
	assert.ok(!document.querySelector('.web-extract-meta'));
	assert.doesNotMatch(html, /data-web-extract-chain/);
});

test('整页存：浏览器里 display:none 的元素删掉，<svg> 里的不碰', async () => {
	const { document } = parseHTML(PAGE.replace('<aside class="sidebar">侧栏</aside>', '<aside class="sidebar">侧栏<div class="login-modal">登录框</div></aside>'));
	// linkedom 没有计算样式，这里装一个：登录框和图标 sprite 都是 display:none
	Object.defineProperty(document, 'defaultView', {
		value: {
			getComputedStyle: (el) => ({
				display: /login-modal/.test(el.getAttribute('class') ?? '') || el.getAttribute('style') === 'display:none' ? 'none' : 'block',
			}),
		},
	});
	const snap = snapshotDocument(document, 'https://example.com/post/1');
	assert.doesNotMatch(snap.body, /登录框/);
	assert.match(snap.body, /<symbol id="icon-star">/, 'sprite 在 <svg> 里，不按 display:none 删');
});

test('整页存：站点广告位（豆瓣的 dale_）删掉；规则的 prepare 也跑（豆瓣配图从 JSON 造出来）', async () => {
	const page = `<!DOCTYPE html><html><head><title>王逅逅的广播</title></head><body>
<div id="dale_update_top_right">广告</div>
<div class="new-status from-detail"><div class="status-item"><div class="mod"><div class="bd sns"><div class="status-saying"><blockquote><p>正文</p></blockquote>
<div class="attachments-saying"><script>var photos = [{"image":{"large":{"url":"https://img3.doubanio.com/view/status/l/public/x.jpg"}}}];</script></div>
</div></div></div></div></div></body></html>`;
	const { html } = await styledHtml(page, 'https://www.douban.com/people/a/status/1/', { fetchImpl: fakeFetch() });
	assert.doesNotMatch(html, /dale_|广告/);
	assert.match(html, /<img [^>]*src="https:\/\/img3\.doubanio\.com\/view\/status\/l\/public\/x\.jpg"/);
	// 豆瓣别的页面（电影条目）一样去广告
	const movie = await styledHtml('<html><body><div id="dale_movie_subject_top_right">广告</div><div id="info">导演</div></body></html>', 'https://movie.douban.com/subject/1/', { fetchImpl: fakeFetch() });
	assert.doesNotMatch(movie.html, /广告/);
	assert.match(movie.html, /导演/);
});

test('整页存：<iframe> 换成一样大的空块，版面不塌；广告位里的 iframe 跟着广告一起删', async () => {
	const page = '<html><body><div class="hero"><div class="login"><iframe src="https://accounts.example.com/login" width="300" height="320" class="lf"></iframe></div></div><div class="ad-box"><iframe src="https://ads.example.com/x"></iframe></div></body></html>';
	const { html } = await styledHtml(page, 'https://example.com/', { fetchImpl: fakeFetch() });
	const { document } = parseHTML(html);
	assert.ok(!document.querySelector('iframe'));
	const box = document.querySelector('.login > div[data-web-extract-frame]');
	assert.ok(box);
	assert.equal(box.getAttribute('class'), 'lf');
	assert.match(box.getAttribute('style'), /width:300px;height:320px/);
	assert.equal(document.querySelectorAll('[data-web-extract-frame]').length, 1);
});

test('--assets：CSS 和行内 style 里的背景图也存到本地，字体不存', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'web-extract-assets-'));
	try {
		const page = '<html><head><style>.logo{background:url(/img/logo.jpg)}@font-face{font-family:F;src:url(/f.woff2)}.logo{font-family:F}</style></head><body><div class="logo" style="background-image:url(/img/hero.jpg)">豆瓣</div></body></html>';
		const log = [];
		const { html, stats } = await styledHtml(page, 'https://example.com/', {
			fetchImpl: fakeFetch(log),
			assetsDir: join(dir, 'files'),
			assetsHref: 'files',
		});
		assert.equal(stats.saved, 2);
		assert.match(html, /\.logo\{background:url\(files\/[0-9a-f]{16}\.jpg\)\}/);
		assert.match(html, /style="background-image:url\(files\/[0-9a-f]{16}\.jpg\)"/);
		assert.match(html, /url\(https:\/\/example\.com\/f\.woff2\)/);
		assert.ok(!log.some((e) => e.url.endsWith('.woff2')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
