# 图床（`--upload-images`）

`--html --upload-images` 把页面上的图片（`<img>`、视频封面、CSS 背景图）下载下来，传到你自己的图床，
HTML 里换成图床的地址。和另外两种存法比：

| 存法 | 参数 | 文件 | 图片能活多久 |
|------|------|------|------|
| 留远程地址 | （默认） | 一个，小 | 看原站：小红书的图片地址带签名，几天后就打不开；豆瓣、微博离开原站就打不开 |
| 存到本地目录 | `--assets <目录>` | HTML + 一个图片目录 | 一直在 |
| 塞进 HTML | `--embed-images` | 一个，大（小红书一条热门笔记带几百条评论约 8 MB） | 一直在 |
| 转存图床 | `--upload-images` | 一个，小 | 图床在就在 |

## 配置放哪

**不放进仓库。** 这个仓库是公开的，密钥一旦 push 上去就算泄露了。配置从两个地方读，环境变量优先：

1. 配置文件 `~/.config/web-extract/.env`（`WEB_EXTRACT_ENV` 环境变量可以指到别的文件）
2. 环境变量

只认 `WEB_EXTRACT_` 开头的变量，别的不碰。配置文件建议 `chmod 600`。

没配就用 `--upload-images` 会直接报错（退出码 2），在抓页面之前就报，不白等。

## 阿里云 OSS

```bash
mkdir -p ~/.config/web-extract
cat > ~/.config/web-extract/.env <<'EOF'
WEB_EXTRACT_IMAGE_HOST=oss
WEB_EXTRACT_OSS_ACCESS_KEY_ID=<AccessKey ID>
WEB_EXTRACT_OSS_ACCESS_KEY_SECRET=<AccessKey Secret>
WEB_EXTRACT_OSS_BUCKET=<bucket 名>
WEB_EXTRACT_OSS_REGION=oss-cn-shenzhen
# 可选：对象名前缀，默认 web-extract
WEB_EXTRACT_OSS_PREFIX=web-extract
# 可选：绑了自己的域名 / CDN 就写上，图片地址用它拼；不写用 OSS 默认域名
WEB_EXTRACT_OSS_PUBLIC_BASE=https://img.example.com
EOF
chmod 600 ~/.config/web-extract/.env
```

- 每张图传成**公共读**的对象（`x-oss-object-acl: public-read`），bucket 本身是私有的也没关系
- 对象名是 `<前缀>/<内容的 sha256 前 32 位>.<扩展名>`：同一张图传几次都是同一个对象，不会越传越多
- 带 `Content-MD5`，OSS 会校验内容；`Cache-Control: public, max-age=31536000, immutable`
- 签名用 OSS V1（HMAC-SHA1），不装 SDK
- 出错只报 HTTP 状态码和 OSS 的错误码（`AccessDenied` 这类），不带密钥

**AccessKey 建议单独开一个 RAM 用户**，只给这个前缀的写权限，泄露了也只能往这个目录里写图：

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["oss:PutObject", "oss:PutObjectAcl"],
    "Resource": ["acs:oss:*:*:<bucket 名>/web-extract/*"]
  }]
}
```

## 自定义命令（PicGo、别的图床）

图床不是 OSS 的，给一条命令：收一个本地图片文件，在输出里打印图片地址。

```bash
WEB_EXTRACT_IMAGE_HOST=command
WEB_EXTRACT_UPLOAD_COMMAND=picgo upload {file}
```

- 图片先写进临时目录，`{file}` 换成它的路径（加好了引号）；命令里没写 `{file}` 就接在末尾
- 输出（stdout）里**最后一个** `http(s)://` 地址当作图床地址
- 退出码不是 0、60 秒没跑完、输出里没有地址，这张图就留原地址，stderr 里记一条
- 命令里有单引号时，值用反引号括起来：``WEB_EXTRACT_UPLOAD_COMMAND=`node up.mjs '{file}'` ``

## 失败了会怎样

单张图下载不到、图床拒收，这张留原来的远程地址，stderr 记一条「图片 … 没存下来（原因）」，
别的照常。最后一行报传了几张：

```
web-extract: HTML 1.5 MB（样式 534.8 KB 裁到 48.3 KB，传到图床 419 张图）
```

## 当库用

```js
import { styledHtml } from 'web-extract/node';
import { createImageUploader } from 'web-extract/image-host';

const uploadImage = createImageUploader();   // 读上面的配置；没配抛 ImageHostError
const { html } = await styledHtml(page, url, { uploadImage });
```

`uploadImage` 也可以自己写：`(bytes, { mime, ext, url }) => Promise<图床地址>`。
