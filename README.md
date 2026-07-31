# Altair

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

![Altair](docs/brand/header.svg)

**ALTAIR** — **A**uthoring & **L**ocalization **T**oolkit for **A**daptation, **I**nterchange, and **R**evision

Altair is a visual authoring and localization tool for visual novels. It brings
scenes, dialogue, assets, languages, preview, and story flow into one editable
workspace.

## What Altair does

- Edits dialogue and story commands with visual controls.
- Manages any number of project languages and their fonts.
- Previews the current scene with Vega while you work.
- Imports, converts, and exports projects through plugins.
- Provides asset browsing, flowcharts, history, drafts, and plugin management.

A project chooses its own languages. Source-specific language and server rules
remain in the relevant source plugin.

## Try it

[First Light](https://github.com/haneoka-gakuen/vega-example-first-light) is an
editable example project designed to open directly in Altair.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

[Vega](https://github.com/haneoka-gakuen/vega) plays the project, and
[Deneb](https://github.com/haneoka-gakuen/deneb) builds release targets.

## License

Altair is available under MPL-2.0. Third-party formats and components retain
their own licenses.
