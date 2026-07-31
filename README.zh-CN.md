# Altair

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

![Altair](docs/brand/header.svg)

**ALTAIR** — **A**uthoring & **L**ocalization **T**oolkit for **A**daptation, **I**nterchange, and **R**evision

Altair 是视觉小说的创作与本地化工具。它把场景、台词、素材、语言、预览和剧情流程
放在同一个可编辑工作区中。


## Altair 能做什么

- 用可视化控件编辑台词和剧情操作。
- 管理任意数量的项目语言及其字体。
- 编辑时直接使用 Vega 预览当前场景。
- 通过插件导入、转换和导出不同项目格式。
- 浏览素材、查看流程图、管理历史、草稿和插件。

作品语言由创作者设置。不同来源的语言和服务器规则由对应插件处理。

## 开始使用

[First Light](https://github.com/haneoka-gakuen/vega-example-first-light)
是可以直接在 Altair 中打开的示例项目。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

[Vega](https://github.com/haneoka-gakuen/vega) 负责播放，
[Deneb](https://github.com/haneoka-gakuen/deneb) 负责发布构建。

Altair 以 MPL-2.0 发布。
