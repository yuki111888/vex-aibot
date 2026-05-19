#!/usr/bin/env node

import { Client, DeviceApprovalRequiredError } from "@vex-chat/libvex";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_HOST = "api.vex.wtf";
const LOCAL_HOST = "127.0.0.1:16777";
const DEFAULT_INVITE =
    "https://vex.wtf/invite/c1990fa3-2eea-4f87-b01d-10c8171ec218";
const DEFAULT_LLM_URL = "http://192.168.0.123:8080";
const DEFAULT_MODEL = "Qwen2";
const DEFAULT_USERNAME = "llm";
const LEGACY_COMMANDS = ["/llm", "/qwen"];
const MAX_REPLY_CHARS = 1800;
const DEFAULT_SYNC_INTERVAL_MS = 5000;
const DEFAULT_CONTEXT_MESSAGES = 24;
const DEFAULT_VEX_TOOL_STEPS = 3;
const MAX_CONTEXT_LINE_CHARS = 500;
const MAX_TOOL_RESULT_CHARS = 4000;

const names = new Map();

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});

async function main() {
    const { flags } = parseArgs(process.argv.slice(2));
    if (flags.help) {
        printUsage();
        return;
    }

    const settings = await resolveSettings(flags);
    const { client, state } = await authenticateOrRegisterBot(settings);
    let closing = false;

    const close = async () => {
        if (closing) return;
        closing = true;
        await client.close().catch(() => {});
    };

    process.once("SIGINT", () => {
        void close().then(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
        void close().then(() => process.exit(0));
    });

    client.on("disconnect", () =>
        logDebug(settings, "vex websocket disconnected"),
    );
    client.on("connected", () => logDebug(settings, "vex websocket connected"));

    const seen = new Set();
    client.on("message", (message) => {
        if (seen.has(message.mailID)) return;
        seen.add(message.mailID);
        void handleMessage(client, settings, message).catch((err) => {
            console.error(
                `message handler failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        });
    });

    await persistState(settings, state, client);
    await redeemInvite(client, settings.invite);
    await connectAndWait(client);
    await persistState(settings, state, client);
    await checkLlm(settings);
    startInboxSync(client, settings);

    const me = client.me.user();
    names.set(me.userID, me.username);
    console.log(
        `${settings.username} bot online as ${me.username} (${me.userID}); listening for @${settings.username} <text>`,
    );

    await new Promise(() => {});
}

async function authenticateOrRegisterBot(settings) {
    const state = await readState(settings.statePath);
    if (typeof state.privateKey === "string" && state.privateKey.length > 0) {
        const client = await Client.create(state.privateKey, settings.client);
        const err = await client.loginWithDeviceKey(state.deviceID);
        if (!err) {
            return { client, state };
        }
        await client.close().catch(() => {});
        throw new Error(
            `Stored ${settings.username} device login failed: ${err.message}. Delete ${settings.statePath} to create a fresh bot device, or restore the matching device on the server.`,
        );
    }

    const client = await Client.create(undefined, settings.client);
    const privateKey = client.getKeys().private;
    const [user, err] = await client.register(
        settings.username,
        settings.password,
    );
    if (err) {
        await client.close().catch(() => {});
        throw explainRegisterError(err, settings.username, settings.statePath);
    }
    if (!user) {
        await client.close().catch(() => {});
        throw new Error(
            `Registration did not return a user for ${settings.username}.`,
        );
    }

    const nextState = {
        createdAt: new Date().toISOString(),
        deviceID: safeDeviceID(client),
        privateKey,
        userID: user.userID,
        username: user.username,
    };
    return { client, state: nextState };
}

async function redeemInvite(client, invite) {
    const inviteID = parseInviteID(invite);
    const permission = await client.invites.redeem(inviteID);
    if (permission.resourceType !== "server") {
        throw new Error(
            `Invite ${inviteID} redeemed to ${permission.resourceType}, expected server.`,
        );
    }
    const channels = await client.channels
        .retrieve(permission.resourceID)
        .catch(() => []);
    const channelNames = channels
        .map((channel) => `#${channel.name}`)
        .join(", ");
    console.log(
        `joined invite ${inviteID}; server=${permission.resourceID}${
            channelNames ? ` channels=${channelNames}` : ""
        }`,
    );
}

async function connectAndWait(client) {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("Timed out waiting for Vex websocket.")),
            20_000,
        );
        client.once("connected", () => {
            clearTimeout(timer);
            resolve();
        });
        client.connect().catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function handleMessage(client, settings, message) {
    if (!message.decrypted) {
        logDebug(settings, `ignored undecrypted message ${message.mailID}`);
        return;
    }
    if (message.authorID === client.me.user().userID) {
        logDebug(settings, `ignored own message ${message.mailID}`);
        return;
    }

    const prompt = parseBotPrompt(message.message, settings);
    if (prompt === null) {
        logDebug(
            settings,
            `ignored non-command message ${message.mailID}${
                message.group ? ` group=${message.group}` : ""
            } text=${JSON.stringify(message.message.slice(0, 80))}`,
        );
        return;
    }

    if (!prompt) {
        await reply(client, message, `Usage: @${settings.username} <text>`);
        return;
    }

    console.log(
        `prompt from ${message.authorID}${message.group ? ` in ${message.group}` : ""}: ${prompt}`,
    );
    let output;
    try {
        output = await completeWithModel(client, settings, message, prompt);
    } catch (err) {
        output = `${settings.username} error: ${formatError(err)}`;
    }

    for (const part of splitReply(output)) {
        try {
            await reply(client, message, part);
        } catch (err) {
            const rendered = formatError(err);
            console.error(`reply failed: ${rendered}`);
            if (message.group) {
                await client.messages.send(
                    message.authorID,
                    `${settings.username} saw your group prompt but could not answer in-channel: ${rendered}`,
                );
            } else {
                throw err;
            }
        }
    }
}

async function completeWithModel(client, settings, source, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
    try {
        const headers = { "Content-Type": "application/json" };
        if (settings.llmApiKey) {
            headers.Authorization = `Bearer ${settings.llmApiKey}`;
        }
        const context = await buildChatContext(client, settings, source).catch(
            (err) => {
                logDebug(
                    settings,
                    `context lookup failed: ${formatError(err)}`,
                );
                return "";
            },
        );
        const toolTrace = [];
        for (let step = 0; ; step++) {
            const userContent = buildModelPrompt(
                settings,
                prompt,
                context,
                toolTrace,
            );
            const content = await requestChatCompletion(
                settings,
                headers,
                controller.signal,
                userContent,
            );
            const toolCall = parseToolCall(content);
            if (!toolCall) return cleanupFinalAnswer(content);
            if (step >= settings.vexToolSteps) {
                return `I wanted to use ${toolCall.name}, but I hit my Vex tool-call limit.`;
            }

            const result = await runVexTool(
                client,
                settings,
                source,
                toolCall,
            );
            toolTrace.push({ call: toolCall, result });
        }
    } finally {
        clearTimeout(timer);
    }
}

async function requestChatCompletion(settings, headers, signal, userContent) {
    let res;
    try {
        res = await fetch(settings.llmChatCompletionsUrl, {
            body: JSON.stringify({
                messages: [{ content: userContent, role: "user" }],
                model: settings.model,
                stream: false,
            }),
            headers,
            method: "POST",
            signal,
        });
    } catch (err) {
        throw new Error(
            `could not reach ${settings.llmChatCompletionsUrl}: ${formatError(err)}`,
        );
    }
    const body = await res.text();
    if (!res.ok) {
        throw new Error(
            `LLM request failed with ${res.status}: ${body.slice(0, 500)}`,
        );
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(`LLM returned non-JSON: ${body.slice(0, 500)}`);
    }
    const content =
        parsed?.choices?.[0]?.message?.content ??
        parsed?.choices?.[0]?.text ??
        "";
    return String(content).trim() || "(empty response)";
}

function buildModelPrompt(settings, prompt, context, toolTrace = []) {
    const parts = [
        `You are ${settings.username}, an AI assistant inside a Vex chat.`,
        "Answer directly and keep the response useful.",
        "If recent chat context is provided, use it as memory for this conversation, but do not quote it unless helpful.",
        buildVexToolInstructions(settings),
    ];
    if (context) {
        parts.push(`Recent chat context, oldest to newest:\n${context}`);
    }
    if (toolTrace.length > 0) {
        parts.push(
            `Vex tool results so far:\n${toolTrace
                .map(formatToolTraceEntry)
                .join("\n\n")}`,
        );
    }
    parts.push(`Current prompt:\n${prompt}`);
    return parts.join("\n\n");
}

function buildVexToolInstructions(settings) {
    if (settings.vexToolSteps <= 0) {
        return "Vex tools are disabled for this run.";
    }
    return `You may inspect Vex through read-only tools backed by libvex.
Available tools:
- vex.current_chat: details about the current DM or channel and the prompting user. Arguments: {}.
- vex.list_servers: list servers visible to this bot, with channels. Arguments: {}.
- vex.list_channels: list channels in a server. Arguments: {"server_id":"..."}; omit server_id to use the current channel's server.
- vex.channel_members: list users visible in a channel. Arguments: {"channel_id":"..."}; omit channel_id to use the current channel.
- vex.recent_messages: read recent local encrypted history. Arguments: {"channel_id":"...","user_id":"...","limit":20}; omit channel_id/user_id to use the current chat.
- vex.lookup_user: look up a user by username or user id. Arguments: {"identifier":"..."}.
- vex.my_profile: show the bot's current user and device ids. Arguments: {}.

When you need a Vex tool, reply with only this JSON:
{"type":"tool","name":"vex.current_chat","arguments":{}}

Call at most one tool per response. Do not invent Vex IDs; use tools to discover them. After tool results are provided, answer normally in plain text.`;
}

function formatToolTraceEntry(entry) {
    return `Tool call: ${JSON.stringify(entry.call)}\nTool result: ${JSON.stringify(entry.result)}`;
}

function parseToolCall(content) {
    const trimmed = String(content ?? "").trim();
    const withoutPrefix = trimmed.startsWith("TOOL_CALL:")
        ? trimmed.slice("TOOL_CALL:".length).trim()
        : trimmed;
    const fenced = withoutPrefix.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const jsonText = fenced ? fenced[1].trim() : withoutPrefix;
    if (!jsonText.startsWith("{")) return null;
    try {
        const parsed = JSON.parse(jsonText);
        const type = String(parsed.type ?? "").toLowerCase();
        const name = parsed.name ?? parsed.tool ?? parsed.tool_name;
        if (type !== "tool" || typeof name !== "string") return null;
        const args =
            parsed.arguments && typeof parsed.arguments === "object"
                ? parsed.arguments
                : {};
        return { arguments: args, name };
    } catch {
        return null;
    }
}

function cleanupFinalAnswer(content) {
    const text = String(content ?? "").trim();
    if (!text) return "(empty response)";
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed.text === "string") return parsed.text.trim();
        if (typeof parsed.answer === "string") return parsed.answer.trim();
        if (typeof parsed.final === "string") return parsed.final.trim();
    } catch {}
    return text;
}

async function runVexTool(client, settings, source, toolCall) {
    const args = toolCall.arguments ?? {};
    let result;
    switch (toolCall.name) {
        case "vex.current_chat":
            result = await vexCurrentChat(client, source);
            break;
        case "vex.list_servers":
            result = await vexListServers(client);
            break;
        case "vex.list_channels":
            result = await vexListChannels(client, source, args);
            break;
        case "vex.channel_members":
            result = await vexChannelMembers(client, source, args);
            break;
        case "vex.recent_messages":
            result = await vexRecentMessages(client, source, args);
            break;
        case "vex.lookup_user":
            result = await vexLookupUser(client, args);
            break;
        case "vex.my_profile":
            result = vexMyProfile(client);
            break;
        default:
            result = {
                error: `Unknown Vex tool: ${toolCall.name}`,
                knownTools: [
                    "vex.current_chat",
                    "vex.list_servers",
                    "vex.list_channels",
                    "vex.channel_members",
                    "vex.recent_messages",
                    "vex.lookup_user",
                    "vex.my_profile",
                ],
            };
    }
    const clipped = clipToolResult(result);
    logDebug(settings, `tool ${toolCall.name} -> ${JSON.stringify(clipped)}`);
    return clipped;
}

async function vexCurrentChat(client, source) {
    const author = await usernameFor(client, source.authorID);
    const base = {
        bot: sanitizeUser(client.me.user()),
        promptAuthor: { userID: source.authorID, username: author },
        triggerMailID: source.mailID,
    };
    if (!source.group) {
        return { ...base, kind: "dm", userID: source.authorID };
    }
    const channel = await client.channels.retrieveByID(source.group);
    const server = channel?.serverID
        ? await client.servers.retrieveByID(channel.serverID)
        : null;
    return {
        ...base,
        channel: sanitizeChannel(channel),
        kind: "channel",
        server: sanitizeServer(server),
    };
}

async function vexListServers(client) {
    const bootstrap = await client.servers.retrieveWithChannels();
    return {
        servers: bootstrap.servers.map((server) => ({
            ...sanitizeServer(server),
            channels: (bootstrap.channelsByServer[server.serverID] ?? []).map(
                sanitizeChannel,
            ),
        })),
    };
}

async function vexListChannels(client, source, args) {
    const serverID = String(
        args.server_id ?? args.serverID ?? (await currentServerID(client, source)) ?? "",
    );
    if (!serverID) {
        return { error: "server_id is required outside a channel context" };
    }
    const [server, channels] = await Promise.all([
        client.servers.retrieveByID(serverID),
        client.channels.retrieve(serverID),
    ]);
    return {
        channels: channels.map(sanitizeChannel),
        server: sanitizeServer(server),
    };
}

async function vexChannelMembers(client, source, args) {
    const channelID = String(
        args.channel_id ?? args.channelID ?? source.group ?? "",
    );
    if (!channelID) {
        return { error: "channel_id is required outside a channel context" };
    }
    const [channel, users] = await Promise.all([
        client.channels.retrieveByID(channelID),
        client.channels.userList(channelID),
    ]);
    return {
        channel: sanitizeChannel(channel),
        users: users.map(sanitizeUser),
    };
}

async function vexRecentMessages(client, source, args) {
    const limit = clampInt(args.limit, 20, 1, 50);
    const channelID = args.channel_id ?? args.channelID;
    const userID = args.user_id ?? args.userID;
    const history =
        channelID || (!userID && source.group)
            ? await client.messages.retrieveGroup(String(channelID ?? source.group))
            : await client.messages.retrieve(String(userID ?? source.authorID));
    const sorted = history
        .filter((message) => message.decrypted && message.message.trim())
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        .slice(-limit);
    const messages = [];
    for (const message of sorted) {
        messages.push({
            authorID: message.authorID,
            group: message.group,
            mailID: message.mailID,
            message: truncateForContext(message.message.replace(/\s+/g, " ")),
            timestamp: message.timestamp,
            username: await usernameFor(client, message.authorID),
        });
    }
    return { messages };
}

async function vexLookupUser(client, args) {
    const identifier = String(args.identifier ?? args.user ?? "").trim();
    if (!identifier) return { error: "identifier is required" };
    const [user, err] = await client.users.retrieve(identifier);
    if (err) return { error: err.message };
    return { user: sanitizeUser(user) };
}

function vexMyProfile(client) {
    return {
        device: { deviceID: client.me.device().deviceID },
        user: sanitizeUser(client.me.user()),
    };
}

async function currentServerID(client, source) {
    if (!source.group) return null;
    const channel = await client.channels.retrieveByID(source.group);
    return channel?.serverID ?? null;
}

function clipToolResult(result) {
    const json = JSON.stringify(result);
    if (json.length <= MAX_TOOL_RESULT_CHARS) return result;
    return {
        truncated: true,
        value: `${json.slice(0, MAX_TOOL_RESULT_CHARS - 3)}...`,
    };
}

function sanitizeServer(server) {
    if (!server) return null;
    return {
        icon: server.icon,
        name: server.name,
        serverID: server.serverID,
    };
}

function sanitizeChannel(channel) {
    if (!channel) return null;
    return {
        channelID: channel.channelID,
        name: channel.name,
        serverID: channel.serverID,
    };
}

function sanitizeUser(user) {
    if (!user) return null;
    return {
        lastSeen: user.lastSeen,
        userID: user.userID,
        username: user.username,
    };
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

async function buildChatContext(client, settings, source) {
    if (settings.contextMessages <= 0) return "";
    const history = source.group
        ? await client.messages.retrieveGroup(source.group)
        : await client.messages.retrieve(source.authorID);
    const sorted = history
        .filter((message) => message.decrypted && message.message.trim())
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const sourceIndex = sorted.findIndex(
        (message) => message.mailID === source.mailID,
    );
    const previous = sourceIndex >= 0 ? sorted.slice(0, sourceIndex) : sorted;
    const recent = previous.slice(-settings.contextMessages);
    const lines = [];
    for (const message of recent) {
        lines.push(await formatContextMessage(client, message));
    }
    return lines.join("\n");
}

async function formatContextMessage(client, message) {
    const who =
        message.authorID === client.me.user().userID
            ? client.me.user().username
            : await usernameFor(client, message.authorID);
    const body = truncateForContext(message.message.replace(/\s+/g, " "));
    const time = Number.isFinite(Date.parse(message.timestamp))
        ? new Date(message.timestamp).toISOString()
        : message.timestamp;
    return `${time} ${who}: ${body}`;
}

async function usernameFor(client, userID) {
    if (names.has(userID)) return names.get(userID);
    const [user] = await client.users.retrieve(userID);
    const username = user?.username ?? userID;
    names.set(userID, username);
    return username;
}

function truncateForContext(text) {
    if (text.length <= MAX_CONTEXT_LINE_CHARS) return text;
    return `${text.slice(0, MAX_CONTEXT_LINE_CHARS - 3)}...`;
}

async function checkLlm(settings) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const headers = {};
        if (settings.llmApiKey) {
            headers.Authorization = `Bearer ${settings.llmApiKey}`;
        }
        const res = await fetch(settings.llmModelsUrl, {
            headers,
            signal: controller.signal,
        });
        if (!res.ok) {
            console.error(
                `${settings.username} warning: model endpoint ${settings.llmModelsUrl} returned ${res.status}`,
            );
            return;
        }
        logDebug(
            settings,
            `model endpoint ${settings.llmModelsUrl} is reachable`,
        );
    } catch (err) {
        console.error(
            `${settings.username} warning: could not reach model endpoint ${settings.llmModelsUrl}: ${formatError(err)}`,
        );
    } finally {
        clearTimeout(timer);
    }
}

function startInboxSync(client, settings) {
    if (settings.syncIntervalMs <= 0) return;
    const interval = setInterval(() => {
        client.syncInboxNow().catch((err) => {
            if (settings.debug) {
                console.error(`${settings.username} sync failed: ${formatError(err)}`);
            }
        });
    }, settings.syncIntervalMs);
    interval.unref?.();
}

async function reply(client, source, text) {
    if (source.group) {
        await client.messages.group(source.group, text);
    } else {
        await client.messages.send(source.authorID, text);
    }
}

function parseBotPrompt(text, settings) {
    const trimmed = String(text ?? "").trim();
    const lower = trimmed.toLowerCase();
    for (const command of LEGACY_COMMANDS) {
        if (lower === command) return "";
        if (lower.startsWith(`${command} `)) {
            return trimmed.slice(command.length).trim();
        }
    }

    const mention = mentionRegex(settings.username);
    if (!mention.test(trimmed)) return null;
    return trimmed.replace(mentionRegex(settings.username, "gi"), " ").trim();
}

function mentionRegex(username, flags = "i") {
    return new RegExp(`(^|\\s)@${escapeRegex(username)}\\b[:,]?\\s*`, flags);
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitReply(text) {
    const normalized = String(text ?? "").trim() || "(empty response)";
    if (normalized.length <= MAX_REPLY_CHARS) return [normalized];

    const parts = [];
    let remaining = normalized;
    while (remaining.length > MAX_REPLY_CHARS) {
        let splitAt = remaining.lastIndexOf("\n\n", MAX_REPLY_CHARS);
        if (splitAt < MAX_REPLY_CHARS * 0.5) {
            splitAt = remaining.lastIndexOf(" ", MAX_REPLY_CHARS);
        }
        if (splitAt < MAX_REPLY_CHARS * 0.5) {
            splitAt = MAX_REPLY_CHARS;
        }
        parts.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) parts.push(remaining);
    return parts;
}

async function resolveSettings(flags) {
    const local = Boolean(flags.local) || process.env.VEX_CHAT_LOCAL === "1";
    const apiUrl = flags["api-url"] ?? process.env.API_URL;
    const host = String(
        local
            ? LOCAL_HOST
            : (flags.host ??
                  process.env.VEX_CHAT_HOST ??
                  process.env.API_HOST ??
                  hostFromApiUrl(apiUrl) ??
                  DEFAULT_HOST),
    );
    const unsafeHttp =
        local ||
        Boolean(flags.http) ||
        process.env.VEX_CHAT_HTTP === "1" ||
        httpFromApiUrl(apiUrl) ||
        isLocalHost(host);
    if (unsafeHttp && !process.env.NODE_ENV) {
        process.env.NODE_ENV = "development";
    }

    const username = String(
        flags.username ?? process.env.VEX_QWEN_USERNAME ?? DEFAULT_USERNAME,
    ).toLowerCase();

    const dataDir = path.resolve(
        String(
            flags["data-dir"] ??
                process.env.VEX_QWEN_DATA_DIR ??
                path.join(os.homedir(), `.vex-${username}-bot`),
        ),
    );
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const dbFolder = path.join(dataDir, "db");
    await fs.mkdir(dbFolder, { recursive: true, mode: 0o700 });

    const llmUrl = String(
        flags["llm-url"] ??
            process.env.VEX_QWEN_LLM_URL ??
            process.env.OPENAI_BASE_URL ??
            DEFAULT_LLM_URL,
    );
    const llmTimeoutMs = Number.parseInt(
        String(
            flags["llm-timeout-ms"] ??
                process.env.VEX_QWEN_LLM_TIMEOUT_MS ??
                "120000",
        ),
        10,
    );
    const syncIntervalMs = Number.parseInt(
        String(
            flags["sync-interval-ms"] ??
                process.env.VEX_QWEN_SYNC_INTERVAL_MS ??
                DEFAULT_SYNC_INTERVAL_MS,
        ),
        10,
    );
    const contextMessages = Number.parseInt(
        String(
            flags["context-messages"] ??
                process.env.VEX_QWEN_CONTEXT_MESSAGES ??
                DEFAULT_CONTEXT_MESSAGES,
        ),
        10,
    );
    const vexToolSteps = Number.parseInt(
        String(
            flags["vex-tool-steps"] ??
                process.env.VEX_QWEN_TOOL_STEPS ??
                DEFAULT_VEX_TOOL_STEPS,
        ),
        10,
    );
    const llmChatCompletionsUrl = normalizeChatCompletionsUrl(llmUrl);

    return {
        client: {
            dbFolder,
            deviceName: `vex-${username}-bot`,
            host,
            unsafeHttp,
            ...(flags["dev-key"] || process.env.DEV_API_KEY
                ? {
                      devApiKey: String(
                          flags["dev-key"] ?? process.env.DEV_API_KEY,
                      ),
                  }
                : {}),
        },
        contextMessages: Number.isFinite(contextMessages)
            ? Math.max(0, contextMessages)
            : DEFAULT_CONTEXT_MESSAGES,
        dataDir,
        invite: String(
            flags.invite ?? process.env.VEX_QWEN_INVITE ?? DEFAULT_INVITE,
        ),
        llmApiKey:
            flags["llm-api-key"] ??
            process.env.VEX_QWEN_LLM_API_KEY ??
            process.env.OPENAI_API_KEY,
        llmChatCompletionsUrl,
        llmModelsUrl: normalizeModelsUrl(llmChatCompletionsUrl),
        llmTimeoutMs: Number.isFinite(llmTimeoutMs) ? llmTimeoutMs : 120000,
        model: String(
            flags.model ?? process.env.VEX_QWEN_MODEL ?? DEFAULT_MODEL,
        ),
        password: flags.password ?? process.env.VEX_QWEN_PASSWORD,
        statePath: path.join(dataDir, `${username}-bot.json`),
        syncIntervalMs: Number.isFinite(syncIntervalMs)
            ? syncIntervalMs
            : DEFAULT_SYNC_INTERVAL_MS,
        debug:
            Boolean(flags.debug) ||
            process.env.VEX_QWEN_DEBUG === "1" ||
            process.env.VEX_QWEN_DEBUG === "true",
        username,
        vexToolSteps: Number.isFinite(vexToolSteps)
            ? Math.max(0, vexToolSteps)
            : DEFAULT_VEX_TOOL_STEPS,
    };
}

async function readState(statePath) {
    try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
        if (err?.code === "ENOENT") return {};
        throw err;
    }
}

async function persistState(settings, state, client) {
    const nextState = {
        ...state,
        deviceID: state.deviceID || safeDeviceID(client),
        updatedAt: new Date().toISOString(),
        userID: state.userID || client.me.user().userID,
        username: client.me.user().username ?? settings.username,
    };
    await fs.writeFile(settings.statePath, JSON.stringify(nextState, null, 2), {
        mode: 0o600,
    });
}

function safeDeviceID(client) {
    try {
        return client.me.device().deviceID;
    } catch {
        return undefined;
    }
}

function explainRegisterError(err, username, statePath) {
    if (err instanceof DeviceApprovalRequiredError) {
        return new Error(
            `The username ${username} already exists and requires device approval. Approve request ${err.requestID} from an existing device, or restore the bot state file at ${statePath}.`,
        );
    }
    return err instanceof Error ? err : new Error(String(err));
}

function parseInviteID(invite) {
    const value = String(invite ?? "").trim();
    const match =
        value.match(/(?:vex:\/\/invite\/|\/invite\/)([0-9a-f-]{36})/i) ??
        value.match(/^([0-9a-f-]{36})$/i);
    if (!match?.[1]) {
        throw new Error(`Invalid invite code or URL: ${invite}`);
    }
    return match[1].toLowerCase();
}

function normalizeChatCompletionsUrl(raw) {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/v1/chat/completions")) {
        return url.toString();
    }
    if (pathname.endsWith("/chat/completions")) {
        return url.toString();
    }
    if (pathname.endsWith("/v1")) {
        url.pathname = `${pathname}/chat/completions`;
        return url.toString();
    }
    url.pathname = `${pathname}/v1/chat/completions`;
    return url.toString();
}

function normalizeModelsUrl(raw) {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/v1/chat/completions")) {
        url.pathname = `${pathname.slice(0, -"/chat/completions".length)}/models`;
        return url.toString();
    }
    if (pathname.endsWith("/chat/completions")) {
        url.pathname = `${pathname.slice(0, -"/chat/completions".length)}/models`;
        return url.toString();
    }
    if (pathname.endsWith("/v1")) {
        url.pathname = `${pathname}/models`;
        return url.toString();
    }
    url.pathname = `${pathname}/v1/models`;
    return url.toString();
}

function formatError(err) {
    if (!(err instanceof Error)) return String(err);
    const parts = [err.message];
    const cause = err.cause;
    if (
        cause instanceof Error &&
        cause.message &&
        cause.message !== err.message
    ) {
        parts.push(cause.message);
    } else if (cause && typeof cause === "object") {
        const code = cause.code ? String(cause.code) : "";
        const address = cause.address ? String(cause.address) : "";
        const port = cause.port ? String(cause.port) : "";
        const detail = [code, address, port].filter(Boolean).join(" ");
        if (detail) parts.push(detail);
    }
    if (err.name === "AbortError") {
        parts.push("request timed out");
    }
    return parts.join(": ");
}

function logDebug(settings, message) {
    if (settings.debug) {
        console.error(`${settings.username} debug: ${message}`);
    }
}

function hostFromApiUrl(raw) {
    if (!raw) return undefined;
    try {
        return new URL(raw).host;
    } catch {
        return raw;
    }
}

function httpFromApiUrl(raw) {
    if (!raw) return false;
    try {
        return new URL(raw).protocol === "http:";
    } catch {
        return true;
    }
}

function isLocalHost(host) {
    const h = host.split(":")[0];
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function parseArgs(argv) {
    const flags = {};
    const positionals = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") {
            continue;
        }
        if (!arg.startsWith("--")) {
            positionals.push(arg);
            continue;
        }
        const key = arg.slice(2);
        if (["debug", "help", "http", "local"].includes(key)) {
            flags[key] = true;
            continue;
        }
        const next = argv[++i];
        if (!next) throw new Error(`Missing value for --${key}`);
        flags[key] = next;
    }
    return { flags, positionals };
}

function printUsage() {
    console.log(`Usage: vex-aibot [options]

Creates or reuses a libvex user named ${DEFAULT_USERNAME}, redeems the configured invite, and
responds to "@${DEFAULT_USERNAME} <text>" with output from an OpenAI-compatible local model.

Options:
  --invite <url-or-id>       Invite to redeem (default: ${DEFAULT_INVITE})
  --llm-url <url>            OpenAI-compatible base or chat URL (default: ${DEFAULT_LLM_URL})
  --model <id>               Model field for chat completions (default: ${DEFAULT_MODEL})
  --username <name>          Bot username (default: ${DEFAULT_USERNAME})
  --data-dir <path>          Persistent bot state dir (default: ~/.vex-${DEFAULT_USERNAME}-bot)
  --api-url <url>            Vex API URL; sets host and protocol
  --host <host[:port]>       Vex API host (default: ${DEFAULT_HOST})
  --http                     Use http/ws for Vex API
  --local                    Use local Spire at ${LOCAL_HOST}
  --dev-key <key>            x-dev-api-key for local Spire
  --password <password>      Optional password for first registration
  --context-messages <n>     Recent DM/channel messages to send as context (default: ${DEFAULT_CONTEXT_MESSAGES})
  --vex-tool-steps <n>       Read-only Vex tool calls allowed per prompt (default: ${DEFAULT_VEX_TOOL_STEPS})
  --llm-timeout-ms <ms>      LLM request timeout (default: 120000)
  --sync-interval-ms <ms>    Poll inbox in addition to websocket notify (default: ${DEFAULT_SYNC_INTERVAL_MS})
  --debug                    Log ignored messages, sync, and context activity
  --help                     Show this help

Environment equivalents:
  VEX_QWEN_INVITE, VEX_QWEN_LLM_URL, VEX_QWEN_MODEL, VEX_QWEN_DATA_DIR,
  VEX_QWEN_USERNAME, VEX_QWEN_PASSWORD, VEX_QWEN_LLM_API_KEY,
  VEX_QWEN_CONTEXT_MESSAGES, VEX_QWEN_TOOL_STEPS, VEX_QWEN_SYNC_INTERVAL_MS,
  VEX_QWEN_DEBUG`);
}
