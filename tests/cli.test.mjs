import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../bin/web-extract.mjs';
import { dumpExpression, extractExpression, pageBundle, snapshotExpression } from '../src/browser.js';
import { snapshotDocument } from '../src/snapshot.js';
import { decodeHtml, extractHtml, fetchHtml, parseDocument } from '../src/node.js';

const ARTICLE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>样例文章 - 样例站</title>
<meta property="og:site_name" content="样例站">
<meta name="author" content="某某">
<meta property="article:published_time" content="2026-08-01T08:00:00Z">
</head><body>
<nav class="navbar"><a href="/">首页</a><a href="/about">关于</a></nav>
<article>
<h1>样例文章</h1>
<p>第一段正文，写得足够长，让默认规则认得出这是正文而不是导航。这里再多写几句凑够字数，免得被当成短页面。</p>
<p>第二段正文，带一个<a href="https://example.com/ref">链接</a>和<strong>加粗</strong>。同样多写几句，保证段落文字量够。</p>
<ul><li>列表一</li><li>列表二</li></ul>
<div class="related-posts"><a href="/a">推荐一</a><a href="/b">推荐二</a></div>
</article>
<footer class="site-footer">版权所有</footer>
</body></html>`;

/** 跑一次 CLI，收集输出和退出码。 */
async function cli(args) {
	let out = '';
	let err = '';
	const code = await main(args, {
		stdout: { write: (s) => { out += s; } },
		stderr: { write: (s) => { err += s; } },
	});
	return { code, out, err };
}

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'web-extract-test-'));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('注入页面用的拼接脚本能直接执行，结果和 Node 侧一致', () => {
	// 浏览器模式靠「去掉 import / export」把模块拼成一段脚本。模块里哪天写了多行 import
	// 或者顶层重名，这里直接报错，不用等到真浏览器里才发现
	const url = 'https://example.com/post/1';
	const inPage = new Function('document', 'location', `${pageBundle()}
		return extractDocument(document, location.href, { withReplies: true });`);
	const viaBundle = inPage(parseDocument(ARTICLE), { href: url });
	assert.deepEqual(viaBundle, extractHtml(ARTICLE, url, { withReplies: true }));

	// 带样式 HTML 的材料也走这段拼接脚本
	const snapInPage = new Function('document', 'location', `${pageBundle()}
		return snapshotDocument(document, location.href, {});`);
	assert.deepEqual(snapInPage(parseDocument(ARTICLE), { href: url }), snapshotDocument(parseDocument(ARTICLE), url));

	// 表达式本身也得是合法 JS
	assert.doesNotThrow(() => new Function(`return ${extractExpression({ plain: true })}`));
	assert.doesNotThrow(() => new Function(`return ${dumpExpression()}`));
	assert.doesNotThrow(() => new Function(`return ${snapshotExpression({ withReplies: true })}`));
});

test('提取结果：元信息、markdown、噪声过滤', () => {
	const result = extractHtml(ARTICLE, 'https://www.example.com/post/1');
	assert.equal(result.title, '样例文章');
	assert.equal(result.author, '某某');
	assert.equal(result.publishedAt, '2026-08-01T08:00:00Z');
	assert.equal(result.siteName, '样例站');
	assert.equal(result.domain, 'example.com');
	assert.match(result.markdown, /\[链接\]\(https:\/\/example\.com\/ref\)/);
	assert.match(result.markdown, /\*\*加粗\*\*/);
	assert.match(result.markdown, /- 列表一\n- 列表二/);
	assert.doesNotMatch(result.markdown, /推荐一|首页|版权所有/);
	assert.match(result.html, /^<article>/);
});

test('字符集：响应头优先，其次 <meta>，认不出的编码退回 UTF-8', () => {
	// 「中文」的 GBK 编码
	const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
	assert.equal(decodeHtml(gbk, 'text/html; charset=GBK'), '中文');

	const head = new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">');
	const withMeta = new Uint8Array([...head, ...gbk]);
	assert.match(decodeHtml(withMeta, 'text/html'), /中文$/);

	const utf8 = new TextEncoder().encode('中文');
	assert.equal(decodeHtml(utf8, 'text/html; charset=no-such-charset'), '中文');
	assert.equal(decodeHtml(utf8, ''), '中文');
});

test('静态抓取：跟重定向、拒绝非 HTML、超过上限立刻断开', async () => {
	const big = 'x'.repeat(4096);
	const server = createServer((req, res) => {
		if (req.url === '/go') {
			res.writeHead(302, { location: '/article' });
			res.end();
		} else if (req.url === '/article') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(ARTICLE);
		} else if (req.url === '/image') {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end('png');
		} else if (req.url === '/big') {
			// 不给 content-length，只能边读边数
			res.writeHead(200, { 'content-type': 'text/html' });
			res.write(big);
			res.end(big);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const page = await fetchHtml(`${base}/go`);
		assert.equal(page.url, `${base}/article`, '返回落地地址，站点规则要按它匹配');
		assert.match(page.html, /样例文章/);

		await assert.rejects(fetchHtml(`${base}/image`), /不是 HTML/);
		await assert.rejects(fetchHtml(`${base}/missing`), /HTTP 404/);
		await assert.rejects(fetchHtml(`${base}/big`, { maxBytes: 5000 }), /页面太大/);
		await assert.rejects(fetchHtml('ftp://example.com/'), /只支持 http/);
	} finally {
		server.close();
	}
});

test('CLI：--md / --json / -p / 默认 HTML / -o', async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, 'page.html');
		writeFileSync(file, ARTICLE);
		const url = 'https://example.com/post/1';

		const md = await cli(['parse', file, '--md', '--url', url]);
		assert.equal(md.code, 0);
		assert.match(md.out, /^# 样例文章\n\n第一段正文/);

		const json = JSON.parse((await cli(['parse', file, '--json', '--url', url])).out);
		assert.equal(json.url, url);
		assert.equal(json.domain, 'example.com');
		assert.deepEqual(Object.keys(json), ['url', 'title', 'author', 'publishedAt', 'siteName', 'domain', 'markdown', 'html']);

		assert.equal((await cli(['parse', file, '-p', 'title'])).out, '样例文章\n');
		assert.equal((await cli(['parse', file, '-p', 'published'])).out, '2026-08-01T08:00:00Z\n');
		assert.match((await cli(['parse', file])).out, /^<article>/);

		const outFile = join(dir, 'out.md');
		const written = await cli(['parse', file, '--md', '-o', outFile]);
		assert.equal(written.out, '');
		assert.match(readFileSync(outFile, 'utf8'), /第二段正文/);
	});
});

test('CLI：dump 列出文字量最大的容器', async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, 'page.html');
		const body = '正文'.repeat(150);
		writeFileSync(file, `<html><body><div class="wrap"><article id="main"><p>${body}</p></article></div><p>短</p></body></html>`);
		const { code, out } = await cli(['dump', file]);
		assert.equal(code, 0);
		const dump = JSON.parse(out);
		assert.deepEqual(dump.counts, { p: 2, section: 0, div: 1, article: 1, img: 0 });
		assert.deepEqual(dump.heavy.map((h) => h.el), ['DIV.wrap', 'ARTICLE#main', 'P']);
	});
});

test('CLI：用法错误退出码 2，运行错误退出码 1，正文太短提示走 stderr', async () => {
	assert.equal((await cli(['parse'])).code, 2);
	assert.equal((await cli(['frobnicate', 'x'])).code, 2);
	assert.equal((await cli(['parse', 'page.html', '--browser'])).code, 2);
	assert.equal((await cli(['parse', 'a', 'b'])).code, 2);
	assert.equal((await cli(['parse', 'x', '--bogus'])).code, 2);
	assert.equal((await cli(['parse', 'x', '--url', 'not-a-url'])).code, 2);

	await withTempDir(async (dir) => {
		const file = join(dir, 'page.html');
		writeFileSync(file, ARTICLE);
		const bad = await cli(['parse', file, '-p', 'nope']);
		assert.equal(bad.code, 2);
		assert.match(bad.err, /不认识的字段/);

		const missing = await cli(['parse', join(dir, 'missing.html')]);
		assert.equal(missing.code, 1);

		const empty = join(dir, 'empty.html');
		writeFileSync(empty, '<html><body><p>短</p></body></html>');
		const short = await cli(['parse', empty, '--md']);
		assert.equal(short.code, 0);
		assert.equal(short.out, '短\n');
		assert.match(short.err, /正文只有 \d+ 个字符/);
	});

	assert.match((await cli(['--help'])).out, /web-extract parse/);
	assert.match((await cli(['-v'])).out, /^\d+\.\d+\.\d+\n$/);
});

test('CLI：--html 输出单文件 HTML，体积走 stderr；--assets 的相对路径从输出文件所在目录算', async () => {
	// 图片和样式表都从本机起的服务拿，不出网
	const server = createServer((req, res) => {
		if (req.url === '/a.css') {
			res.writeHead(200, { 'content-type': 'text/css' });
			res.end('article p{color:#222}.unused{color:red}');
		} else if (req.url === '/pic.png') {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end('png');
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		await withTempDir(async (dir) => {
			const file = join(dir, 'page.html');
			writeFileSync(file, ARTICLE
				.replace('</head>', '<link rel="stylesheet" href="/a.css"></head>')
				.replace('<ul>', '<p><img src="/pic.png"></p><ul>'));
			const url = `${base}/post/1`;

			const plain = await cli(['parse', file, '--html', '--url', url]);
			assert.equal(plain.code, 0);
			assert.match(plain.out, /^<!DOCTYPE html>/);
			assert.match(plain.out, /article p\{color:#222\}/);
			assert.doesNotMatch(plain.out, /\.unused/);
			assert.match(plain.out, new RegExp(`<img src="${base}/pic.png">`));
			assert.match(plain.err, /HTML [\d.]+ KB（样式 [\d.]+ KB 裁到 [\d.]+ KB）/);

			const out = join(dir, 'out', 'page.html');
			const saved = await cli(['parse', file, '--html', '--url', url, '-o', out, '--assets', join(dir, 'out', 'page_files')]);
			assert.equal(saved.code, 0);
			assert.match(readFileSync(out, 'utf8'), /<img src="page_files\/[0-9a-f]{16}\.png">/);
			assert.match(saved.err, /存下 1 张图/);
		});
	} finally {
		server.close();
	}

	assert.equal((await cli(['parse', 'x.html', '--assets', 'd'])).code, 2, '--assets 要配 --html');
	assert.equal((await cli(['parse', 'x.html', '--html', '--md'])).code, 2);
	assert.equal((await cli(['parse', 'x.html', '--article'])).code, 2, '--article 要配 --html');
	assert.equal((await cli(['parse', 'x.html', '--embed-images'])).code, 2);
	assert.equal((await cli(['parse', 'x.html', '--html', '--embed-images', '--assets', 'd'])).code, 2);
});
