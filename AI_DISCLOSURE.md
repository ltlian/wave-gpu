---
disclosure-default: ai-generated
models-used:
  - deepseek-flash-v4.1
providers:
  - DeepSeek
scope: |
  Application code, tests, documentation and deployment configuration were
  written by the DeepSeek Harness agent running DeepSeek Flash v4.1, with the
  developer prompting, directing, reviewing, testing and approving every
  change. Nothing enters the repository without human inspection.
last-updated: 2026-11-17
---

# AI Disclosure

This repository follows the [ai-disclosure convention](https://github.com/ggfevans/ai-disclosure).
The default level for all files is `ai-generated`: AI-generated with human prompting and review.
Per-file overrides would use `SPDX-AI-Disclosure:` headers.

No files are `autonomous` — every change was inspected, tested and accepted by the developer before
it was committed.

## How AI was used

- **Agent:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), running **DeepSeek
  Flash v4.1**.
- **What it wrote:** the demo application (`src/`, `server/`, `shared/`), the tests, the docs, the
  build and deploy configuration (`wrangler.jsonc`, `scripts/`, `public/_headers`,
  `.github/workflows/`), and the Cloudflare deployment.
- **What the human did:** chose the design and the demo track, directed each change, reviewed the
  diffs, ran the browser and test-suite verification (WebGPU, audio, cross-origin isolation) and
  approved the deployments.

The demo audio is not covered by this file — it was generated with YuE2, see
[CREDITS.md](CREDITS.md).
