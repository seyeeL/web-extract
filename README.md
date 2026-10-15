# web-extract

提取网页正文，转成干净的 Markdown，同时给出标题、作者、发布时间。

Extract the main content of a web page as clean Markdown, with title, author and publish date. Default rules that work on most article pages, plus hand-written site rules where they fall short: WeChat 公众号, 微博 (Weibo), 小红书 (Xiaohongshu), X/Twitter, 知识星球 (zsxq), GitHub Gist and 豆瓣广播 (Douban statuses). `--html` saves the page with the site's own styles (ads, scripts and unused CSS stripped) as a single small HTML file.

一份代码三种用法：

- **命令行**：`web-extract parse <url> --md`，静态抓取或用 headless Chrome 渲染后提取
- **库**：浏览器里直接 import（不依赖任何包），Node 里配 linkedom
- **Agent Skill**：[`skills/web-extract/SKILL.md`](skills/web-extract/SKILL.md)，教 AI 什么时候、怎么用这个 CLI，设计照搬 [kepano/obsidian-skills 的 defuddle](https://github.com/kepano/obsidian-skills/blob/main/skills/defuddle/SKILL.md)

从 [simplenote-clipper](https://github.com/seyeeL/simplenote-clipper) 的页面解析部分拆出来，那个扩展现在用的是这里的副本。

## 安装

要 Node 22+。

```bash
npm install -g github:seyeeL/web-extract
# 或者不装，直接跑
npx github:seyeeL/web-extract parse <url> --md
```

`--browser` / `--attach` 还要一个本机 Chrome（或 Edge）。找不到时用 `CHROME_PATH` 环境变量指一个。

## 命令行

```bash
web-extract parse <url> --md              # Markdown
web-extract parse <url> --json            # 元信息 + markdown + html
web-extract parse <url> -p title          # 单个字段
web-extract parse <url> --md -o out.md    # 写文件
web-extract parse <url> --html -o out.html  # 带原站样式的单文件 HTML（见下）
web-extract parse <url>                   # 清洗后的正文 HTML
```

`--json` 的字段：

| 字段 | 说明 |
|------|------|
| `url` | 来源地址。跟完重定向；X 的 status 链接去掉 `?s=46&t=…` 这类分享参数 |
| `title` | 标题。没有独立标题的站点（微博、推文）取正文开头 |
| `author` | 作者 |
| `publishedAt` | 发布时间，原样给出（站点给什么格式就是什么格式，X 是本机时区的 `YYYY-MM-DD`） |
| `siteName` | 站点名，`og:site_name`，没有就用域名 |
| `domain` | 域名，去掉 `www.` |
| `markdown` | 正文 Markdown。站内相对链接和图片地址已补成绝对地址（按页面地址或 `<base href>`） |
| `html` | 清洗后的正文 HTML |

`-p` 接受上面的字段名，另有 `published`、`site`、`content` 三个别名。

### 抓取方式

| 方式 | 参数 | 适合 |
|------|------|------|
| 静态 | （默认） | 服务端直出 HTML 的页面：博客、新闻、文档站。几百毫秒 |
| 浏览器 | `--browser` | 正文靠 JS 渲染的：X、微博、公众号。起一个一次性 profile 的 headless Chrome，十几秒 |
| 连已开的浏览器 | `--attach [--port 9222]` | 要登录态的：小红书、知识星球。不导航、不读 cookie，只在已打开的 tab 里跑提取 |

静态抓取有 30 秒超时（`--timeout`）和 20 MB 上限，按响应头或 `<meta>` 识别 GBK 这类编码。
浏览器模式页面 load 之后再等 5 秒（`--wait`）给首屏 JS 把正文塞进 DOM；headless 的 UA 会换成
同版本的普通 Chrome，不然 X 直接 403。

`--attach` 要那个浏览器带调试端口启动，并且已经打开了目标页：

```bash
chrome --remote-debugging-port=9222 --user-data-dir=<一个专门的目录>
web-extract parse "<url>" --attach --md
```

正文不到 100 个字符时 stderr 会提示下一步怎么办（换 `--browser`、换 `--attach`，或者告诉你被跳到了哪个落地页），stdout 照常输出。

### 带样式的 HTML

`--html` 存一个能单独打开的 HTML，长得和原页面一样：默认整页，只去掉广告、脚本和看不见的元素；
`--article` 只存正文（导航侧栏评论区都不要）。站点 CSS 只留页面上用到的那部分，图片不转 base64，留远程地址：

```bash
web-extract parse <url> --browser --html -o page.html --assets page_files   # 整页，图片存到本地
web-extract parse <url> --html --article -o page.html                       # 只存正文
```

豆瓣、微博这类有防盗链的站点，离开原站图片打不开，加 `--assets <目录>` 把图片（含 CSS 背景图）下载到
HTML 旁边，用相对路径引用。体积和抓不到的样式表报在 stderr。怎么裁、实测体积、边界：
**[docs/styled-html.md](docs/styled-html.md)**。

其它参数：

| 参数 | 作用 |
|------|------|
| `--wx` | 用微信 UA（公众号链接需要） |
| `--user-agent <UA>` | 自定义 UA |
| `--headed` | 浏览器模式开真窗口（挪到屏幕外），不用 headless |
| `--plain` | Markdown 去掉所有格式标记，只留文字、图片、列表和表格。给排版坏掉的页面用：公众号编辑器有把三千字正文塞进一个 `<h1>` 的，照标题渲染会压成一行 |
| `--no-replies` | 不收主贴底下的回复（目前只有 X 的规则收回复，默认收） |
| `--url <地址>` | 输入是本地文件或标准输入（`-`）时，告诉提取器原始地址，决定命中哪条站点规则 |

退出码：0 成功，1 抓取或运行出错，2 参数用错。

## 当库用

浏览器里（扩展的 content script、书签脚本），`src/` 下的文件不依赖任何包：

```js
import { extractArticle, htmlToMarkdown } from './src/index.js';

const article = extractArticle(document, location.href, { withReplies: true });
// article.root 是清洗过的克隆节点，页面本身不会被改动
const markdown = htmlToMarkdown(article.root);
```

`extractDocument(document, url, options)` 一步给出和 CLI `--json` 一样的对象。

Node 里：

```js
import { extractHtml, extractUrl, styledHtml } from 'web-extract/node';

const fromHtml = extractHtml(html, 'https://example.com/post');
const fromUrl = await extractUrl('https://example.com/post', { plain: false });

// 带样式的单文件 HTML（要联网抓样式表，所以是异步的）
// articleOnly: true 只存正文，不给就整页（去广告）
const { html: page, warnings, stats } = await styledHtml(html, 'https://example.com/post');
```

浏览器渲染：

```js
import { extractUrlInBrowser } from 'web-extract/browser';

const result = await extractUrlInBrowser('https://x.com/u/status/123');
```

### 给下游复制文件时

浏览器模式会把 `src/site-rules.js`、`html2md.js`、`extract.js`、`snapshot.js`、`result.js`、`dump.js` 去掉 import / export 拼成一段脚本注进页面，所以这几个文件的 import **只能写单行**，顶层名字不能互相重名（`tests/cli.test.mjs` 里有用例守着）。

扩展这类没有打包工具的下游可以直接复制 `src/extract.js`、`src/html2md.js`、`src/site-rules.js` 三个文件用。复制过去别在下游改，改这里再同步。

## Agent Skill

[`skills/web-extract/SKILL.md`](skills/web-extract/SKILL.md) 告诉 AI：要网页正文时优先用这个 CLI 而不是 WebFetch，什么站点要加 `--browser` / `--attach`，抓空了怎么办。

Claude Code 里当插件装：

```
/plugin marketplace add seyeeL/web-extract
/plugin install web-extract@web-extract
```

其它工具（Codex 等）把 `skills/web-extract` 目录链接或复制到对应的 skills 目录即可。

## 站点规则

大部分文章页走默认规则就能抓：先按 `article`、`main`、`.post-content` 这类语义选择器猜正文容器，猜不中就按「段落文字量 × (1 - 链接密度)」打分，最后在克隆体上删噪声（导航、推荐、评论区……）。

默认规则对付不了的站点写了专用规则（`src/site-rules.js`）：

| 站点 | 要点 |
|------|------|
| 微信公众号 | 普通图文、纯文字分享、贴图三种版式；正文挂在 `share` 类名上也不误删 |
| 微博 | 九宫格配图换原图；没有标题，取正文开头 |
| 小红书 | 正文分段靠 `\n`；发布时间从 `__INITIAL_STATE__` 取；要登录态 |
| X / Twitter | 按 URL 框出主推；引用推文、回复排成引用段；视频留封面；日期从推文 id 算 |
| 知识星球 | 独立详情页和主页详情浮层都只收那一条主题；正文分段靠 `\n`；要登录态 |
| GitHub Gist | 多文件都收，不带页头和评论；时间是创建时间（页头那个是「Last active」） |
| 豆瓣广播 | 只管广播详情页；配图从脚本里的 JSON 造出来；转发的原广播排成引用段；回应要 `--browser` |

每个站点怎么取、实测过哪些页面、踩过什么坑、怎么加新站点：**[docs/sites.md](docs/sites.md)**。

## 抓不到正文怎么查

```bash
web-extract dump "<url>" [--browser]   # 页面里文字量最大的容器，正文到底在哪
web-extract parse "<url>" --json       # 提取选中了什么
```

两者对不上就是选容器的问题（改 `src/extract.js` 的 `PREFERRED` 或 `scoreNode`，或者给站点写 `root`）；选对了但 markdown 很短，就是被噪声过滤误删了（改 `ALWAYS_JUNK` / `WEAK_JUNK`，或者在规则里用 `keep` 豁免）。

## 已知边界

- **默认规则是按页面结构猜的。** 论坛、瀑布流、SPA 这类页面会漏，遇到一个验一个写站点规则。
- **噪声过滤按 class / id 命名猜，会误伤。** 命名带 `share`、`nav`、`footer` 这类弱证据词但文字量大、不是链接堆的容器会保留；正文容器要是被命名成 `related` / `comments` 就一定会丢。
- **静态模式只看服务端 HTML。** JS 渲染的正文要 `--browser`；要登录的要 `--attach`。
- **公众号会限频。** 同一台机器短时间请求多了会跳人机验证页（`wappoc_appmsgcaptcha`），这时只能在自己的浏览器里打开后 `--attach`。

## 开发

```bash
npm ci
npm test
```

测试用 Node 原生 test runner。`html2md` 用手搓的假节点（`tests/fake-dom.mjs`），提取和站点规则用 linkedom 跑离线 DOM，不依赖网络和登录态。

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：个人使用、学习、研究、非营利组织可以免费用和改，商用要先找我授权。
