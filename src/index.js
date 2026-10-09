// 浏览器和 Node 都能 import 的入口：只有纯提取逻辑，不碰网络和文件。
// Node 里要从 HTML 字符串或 URL 起步，用 ./node.js。

export { extractArticle, pickRoot, stripSiteSuffix } from './extract.js';
export { htmlToMarkdown, normalizeMarkdown } from './html2md.js';
export { ruleFor, SITE_RULES } from './site-rules.js';
export { articleToResult, domainOf, extractDocument } from './result.js';
export { dumpCandidates } from './dump.js';
