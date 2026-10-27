import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandUploader, createImageUploader, ImageHostError, loadImageHostConfig, objectKey, ossUploader } from '../src/image-host.js';

const OSS = {
	WEB_EXTRACT_IMAGE_HOST: 'oss',
	WEB_EXTRACT_OSS_ACCESS_KEY_ID: 'test-key-id',
	WEB_EXTRACT_OSS_ACCESS_KEY_SECRET: 'test-key-secret',
	WEB_EXTRACT_OSS_BUCKET: 'my-bucket',
	WEB_EXTRACT_OSS_REGION: 'oss-cn-shenzhen',
};

async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'web-extract-test-'));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('图床配置：配置文件垫底、环境变量覆盖，只收 WEB_EXTRACT_ 开头的；文件不存在不算错', async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, '.env');
		writeFileSync(file, '# 注释\nWEB_EXTRACT_IMAGE_HOST=oss\nWEB_EXTRACT_OSS_BUCKET="from-file"\nOTHER=1\n');
		const config = loadImageHostConfig({ env: { WEB_EXTRACT_ENV: file, WEB_EXTRACT_OSS_BUCKET: 'from-env', PATH: '/bin' } });
		assert.equal(config.WEB_EXTRACT_IMAGE_HOST, 'oss');
		assert.equal(config.WEB_EXTRACT_OSS_BUCKET, 'from-env');
		assert.equal(config.OTHER, undefined);
		assert.equal(config.PATH, undefined);
		assert.equal(config.configFile, file);

		const none = loadImageHostConfig({ env: {}, file: join(dir, 'missing.env') });
		assert.equal(none.WEB_EXTRACT_IMAGE_HOST, undefined);
	});
});

test('图床配置：没配、配错、缺字段都抛 ImageHostError，说清缺哪个，不带密钥的值', () => {
	assert.throws(() => createImageUploader({ configFile: '/x/.env' }), (err) => err instanceof ImageHostError && /没配图床/.test(err.message));
	assert.throws(() => createImageUploader({ WEB_EXTRACT_IMAGE_HOST: 'ftp' }), /不认识的图床/);
	assert.throws(
		() => createImageUploader({ ...OSS, WEB_EXTRACT_OSS_ACCESS_KEY_SECRET: '', WEB_EXTRACT_OSS_REGION: '' }),
		(err) => /WEB_EXTRACT_OSS_ACCESS_KEY_SECRET、WEB_EXTRACT_OSS_REGION/.test(err.message) && !err.message.includes('test-key-id'),
	);
	assert.throws(() => createImageUploader({ ...OSS, WEB_EXTRACT_OSS_REGION: 'shenzhen' }), /oss-cn-shenzhen 这样/);
	assert.throws(() => createImageUploader({ WEB_EXTRACT_IMAGE_HOST: 'command' }), /WEB_EXTRACT_UPLOAD_COMMAND/);
});

test('对象名按内容算：同一张图同一个名字，前缀两头的斜杠去掉', () => {
	const a = objectKey('/clips/', new Uint8Array([1, 2, 3]), 'webp');
	assert.match(a, /^clips\/[0-9a-f]{32}\.webp$/);
	assert.equal(objectKey('clips', new Uint8Array([1, 2, 3]), 'webp'), a);
	assert.notEqual(objectKey('clips', new Uint8Array([1, 2, 4]), 'webp'), a);
	assert.match(objectKey('', new Uint8Array([1]), 'png'), /^[0-9a-f]{32}\.png$/);
});

test('OSS：PUT 公共读对象，V1 签名 + Content-MD5；返回公开地址，绑了域名用域名', async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return new Response('', { status: 200 });
	};
	const now = () => new Date('2026-10-27T08:00:00Z');
	const upload = ossUploader(OSS, { fetchImpl, now });
	const url = await upload(new Uint8Array([1, 2, 3]), { mime: 'image/webp', ext: 'webp' });
	assert.match(url, /^https:\/\/my-bucket\.oss-cn-shenzhen\.aliyuncs\.com\/web-extract\/[0-9a-f]{32}\.webp$/);
	assert.equal(calls[0].url, url);
	const headers = calls[0].init.headers;
	assert.equal(calls[0].init.method, 'PUT');
	assert.equal(headers['x-oss-object-acl'], 'public-read');
	assert.equal(headers['Content-Type'], 'image/webp');
	assert.equal(headers.Date, 'Tue, 27 Oct 2026 08:00:00 GMT');
	assert.match(headers.Authorization, /^OSS test-key-id:[A-Za-z0-9+/]+=*$/);
	assert.ok(headers['Content-MD5']);

	const cdn = ossUploader({ ...OSS, WEB_EXTRACT_OSS_PREFIX: 'clips', WEB_EXTRACT_OSS_PUBLIC_BASE: 'https://img.example.com/' }, { fetchImpl, now });
	assert.match(await cdn(new Uint8Array([9]), { mime: 'image/png', ext: 'png' }), /^https:\/\/img\.example\.com\/clips\/[0-9a-f]{32}\.png$/);
});

test('OSS：拒收时只报状态码和错误码', async () => {
	const fetchImpl = async () => new Response('<Error><Code>AccessDenied</Code><Message>x</Message></Error>', { status: 403 });
	const upload = ossUploader(OSS, { fetchImpl });
	await assert.rejects(upload(new Uint8Array([1]), { mime: 'image/png', ext: 'png' }), (err) => {
		assert.equal(err.message, 'OSS 拒收（HTTP 403 AccessDenied）');
		return true;
	});
});

test('命令图床：{file} 换成临时文件路径，取输出里最后一个地址；失败报退出码', async () => {
	const print = `node -e "console.log('uploading'); console.log('https://img.example.com/' + require('path').basename(process.argv[1]))"`;
	const upload = commandUploader({ WEB_EXTRACT_UPLOAD_COMMAND: `${print} {file}` });
	assert.match(await upload(new Uint8Array([1, 2]), { mime: 'image/png', ext: 'png' }), /^https:\/\/img\.example\.com\/[0-9a-f]{16}\.png$/);

	// 没写 {file} 就接在末尾
	const appended = commandUploader({ WEB_EXTRACT_UPLOAD_COMMAND: print });
	assert.match(await appended(new Uint8Array([3]), { mime: 'image/png', ext: 'png' }), /\.png$/);

	const silent = commandUploader({ WEB_EXTRACT_UPLOAD_COMMAND: 'node -e "1"' });
	await assert.rejects(silent(new Uint8Array([1]), { mime: 'image/png', ext: 'png' }), /输出里没有图片地址/);
	const failing = commandUploader({ WEB_EXTRACT_UPLOAD_COMMAND: `node -e "console.error('boom'); process.exit(3)"` });
	await assert.rejects(failing(new Uint8Array([1]), { mime: 'image/png', ext: 'png' }), /退出码 3：boom/);
});
