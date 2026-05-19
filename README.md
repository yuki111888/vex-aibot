# vex-aibot

Standalone libvex bot that creates or reuses an `llm` user, joins
`https://vex.wtf/invite/c1990fa3-2eea-4f87-b01d-10c8171ec218`, and responds to
`@llm <text>` in Vex channels or DMs.

The PM2 config also runs a second `llm` bot against `dev.vex.wtf`, using
`~/.vex-llm-bot-dev` and invite
`https://vex.wtf/invite/a2f76971-2a43-403b-bc99-f62e7a7374b1`.

Responses come from the local OpenAI-compatible llama.cpp endpoint at
`http://192.168.0.123:8080/v1/chat/completions` with `model: "Qwen2"`.

The bot can also use read-only Vex tools through `@vex-chat/libvex` when the
model needs live Vex context. It can inspect the current chat, visible servers
and channels, channel members, recent local message history, user profiles, and
its own account/device profile. It cannot send extra messages or mutate Vex
state through tools; its only write is the normal final reply.

The bot keeps a compact rolling memory summary per DM or channel. Prompts use
that summary plus the freshest raw messages, and the summary is rewritten after
successful replies so long chats stay under the local model's context limit.

## Setup

```sh
pnpm install
```

## Run

```sh
pnpm start
```

## PM2

```sh
pm2 start ecosystem.config.cjs
pm2 logs vex-llm-bot
pm2 logs vex-llm-bot-dev
pm2 restart vex-llm-bot
pm2 save
```

## Options

```sh
node src/qwen-bot.js --help
```

Important environment overrides:

- `VEX_QWEN_LLM_URL`
- `VEX_QWEN_MODEL`
- `VEX_QWEN_INVITE`
- `VEX_QWEN_DATA_DIR`
- `VEX_QWEN_CONTEXT_MESSAGES`
- `VEX_QWEN_CONTEXT_CHARS`
- `VEX_QWEN_MEMORY` (`0` disables rolling summaries)
- `VEX_QWEN_MEMORY_SUMMARY_CHARS`
- `VEX_QWEN_TOOL_STEPS`
- `VEX_QWEN_DEBUG`

Persistent bot state defaults to `~/.vex-llm-bot`; rolling memory is stored in
`~/.vex-llm-bot/llm-memory.json`.
