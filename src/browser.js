// 浏览器模式：起一个独立 profile 的 Chrome（或连已经开着调试端口的那个），把提取逻辑
// 注进页面执行。正文靠 JS 渲染的站点只能这么拿 —— 抓 HTTP 请求看不到渲染出来的 DOM。
//
// 默认用一次性的 user-data-dir，不碰你正在用的 Chrome 和登录态。要登录才给内容的站点
// （小红书干净 profile 只会拿到风控拦截页）用 attach：先在那个浏览器里登录并打开目标页，
// 这里只是连上去执行，同样不读 cookie。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
// 拼进页面的顺序：被依赖的在前
const PAGE_MODULES = ['site-rules.js', 'html2md.js', 'extract.js', 'result.js', 'dump.js'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把几个 ESM 模块拼成一段能直接 eval 的脚本（页面里没法 import 本地文件）。
 * 只是去掉 import 行和 export 前缀，所以模块里的 import 必须写成单行。
 */
export function pageBundle() {
	return PAGE_MODULES.map((name) =>
		readFileSync(join(SRC, name), 'utf8')
			.replace(/^import .*$/gm, '')
			.replace(/^export /gm, ''),
	).join('\n');
}

/** 在页面里跑提取的表达式，返回 JSON 字符串。 */
export function extractExpression(options = {}) {
	const opts = JSON.stringify({ withReplies: options.withReplies === true, plain: options.plain === true });
	return `(() => { ${pageBundle()}\n return JSON.stringify(extractDocument(document, location.href, ${opts})); })()`;
}

/** 在页面里跑诊断的表达式，返回 JSON 字符串。 */
export function dumpExpression() {
	return `(() => { ${pageBundle()}\n return JSON.stringify(dumpCandidates(document)); })()`;
}

export function findChrome(env = process.env) {
	const candidates = [
		env.CHROME_PATH,
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
		'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	].filter(Boolean);
	const found = candidates.find((p) => existsSync(p));
	if (!found) throw new Error('找不到 Chrome，用 CHROME_PATH 环境变量指一个');
	return found;
}

function cdp(ws) {
	let id = 0;
	const pending = new Map();
	const seen = new Set();
	ws.addEventListener('message', (ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		} else if (msg.method) {
			seen.add(msg.method);
		}
	});
	return {
		send: (method, params = {}) =>
			new Promise((resolve) => {
				id += 1;
				pending.set(id, resolve);
				ws.send(JSON.stringify({ id, method, params }));
			}),
		loaded: () => seen.has('Page.loadEventFired'),
		// 导航前清掉：空白页自己的 load 事件不能算成目标页加载完了
		forget: () => seen.clear(),
	};
}

/** 已经开着的浏览器里找那个 tab。传的 URL 常带 xsec_token 之类的参数，用路径匹配更稳。 */
async function attachTarget(port, url) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const pages = list.filter((t) => t.type === 'page');
	let key = url;
	try {
		key = new URL(url).pathname;
	} catch {
		// 传的不是完整 URL，当子串用
	}
	const found = pages.find((t) => t.url.includes(url)) ?? pages.find((t) => t.url.includes(key));
	if (found) return found;
	const opened = pages.map((t) => t.url).join('\n  ');
	throw new Error(`那个浏览器里没有匹配 ${key} 的标签页，先在它里面打开目标页。\n当前开着：\n  ${opened}`);
}

/** Chrome 用 --remote-debugging-port=0 自己挑端口，挑好写进 profile 里的这个文件。 */
async function waitForPort(profile, child) {
	const file = join(profile, 'DevToolsActivePort');
	for (let i = 0; i < 100; i += 1) {
		if (child.exitCode !== null) throw new Error(`Chrome 启动后立刻退出了（退出码 ${child.exitCode}）`);
		if (existsSync(file)) {
			const port = readFileSync(file, 'utf8').split('\n')[0].trim();
			if (port) return port;
		}
		await sleep(150);
	}
	throw new Error('Chrome 没起来（15 秒内没拿到调试端口）');
}

async function waitForHttp(port, tries) {
	let lastError = '';
	for (let i = 0; i < tries; i += 1) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
		} catch (err) {
			lastError = err?.message || String(err);
		}
		await sleep(300);
	}
	// 端口一直连不上的原因五花八门（端口被占、代理拦本地回环），把最后一次的报错带出来
	throw new Error(`连不上 127.0.0.1:${port}（${lastError || '未知原因'}）`);
}

/**
 * 打开（或找到）页面，执行 expression，返回它的值。
 *
 * @param {string} url
 * @param {string} expression 返回字符串的 JS 表达式
 * @param {{attach?: boolean, port?: number|string, headed?: boolean, userAgent?: string, waitMs?: number}} [options]
 *   attach：不开新浏览器，连 port（默认 9222）上那个、在已打开的 tab 里跑
 *   headed：开真窗口（挪到屏幕外，不打扰），有些站点认 headless
 *   waitMs：页面 load 之后再等多久，给首屏 JS 把正文塞进 DOM
 */
export async function evaluateInBrowser(url, expression, options = {}) {
	// 全局 fetch / WebSocket 是 Node 22 才都齐的。缺了会在重试循环里被吃掉，
	// 最后报成「Chrome 没起来」——查半天查到 node 版本上
	const missing = ['fetch', 'WebSocket'].filter((name) => typeof globalThis[name] !== 'function');
	if (missing.length) {
		throw new Error(`浏览器模式需要 Node 22+（缺少全局 ${missing.join(' / ')}），当前是 ${process.version}`);
	}

	const attach = options.attach === true;
	const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 5000;
	let profile = '';
	let chrome = null;
	let ws = null;
	try {
		let port;
		if (attach) {
			port = String(options.port ?? 9222);
			try {
				await waitForHttp(port, 3);
			} catch (err) {
				throw new Error(`${err.message}。那个浏览器要带 --remote-debugging-port=${port} 启动。`);
			}
		} else {
			profile = mkdtempSync(join(tmpdir(), 'web-extract-'));
			chrome = spawn(findChrome(), [
				...(options.headed ? ['--window-position=-3000,0'] : ['--headless=new', '--disable-gpu']),
				'--remote-debugging-port=0',
				`--user-data-dir=${profile}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--window-size=1280,2000',
				'about:blank',
			], { stdio: 'ignore' });
			port = await waitForPort(profile, chrome);
			await waitForHttp(port, 30);
		}

		// 新开的 tab 先停在空白页：UA 要在导航之前换好，不然第一个请求已经发出去了
		const target = attach
			? await attachTarget(port, url)
			: await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
		ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', () => reject(new Error('连不上页面的调试 WebSocket')), { once: true });
		});
		const client = cdp(ws);

		await client.send('Page.enable');
		await client.send('Runtime.enable');
		// attach 的页面早就加载完了，不导航也不等
		if (!attach) {
			// headless 的默认 UA 带 HeadlessChrome，X 这类站点直接 403。换成同版本的普通 Chrome
			let userAgent = options.userAgent ?? '';
			if (!userAgent && !options.headed) {
				const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
				userAgent = String(version['User-Agent'] ?? '').replace('HeadlessChrome', 'Chrome');
			}
			if (userAgent) await client.send('Network.setUserAgentOverride', { userAgent });

			client.forget();
			const nav = await client.send('Page.navigate', { url });
			// 连不上、被拒（403 空页面）时 Chrome 显示的是它自己的报错页，不能当正文交出去
			const errorText = nav.result?.errorText ?? nav.error?.message;
			if (errorText) throw new Error(`页面打不开（${errorText}）：${url}`);
			for (let i = 0; i < 100 && !client.loaded(); i += 1) await sleep(300);
			await sleep(waitMs);
		}

		const res = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		const result = res.result;
		if (result?.exceptionDetails) {
			const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
			throw new Error(`页面内执行出错：${detail}`);
		}
		if (typeof result?.result?.value !== 'string') throw new Error(`页面没有返回内容：${JSON.stringify(res)}`);
		return result.result.value;
	} finally {
		ws?.close();
		chrome?.kill();
		if (profile) {
			// Chrome 退出要一会儿，Windows 上文件还锁着时删不掉，重试几次，实在不行就留在临时目录
			try {
				rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
			} catch {
				// 临时目录，系统会收
			}
		}
	}
}

/** URL → 提取结果，在浏览器里渲染之后提取。 */
export async function extractUrlInBrowser(url, options = {}) {
	const result = JSON.parse(await evaluateInBrowser(url, extractExpression(options), options));
	// attach 到的 tab 可能本身就停在报错页上
	if (/^chrome-error:/.test(result.url)) throw new Error(`页面没加载成功（${result.title}）：${url}`);
	return result;
}

/** URL → 正文候选容器列表，在浏览器里渲染之后诊断。 */
export async function dumpUrlInBrowser(url, options = {}) {
	return JSON.parse(await evaluateInBrowser(url, dumpExpression(), options));
}
