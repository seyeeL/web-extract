#!/usr/bin/env node
// web-extract 命令行。用法见 HELP，或者 README。

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { dumpUrlInBrowser, extractUrlInBrowser, styledUrlInBrowser } from '../src/browser.js';
import { createImageUploader, ImageHostError } from '../src/image-host.js';
import { dumpHtml, extractHtml, fetchHtml, styledHtml, WECHAT_UA } from '../src/node.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `web-extract —— 把网页存成 Markdown（只留正文）或 HTML（保留原站样式，图片可塞进文件或转存图床）

用法:
  web-extract parse <url|文件|-> [选项]   提取正文
  web-extract dump  <url|文件|-> [选项]   列出文字量最大的容器（定位「正文在哪」）

输出（parse）:
  --md                 Markdown（推荐）
  --json               JSON：url / title / author / publishedAt / siteName / domain / markdown / html
  --html               带原站样式的单文件 HTML：整页去掉广告和脚本，CSS 只留用到的，图片留远程地址
  --article            --html 时只存正文（导航、侧栏、评论区都不要），上面补一行出处
  --assets <目录>      --html 时把图片下载到这个目录，HTML 里用相对路径引用（防盗链的站点用）
  --embed-images       --html 时把图片塞进 HTML（base64），只出一个文件（大，但好传）
  --upload-images      --html 时把图片转存到自己的图床，HTML 里换成图床地址（配置见 docs/image-host.md）
  (不带)               清洗后的正文 HTML
  -p, --property <名>  只输出一个字段：title author publishedAt siteName domain url markdown html
  -o, --output <文件>  写进文件，不打到标准输出

抓取:
  --browser            用 headless Chrome 渲染后再提取（X、小红书、微博这类 JS 渲染的站点要开）
  --attach             连已经开着调试端口的浏览器，在已打开的那个 tab 里提取（要登录态的站点用）
  --port <端口>        --attach 的调试端口，默认 9222
  --headed             --browser 时开真窗口（挪到屏幕外）而不是 headless
  --wait <毫秒>        --browser 时页面加载完再等多久，默认 5000
  --wx                 用微信 UA（公众号链接需要）
  --user-agent <UA>    自定义 UA
  --timeout <毫秒>     静态抓取超时，默认 30000
  --url <地址>         输入是文件或标准输入时，告诉提取器原始地址（决定命中哪条站点规则）

内容:
  --plain              Markdown 去掉格式标记，只留文字和图片（排版坏掉的页面用）
  --load-comments      --html 配 --browser / --attach 时，先在页面上把评论往下翻、楼中楼点开再存（目前只有小红书）。
                       每步隔 3–5 秒，最多 200 条、5 分钟，弹验证就停：替人点太快会触发风控
  --no-replies         不收主贴底下的回复（只对写了 replies 的站点有效，比如 X）

  -h, --help           帮助
  -v, --version        版本
`;

// -p 接受的字段名，含两个顺手的别名
const PROPERTIES = {
	url: 'url',
	title: 'title',
	author: 'author',
	publishedAt: 'publishedAt',
	published: 'publishedAt',
	siteName: 'siteName',
	site: 'siteName',
	domain: 'domain',
	markdown: 'markdown',
	html: 'html',
	content: 'html',
};

class UsageError extends Error {}

function toNumber(value, name) {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) throw new UsageError(`${name} 要一个非负数字，收到 ${value}`);
	return n;
}

function isHttpUrl(value) {
	return /^https?:\/\//i.test(value);
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

/** 输入是文件或标准输入时读进来；file:// 也当文件。 */
async function readLocal(input) {
	if (input === '-') return readStdin();
	const path = /^file:\/\//i.test(input) ? fileURLToPath(input) : input;
	return readFileSync(path, 'utf8');
}

function render(result, values) {
	if (values.property) {
		const key = PROPERTIES[values.property];
		if (!key) {
			throw new UsageError(`不认识的字段 ${values.property}，可选：${Object.keys(PROPERTIES).join(' ')}`);
		}
		return String(result[key] ?? '');
	}
	if (values.json) return JSON.stringify(result, null, 2);
	if (values.md) return result.markdown;
	return result.html;
}

async function run(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			md: { type: 'boolean' },
			json: { type: 'boolean' },
			html: { type: 'boolean' },
			article: { type: 'boolean' },
			assets: { type: 'string' },
			'embed-images': { type: 'boolean' },
			'upload-images': { type: 'boolean' },
			'load-comments': { type: 'boolean' },
			property: { type: 'string', short: 'p' },
			output: { type: 'string', short: 'o' },
			browser: { type: 'boolean' },
			attach: { type: 'boolean' },
			port: { type: 'string' },
			headed: { type: 'boolean' },
			wait: { type: 'string' },
			wx: { type: 'boolean' },
			'user-agent': { type: 'string' },
			timeout: { type: 'string' },
			url: { type: 'string' },
			plain: { type: 'boolean' },
			'no-replies': { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean', short: 'v' },
		},
	});

	if (values.version) {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
		return { text: `${pkg.version}\n` };
	}
	const [command, input, ...extra] = positionals;
	if (values.help || !command) return { text: HELP };
	if (command !== 'parse' && command !== 'dump') throw new UsageError(`不认识的命令 ${command}`);
	if (!input) throw new UsageError(`${command} 要一个 URL、文件路径或 -（标准输入）`);
	if (extra.length) throw new UsageError(`多余的参数：${extra.join(' ')}`);

	const remote = isHttpUrl(input);
	const browser = values.browser || values.attach;
	if (browser && !remote) throw new UsageError('--browser / --attach 只能配 http(s) 地址');
	if (values.url && !isHttpUrl(values.url)) throw new UsageError(`--url 要一个 http(s) 地址，收到 ${values.url}`);

	const options = {
		withReplies: !values['no-replies'],
		plain: values.plain === true,
		userAgent: values['user-agent'] ?? (values.wx ? WECHAT_UA : undefined),
		timeoutMs: toNumber(values.timeout, '--timeout'),
		waitMs: toNumber(values.wait, '--wait'),
		attach: values.attach === true,
		port: values.port,
		headed: values.headed === true,
	};
	for (const key of Object.keys(options)) if (options[key] === undefined) delete options[key];

	if (values.assets && !values.html) throw new UsageError('--assets 要配 --html');
	if (values.article && !values.html) throw new UsageError('--article 要配 --html');
	if (values['embed-images'] && !values.html) throw new UsageError('--embed-images 要配 --html');
	if (values['upload-images'] && !values.html) throw new UsageError('--upload-images 要配 --html');
	if (values['load-comments'] && !(values.html && browser)) throw new UsageError('--load-comments 要配 --html 和 --browser / --attach');
	const imageModes = ['assets', 'embed-images', 'upload-images'].filter((name) => values[name]);
	if (imageModes.length > 1) throw new UsageError(`图片的存法只能选一种：${imageModes.map((n) => `--${n}`).join(' / ')}`);
	if (values.html && (values.md || values.json || values.property)) {
		throw new UsageError('--html 不能和 --md / --json / -p 一起用');
	}
	if (values.html && command === 'parse') return runStyled(input, values, options, { remote, browser });

	if (command === 'dump') {
		let dump;
		if (browser) dump = await dumpUrlInBrowser(input, options);
		else dump = dumpHtml(remote ? (await fetchHtml(input, options)).html : await readLocal(input));
		return { text: `${JSON.stringify(dump, null, 2)}\n`, outFile: values.output };
	}

	let result;
	if (browser) {
		result = await extractUrlInBrowser(input, options);
	} else if (remote) {
		const page = await fetchHtml(input, options);
		result = extractHtml(page.html, page.url, options);
	} else {
		const base = values.url ?? (input === '-' ? '' : pathToFileURL(input).toString());
		result = extractHtml(await readLocal(input), base, options);
	}

	// 抓空了要说出来，提示走 stderr，不污染输出。静态抓取抓空十有八九是 JS 渲染的页面；
	// 落地地址和输入对不上时多半是被跳到了登录 / 人机验证页，把落地地址带出来一眼就能看出
	let warning = '';
	if (result.markdown.length < 100) {
		const hint = !remote
			? ''
			: browser
				? '要登录或验证的站点，在自己的浏览器里打开后用 --attach。'
				: '正文靠 JS 渲染的页面试试 --browser；要登录的站点用 --attach。';
		const landed = remote && result.url && result.url !== input ? `落地地址 ${result.url}。` : '';
		warning = `正文只有 ${result.markdown.length} 个字符。${landed}${hint}`;
	}
	const text = render(result, values);
	return { text: text.endsWith('\n') ? text : `${text}\n`, outFile: values.output, warning };
}

function kb(n) {
	return `${(n / 1024).toFixed(1)} KB`;
}

/** --html：带样式的单文件 HTML。体积和抓不到的样式表、图片走 stderr。 */
async function runStyled(input, values, options, { remote, browser }) {
	const styledOptions = {
		...options,
		articleOnly: values.article === true,
		embedImages: values['embed-images'] === true,
		loadComments: values['load-comments'] === true,
	};
	if (values['upload-images']) {
		// 先把图床配置读出来：没配的话在抓页面之前就报错，不白等
		try {
			styledOptions.uploadImage = createImageUploader();
		} catch (err) {
			if (err instanceof ImageHostError) throw new UsageError(err.message);
			throw err;
		}
	}
	if (values.assets) {
		// HTML 里引用图片的相对路径：从输出文件所在目录（没给 -o 就是当前目录）算到图片目录。
		// Windows 的反斜杠换成 /，不然浏览器认不出
		const from = values.output ? dirname(resolve(values.output)) : process.cwd();
		styledOptions.assetsDir = resolve(values.assets);
		styledOptions.assetsHref = relative(from, styledOptions.assetsDir).split(sep).join('/') || '.';
	}
	let result;
	if (browser) {
		result = await styledUrlInBrowser(input, styledOptions);
	} else if (remote) {
		const page = await fetchHtml(input, styledOptions);
		result = await styledHtml(page.html, page.url, styledOptions);
	} else {
		const base = values.url ?? (input === '-' ? '' : pathToFileURL(input).toString());
		result = await styledHtml(await readLocal(input), base, styledOptions);
	}
	const { stats } = result;
	const notes = [
		...result.warnings,
		`HTML ${kb(stats.bytes)}（样式 ${kb(stats.cssBefore)} 裁到 ${kb(stats.cssAfter)}${stats.saved !== undefined ? `，${values['upload-images'] ? '传到图床' : values['embed-images'] ? '塞进' : '存下'} ${stats.saved} 张图` : ''}${stats.fonts ? `，塞进 ${stats.fonts} 个字体` : ''}）`,
	];
	return { text: result.html, outFile: values.output, warning: notes.join('\nweb-extract: ') };
}

/** 返回退出码；输出写到 stdout 或 -o 指定的文件。测试直接调这个。 */
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
	try {
		const { text, outFile, warning } = await run(argv);
		if (warning) stderr.write(`web-extract: ${warning}\n`);
		if (outFile) writeFileSync(outFile, text, 'utf8');
		else stdout.write(text);
		return 0;
	} catch (err) {
		const usage = err instanceof UsageError || err?.code?.startsWith?.('ERR_PARSE_ARGS');
		stderr.write(`web-extract: ${err?.message ?? err}\n`);
		if (usage) stderr.write('用 web-extract --help 看用法\n');
		return usage ? 2 : 1;
	}
}

// 直接跑的时候才执行；被测试 import 时不动。npm 全局安装在 Unix 上是符号链接，先解开再比
function invokedDirectly() {
	try {
		return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
	} catch {
		return false;
	}
}

if (process.argv[1] && invokedDirectly()) {
	process.exitCode = await main();
}
