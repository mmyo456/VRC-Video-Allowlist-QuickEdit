# VRC Video Allowlist QuickEdit

一个用于快速批量编辑 VRChat 世界播放器域名白名单 `Video Player Allowed Domains` 的 Tampermonkey 用户脚本。

它会在 VRChat 世界编辑页面右下角添加一个轻量面板，自动读取当前白名单，并允许你一次性修改、去重和保存多个域名。

## 功能

- 自动读取当前世界的 `Video Player Allowed Domains`
- 批量粘贴和编辑域名
- 支持换行、空格、中英文逗号或分号分隔
- 自动删除下方重复域名
- 自动排序按完整域名自然排序
- 不保存 Cookie、密码或 Token

## 安装

### 1. 安装用户脚本管理器

在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。

### 2. 安装脚本

[点击安装 VRC Video Allowlist QuickEdit](https://raw.githubusercontent.com/mmyo456/VRC-Video-Allowlist-QuickEdit/main/vrc-video-allowlist-quickedit.user.js)

如果浏览器没有自动打开安装页面，也可以下载
`vrc-video-allowlist-quickEdit.user.js`，然后将其导入 Tampermonkey。

## 使用方法

1. 登录 [VRChat 网站](https://vrchat.com/home)。
2. 打开你拥有的世界，并进入世界编辑页面。
3. 点击右下角的“播放器白名单”面板。
4. 在文本框中添加、删除或粘贴域名。
5. 点击“保存修改”。
6. 检查变更摘要，确认后提交。

文本框中的内容会作为最终白名单整体保存。清空文本框并提交，将清空该世界的 `Video Player Allowed Domains`。

## 输入示例

每行输入一个域名：

```text
example.com
cdn.example.com
video.example.net
```

也可以直接粘贴完整 URL：

```text
https://example.com/video/test.m3u8
https://cdn.example.com/path/file.mp4
```

脚本会自动转换为：

```text
example.com
cdn.example.com
```

以下输入方式也受支持：

```text
example.com, cdn.example.com; video.example.net
```

## 自动去重

如果同一个域名出现多次，脚本会：

1. 保留最上方第一次出现的域名；
2. 删除下面的重复项；
3. 显示本次自动删除的数量。

域名比较不区分大小写，完整 URL 会先提取主机名再参与比较。

## 安全与权限

- 脚本只在 `https://vrchat.com/home/*` 页面运行。
- 编辑面板只会在世界编辑路径中显示。
- API 请求使用浏览器当前的 VRChat 登录会话。
- 脚本不会读取、保存或上传你的密码和登录凭据。
- 只有当前账号有权编辑的世界才能成功保存。
- 保存前会重新读取服务器数据并要求确认。

建议只从本仓库安装脚本，并在更新前检查代码变更。

## 工作原理

脚本从当前编辑页面取得世界 ID，然后：

1. 使用 `GET /api/1/worlds/{worldId}` 读取最新世界信息；
2. 规范化并校验输入的域名；
3. 显示本次新增和删除数量；
4. 使用 `PUT /api/1/worlds/{worldId}` 保存更新后的 `Video Player Allowed Domains`。

请求为 VRChat 同源请求，会自动使用当前浏览器会话。

## 注意事项

- VRChat 官方默认播放器白名单与世界自定义 `Video Player Allowed Domains` 并不完全相同。
- Android 平台要求视频主机使用 HTTPS。
- 用户仍可能需要在 VRChat 设置中允许不受信任的 URL。
- VRChat 网站或 API 更新后，脚本可能需要同步调整。

有关播放器允许列表的详细规则，请参阅
[VRChat 官方文档：Video Player Allowlist](https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/)。

## 问题反馈

如果遇到读取失败、保存失败或页面更新导致的兼容性问题，请在
[GitHub Issues](https://github.com/mmyo456/VRC-Video-Allowlist-QuickEdit/issues)
中提交问题，并附上：

- 浏览器与版本
- Tampermonkey 版本
- 操作步骤
- 错误提示
