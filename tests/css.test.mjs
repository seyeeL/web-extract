import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
	absolutizeCssUrls,
	dedupeRules,
	findImports,
	matchableSelector,
	minifyCss,
	parseCss,
	pruneRules,
	pruneUnusedAtRules,
	pruneUnusedVariables,
	serializeCss,
	shrinkCss,
	splitSelectors,
	stripCssComments,
} from '../src/css.js';

/** 按一棵小文档判断选择器命中没有，和 styled.js 里的 selectorMatcher 一个意思。 */
function matcherFor(html) {
	const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
	return (selector) => {
		try {
			return document.querySelector(matchableSelector(selector)) !== null;
		} catch {
			return null;
		}
	};
}

test('切规则：字符串、注释、转义里的括号和分号不算边界', () => {
	const css = stripCssComments(`
		/* 注释里的 { 不算 */
		a[title="x{y;z}"] { content: "}"; color: red }
		.md\\:flex { display: flex }
		@media (max-width: 600px) { .a { b: c } }
		@font-face { font-family: Foo; src: url(a;b.woff) }
		@import "x.css";
	`);
	const items = parseCss(css);
	assert.deepEqual(items.map((i) => i.type), ['rule', 'rule', 'group', 'at', 'stmt']);
	assert.equal(items[0].prelude, 'a[title="x{y;z}"]');
	assert.match(items[0].body, /content: "}"/);
	assert.equal(items[1].prelude, '.md\\:flex');
	assert.equal(items[2].items[0].prelude, '.a');
	assert.match(items[3].body, /url\(a;b\.woff\)/);
	assert.equal(items[4].text, '@import "x.css"');
});

test('切规则：@media 套几万层不把递归栈打爆', () => {
	const deep = `${'@media screen{'.repeat(20000)}a{b:c}${'}'.repeat(20000)}`;
	assert.doesNotThrow(() => parseCss(deep));
});

test('选择器按顶层逗号切，:is() 里的逗号不切', () => {
	assert.deepEqual(splitSelectors('a, b:is(.x, .y) > c ,d[title="1,2"]'), ['a', 'b:is(.x, .y) > c', 'd[title="1,2"]']);
});

test('去掉伪元素和状态伪类再去匹配', () => {
	assert.equal(matchableSelector('a:hover > span::after'), 'a > span');
	assert.equal(matchableSelector('.x:before'), '.x');
	assert.equal(matchableSelector('::selection'), '*');
	assert.equal(matchableSelector('input:-webkit-autofill'), 'input');
	assert.equal(matchableSelector('.nav >'), '.nav > *');
	// 结构伪类留着，它们决定命中谁
	assert.equal(matchableSelector('li:first-child'), 'li:first-child');
});

test('裁规则：没命中的整条删，一条里只留命中的选择器，认不出的留着', () => {
	const matches = matcherFor('<div class="post"><p>正文</p><a href="#">链</a></div>');
	const items = parseCss('.post p{a:b} .sidebar{c:d} .post a:hover, .nav a{e:f} svg|a{g:h}');
	const out = serializeCss(pruneRules(items, matches));
	assert.equal(out, '.post p{a:b}.post a:hover{e:f}svg|a{g:h}');
});

test('裁规则：只给打印用的 @media、@page、@charset 扔掉', () => {
	const matches = () => true;
	const out = serializeCss(pruneRules(parseCss('@charset "utf-8";@media print{a{b:c}}@media only print and (color){a{b:c}}@media screen, print{a{d:e}}@page{margin:0}'), matches));
	assert.equal(out, '@media screen,print{a{d:e}}');
});

test('没被用到的 @font-face、@keyframes 删掉；写在变量里、行内 style 里的也算用到', () => {
	const css = parseCss(`
		@font-face{font-family:"Used";src:url(a.woff2)}
		@font-face{font-family:Unused;src:url(b.woff2)}
		@font-face{font-family:"ViaVar";src:url(c.woff2)}
		@font-face{font-family:Inline;src:url(d.woff2)}
		@keyframes spin{to{transform:rotate(1turn)}}
		@-webkit-keyframes fade{to{opacity:0}}
		.a{font-family:"Used",sans-serif;animation:spin 1s}
		:root{--brand-font:"ViaVar"}
	`);
	const out = serializeCss(pruneUnusedAtRules(css, 'font-family: Inline'));
	assert.match(out, /Used/);
	assert.match(out, /ViaVar/);
	assert.match(out, /Inline/);
	assert.match(out, /keyframes spin/);
	assert.doesNotMatch(out, /Unused/);
	assert.doesNotMatch(out, /fade/);
});

test('没人引用的 CSS 变量删掉，被别的变量引用的留着；带嵌套的规则不动', () => {
	const css = parseCss(':root{--a:1px;--b:var(--a);--c:red;--unused:blue;color:var(--b)} .x{--d:1;&:hover{--e:2}} .y{--only:1}');
	const out = serializeCss(pruneUnusedVariables(css, 'border-color: var(--c)'));
	assert.equal(out, ':root{--a:1px;--b:var(--a);--c:red;color:var(--b)}.x{--d:1;&:hover{--e:2}}');
});

test('一字不差的规则只留最后一条，组里面的也去重', () => {
	const css = parseCss('body{--x:1}a{b:c}body{--x:1}@media (min-width:1px){p{q:r}p{q:r}}');
	assert.equal(serializeCss(dedupeRules(css)), 'a{b:c}body{--x:1}@media (min-width:1px){p{q:r}}');
});

test('压空白：字符串里的空白和注释样的东西原样留着', () => {
	assert.equal(minifyCss('a ,  b  {  content : "  /* x */  " ;  }'), 'a,b{content : "  /* x */  ";}');
	assert.equal(stripCssComments('a{content:"/* no */"}/* yes */'), 'a{content:"/* no */"} ');
});

test('url() 按样式表自己的地址补全；data:、锚点、绝对地址不动', () => {
	const base = 'https://cdn.example.com/css/site.css';
	const css = 'a{background:url(../img/a.png)}b{background:url("x.svg#i")}c{mask:url(#m)}d{background:url(data:image/png;base64,AA)}e{background:url(https://o.com/e.png)}';
	assert.equal(
		absolutizeCssUrls(css, base),
		'a{background:url(https://cdn.example.com/img/a.png)}b{background:url("https://cdn.example.com/css/x.svg#i")}c{mask:url(#m)}d{background:url(data:image/png;base64,AA)}e{background:url(https://o.com/e.png)}',
	);
});

test('@import 两种写法都认，带 media', () => {
	assert.deepEqual(findImports('@import url("a.css") screen and (min-width: 1px);\n@import \'b.css\';\na{}'), [
		{ text: '@import url("a.css") screen and (min-width: 1px)', url: 'a.css', media: 'screen and (min-width: 1px)' },
		{ text: "@import 'b.css'", url: 'b.css', media: '' },
	]);
});

test('shrinkCss 一步到位', () => {
	const matches = matcherFor('<p class="t">x</p>');
	const css = '/* c */ .t { color : red } .gone { color: blue } @font-face { font-family: X } :root { --unused: 1 }';
	assert.equal(shrinkCss(css, matches), '.t{color : red}');
});
