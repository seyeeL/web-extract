// 带样式的 HTML（--html）在 Node 这一侧：拼文件的活都在 ./styled-core.js（不依赖 Node，
// 浏览器扩展也用它），这里只补两样 Node 才有的东西：linkedom 解析文档，图片存到本地目录。
//
// 页面那一侧的材料（正文 + 祖先骨架、样式表清单）由 ./snapshot.js 给出：静态抓取时在
// linkedom 里跑，浏览器模式时注进页面跑，两条路交过来的东西长得一样。

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseHTML } from 'linkedom';

import { buildStyledHtml as buildWith, MAX_ASSET_BYTES } from './styled-core.js';

export { collectCss, embedStore, uploadStore, MAX_ASSET_BYTES, MAX_EMBED_BYTES, MAX_EMBED_TOTAL, MAX_SHEET_BYTES, MAX_TOTAL_CSS_BYTES } from './styled-core.js';

/**
 * 图片存到 dir 目录，文件名是原地址的 sha1，HTML 里用 href 下的相对路径引用。
 * 目录等到第一张存下来才建，一张都没有就不建。
 */
export function dirStore(dir, href = dir) {
	let made = false;
	return {
		maxBytes: MAX_ASSET_BYTES,
		put(bytes, { ext, url }) {
			const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.${ext}`;
			if (!made) {
				mkdirSync(dir, { recursive: true });
				made = true;
			}
			writeFileSync(join(dir, name), bytes);
			return `${String(href).replace(/\/+$/, '')}/${name}`;
		},
	};
}

/**
 * 页面侧材料 → 完整的 HTML 文件。选项见 ./styled-core.js 的 buildStyledHtml，另外认：
 * assetsDir：图片下载到这个目录；assetsHref：HTML 里引用它们用的相对路径。
 * 图片的存法同时给了几种，按 uploadImage、assetsDir、embedImages 的顺序取第一个。
 * @returns {Promise<{html: string, warnings: string[], stats: object}>}
 */
export function buildStyledHtml(snap, options = {}) {
	const useDir = !options.storeImage && typeof options.uploadImage !== 'function' && options.assetsDir;
	return buildWith(snap, {
		...options,
		parseDocument: (html) => parseHTML(html).document,
		...(useDir ? { storeImage: dirStore(options.assetsDir, options.assetsHref ?? options.assetsDir) } : {}),
	});
}
