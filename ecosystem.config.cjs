module.exports = {
    apps: [
        {
            name: "vex-qwen-bot",
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
            },
        },
    ],
};
