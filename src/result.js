// 提取结果的统一形状。Node 侧（linkedom）和浏览器侧（注入页面）都走这里，
// 两条路出来的 JSON 字段一模一样。
//
// 浏览器模式会把这个文件和 extract.js 等一起去掉 import / export 拼成一段脚本注入，
// 所以这里的顶层名字不能和那几个文件撞，import 也只能写单行。

import { extractArticle } from './extract.js';
import { htmlToMarkdown } from './html2md.js';

/** 来源域名，去掉 www.。认不出返回空串。 */
export function domainOf(url) {
	try {
		return new URL(String(url)).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/**
 * extractArticle 的结果转成可序列化的对象：DOM 节点换成 markdown 和 html 两份文本。
 * @param {{plain?: boolean}} [options] plain：markdown 去掉格式标记，只留文字和图片
 */
export function articleToResult(article, options = {}) {
	const root = article?.root ?? null;
	return {
		url: article?.url ?? '',
		title: article?.title ?? '',
		author: article?.author ?? '',
		publishedAt: article?.publishedAt ?? '',
		siteName: article?.siteName ?? '',
		domain: domainOf(article?.url ?? ''),
		markdown: htmlToMarkdown(root, { plain: options.plain === true }),
		html: root?.outerHTML ?? '',
	};
}

/**
 * 一步到位：文档 → 结果对象。
 * @param {{withReplies?: boolean, plain?: boolean}} [options]
 */
export function extractDocument(doc, url = '', options = {}) {
	const article = extractArticle(doc, url, { withReplies: options.withReplies === true });
	return articleToResult(article, options);
}
