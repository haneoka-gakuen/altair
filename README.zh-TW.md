# Altair

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

![Altair](docs/brand/header.svg)

**ALTAIR** — **A**uthoring & **L**ocalization **T**oolkit for **A**daptation, **I**nterchange, and **R**evision

Altair 是視覺小說的創作與本地化工具。它把場景、對白、素材、語言、預覽與劇情流程
放在同一個可編輯工作區中。


## Altair 能做什麼

- 用視覺化控制項編輯對白與劇情操作。
- 管理任意數量的專案語言及其字型。
- 編輯時直接使用 Vega 預覽目前場景。
- 透過外掛匯入、轉換及匯出不同專案格式。
- 瀏覽素材、查看流程圖、管理歷史、草稿與外掛。

作品語言由創作者設定。不同來源的語言和伺服器規則由對應外掛處理。

## 開始使用

[First Light](https://github.com/haneoka-gakuen/vega-example-first-light)
是可以直接在 Altair 中開啟的範例專案。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

[Vega](https://github.com/haneoka-gakuen/vega) 負責播放，
[Deneb](https://github.com/haneoka-gakuen/deneb) 負責發布建置。

Altair 以 MPL-2.0 發布。
