# vex-qwen-bot

Standalone libvex bot that creates or reuses a `qwen` user, joins
`https://vex.wtf/invite/c1990fa3-2eea-4f87-b01d-10c8171ec218`, and responds to
`@qwen <text>` in Vex channels or DMs.

Responses come from the local OpenAI-compatible llama.cpp endpoint at
`http://192.168.0.123:8080/v1/chat/completions` with `model: "Qwen2"`.

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
pm2 logs vex-qwen-bot
pm2 restart vex-qwen-bot
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
- `VEX_QWEN_DEBUG`

Persistent bot state defaults to `~/.vex-qwen-bot`.
