// 图床：--upload-images 把页面上的图片转存到自己的图床，HTML 里换成图床的地址。
//
// 小红书这类站点的图片地址带签名，过几天就打不开；转成 base64 塞进 HTML 又太大。
// 传到自己的图床之后 HTML 仍然只有一个、体积小，图片地址长期有效。
//
// 这个仓库是公开的，图床的配置（密钥、bucket）不能写进来：从环境变量读，或者从
// ~/.config/web-extract/.env 读（WEB_EXTRACT_ENV 可以指到别的文件）。环境变量优先。
// 写法见 docs/image-host.md。
//
// 两种图床：
// - oss：阿里云 OSS，用 AccessKey 直传（V1 签名，不依赖 SDK），对象设成公共读
// - command：自己给一条命令（PicGo 之类），收一个本地文件、在输出里打印图片地址

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_CONFIG_FILE = join(homedir(), '.config', 'web-extract', '.env');
const PREFIX = 'WEB_EXTRACT_';
const UPLOAD_TIMEOUT_MS = 60_000;

export class ImageHostError extends Error {}

/**
 * 图床配置：配置文件里的值垫底，环境变量覆盖。只收 WEB_EXTRACT_ 开头的，别的不碰。
 * 配置文件不存在不算错（全靠环境变量也行）。
 */
export function loadImageHostConfig({ env = process.env, file } = {}) {
	const path = file ?? env.WEB_EXTRACT_ENV ?? DEFAULT_CONFIG_FILE;
	let fromFile = {};
	if (path && existsSync(path)) {
		try {
			fromFile = parseEnv(readFileSync(path, 'utf8'));
		} catch (err) {
			throw new ImageHostError(`图床配置文件 ${path} 读不了（${err.message}）`);
		}
	}
	const pick = (source) => Object.fromEntries(Object.entries(source).filter(([key]) => key.startsWith(PREFIX)));
	return { ...pick(fromFile), ...pick(env), configFile: path };
}

function need(config, keys, kind) {
	const missing = keys.filter((key) => !String(config[`${PREFIX}${key}`] ?? '').trim());
	if (missing.length) {
		throw new ImageHostError(
			`图床（${kind}）缺配置：${missing.map((key) => PREFIX + key).join('、')}。` +
				`写进 ${config.configFile} 或者设成环境变量，见 docs/image-host.md`,
		);
	}
	return Object.fromEntries(keys.map((key) => [key, String(config[`${PREFIX}${key}`]).trim()]));
}

/** 对象名：前缀 / 内容的 sha256。同一张图传几次都是同一个对象，不会越传越多。 */
export function objectKey(prefix, bytes, ext) {
	const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
	const clean = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
	return `${clean ? `${clean}/` : ''}${hash}.${ext}`;
}

const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

/**
 * 阿里云 OSS：PUT 一个公共读的对象，返回公开地址。
 * 签名是 OSS V1（HMAC-SHA1），带 Content-MD5 让 OSS 校验内容。出错只报状态码和 OSS 的错误码，不带密钥。
 */
export function ossUploader(config, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
	const { OSS_ACCESS_KEY_ID: keyId, OSS_ACCESS_KEY_SECRET: secret, OSS_BUCKET: bucket, OSS_REGION: region } = need(
		config,
		['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'],
		'oss',
	);
	if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) throw new ImageHostError(`OSS bucket 名不对：${bucket}`);
	if (!/^oss-[a-z0-9-]+$/.test(region)) throw new ImageHostError(`OSS 地域要写成 oss-cn-shenzhen 这样，收到 ${region}`);
	const host = `${bucket}.${region}.aliyuncs.com`;
	const prefix = config[`${PREFIX}OSS_PREFIX`] ?? 'web-extract';
	// 绑了自己的域名（CDN）就用它拼地址，没有就用 OSS 默认域名
	const publicBase = String(config[`${PREFIX}OSS_PUBLIC_BASE`] ?? '').trim().replace(/\/+$/, '') || `https://${host}`;
	if (!/^https?:\/\//i.test(publicBase)) throw new ImageHostError(`WEB_EXTRACT_OSS_PUBLIC_BASE 要以 http(s):// 开头`);

	return async (bytes, { mime, ext }) => {
		const key = objectKey(prefix, bytes, ext);
		const date = now().toUTCString();
		const md5 = createHash('md5').update(bytes).digest('base64');
		const acl = 'x-oss-object-acl:public-read\n';
		const signature = createHmac('sha1', secret).update(`PUT\n${md5}\n${mime}\n${date}\n${acl}/${bucket}/${key}`).digest('base64');
		let res;
		try {
			res = await fetchImpl(`https://${host}/${encodeKey(key)}`, {
				method: 'PUT',
				headers: {
					Date: date,
					Authorization: `OSS ${keyId}:${signature}`,
					'Content-MD5': md5,
					'Content-Type': mime,
					'Cache-Control': 'public, max-age=31536000, immutable',
					'x-oss-object-acl': 'public-read',
				},
				body: bytes,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
		} catch (err) {
			throw new ImageHostError(`连不上 OSS（${err?.cause?.code || err?.message}）`);
		}
		if (!res.ok) {
			const code = /<Code>([^<]+)<\/Code>/.exec(await res.text().catch(() => ''))?.[1] ?? '';
			throw new ImageHostError(`OSS 拒收（HTTP ${res.status}${code ? ` ${code}` : ''}）`);
		}
		return `${publicBase}/${encodeKey(key)}`;
	};
}

/**
 * 自定义命令：图片先写进临时文件，命令里的 {file} 换成它的路径（没写 {file} 就接在末尾），
 * 命令输出里最后一个 http(s) 地址就是图床给的地址。PicGo 是 `picgo upload {file}`。
 */
export function commandUploader(config, { timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
	const { UPLOAD_COMMAND: command } = need(config, ['UPLOAD_COMMAND'], 'command');
	return async (bytes, { ext }) => {
		const dir = mkdtempSync(join(tmpdir(), 'web-extract-img-'));
		const file = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`);
		writeFileSync(file, bytes);
		// 路径是这里生成的（临时目录 + 十六进制名 + 扩展名），加引号防临时目录带空格
		const quoted = process.platform === 'win32' ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`;
		const line = command.includes('{file}') ? command.split('{file}').join(quoted) : `${command} ${quoted}`;
		try {
			const output = await new Promise((resolve, reject) => {
				const child = spawn(line, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
				let out = '';
				let err = '';
				const timer = setTimeout(() => {
					child.kill();
					reject(new ImageHostError(`上传命令 ${timeoutMs / 1000} 秒没跑完`));
				}, timeoutMs);
				child.stdout.on('data', (chunk) => {
					out += chunk;
				});
				child.stderr.on('data', (chunk) => {
					err += chunk;
				});
				child.on('error', (e) => {
					clearTimeout(timer);
					reject(new ImageHostError(`上传命令起不来（${e.message}）`));
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					if (code === 0) resolve(out);
					else reject(new ImageHostError(`上传命令退出码 ${code}${err.trim() ? `：${err.trim().split('\n').pop()}` : ''}`));
				});
			});
			const urls = String(output).match(/https?:\/\/[^\s"'<>]+/g);
			if (!urls) throw new ImageHostError('上传命令的输出里没有图片地址');
			return urls[urls.length - 1];
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/**
 * 按配置造一个上传函数：(bytes, {mime, ext, url}) => Promise<图床地址>，交给 buildStyledHtml 的 uploadImage。
 * 没配、配错了抛 ImageHostError，说清缺哪个。
 */
export function createImageUploader(config = loadImageHostConfig(), options = {}) {
	const kind = String(config[`${PREFIX}IMAGE_HOST`] ?? '').trim().toLowerCase();
	if (kind === 'oss') return ossUploader(config, options);
	if (kind === 'command') return commandUploader(config, options);
	throw new ImageHostError(
		kind
			? `不认识的图床 WEB_EXTRACT_IMAGE_HOST=${kind}，可选 oss、command`
			: `没配图床：在 ${config.configFile} 里写 WEB_EXTRACT_IMAGE_HOST=oss（或 command）和对应的配置，见 docs/image-host.md`,
	);
}
