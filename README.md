# VRC Video Allowlist QuickEdit

一个用于快速批量编辑 VRChat 世界播放器域名白名单 `Video Player Allowed Domains` 的 Tampermonkey 用户脚本。

## 功能

- 自动读取当前世界的域名白名单
- 批量输入域名或完整 URL
- 自动保留第一条并删除下方重复域名
- 点击“自动排序”后按域名层级分组排序
- 保存前显示新增、删除和数量变化
- 没有修改时不请求 API
- 站内切换页面时保留未保存草稿

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

清空文本框并保存会清空该世界的自定义播放器白名单。

```text
example.com
cdn.example.com
video.example.net
```

支持换行、空格、中英文逗号和分号。完整 URL 会自动转换为域名。

```text
https://example.com/video/test.m3u8
https://cdn.example.com/path/file.mp4
```

## 安全与权限

- 脚本只在 `https://vrchat.com/home` 及其子路径运行。
- API 请求使用浏览器当前的 VRChat 登录会话

## 注意事项

- VRChat 官方默认播放器白名单与世界自定义 `Video Player Allowed Domains` 并不完全相同。
- Android 平台要求视频使用 HTTPS。
- 用户仍可能需要在 VRChat 设置中允许不受信任的 URL。

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
