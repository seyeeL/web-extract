# 带样式的 HTML（`--html`）

Markdown 只留文字结构，原站的排版、字体、配色都没了。有些站点的样式本身就值得留（豆瓣、代码高亮、
排版讲究的博客、社交平台的卡片），`--html` 存一个能单独打开的 HTML 文件。

```bash
web-extract parse <url> --browser --html -o page.html --assets page_files   # 整页，图片存到本地
web-extract parse <url> --html --article -o page.html                       # 只存正文
web-extract parse <url> --browser --html --embed-images -o page.html        # 图片塞进 HTML，只出一个文件
web-extract parse <url> --attach --html --upload-images -o page.html        # 图片转存到自己的图床
```

参考的是 [SingleFile](https://github.com/gildas-lormeau/SingleFile)（浏览器扩展，把整页存成一个 HTML），
学了它控体积的那几招，没学它把图片、字体转成 base64 塞进文件的做法。

## 两种存法

**整页（默认）。** `<body>` 整个拷一份，导航、侧栏、评论区、页脚都在，长得和原页面一样，只去掉：

- **广告**：class / id 里有 `ad`、`ads`、`advert`、`sponsor` 这类整词的（按 `-` `_` 空格切词，
  `header`、`download` 不会误中），广告联盟的固定写法（`ins.adsbygoogle`、`div-gpt-ad…`），
  加上 `src/site-rules.js` 里 `SITE_ADS` 按站点登记的广告位（豆瓣是 `id="dale_…"`，整个豆瓣都算）
- **脚本和看不见的东西**：`<script>` 这类全删；浏览器模式下 `display: none` 的元素删（`<svg>` 里的不删，
  图标 sprite 本来就是隐藏的）
- **`<iframe>` 换成一样大的空块**：iframe 不能留（能跑别人的页面），可直接删的话靠它撑起来的版面会塌。
  豆瓣首页那一大块背景图的高度就是登录框 iframe 撑的
- **表单留着但不能提交**：去掉 `action`，头上的 CSP 也禁了提交

站点规则的 `prepare` 也跑（豆瓣广播的配图在静态 HTML 里只是脚本里的 JSON），别的规则（删头像、重排引用段）
不跑：整页存就是要原样。

**只存正文（`--article`）。** 正文选哪块和 `--md` 一样（默认规则 / 站点规则），再把正文到 `<body>` 之间的
每一层祖先浅拷贝一份套回去：只要标签和属性，不要兄弟节点。站点 CSS 里 `.article .post p` 这种后代选择器
照样命中。正文上面补一行出处（作者 · 时间 · 原文链接），字体颜色跟着站点走；正文没带标题时再补标题，
标题是拿正文开头凑的站点（微博、豆瓣广播、推文）不补。`<svg>` 留着，`<use href="#icon">` 引用的 sprite
定义从页面别处找来一起带上。

## 图片轮播

Swiper 做的轮播（小红书多图笔记就是）靠 JS 挪 `transform` 换图，存下来不许跑脚本（头上有 CSP），
原样留着就只能停在当时那一张。SingleFile 存出来也是这样。

`src/snapshot.js` 的 `snapCarousels` 把它换成纯 CSS 的：

- loop 模式首尾复制出来的几张（`swiper-slide-duplicate`）去掉，按 `data-swiper-slide-index` 排回原顺序；
  `swiper-wrapper` 上的 `transform` 去掉
- 每张前面一个隐藏的 `<input type=radio>`，当时停在哪张就选中哪个
- 每张里面补上左右箭头、「2/4」页码、一排圆点，都是指向别的 radio 的 `<label>`，点了就切过去；
  第一张没有「上一张」，最后一张没有「下一张」
- Node 那边按页面上最多那个轮播的张数补规则：「第 k 个 radio 没选中 → 第 k 张 `display:none`」。
  只藏不显，留下那张用的还是站点自己的 `display`
- 藏起来的几张去掉 `loading="lazy"`，点过去不用等

站点自己那套箭头、页码要 JS 才动，在规则的 `styledDrop` 里删（小红书：`.fraction`、`.arrow-controller`、
`.slider-pagination-container`）。只有一张图的轮播只去掉复制品和 `transform`，不加控件。

## 评论区

整页存时评论区本来就在，存的是页面上当时已经加载出来的那些。小红书一次只给十来条，往下滚才接着要，
楼中楼收在「展开 N 条回复」后面。

`--load-comments`（要 `--browser` 或 `--attach`）在取材料之前先跑规则的 `expand`：小红书是
`xhsExpandComments`，在笔记右边那栏滚到底等下一批，不再长了就一个个点「展开」。stderr 里报一句加载到哪了：

```
web-extract: 评论加载了 383 / 428 条（点开楼中楼 12 次）
```

**默认不开，开了也很慢**，因为小红书有风控：2026-10-27 第一版每步 1.2–1.8 秒，滚了约 40 次、点了 12 次
「展开」后，小红书弹出「用小红书 APP 扫码验证身份」，页面掉了登录。现在每步 3–5 秒、最多 200 条、5 分钟，
每一步先看有没有弹验证 / 登录框，有就立刻停下、存已经出来的；点一次没反应的「展开」不再点第二次。
评论要得多，就在 `--attach` 的那个浏览器里自己往下滚，滚出来的都会存下来。

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
| **图片默认不转 base64** | （SingleFile 默认转） | 留远程地址；要离线就 `--assets` 存成旁边目录里的文件，要单文件才 `--embed-images`，要单文件又要小用 `--upload-images` 转存图床 |

实测（2026-10-15）：

| 页面 | 方式 | 样式（裁前 → 裁后） | HTML 文件 |
|------|------|------|------|
| 豆瓣广播 | 整页，`--browser --assets` | 317.0 KB → 12.7 KB | 32.3 KB + 18 张图（头像、配图） |
| 豆瓣广播 | 整页，静态 | 252.6 KB → 12.9 KB | 28.8 KB |
| 豆瓣电影条目 | 整页，`--browser --assets` | 385.6 KB → 28.9 KB | 93.4 KB + 30 张图，七个 `dale_` 广告位都去掉 |
| 豆瓣首页 | 整页，`--browser --assets` | 221.5 KB → 158.6 KB | 239.1 KB + 48 张图（首页几十个版块，样式基本都用得上） |
| 豆瓣广播 | `--article`，静态 | 252.6 KB → 1.3 KB | 5.5 KB |
| 公众号贴图 | `--article --browser` | 3204.5 KB → 6.9 KB | 10.1 KB |
| 少数派文章 | `--article --browser` | 446.4 KB → 9.4 KB | 51.9 KB |
| overreacted.io | `--article`，静态 | 26.5 KB → 15.9 KB | 114.9 KB（代码高亮的 span 占大头） |
| 微博 | `--article --browser --assets` | 868.3 KB → 19.9 KB | 23.9 KB + 2 张图 |
| X 推文（带引用推） | `--article --browser` | 321.3 KB → 45.7 KB | 57.9 KB |
| 小红书笔记（4 张图，383 条评论已加载） | 整页，`--attach` | 534.8 KB → 48.3 KB | 1.5 MB（评论区几百条的 DOM 占大头） |
| 同上 | 整页，`--attach --embed-images` | 同上 | 7.6 MB，419 张图（大头是评论头像和背后推荐流的封面） |
| 知识星球主题（5 条评论） | 整页，`--attach` | 176.2 KB → 22.3 KB | 44.5 KB |
| 同上 | 整页，`--attach --embed-images` | 同上 | 1.0 MB，22 张图（图标 sprite 两张占 0.9 MB） |

实测是 2026-10-27，知识星球那两行是 2026-10-28。

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

- `<script>`、`<iframe>`、`<object>`、`<meta>`、`<base>` 这类都删（整页存时 iframe 换成空块）；`on*` 事件属性、
  `javascript:` 地址删；表单只存正文时删，整页存时留着但去掉 `action`
- 头上一行 CSP：`script-src 'none'`、`form-action 'none'`，漏网的也跑不起来、提交不出去
- CSS 里的 `</style` 转义，不能把 `<style>` 提前关掉
- 样式表单个 5 MB、总共 20 MB、最多 100 个、`@import` 最多 5 层、总共 60 秒；`@media` 嵌套超过 32 层
  不再往里拆；图片单张 20 MB、最多 1000 张，回来的不是图片（防盗链给的报错页）不存

## 图片和防盗链

默认留远程地址，加 `<meta name="referrer" content="no-referrer">`：多数图床认「没有 Referer」放行。
豆瓣（`doubanio.com`）不认，浏览器里不带 Referer 一样打不开；微博要 `weibo.com` 的 Referer。
这类站点用 `--assets <目录>`：Node 带原页面（或规则里 `imageReferer`）的 Referer 去下载，
存成 `<sha1>.jpg` 这样的文件，HTML 里用相对路径引用，`srcset` 去掉（不然浏览器还是挑远程那张）。
`<img>`、视频封面、CSS 和行内 style 里的背景图（豆瓣首页的 logo、导航都是背景图）都存。

小红书的图片地址带签名（`sns-webpic-qc.xhscdn.com/<时间>/<签名>/…`），几天后就 403，留远程地址等于没存。
这类站点要 `--embed-images` 或 `--upload-images`。

手机上传来传去时，一个 HTML 加一个图片目录不方便，可以用 `--embed-images`：同样带 Referer 下载，
但塞进 HTML 当 `data:` URI（单张 5 MB、总共 30 MB 封顶，超了的留远程地址）。体积会大很多：
豆瓣那条广播 `--assets` 是 32 KB + 22 张图（约 350 KB），`--embed-images` 是一个 540 KB 的文件。
CSS 里同一张图被几条规则引用（图标 sprite）时只塞一份，放进 `:root` 的变量，各处写 `var()`：
知识星球的 sprite 被七八条规则引用，每处一份的话 CSS 是 4.8 MB，只塞一份是 0.9 MB。
默认不开，和 `--assets` 二选一。

`--upload-images` 转存到自己的图床（阿里云 OSS，或者 PicGo 这类自定义命令），HTML 里换成图床地址：
一个文件、体积小、长期有效。配置不进仓库，见 [image-host.md](image-host.md)。三种存法只能选一种。
存图上限：单张 20 MB（塞进 HTML 时 5 MB），最多 1000 张（小红书一条热门笔记几百条评论，每条一个头像）。

字体不存，仍是远程地址：一套字体几 MB，不值。字体跨域要 CORS，原站没开就退回系统字体。

## 已知边界

- **iframe 里的东西没了。** 嵌入的视频、登录框、第三方评论区只剩一个一样大的空块。SingleFile 会把 frame
  的内容也存下来，这里没做。
- **shadow DOM 里的东西没了。** Web Components 渲染在 shadow root 里的内容 `cloneNode` 拷不到。
- **广告靠认词。** 类名里不带广告词、也没在 `SITE_ADS` 登记的广告位删不掉，遇到一个登记一个；
  反过来，类名里真有个 `ad` 整词但不是广告的也会被删。
- **`--attach` 会把浏览器扩展塞进页面的东西一起存下来**（`--browser` 用的是干净 profile，没有扩展）。
- **只存正文时，站点规则重排过的块是新节点。** 推特、豆瓣转发的引用段是规则拼出来的（为了 Markdown 版式统一），
  没有原站类名，长得是浏览器默认样式；骨架上的固定高度和 `overflow: hidden` 一律压掉（SPA「整屏 + 内部滚动」
  的布局不压正文就被截在一屏里），`position: fixed / sticky` 的祖先改成普通定位。
- **静态模式看不到计算样式。** 看不见的元素删不掉，JS 改过的样式、靠脚本显示的内容都还是 HTML 里原来的样子；
  要和浏览器里看到的一样用 `--browser`。
- **没有页面宽度适配。** 原站是 950px 定宽的（豆瓣），手机上打开也是 950px，和原站在手机浏览器里一样。
