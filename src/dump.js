// 站点无关的诊断：文字量最大的那些容器就是正文候选。看它们的 class 能判断是没选中
// 容器，还是选中了但被噪声过滤删了。
//
// 浏览器模式下这个文件和其它模块一起拼进页面执行，所以只依赖 DOM，不 import 任何东西。

/** 元素的简短描述：TAG#id.class1.class2。 */
function describeElement(el) {
	const id = el.id ? `#${el.id}` : '';
	const cls = typeof el.className === 'string' && el.className.trim()
		? `.${el.className.trim().split(/\s+/).join('.')}`
		: '';
	return `${el.tagName}${id}${cls}`;
}

/** 页面里各类标签的数量，加上文字量超过 minLength 的前 limit 个容器。 */
export function dumpCandidates(doc, { limit = 12, minLength = 200 } = {}) {
	const heavy = [];
	for (const el of doc.querySelectorAll('div,section,article,main,p')) {
		const len = (el.textContent ?? '').trim().length;
		if (len > minLength) heavy.push({ el: describeElement(el).slice(0, 100), len });
	}
	heavy.sort((a, b) => b.len - a.len);
	const counts = {};
	for (const tag of ['p', 'section', 'div', 'article', 'img']) {
		counts[tag] = doc.querySelectorAll(tag).length;
	}
	return { counts, heavy: heavy.slice(0, limit) };
}
