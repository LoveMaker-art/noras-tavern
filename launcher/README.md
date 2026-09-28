# 桌面启动器

- `ui/index.html` 是正式页面；`ui/launcher-controller.js` 处理交互状态。
- `ui/assets/` 是随包图像和图标，三平台使用同一份诺拉素材。
- `desktop/` 是 Electron 壳、IPC、后台任务和平台打包配置。
- `bridge.py` 将界面操作交给部署模块。
- `previews/` 是设计历史，不作为桌面主入口。其旧相对路径在生成的交付布局中预览。

安装、更新与卸载实现归属 [deployment](../deployment/README.md)，不是在启动器里重复维护一套。桌面配置中的相对路径描述最终交付布局，由 `tooling/source-layout.json` 生成。

无打包开发预览、真实安装测试和三平台封装命令见 [CONTRIBUTING.md](../CONTRIBUTING.md)。直接用浏览器打开 `ui/index.html` 是前端模拟，不代表后台已安装或配对成功。
