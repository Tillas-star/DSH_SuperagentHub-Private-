# 手机文件 · 只读手机浏览器

在电脑上运行一个只读的小型 Web 服务，用手机浏览器浏览指定文件夹和图片。支持三种访问方式：

- **本机**：只监听 `127.0.0.1`，适合调试；
- **同一局域网**：`--lan` 监听网卡，手机扫码配对；
- **外网**：只监听回环，通过 Tailscale Serve / Cloudflare Tunnel 等隧道访问，使用访问密码登录。

实现对应 `docs/proposals/mobile-file-browser.md` v0.2 的 M1–M4，并包含 M5 中不依赖额外账号的部分（README、跨平台 CI、缓存清理、终端二维码等）。没有上传、删除、重命名、移动、新建、编辑或下载按钮。

> 仓库位置：`apps/mobile-file-browser/`，不修改 DSH 本体。

## 功能

- 目录浏览：进入子目录、面包屑、切换根目录、隐藏文件过滤、自然排序、条目上限。
- 图片浏览：网格缩略图、全屏查看、左右滑动/按钮切换、点击放大、双指缩放、相邻图预加载、省流量模式。
- 认证：局域网一次性配对链接（放在 URL `#fragment`）、外网访问密码（scrypt）、持久会话 Cookie、失败限流与锁定。
- 安全：路径白名单、路径穿越/符号链接校验、只读接口、CSP 等安全响应头、Host/Origin 校验、可信代理头处理。
- 图片：JPEG/PNG/WebP/GIF/BMP/AVIF；HEIC/HEIF 在服务端转 JPEG 预览（取决于 sharp 构建是否带 HEIC 解码）。
- 缩略图：sharp 按需生成 WebP，磁盘缓存，并发上限 4，启动时清理过期/超量缓存。

## 环境要求

- Node.js **22.12 或更高**（22 LTS 推荐）。
- Windows / macOS / Linux。Windows 优先适配。
- `sharp` 依赖预编译二进制；首次 `npm ci` 需要网络。

## 快速开始

```bash
cd apps/mobile-file-browser
npm ci
npm run build
npm start -- --lan --root "C:\Users\me\Pictures" --root "C:\Users\me\Desktop"
```

macOS / Linux 把路径换成 `~/Pictures` 即可。

启动后终端会打印：

```text
模式      局域网（所有网卡）
本机访问  http://127.0.0.1:8787/#pair=...
局域网    http://192.168.x.x:8787/#pair=...
[二维码]
会话有效期 30 天；Ctrl+C 退出
```

手机和电脑连同一个 Wi-Fi，用相机扫码打开即可配对。配对链接 10 分钟内有效、只能使用一次；服务重启会生成新链接。

只监听本机（不开放局域网）：

```bash
npm start -- --root "$HOME/Pictures"
```

## 外网访问

外网模式**不开放路由器端口**，也不要求公网 IP。电脑只监听 `127.0.0.1`，由隧道客户端把请求转发进来。

### 1. 设置访问密码

```bash
npm start -- --set-password
```

至少 12 个字符，输入不回显，只保存 scrypt 哈希（`password.json`，权限 0600）。忘记密码只能在电脑上重新设置。

### 2. 启动并声明公网地址

以 Tailscale Serve 为例（电脑和手机安装 Tailscale、登录同一 tailnet，并在管理后台启用 HTTPS）：

```bash
# 电脑上
npm start -- --root "$HOME/Pictures" --public-url https://my-pc.tailnet-xxxx.ts.net

# 另一个终端
tailscale serve --bg 8787
tailscale serve status
```

手机切到 4G/5G，打开 `https://my-pc.tailnet-xxxx.ts.net`，输入访问密码。

Cloudflare Tunnel（需要 Cloudflare 账号；命名隧道通常还需要自己的域名）：

```bash
npm start -- --root "$HOME/Pictures" --public-url https://files.example.com
cloudflared tunnel --url http://127.0.0.1:8787
```

在 Cloudflare Zero Trust 中把隧道指向 `http://127.0.0.1:8787`，建议加 Access 策略。`--public-url` 必须与浏览器地址的 scheme + host 完全一致（只接受 `https://`，不能带路径、查询参数或锚点）。

### 3. 撤销

```bash
tailscale serve --https=443 off    # 或关闭 cloudflared
npm start -- --reset-sessions      # 让所有设备立即失效（下次启动时执行）
```

> 不要使用路由器端口映射 + DDNS 直接暴露服务；不要运行无密码的公网隧道。应用仍要求自己的密码，隧道身份层只是额外一层。

## 配置

命令行参数优先于 JSON 配置文件。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--root <路径>` | 必填，可重复 | 允许浏览的根目录；启动时校验并解析真实路径 |
| `--lan` | 关闭 | 监听所有网卡；默认只监听 `127.0.0.1` |
| `--public-url <URL>` | 无 | 外网 HTTPS 源；设置后进入远程模式并要求已设密码 |
| `--set-password` | — | 交互设置/修改访问密码后退出 |
| `--trusted-host <host>` | 无 | 额外允许的 Host，可重复 |
| `--port <端口>` | `8787` | 监听端口 |
| `--config <文件>` | 无 | JSON 配置文件 |
| `--show-hidden` | 关闭 | 显示点号开头的文件/目录 |
| `--max-entries <数量>` | `2000` | 单目录返回上限 |
| `--thumb-width <像素>` | `640` | 缩略图最大边（64–2048） |
| `--thumbs-dir <目录>` | 系统缓存目录 | 缩略图缓存位置 |
| `--thumbs-max-size <容量>` | `2GB` | 缓存上限 |
| `--session-ttl <时长>` | `30d` | 会话有效期（1 分钟–365 天） |
| `--tls-cert` / `--tls-key` | 无 | 本地 HTTPS；通常由隧道终止 TLS，不需要 |
| `--reset-sessions` | 关闭 | 启动时清空所有会话 |
| `--verbose` | 关闭 | 调试日志；不记录完整文件路径和密码 |

配置文件示例：

```json
{
  "roots": [
    { "id": "pictures", "name": "图片", "path": "C:\\Users\\me\\Pictures" },
    { "id": "desktop", "name": "桌面", "path": "C:\\Users\\me\\Desktop" }
  ],
  "lan": false,
  "publicUrl": "https://my-pc.tailnet-xxxx.ts.net",
  "port": 8787,
  "showHidden": false,
  "maxEntries": 2000,
  "sessionTtl": "30d",
  "thumbsMaxSize": "2GB"
}
```

相对路径规则：配置文件里的路径相对于配置文件所在目录，命令行路径相对于当前工作目录。

环境变量：

- `MOBILE_FILES_DATA_DIR`：会话和密码文件目录，默认平台配置目录。
- `MOBILE_FILES_CACHE_DIR`：缩略图缓存根目录，默认平台缓存目录。

## 安全模型

- **只读**：文件接口只注册 `GET`/`HEAD`；文件系统调用只有列目录、`lstat`、`realpath`、`createReadStream`。唯一写入是独立的缩略图缓存目录。
- **路径守卫**：只接受相对路径；拒绝绝对路径、盘符、UNC/设备路径、NUL、`.`/`..`、空段；逐段 `lstat` 拒绝符号链接；最终 `realpath` 必须仍在根目录内。
- **认证**：配对令牌 32 字节随机、只用一次、10 分钟过期；密码用 scrypt（N=2^15, r=8, p=1）保存；会话 Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，HTTPS 下追加 `Secure`。
- **限流**：登录按 IP 每分钟 5 次失败、全局每小时 20 次失败，指数退避，连续失败锁定 15 分钟；配对按 IP 10 分钟最多 10 次失败。
- **远程**：强制 `https://` 公网源；远程模式默认只监听回环；只有来自回环的 `X-Forwarded-*` 才被采信；Host 必须是 `--public-url` 的主机或 `--trusted-host`；跨站 POST 拒绝；HTTPS 下返回 HSTS。
- **响应头**：CSP（无内联脚本/样式）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、COOP/CORP、`X-Robots-Tag: noindex`。
- **无遥测**：不请求外部资源、不加载 CDN/字体、不记录完整文件路径。

### 隐私说明

- 请求会经过你选择的隧道服务。Tailscale 使用 WireGuard，通常只暴露连接元数据；Cloudflare 在边缘终止 TLS，服务商理论上能看到经过的 HTTP 内容。敏感场景优先 Tailscale Serve。
- 缩略图只缓存在本机；缓存目录可手动删除。
- 浏览器自带的长按保存图片不受限制；产品不提供“保存到相册”按钮。

## API

除配对/登录/健康检查外都需要会话 Cookie。文件接口只支持 `GET`/`HEAD`，其他方法返回 405。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 移动端 SPA |
| `GET` | `/healthz` | `{ "ok": true }` |
| `POST` | `/api/session/pair` | `{ token }` 换取会话 Cookie |
| `POST` | `/api/session/login` | `{ password }` 登录 |
| `POST` | `/api/session/logout` | 注销当前会话 |
| `GET` | `/api/session` | 会话状态（是否登录、模式、是否已设密码、配对是否可用） |
| `GET` | `/api/roots` | 根目录列表 |
| `GET` | `/api/directories?root=<id>&path=<相对路径>` | 列出一级子项 |
| `GET` | `/api/thumbnails?root=<id>&path=<相对路径>&w=640` | WebP 缩略图 |
| `GET` | `/api/images?root=<id>&path=<相对路径>&preview=1` | 原图字节流；`preview=1` 时 HEIC 转 JPEG |

错误统一为：

```json
{ "error": { "code": "forbidden-path", "message": "无法访问该位置" } }
```

## 开发与测试

```bash
npm run typecheck      # 服务端 + 前端类型检查
npm test               # Vitest：单元 + Fastify inject 集成测试
npm run build          # tsc + Vite
npm run test:e2e       # Playwright（先 npm run build）
```

E2E 使用临时 `.e2e/` 目录和假图片，不接触真实照片；默认端口 `8791`。当前 E2E 覆盖登录、目录浏览、图片查看/切换、空目录、断连提示与重试、根目录切换。

## 常见问题

- **手机打不开局域网地址**：确认同一 Wi-Fi；路由器“AP 隔离/访客网络”会导致互不可见。Windows 首次监听会弹防火墙提示，只勾选“专用网络”。
- **外网打不开**：先看 `tailscale serve status` 或 `cloudflared` 是否在运行；再确认 `--public-url` 与浏览器地址完全一致。
- **Host 不被允许**：隧道改写了 Host。核对 `--public-url`，或用 `--trusted-host` 加上实际 Host。
- **登录后立刻掉线**：检查浏览器是否阻止 Cookie；HTTPS 的 `Secure` Cookie 不会在 HTTP 页面生效。
- **端口被占用**：换 `--port`。
- **HEIC 显示失败**：sharp 的预编译 libvips 是否带 HEIC 解码取决于平台；失败时页面会提示“这张图片无法显示”。
- **电脑休眠**：远程访问会断开，这是自托管服务的固有边界。

## 已知限制

- 本期未实现可选 TOTP 第二因素、自动拉起隧道（M5 可选）；隧道由用户自行安装和启动。
- 不提供视频、Office/PDF 预览、上传、下载按钮、搜索、OCR、相册聚合。
- 单用户、无分享链接、无权限体系。
- 前端为移动优先；桌面浏览器可用，但不是主要目标。
- 点击/双指放大只做居中缩放，未实现缩放后的拖拽平移。
- 真实 iPhone Safari / Android Chrome 的最终手工验收需要在有实体手机的电脑上完成；CI 使用 Chromium 手机视口。
