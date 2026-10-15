# 带样式的 HTML（`--html`）

Markdown 只留文字结构，原站的排版、字体、配色都没了。有些站点的样式本身就值得留（代码高亮、
排版讲究的博客、社交平台的卡片），`--html` 存一个能单独打开的 HTML 文件：**正文 + 原站样式**。

```bash
web-extract parse <url> --html -o page.html
web-extract parse <url> --browser --html -o page.html --assets page_files   # 图片也存到本地
```

参考的是 [SingleFile](https://github.com/gildas-lormeau/SingleFile)（浏览器扩展，把整页存成一个 HTML），
学了它控体积的那几招，没学它把图片、字体转成 base64 塞进文件的做法。

## 存什么

**不存整页，存正文 + 祖先骨架。** 正文选哪块和 `--md` 一样（默认规则 / 站点规则），然后把正文到
`<body>` 之间的每一层祖先浅拷贝一份套回去：只要标签和属性，不要兄弟节点。导航、侧栏、广告、
推荐都不在，站点 CSS 里 `.article .post p` 这种后代选择器照样命中。

正文上面加一行出处（作者 · 时间 · 原文链接），放在正文容器里，字体颜色跟着站点走。站点规则
为了 Markdown 干净常把作者、时间、头像从正文里删掉，HTML 文件里不补就不知道是谁写的。正文
没带标题时再补一个标题；标题是拿正文开头凑的站点（微博、豆瓣广播、推文）不补，免得读两遍。

和 `--md` 的清洗只差一处：`<svg>` 留着（图标、插图是长相的一部分），带 `aria-hidden` 的也留，
`<use href="#icon">` 引用的 sprite 定义从页面别处找来一起带上。

## 怎么控体积

| 招数 | 来自 SingleFile 的哪个选项 | 做法 |
|------|------|------|
| 删没用到的 CSS 规则 | remove-unused-styles | 每条规则按选择器去最终那棵树里 `querySelector`，没命中的删；一条规则里只留命中的选择器。`:hover`、`::before` 这类先去掉再匹配；认不出的选择器当命中留着 |
| 删没人引用的 CSS 变量 | remove-unused-styles（unneeded declarations） | 整份 CSS 加行内 style 里没出现过 `var(--名字)` 的变量声明删掉 |
| 删没用到的字体、动画 | remove-unused-fonts | `@font-face` 的字体名、`@keyframes` 的名字没在留下的声明里出现过就删 |
| 扔掉打印样式 | remove-alternative-medias | `media="print"` 的样式表、`@media print`、`@page`、备选样式表不要 |
| 重复的只留一份 | group-duplicate-stylesheets | 一模一样的内联样式表只留一份；一字不差的规则只留最后一条（层叠结果不变） |
| 补懒加载图片 | load-deferred-images | 占位图换成 `data-src` 这类属性里的真地址 |
| 压空白 | compress-html / compress-css | CSS 压空白、去注释；HTML 去注释 |
| **图片不转 base64** | （SingleFile 默认转） | 留远程地址；要离线就 `--assets` 存成旁边目录里的文件 |

实测（2026-10-15）：

| 页面 | 方式 | 样式（裁前 → 裁后） | HTML 文件 |
|------|------|------|------|
| 豆瓣广播 | 静态 | 252.6 KB → 1.3 KB | 5.5 KB |
| 豆瓣广播 | `--browser --assets` | 317.0 KB → 2.3 KB | 8.1 KB + 1 张图 |
| 公众号贴图 | `--browser` | 3204.5 KB → 6.9 KB | 10.1 KB |
| 少数派文章 | `--browser` | 446.4 KB → 9.4 KB | 51.9 KB |
| overreacted.io | 静态 | 26.5 KB → 15.9 KB | 114.9 KB（代码高亮的 span 占大头） |
| 微博 | `--browser --assets` | 868.3 KB → 19.9 KB | 23.9 KB + 2 张图 |
| X 推文（带引用推） | `--browser` | 321.3 KB → 45.7 KB | 57.9 KB |

公众号那 3 MB 里大头是同一套 weui 变量定义被五个样式表各带一份（一份 7 KB），加上几百个没人用的
CSS 变量。去重和删变量之前裁完还有 222 KB。

## 样式表从哪来

页面那一侧（`src/snapshot.js`）只收清单，Node 那一侧（`src/styled.js`）去抓：

- `<link rel=stylesheet>` 在 Node 里抓原文（带 UA 和原页面 Referer），`@import` 递归展开，
  `url()` 按各自样式表的地址补全。页面里读得到 `cssRules` 的顺手带一份，抓不到时兜底
- `<style>` 用文字；文字是空的但 `cssRules` 有东西，就是 CSS-in-JS 用 `insertRule` 塞的（X 就是），
  读 `cssRules`
- `adoptedStyleSheets` 读 `cssRules`

为什么不全在页面里读 `cssRules`：跨域的样式表读不到；读到的也是浏览器解析过的版本，别的浏览器
的私有前缀会被丢掉。

裁 CSS 在 Node 里用 linkedom 对着最终那棵树匹配。CSS 自己切，不用解析库：只要认出规则边界
（字符串、注释、转义、嵌套括号），声明原样保留。

## 安全

存下来的文件会被拿去别处打开，按不可信内容处理：

- `<script>`、`<iframe>`、`<object>`、`<form>`、`<meta>`、`<base>` 这类都删；`on*` 事件属性、
  `javascript:` 地址删
- 头上一行 CSP：`script-src 'none'`，漏网的也跑不起来
- CSS 里的 `</style` 转义，不能把 `<style>` 提前关掉
- 样式表单个 5 MB、总共 20 MB、最多 100 个、`@import` 最多 5 层、总共 60 秒；`@media` 嵌套超过 32 层
  不再往里拆；图片单张 20 MB、最多 300 张，回来的不是图片（防盗链给的报错页）不存

## 图片和防盗链

默认留远程地址，加 `<meta name="referrer" content="no-referrer">`：多数图床认「没有 Referer」放行。
豆瓣（`doubanio.com`）不认，浏览器里不带 Referer 一样打不开；微博要 `weibo.com` 的 Referer。
这类站点用 `--assets <目录>`：Node 带原页面（或规则里 `imageReferer`）的 Referer 去下载，
存成 `<sha1>.jpg` 这样的文件，HTML 里用相对路径引用，`srcset` 去掉（不然浏览器还是挑远程那张）。

CSS 里的背景图、字体仍然是远程地址。字体跨域要 CORS，原站没开就退回系统字体。

## 已知边界

- **只有正文那一块的样式。** 祖先骨架只有标签和属性，兄弟节点没了；靠 `:nth-child`、`+`、`~`
  命中的样式可能对不上。
- **站点规则重排过的块是新节点。** 推特、豆瓣转发的引用段是规则拼出来的（为了 Markdown 版式统一），
  没有原站类名，长得是浏览器默认样式。
- **骨架上的固定高度和 `overflow: hidden` 一律压掉**（SPA「整屏 + 内部滚动」的布局不压正文就被截在一屏里），
  `position: fixed / sticky` 的祖先（浏览器模式下才认得出）改成普通定位。
- **静态模式看不到计算样式。** JS 改过的样式、`display: none` 等脚本去掉的状态都还在；正文靠脚本显示的
  页面用 `--browser`。
- **没有页面宽度适配。** 原站是 950px 定宽的（豆瓣），手机上打开也是 950px，和原站在手机浏览器里一样。
