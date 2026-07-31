# Third-party notices

WebGAL format compatibility is maintained in the independently distributed
`@haneoka/altair-plugin-webgal` package. Its repository preserves the upstream
MPL-2.0 license copy, file-level notice, and codec provenance. Altair does not
bundle that codec, the WebGAL runtime, or the WebGAL Terre editor.

The WebGAL and WebGAL Terre research checkouts are not runtime dependencies.
Their MPL-2.0 editor layout, visual-command insertion, flowchart, and preview
implementations are used as compatibility references. Any source file copied
or modified from those projects must retain its MPL-2.0 file notice.

Visual Studio Code's workbench layout and interaction patterns are used as an
interface reference under the MIT License. The reference checkout retains
Microsoft's complete license and copyright notice. Altair does not bundle the
VS Code application.

Ayaka, UniGal-Script, and Pigeon are architecture references only; GPL/LGPL
source is not incorporated into Altair.

JavaScript dependency licenses remain those of their respective packages.
Release automation must generate a report and SBOM from the exact lockfile and
archive.

## Lucide

Altair uses the `lucide-react` package for interface icons. Lucide is
distributed under the ISC License; selected icons derived from Feather are
distributed under the MIT License. The complete license texts are included in
the installed package and generated release license report.
