---
name: web-extract
description: Extract clean Markdown (title, author, publish date, body) from a web page with the web-extract CLI. Prefer over WebFetch when you need the article itself - it strips navigation, ads, comments and recommendation lists, and has site rules for WeChat 公众号 (mp.weixin.qq.com), 微博, 小红书, X/Twitter, 知识星球 (wx.zsxq.com), GitHub Gist and 豆瓣广播. Use --browser for JS-rendered pages; --html saves the page with the site's styles (ads stripped) as one HTML file.
---

# web-extract

用 web-extract CLI 把网页正文提取成干净的 Markdown。比 WebFetch 省 token：导航、广告、评论区、推荐列表都去掉了，标题、作者、发布时间单独给出来。

没装的话：`npm install -g github:seyeeL/web-extract`（要 Node 22+）

## 用法

默认都带 `--md`：

```bash
web-extract parse <url> --md
```

存成文件：

```bash
web-extract parse <url> --md -o content.md
```

只要某个元信息：

```bash
web-extract parse <url> -p title
web-extract parse <url> -p author
web-extract parse <url> -p publishedAt
web-extract parse <url> -p domain
```

要正文和元信息一起，用 `--json`（字段：`url` `title` `author` `publishedAt` `siteName` `domain` `markdown` `html`）。

## 什么时候加 --browser

默认是静态抓取：直接请求 HTML，几百毫秒出结果。正文靠 JS 渲染的页面这样抓是空的，要加 `--browser` 起 headless Chrome 渲染后再提取（十几秒）：

| 站点 | 参数 |
|------|------|
| 普通博客、新闻、文档站、GitHub Gist、豆瓣广播 | 不用加（豆瓣要回应时加 `--browser`） |
| X / Twitter、微博 | `--browser` |
| 微信公众号 | `--wx --browser` |
| 小红书、知识星球 | 要登录态：`--attach`（见下） |

正文不到 100 个字符时 stderr 会给提示：静态模式下提示改用 `--browser`，加上重跑；提示里出现「落地地址」且是登录页、验证页（公众号短时间请求多了会跳 `wappoc_appmsgcaptcha`）时，换 `--attach`。别把空结果当成页面没内容。

X 的推文页默认连主推底下的回复一起收，只要主推加 `--no-replies`。

## 要登录才给内容的站点

`--browser` 用的是一次性的干净 profile，没有登录态。小红书这类站点会被风控拦掉。让用户在自己的 Chrome 里登录并打开目标页（Chrome 要带 `--remote-debugging-port=9222` 启动），然后：

```bash
web-extract parse <url> --attach --md
```

它只连上去在那个 tab 里执行提取，不读 cookie、不导航。

## 本地文件和标准输入

```bash
web-extract parse page.html --md --url https://example.com/post   # --url 决定命中哪条站点规则
cat page.html | web-extract parse - --md
```

## 输出格式

| 参数 | 格式 |
|------|------|
| `--md` | Markdown（默认选这个） |
| `--json` | JSON，元信息 + markdown + html |
| （不带） | 清洗后的正文 HTML |
| `-p <name>` | 单个字段 |
| `--plain` | 配合 `--md`：去掉所有格式标记，只留文字和图片（排版坏掉的页面用） |
| `--html` | 带原站样式的单文件 HTML（用户要「保留原网站样式」「存成网页」时用），配 `-o page.html`。默认整页只去广告；只要正文加 `--article`；图片打不开的站点（豆瓣、微博）再加 `--assets page_files` 把图存到本地，要单个文件发给别人用 `--embed-images` |

## 抓得不对时

```bash
web-extract dump <url> [--browser]
```

列出页面里文字量最大的几个容器。和 `parse` 选中的正文对不上，说明需要给这个站点写规则 —— 告诉用户，别反复换参数重试。

退出码：0 成功，1 抓取/运行出错（网络、403、超时），2 参数用错。
