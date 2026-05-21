function botApp({ dataDir, host, invite, name }) {
    return {
        name,
        cwd: __dirname,
        script: "src/qwen-bot.js",
        interpreter: "node",
        args: "--debug",
        instances: 1,
        exec_mode: "fork",
        autorestart: true,
        watch: false,
        max_memory_restart: "1G",
        time: true,
        env: {
            NODE_ENV: "production",
            VEX_QWEN_LLM_URL: "http://192.168.0.123:8080",
            VEX_QWEN_MODEL: "Qwen2",
            VEX_QWEN_USERNAME: "bot",
            VEX_QWEN_DATA_DIR: dataDir,
            VEX_QWEN_WHISPER_COMMAND: `${process.env.HOME}/whisper.cpp/build/bin/whisper-cli`,
            VEX_QWEN_WHISPER_MODEL: `${process.env.HOME}/whisper.cpp/models/ggml-base.en.bin`,
            ...(host ? { VEX_CHAT_HOST: host } : {}),
            ...(invite ? { VEX_QWEN_INVITE: invite } : {}),
        },
    };
}

module.exports = {
    apps: [
        botApp({
            dataDir: `${process.env.HOME}/.vex-bot`,
            name: "vex-bot",
        }),
        botApp({
            dataDir: `${process.env.HOME}/.vex-bot-dev`,
            host: "dev.vex.wtf",
            invite: "https://vex.wtf/invite/a2f76971-2a43-403b-bc99-f62e7a7374b1",
            name: "vex-bot-dev",
        }),
    ],
};
