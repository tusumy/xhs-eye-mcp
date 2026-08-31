# 小红书眼睛（XHS Eye MCP）

独立、只读的小红书 MCP 服务。把小红书 App 的分享短链或带 `xsec_token` 的完整链接交给 `xhs_peek`，服务会：

- 读取标题、正文、作者、互动数据与页面中已有的首屏评论；
- 下载图文笔记配图并作为 MCP 图片内容块返回；
- 下载视频笔记，使用 ffprobe/ffmpeg 均匀抽取 4–8 帧并按顺序返回；
- 在不支持图片内容块的客户端中使用 `image_mode="url"`，退回文字和媒体直链。

服务只接受小红书页面和小红书 CDN 域名，不提供任意 URL 代理；所有工具均为只读。OAuth 只授予 `xhs:read`，使用授权码 + PKCE，并支持 refresh token。

安全与资源边界：

- 页面跳转和媒体跳转的每一跳都会重新检查域名；媒体只允许 HTTPS；
- 结果缓存 6 小时，视频下载硬上限 200 MB；
- 每次最多返回 12 个图片内容块，Base64 图片数据还受单独的总量上限约束；
- 过期缓存和 OAuth 临时记录由每小时清理任务删除；
- OAuth access token、refresh token 和授权码只以摘要形式存储，一次性凭证使用强一致原子更新；
- 动态客户端注册仅接受 ChatGPT 或本机回调，客户端信息使用签名载荷而不是永久记录；
- 工具参数在服务端再次校验，`xhs_peek` 标记为只读、非破坏性操作。

## 部署到独立 Netlify Site

1. 新建 Site 并连接本仓库。仓库根目录就是项目根目录，Base directory 留空。
2. 设置环境变量：
   - `XHS_EYE_APPROVAL_TOKEN`：安全随机授权码，只放在 Netlify 环境变量中；连接 ChatGPT 时粘贴它。
   - `XHS_MAX_VIDEO_MB=200`
   - `XHS_CACHE_HOURS=6`
3. 部署后先访问 `https://你的域名/health`，应返回 `{ "ok": true }`。
4. OAuth discovery 位于 `/.well-known/oauth-authorization-server`，MCP endpoint 位于 `/mcp`。
5. 在 ChatGPT Developer mode 的 Plugins 页面新建连接，填写 `https://你的域名/mcp`，扫描 `xhs_peek` 并完成 OAuth 授权。

## 本地验证

```bash
npm install
npm run check
```

`npm test` 同时执行 ffmpeg 与 ffprobe 的可执行检查；`npm run check` 还会用与 Netlify 相同的 esbuild 目标完成函数打包、导入和 250 MB 大小检查。生产环境要求 Node.js 22+；Netlify 构建会把两套二进制一并打包进 MCP 函数。
