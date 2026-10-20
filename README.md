# 知页 · Markdown Notes

面向学生与知识工作者的本地个人 Markdown 笔记与知识管理工具，Windows 桌面基础版 1.0.0。采用 Electron、React、TypeScript 与 SQLite。

## 功能

- Markdown 编辑、安全预览、自动保存与回收站。
- 标签管理、全文搜索、匹配高亮和分页。
- `[[笔记名称]]` 双向引用、自引用、反向链接与原子重命名联动。
- 单篇／批量导出、完整备份、正常恢复与主数据损坏后的故障恢复。
- 业务数据与索引分离、索引重建和容量校验。

基础版不包含云同步、移动端、多人协作；插件与主题按原文档作为 P2 后置。

## 从源码运行

Windows 开发环境需要 Node.js 24 与 npm。首次安装依赖需要网络，构建后的桌面成品可离线使用。

```powershell
cd markdown-notes
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

执行 `npm run package` 后，可直接运行 `markdown-notes/release/知页-win-x64/知页.exe`。请保留整个成品目录。依赖、构建产物、个人资料库及 ZIP 交付包不纳入 Git 版本控制。

## 文档与验证

| 位置 | 内容 |
|---|---|
| [软件使用说明](markdown-notes/README.md) | 功能、操作、数据位置、备份责任与开发命令 |
| [需求分析文档](需求分析文档/01-需求分析文档.md) | 需求基线、场景、范围、优先级与验收规则 |
| [软件设计文档](软件设计文档/01-软件设计文档.md) | 架构、接口、数据、异常处理与测试设计 |
| [实现对照说明](markdown-notes/docs/01-实现对照说明.md) | 需求及设计模块与源码对应 |
| [测试与验收记录](markdown-notes/docs/02-测试与验收记录.md) | 实际执行结果、性能口径及尚未执行的正式验收项 |
| [测试原始记录](markdown-notes/reports) | 自动化日志、性能样本、成品验证及界面截图 |

已执行 27 项核心／集成／容量／安全测试、3 项 Electron 桌面流程测试及成品独立启动验证，均通过。断电、真实新用户任务及部分完整运行预算验证仍待实际执行，详见测试与验收记录。

![编辑与预览界面](markdown-notes/reports/screenshots/知页-编辑与预览.png)
