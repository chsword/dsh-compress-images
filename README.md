# dsh-compress-images

为 **DeepSeek Harness (DSH)** 添加 `/compress-images` 指令：在本地压缩**当前会话已经存在的历史图片**，让后续模型请求使用较小的副本，而不是只处理新上传的图片。

整个过程不调用模型、不上传图片，不需要先通过一次可能已经超大的模型请求。适用于包含截图、工具返回图片的长会话。

## 要求

- DeepSeek Harness **0.2.2-rc.3**。目前仅声明支持这一版本，其他版本需要验证。
- Node.js **24.9.0 或更新版本**（DSH CLI 的要求）；也可使用 DSH Desktop 自带的兼容运行时。
- `sharp` 支持的运行环境。Windows、macOS、Linux 的常见平台可使用其预编译依赖。

## 安装

### 安装到 Desktop

```powershell
dsh plugin --profile desktop add github:chsword/dsh-compress-images
```

安装后**彻底退出并重新打开 DSH Desktop**，在聊天输入框中输入 `/compress-images`。

如果终端找不到 `dsh`，但已经安装兼容的 Node.js，可以使用：

```powershell
npx --yes @deepseek-ai/dsh@0.2.2-rc.3 plugin --profile desktop add github:chsword/dsh-compress-images
```

两种方式应使用与 Desktop 相同的用户和 `DSH_HOME`，否则可能安装到另一套 profile。

### 安装到 Web 或其他 profile

```powershell
dsh plugin --profile web add github:chsword/dsh-compress-images
```

把 `web` 替换为实际使用的 profile，然后重启对应 DSH 实例。

仓库包含构建好的 `dist/`，从 GitHub 安装不需要执行本插件的构建脚本。生产环境建议把 GitHub 地址固定到审核过的提交，例如：

```powershell
dsh plugin --profile desktop add github:chsword/dsh-compress-images#完整提交SHA
```

安装仍会获取 `sharp` 等运行依赖。不要为了安装而全局放开不相关包的构建脚本权限；如果平台缺少预编译二进制，请按照 `sharp` 的平台安装说明处理。

## 使用

先停止当前模型回复、工具执行或上下文压缩，等待会话空闲。

```text
/compress-images
```

默认策略：

- 单图目标上限 **200 KiB**。
- 最长边上限 **1600 px**，保持比例，不放大小图。
- 输出 WebP，逐级降低质量；必要时继续缩小尺寸，但最长边不会主动降到 256 px 以下。
- 已满足限制的图片不重新编码；重复引用的同一附件只压缩一次。

自定义限制：

```text
/compress-images --max-kb 150 --max-edge 1280
```

只预览压缩结果，不保存图片、不替换历史：

```text
/compress-images --max-kb 150 --max-edge 1280 --dry-run
```

`--max-kb` 范围为 16–4096 KiB，`--max-edge` 范围为 256–8192 px。无效参数会明确报错，不会静默忽略。

## 它如何处理历史图片

1. 通过 DSH 的会话投影，定位当前模型可见历史里的用户图片和工具结果图片。
2. 读取并校验附件，在本机生成压缩副本。
3. 检查保存后的实际字节数和尺寸，确保比原图小且满足限制。
4. 所有图片准备成功后，一次性提交标准会话替换事件，仅替换模型上下文中的图片引用。
5. 等待会话持久化。后续请求以及重启后恢复的会话使用压缩版本。

不会直接改写原附件文件，也不会修改过去的日志行。消息身份、文字、顺序及工具调用 ID 保留；原始图片仍可留在历史界面和附件存储中。

不引入自定义必需会话事件：替换使用 DSH 自带的事件格式，移除插件后压缩后的上下文仍可恢复。

## 限制和安全边界

- **有损压缩可能降低截图文字、细线或图表的可读性**。优先使用 `--dry-run`，重要视觉细节应保留原图或重新提供必要的局部截图。
- 仅处理当前会话的当前有效历史，不批量修改其他会话，也不重新启用已经卸载的图片。
- 动图会明确拒绝处理，避免静默丢帧；无法在尺寸下限内达到目标时也会报错。
- 压缩失败、取消或发现会话在处理期间发生变化时，不提交历史替换。此前已生成但未被引用的新附件可能保留，原会话不受影响。
- 如果提交成功但磁盘持久化失败，指令会明确提示“历史已更新，但持久化无法确认”，不要盲目重复操作。
- 原图和旧日志保留，所以这是**降低后续请求大小**，不是回收磁盘空间，也不是抹除敏感内容。
- 图像字节数不是最终 HTTP Body 大小。Base64 通常增加约三分之一，最终请求还包含文字、工具定义及协议结构。
- 不保证解决上游的所有 `400`、超时或请求格式错误；应比较压缩前后实际请求大小与成功率。
- 不自动压缩后续新增图片；需要时再次运行指令。已有图片符合当前限制时不会重复有损编码。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-compress-images
```

重启 DSH。已经提交的压缩引用仍然有效，原附件不会被删除。

## 本地开发

```powershell
git clone https://github.com/chsword/dsh-compress-images.git
cd dsh-compress-images
npm ci
npm run check
```

代码使用 TypeScript，构建输出提交到 `dist/`，以便 GitHub 直接安装。修改源码后需要运行构建并提交相应产物。

测试使用合成图片和独立临时目录，不读取真实会话、配置或 API Key。

## License

[MIT](./LICENSE)
