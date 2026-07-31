# Altair

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

![Altair](docs/brand/header.svg)

**ALTAIR** — **A**uthoring & **L**ocalization **T**oolkit for **A**daptation, **I**nterchange, and **R**evision

Altair はビジュアルノベルの制作・ローカライズツールです。シーン、台詞、素材、
言語、プレビュー、ストーリーフローを一つの編集可能なワークスペースにまとめます。

## できること

- ビジュアル操作で台詞とストーリー動作を編集
- 任意数の作品言語とフォントを管理
- 編集中のシーンを Vega で直接プレビュー
- プラグインによるプロジェクト形式の読み込み、変換、書き出し
- 素材、フローチャート、履歴、下書き、プラグインの管理

作品の言語は制作者が設定します。外部ソース固有の言語・サーバールールは、
対応するプラグインが処理します。

## はじめる

[First Light](https://github.com/haneoka-gakuen/vega-example-first-light)
は Altair で直接開けるサンプルプロジェクトです。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

再生には [Vega](https://github.com/haneoka-gakuen/vega)、
配布ビルドには [Deneb](https://github.com/haneoka-gakuen/deneb) を使用します。

Altair は MPL-2.0 で公開されています。
