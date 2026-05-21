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
const DEFAULT_USERNAME = "bot";
const LEGACY_COMMANDS = ["/bot"];
const MAX_REPLY_CHARS = 1800;
const DEFAULT_SYNC_INTERVAL_MS = 5000;
const DEFAULT_CONTEXT_MESSAGES = 12;
const DEFAULT_CONTEXT_CHARS = 1600;
const DEFAULT_MEMORY_SUMMARY_CHARS = 1200;
const DEFAULT_VEX_TOOL_STEPS = 3;
const MAX_CONTEXT_LINE_CHARS = 220;
const MAX_TOOL_RESULT_CHARS = 1800;
const MEMORY_VERSION = 1;
const UUID_PATTERN =
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const INVITE_LINK_REGEX = new RegExp(
    `(?:vex://invite/|https?://\\S*?/invite/|\\b[a-z0-9.-]+/invite/|/invite/)(${UUID_PATTERN})`,
    "gi",
);
const RAW_INVITE_REGEX = new RegExp(`^\\s*(${UUID_PATTERN})\\s*$`, "i");

const names = new Map();
let memoryUpdateQueue = Promise.resolve();

class ContextExceededError extends Error {}

const VEX_API_SURFACE = Object.freeze({
    "channels.create": {
        args: ["name", "serverID"],
        confirm: true,
        description: "Create a channel in a server.",
    },
    "channels.delete": {
        args: ["channelID"],
        confirm: true,
        description: "Delete a channel.",
    },
    "channels.retrieve": {
        args: ["serverID"],
        description: "List channels in a server.",
    },
    "channels.retrieveByID": {
        args: ["channelID"],
        description: "Get one channel by ID.",
    },
    "channels.userList": {
        args: ["channelID"],
        description: "List users visible in a channel.",
    },
    "devices.abortPendingRegistration": {
        args: ["{challenge,requestID}"],
        confirm: true,
        description: "Abort an unpublished pending device enrollment.",
    },
    "devices.approveRequest": {
        args: ["requestID"],
        confirm: true,
        description: "Approve a pending device registration request.",
    },
    "devices.delete": {
        args: ["deviceID"],
        confirm: true,
        description: "Delete one account device.",
    },
    "devices.getRequest": {
        args: ["requestID"],
        description: "Fetch one pending device request.",
    },
    "devices.list": {
        args: [],
        description: "List this account's devices.",
    },
    "devices.listRequests": {
        args: [],
        description: "List pending or processed device requests.",
    },
    "devices.pollPendingRegistration": {
        args: ["{challenge,requestID}"],
        description: "Poll a pending registration request as the requesting device.",
    },
    "devices.publishPendingRegistration": {
        args: ["{challenge,requestID}"],
        confirm: true,
        description: "Notify existing devices about a pending enrollment.",
    },
    "devices.register": {
        args: [],
        confirm: true,
        description: "Register current key material as a new device.",
    },
    "devices.rejectRequest": {
        args: ["requestID"],
        confirm: true,
        description: "Reject a pending device registration request.",
    },
    "devices.retrieve": {
        args: ["deviceIdentifier"],
        description: "Fetch one device by ID or identifier.",
    },
    "emoji.create": {
        args: ["bytes", "name", "serverID"],
        confirm: true,
        description: "Upload a custom emoji. Pass bytes as {type:'bytes',base64:'...'} or {type:'bytes',text:'...'}",
    },
    "emoji.retrieve": {
        args: ["emojiID"],
        description: "Fetch one emoji by ID.",
    },
    "emoji.retrieveList": {
        args: ["serverID"],
        description: "List emojis available on a server.",
    },
    "files.create": {
        args: ["bytes"],
        confirm: true,
        description: "Upload an encrypted file. Pass bytes as {type:'bytes',base64:'...'} or {type:'bytes',text:'...'}",
    },
    "files.retrieve": {
        args: ["fileID", "key"],
        description: "Download and decrypt a file.",
    },
    "getHost": {
        args: [],
        description: "Return the current HTTP API origin.",
    },
    "getKeys": {
        args: [],
        sensitive: true,
        description: "Return this device's public key; private key is redacted.",
    },
    "getLocalMessageRetentionDays": {
        args: [],
        description: "Return the local message retention cap.",
    },
    "invites.create": {
        args: ["serverID", "duration"],
        confirm: true,
        description: "Create an invite for a server.",
    },
    "invites.redeem": {
        args: ["inviteID"],
        confirm: true,
        description: "Redeem an invite.",
    },
    "invites.retrieve": {
        args: ["serverID"],
        description: "List active invites for a server.",
    },
    "me.device": {
        args: [],
        description: "Return current authenticated device metadata.",
    },
    "me.setAvatar": {
        args: ["bytes"],
        confirm: true,
        description: "Upload and set a new avatar. Pass bytes as {type:'bytes',base64:'...'} or {type:'bytes',text:'...'}",
    },
    "me.user": {
        args: [],
        description: "Return current authenticated user profile.",
    },
    "messages.delete": {
        args: ["userOrChannelID"],
        confirm: true,
        description: "Delete local history for a user or channel.",
    },
    "messages.group": {
        args: ["channelID", "message", "opts?"],
        confirm: true,
        description: "Send an encrypted group message.",
    },
    "messages.purge": {
        args: [],
        confirm: true,
        description: "Delete all locally stored message history.",
    },
    "messages.retrieve": {
        args: ["userID"],
        description: "Return local direct-message history with one user.",
    },
    "messages.retrieveGroup": {
        args: ["channelID"],
        description: "Return local group-message history for one channel.",
    },
    "messages.send": {
        args: ["userID", "message", "opts?"],
        confirm: true,
        description: "Send an encrypted direct message.",
    },
    "moderation.fetchPermissionList": {
        args: ["serverID"],
        description: "Return all permission entries for a server.",
    },
    "moderation.kick": {
        args: ["userID", "serverID"],
        confirm: true,
        description: "Kick a user from a server.",
    },
    "passkeys.approveDeviceRequest": {
        args: ["requestID"],
        confirm: true,
        description: "Approve a pending device request using a passkey session.",
    },
    "passkeys.beginAuthentication": {
        args: ["username"],
        description: "Begin a passkey authentication ceremony.",
    },
    "passkeys.beginRegistration": {
        args: ["name"],
        confirm: true,
        description: "Begin adding a new passkey.",
    },
    "passkeys.delete": {
        args: ["passkeyID"],
        confirm: true,
        description: "Delete a passkey.",
    },
    "passkeys.deleteDevice": {
        args: ["deviceID"],
        confirm: true,
        description: "Delete one account device using a passkey session.",
    },
    "passkeys.finishAuthentication": {
        args: ["{requestID,response}"],
        confirm: true,
        description: "Finish passkey authentication with a WebAuthn assertion.",
    },
    "passkeys.finishRegistration": {
        args: ["{name,requestID,response}"],
        confirm: true,
        description: "Finish adding a passkey with a WebAuthn registration response.",
    },
    "passkeys.list": {
        args: [],
        description: "List account passkeys.",
    },
    "passkeys.listDevices": {
        args: [],
        description: "List account devices using a passkey session.",
    },
    "passkeys.rejectDeviceRequest": {
        args: ["requestID"],
        confirm: true,
        description: "Reject a pending device request using a passkey session.",
    },
    "permissions.delete": {
        args: ["permissionID"],
        confirm: true,
        description: "Delete one permission grant.",
    },
    "permissions.retrieve": {
        args: [],
        description: "List permissions granted to this user.",
    },
    "servers.create": {
        args: ["name"],
        confirm: true,
        description: "Create a server.",
    },
    "servers.delete": {
        args: ["serverID"],
        confirm: true,
        description: "Delete a server.",
    },
    "servers.leave": {
        args: ["serverID"],
        confirm: true,
        description: "Leave a server.",
    },
    "servers.retrieve": {
        args: [],
        description: "List servers available to this user.",
    },
    "servers.retrieveByID": {
        args: ["serverID"],
        description: "Get one server by ID.",
    },
    "servers.retrieveWithChannels": {
        args: [],
        description: "Fetch servers and channels in one payload.",
    },
    "sessions.markVerified": {
        args: ["fingerprint"],
        confirm: true,
        description: "Mark one encryption session as verified.",
    },
    "sessions.retrieve": {
        args: [],
        description: "Return all locally known encryption sessions.",
    },
    "sessions.verify": {
        args: ["session"],
        description: "Build a human-readable verification phrase from a session object.",
    },
    "setLocalMessageRetentionDays": {
        args: ["days"],
        confirm: true,
        description: "Update local message retention cap and prune immediately.",
    },
    "subscribeNotifications": {
        args: ["{channel,token,events?,platform?}"],
        confirm: true,
        description: "Register a push notification subscription.",
    },
    "syncInboxNow": {
        args: [],
        description: "Trigger an immediate inbox sync.",
    },
    "toString": {
        args: [],
        description: "Return a compact debug label.",
    },
    "unsubscribeNotifications": {
        args: ["subscriptionID"],
        confirm: true,
        description: "Remove a push notification subscription.",
    },
    "users.familiars": {
        args: [],
        description: "Return users with active local sessions.",
    },
    "users.retrieve": {
        args: ["identifier"],
        description: "Look up a user by user ID, username, or signing key.",
    },
    "whoami": {
        args: [],
        sensitive: true,
        description: "Return authenticated session details; bearer token is redacted if present.",
    },
});

const BLOCKED_VEX_API_METHODS = Object.freeze({
    close: "Would shut down the running bot process.",
    connect: "The bot already owns its websocket lifecycle.",
    deleteAllData: "Would wipe local bot data and credentials state.",
    login: "Would replace the bot's authenticated session.",
    loginWithDeviceKey: "Would replace the bot's authenticated session.",
    logout: "Would log out the running bot.",
    reconnectWebsocket: "The PM2 process owns reconnect behavior for this bot.",
    register: "Would create or switch accounts outside the configured bot identity.",
});

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
        `${settings.username} bot online as ${me.username} (${me.userID}); listening for @${settings.username} <text> in channels and all DM messages`,
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
    const channelNames = channels.map((channel) => `#${channel.name}`);
    console.log(
        `joined invite ${inviteID}; server=${permission.resourceID}${
            channelNames.length > 0 ? ` channels=${channelNames.join(", ")}` : ""
        }`,
    );
    return {
        channelNames,
        inviteID,
        serverID: permission.resourceID,
    };
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

    const inviteResults = message.group
        ? []
        : await joinDmedInvites(client, message.message);
    const prompt = message.group
        ? parseBotPrompt(message.message, settings)
        : parseDirectPrompt(message.message, settings);
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
        if (inviteResults.length > 0) {
            await replyInviteResults(client, message, inviteResults);
            return;
        }
        await reply(
            client,
            message,
            message.group
                ? `Usage: @${settings.username} <text>`
                : `Send a message and I will respond. In channels, use @${settings.username} <text>.`,
        );
        return;
    }

    if (inviteResults.length > 0) {
        await replyInviteResults(client, message, inviteResults);
    }

    console.log(
        `prompt from ${message.authorID}${message.group ? ` in ${message.group}` : ""}: ${prompt}`,
    );
    let output;
    let completed = false;
    try {
        output = await completeWithModel(client, settings, message, prompt);
        completed = true;
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

    if (completed) {
        void updateConversationMemory(client, settings, message, prompt, output).catch(
            (err) => {
                logDebug(settings, `memory update failed: ${formatError(err)}`);
            },
        );
    }
}

async function joinDmedInvites(client, text) {
    const inviteIDs = extractInviteIDs(text);
    const results = [];
    for (const inviteID of inviteIDs) {
        try {
            results.push({
                ok: true,
                ...(await redeemInvite(client, inviteID)),
            });
        } catch (err) {
            const error = formatError(err);
            console.error(`failed to join DM invite ${inviteID}: ${error}`);
            results.push({ error, inviteID, ok: false });
        }
    }
    return results;
}

async function replyInviteResults(client, message, results) {
    for (const result of results) {
        await reply(client, message, formatInviteResult(result));
    }
}

function formatInviteResult(result) {
    if (!result.ok) {
        return `Could not join invite ${result.inviteID}: ${result.error}`;
    }
    const channels =
        result.channelNames?.length > 0
            ? ` Channels: ${result.channelNames.join(", ")}.`
            : "";
    return `Joined invite ${result.inviteID}. Server: ${result.serverID}.${channels}`;
}

async function completeWithModel(client, settings, source, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
    try {
        const headers = { "Content-Type": "application/json" };
        if (settings.llmApiKey) {
            headers.Authorization = `Bearer ${settings.llmApiKey}`;
        }
        const context = await buildConversationContext(
            client,
            settings,
            source,
        ).catch((err) => {
            logDebug(settings, `context lookup failed: ${formatError(err)}`);
            return { recent: "", summary: "" };
        });
        const toolTrace = [];
        let contextMode = 0;
        for (let step = 0; ; step++) {
            const activeContext = contextForMode(settings, context, contextMode);
            const userContent = buildModelPrompt(
                settings,
                prompt,
                activeContext,
                toolTrace,
            );
            let content;
            try {
                content = await requestChatCompletion(
                    settings,
                    headers,
                    controller.signal,
                    userContent,
                );
            } catch (err) {
                if (err instanceof ContextExceededError && contextMode < 3) {
                    contextMode++;
                    logContextRetry(settings, contextMode);
                    continue;
                }
                throw err;
            }
            const toolCall = parseToolCall(content);
            if (!toolCall) return cleanupFinalAnswer(content);
            if (step >= settings.vexToolSteps) {
                try {
                    return await completeFromToolTrace(
                        settings,
                        headers,
                        controller.signal,
                        prompt,
                        activeContext,
                        toolTrace,
                    );
                } catch (err) {
                    if (err instanceof ContextExceededError && contextMode < 3) {
                        contextMode++;
                        logContextRetry(settings, contextMode);
                        continue;
                    }
                    throw err;
                }
            }
            if (hasToolCall(toolTrace, toolCall)) {
                try {
                    return await completeFromToolTrace(
                        settings,
                        headers,
                        controller.signal,
                        prompt,
                        activeContext,
                        toolTrace,
                    );
                } catch (err) {
                    if (err instanceof ContextExceededError && contextMode < 3) {
                        contextMode++;
                        logContextRetry(settings, contextMode);
                        continue;
                    }
                    throw err;
                }
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
        if (isContextExceeded(body)) {
            throw new ContextExceededError(
                `LLM request exceeded context: ${body.slice(0, 500)}`,
            );
        }
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

function isContextExceeded(body) {
    return /request exceeds available context|exceeds available context|context.*exceed|exceed.*context|n_ctx/i.test(
        String(body ?? ""),
    );
}

function logContextRetry(settings, mode) {
    logDebug(
        settings,
        `model context exceeded; retrying with ${describeContextMode(mode)}`,
    );
}

function contextForMode(settings, context, mode) {
    if (!context) return "";
    const summary = truncateText(
        String(context.summary ?? "").trim(),
        settings.memorySummaryChars,
    );
    let recent = String(context.recent ?? "").trim();
    if (mode === 1) recent = compactContext(settings, recent);
    if (mode >= 2) recent = "";
    if (mode >= 3) return "";
    return formatConversationContext(summary, recent);
}

function describeContextMode(mode) {
    if (mode === 1) return "compacted recent chat context";
    if (mode === 2) return "memory summary only";
    return "no chat memory";
}

function formatConversationContext(summary, recent) {
    const parts = [];
    if (summary) {
        parts.push(`Rolling memory summary:\n${summary}`);
    }
    if (recent) {
        parts.push(`Recent chat context, oldest to newest:\n${recent}`);
    }
    return parts.join("\n\n");
}

function compactContext(settings, context) {
    const text = String(context ?? "").trim();
    if (!text) return "";
    const lines = text.split("\n").filter(Boolean);
    const recent = [];
    let used = 0;
    const budget = Math.max(200, Math.floor(settings.contextChars / 2));
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = truncateText(lines[i], 140);
        const next = used + line.length + 1;
        if (next > budget && recent.length > 0) break;
        recent.unshift(line);
        used = next;
    }
    return recent.join("\n");
}

function buildModelPrompt(settings, prompt, context, toolTrace = []) {
    const parts = [
        `You are ${settings.username}, an AI assistant inside a Vex chat.`,
        "Answer directly and keep the response useful.",
        "If conversation context is provided, use it as memory for this conversation, but do not quote it unless helpful.",
        buildVexToolInstructions(settings),
    ];
    if (context) {
        parts.push(`Conversation context:\n${context}`);
    }
    if (toolTrace.length > 0) {
        parts.push(
            `Vex tool results so far:\n${toolTrace
                .map(formatToolTraceEntry)
                .join("\n\n")}`,
        );
        parts.push(
            "Use the Vex tool results above to answer when they are sufficient. Do not repeat an identical tool call.",
        );
    }
    parts.push(`Current prompt:\n${prompt}`);
    return parts.join("\n\n");
}

function buildVexToolInstructions(settings) {
    if (settings.vexToolSteps <= 0) {
        return "Vex tools are disabled for this run.";
    }
    return `You may inspect and operate Vex through tools backed by libvex.
Available tools:
- vex.current_chat: details about the current DM or channel and the prompting user. Arguments: {}.
- vex.list_servers: list servers visible to this bot, with channels. Arguments: {}.
- vex.list_channels: list channels in a server. Arguments: {"server_id":"..."}; omit server_id to use the current channel's server.
- vex.channel_members: list users visible in a channel. Arguments: {"channel_id":"..."}; omit channel_id to use the current channel.
- vex.recent_messages: read recent decrypted local history through libvex. Arguments: {"channel_id":"...","user_id":"...","limit":20}; omit channel_id/user_id to use the current chat.
- vex.search_messages: search decrypted local history through libvex. Arguments: {"query":"text","scope":"current|all","channel_id":"...","user_id":"...","limit":20}; omit IDs to use the current chat unless scope is all.
- vex.local_overview: summarize libvex-readable local state: visible channels, familiar DMs, message counts, sessions, permissions, and memory entries. Arguments: {}.
- vex.local_sessions: list sanitized local encryption-session metadata without secret keys. Arguments: {"limit":20}.
- vex.local_memory: read this bot's rolling memory summary for the current chat or all chats. Arguments: {"scope":"current|all","limit":10}.
- vex.lookup_user: look up a user by username or user id. Arguments: {"identifier":"..."}.
- vex.my_profile: show the bot's current user and device ids. Arguments: {}.
- vex.api_surface: list callable libvex public API methods. Arguments: {"namespace":"optional namespace such as messages, servers, channels"}.
- vex.api: call a public libvex method by path. Arguments: {"path":"messages.retrieveGroup","args":["channel-id"]}. Mutating calls require {"confirm":true,"reason":"..."}.

When you need a Vex tool, reply with only this JSON:
{"type":"tool","name":"vex.current_chat","arguments":{}}

Call at most one tool per response. Do not invent Vex IDs; use tools to discover them. Use the normal final answer for ordinary replies; do not call messages.send or messages.group just to answer the prompt. After tool results are provided, answer normally in plain text.`;
}

function formatToolTraceEntry(entry) {
    return `Tool call: ${JSON.stringify(entry.call)}\nTool result: ${JSON.stringify(entry.result)}`;
}

async function completeFromToolTrace(
    settings,
    headers,
    signal,
    prompt,
    context,
    toolTrace,
) {
    if (toolTrace.length === 0) {
        return "I tried to use a Vex tool, but I did not get a tool result.";
    }
    const finalSettings = { ...settings, vexToolSteps: 0 };
    const userContent = `${buildModelPrompt(
        finalSettings,
        prompt,
        context,
        toolTrace,
    )}\n\nNo more tool calls are available. Reply now in plain text using the Vex tool results.`;
    const content = await requestChatCompletion(
        settings,
        headers,
        signal,
        userContent,
    );
    if (!parseToolCall(content)) return cleanupFinalAnswer(content);
    return fallbackToolTraceAnswer(toolTrace);
}

function hasToolCall(toolTrace, toolCall) {
    const rendered = JSON.stringify(normalizeToolCall(toolCall));
    return toolTrace.some(
        (entry) => JSON.stringify(normalizeToolCall(entry.call)) === rendered,
    );
}

function normalizeToolCall(toolCall) {
    return {
        arguments: sortObjectKeys(toolCall.arguments ?? {}),
        name: toolCall.name,
    };
}

function sortObjectKeys(value) {
    if (Array.isArray(value)) return value.map(sortObjectKeys);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, sortObjectKeys(child)]),
    );
}

function fallbackToolTraceAnswer(toolTrace) {
    const latest = toolTrace.at(-1);
    if (latest?.call?.name === "vex.my_profile") {
        const user = latest.result?.user;
        if (user?.username && user?.userID) {
            return `My Vex username is ${user.username}, and my user ID is ${user.userID}.`;
        }
    }
    return `Vex tool result: ${JSON.stringify(latest?.result ?? toolTrace)}`;
}

function parseToolCall(content) {
    const trimmed = String(content ?? "").trim();
    const withoutPrefix = trimmed.startsWith("TOOL_CALL:")
        ? trimmed.slice("TOOL_CALL:".length).trim()
        : trimmed;
    const candidates = [withoutPrefix];
    const fenced = withoutPrefix.match(/```(?:json)?\s*({[\s\S]*?})\s*```/i);
    if (fenced?.[1]) candidates.unshift(fenced[1].trim());
    const firstBrace = withoutPrefix.indexOf("{");
    const lastBrace = withoutPrefix.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(withoutPrefix.slice(firstBrace, lastBrace + 1));
    }
    for (const jsonText of candidates) {
        const toolCall = parseToolCallJson(jsonText);
        if (toolCall) return toolCall;
    }
    return null;
}

function parseToolCallJson(jsonText) {
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
        case "vex.search_messages":
            result = await vexSearchMessages(client, source, args);
            break;
        case "vex.local_overview":
            result = await vexLocalOverview(client, settings, source);
            break;
        case "vex.local_sessions":
            result = await vexLocalSessions(client, args);
            break;
        case "vex.local_memory":
            result = await vexLocalMemory(settings, source, args);
            break;
        case "vex.lookup_user":
            result = await vexLookupUser(client, args);
            break;
        case "vex.my_profile":
            result = vexMyProfile(client);
            break;
        case "vex.api_surface":
            result = vexApiSurface(args);
            break;
        case "vex.api":
            result = await vexApiCall(client, args);
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
                    "vex.search_messages",
                    "vex.local_overview",
                    "vex.local_sessions",
                    "vex.local_memory",
                    "vex.lookup_user",
                    "vex.my_profile",
                    "vex.api_surface",
                    "vex.api",
                ],
            };
    }
    const clipped = clipToolResult(result);
    logDebug(settings, `tool ${toolCall.name} -> ${JSON.stringify(clipped)}`);
    return clipped;
}

function vexApiSurface(args) {
    const namespace = String(args.namespace ?? args.ns ?? "").trim();
    const methods = Object.entries(VEX_API_SURFACE)
        .filter(([pathName]) => !namespace || pathName.startsWith(`${namespace}.`))
        .map(([pathName, spec]) => ({
            args: spec.args,
            confirmRequired: Boolean(spec.confirm),
            description: spec.description,
            path: pathName,
            sensitiveResult: Boolean(spec.sensitive),
        }));
    const blocked = Object.entries(BLOCKED_VEX_API_METHODS).map(
        ([pathName, reason]) => ({ path: pathName, reason }),
    );
    return { blocked, methods, namespace: namespace || null };
}

async function vexApiCall(client, args) {
    const pathName = String(args.path ?? args.method ?? "").trim();
    if (!pathName) {
        return {
            error: "path is required, for example messages.retrieveGroup",
            surfaceTool: "vex.api_surface",
        };
    }
    const blockedReason = BLOCKED_VEX_API_METHODS[pathName];
    if (blockedReason) {
        return { blocked: true, error: blockedReason, path: pathName };
    }
    const spec = VEX_API_SURFACE[pathName];
    if (!spec) {
        return {
            error: `Unsupported libvex API method: ${pathName}`,
            knownSimilar: similarApiPaths(pathName),
            surfaceTool: "vex.api_surface",
        };
    }
    if (spec.confirm && args.confirm !== true) {
        return {
            confirmRequired: true,
            error: `${pathName} mutates Vex or local bot state. Call again with confirm:true and a brief reason if this is intentional.`,
            path: pathName,
        };
    }
    const { fn, thisValue } = resolveApiFunction(client, pathName);
    const callArgs = resolveApiCallArgs(args, spec).map(materializeApiArg);
    const result = await fn.apply(thisValue, callArgs);
    return {
        path: pathName,
        result: sanitizeApiResult(pathName, result),
    };
}

function similarApiPaths(pathName) {
    const lower = pathName.toLowerCase();
    return Object.keys(VEX_API_SURFACE)
        .filter(
            (candidate) =>
                candidate.toLowerCase().includes(lower) ||
                lower.includes(candidate.toLowerCase().split(".").at(-1)),
        )
        .slice(0, 10);
}

function resolveApiFunction(client, pathName) {
    const parts = pathName.split(".");
    let target = client;
    for (const part of parts.slice(0, -1)) {
        target = target?.[part];
    }
    const method = target?.[parts.at(-1)];
    if (typeof method !== "function") {
        throw new Error(`libvex method is not callable: ${pathName}`);
    }
    return { fn: method, thisValue: target };
}

function resolveApiCallArgs(args, spec) {
    if (Array.isArray(args.args)) return args.args;
    if (spec.args.length === 1 && spec.args[0].startsWith("{")) {
        return [apiNamedObjectArgs(args)];
    }
    return spec.args
        .filter((name) => !name.endsWith("?"))
        .map((name) => args[apiArgObjectKey(name)]);
}

function apiNamedObjectArgs(args) {
    return Object.fromEntries(
        Object.entries(args).filter(
            ([key]) =>
                !["args", "confirm", "method", "path", "reason"].includes(key),
        ),
    );
}

function apiArgObjectKey(name) {
    return name.replace(/[{}?]/g, "").split(",")[0];
}

function materializeApiArg(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }
    if (
        value.type === "bytes" ||
        value.kind === "bytes" ||
        value.__type === "Uint8Array"
    ) {
        if (typeof value.base64 === "string") {
            return Uint8Array.from(Buffer.from(value.base64, "base64"));
        }
        if (typeof value.hex === "string") {
            return Uint8Array.from(Buffer.from(value.hex, "hex"));
        }
        if (typeof value.text === "string") {
            return Uint8Array.from(Buffer.from(value.text, "utf8"));
        }
        if (Array.isArray(value.bytes)) {
            return Uint8Array.from(value.bytes);
        }
    }
    return value;
}

function sanitizeApiResult(pathName, value) {
    if (pathName === "getKeys") {
        return {
            private: "[redacted]",
            public: value?.public,
        };
    }
    return sanitizeApiValue(value);
}

function sanitizeApiValue(value, seen = new WeakSet()) {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return {
            bytes: value.byteLength,
            previewBase64: Buffer.from(value).subarray(0, 64).toString("base64"),
            truncated: value.byteLength > 64,
        };
    }
    if (value instanceof Map) {
        return sanitizeApiValue(Object.fromEntries(value.entries()), seen);
    }
    if (value instanceof Date) return value.toISOString();
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeApiValue(item, seen));
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
            key,
            shouldRedactApiField(key)
                ? "[redacted]"
                : sanitizeApiValue(child, seen),
        ]),
    );
}

function shouldRedactApiField(key) {
    return /^(private|privateKey|token|bearer|password|secret|SK|keyData)$/i.test(
        key,
    );
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

async function vexSearchMessages(client, source, args) {
    const query = String(args.query ?? args.q ?? "").trim().toLowerCase();
    const limit = clampInt(args.limit, 20, 1, 50);
    const targets = await resolveMessageSearchTargets(client, source, args);
    const matches = [];
    for (const target of targets.slice(0, 40)) {
        const history =
            target.kind === "channel"
                ? await client.messages.retrieveGroup(target.id)
                : await client.messages.retrieve(target.id);
        for (const message of history) {
            if (!message.decrypted || !message.message.trim()) continue;
            const body = message.message.replace(/\s+/g, " ");
            if (query && !body.toLowerCase().includes(query)) continue;
            matches.push({
                authorID: message.authorID,
                group: message.group,
                mailID: message.mailID,
                message: truncateForContext(body),
                target,
                timestamp: message.timestamp,
                username: await usernameFor(client, message.authorID),
            });
        }
    }
    matches.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    return {
        matches: matches.slice(0, limit),
        query,
        searchedTargets: targets.length,
    };
}

async function resolveMessageSearchTargets(client, source, args) {
    const channelID = args.channel_id ?? args.channelID;
    if (channelID) {
        const channel = await client.channels.retrieveByID(String(channelID));
        return [
            {
                id: String(channelID),
                kind: "channel",
                name: channel?.name ?? String(channelID),
            },
        ];
    }
    const userID = args.user_id ?? args.userID;
    if (userID) {
        return [
            {
                id: String(userID),
                kind: "dm",
                name: await usernameFor(client, String(userID)),
            },
        ];
    }
    if (String(args.scope ?? "").toLowerCase() === "all") {
        const [bootstrap, familiars] = await Promise.all([
            client.servers.retrieveWithChannels().catch(() => ({
                channelsByServer: {},
                servers: [],
            })),
            client.users.familiars().catch(() => []),
        ]);
        const serverNames = new Map(
            bootstrap.servers.map((server) => [server.serverID, server.name]),
        );
        const channels = Object.values(bootstrap.channelsByServer)
            .flat()
            .map((channel) => ({
                id: channel.channelID,
                kind: "channel",
                name: `#${channel.name}`,
                server: serverNames.get(channel.serverID),
            }));
        const botID = client.me.user().userID;
        const dms = familiars
            .filter((user) => user.userID !== botID)
            .map((user) => ({
                id: user.userID,
                kind: "dm",
                name: user.username,
            }));
        return [...channels, ...dms];
    }
    if (source.group) {
        const channel = await client.channels.retrieveByID(source.group);
        return [
            {
                id: source.group,
                kind: "channel",
                name: channel?.name ? `#${channel.name}` : source.group,
            },
        ];
    }
    return [
        {
            id: source.authorID,
            kind: "dm",
            name: await usernameFor(client, source.authorID),
        },
    ];
}

async function vexLocalOverview(client, settings, source) {
    const [bootstrap, familiars, sessions, permissions, memory] =
        await Promise.all([
            client.servers.retrieveWithChannels().catch(() => ({
                channelsByServer: {},
                servers: [],
            })),
            client.users.familiars().catch(() => []),
            client.sessions.retrieve().catch(() => []),
            client.permissions.retrieve().catch(() => []),
            readMemoryStore(settings.memoryPath).catch(() => createMemoryStore()),
        ]);
    const channelStats = [];
    for (const server of bootstrap.servers) {
        for (const channel of bootstrap.channelsByServer[server.serverID] ?? []) {
            channelStats.push({
                channel: sanitizeChannel(channel),
                history: await messageHistoryStats(
                    client.messages.retrieveGroup(channel.channelID),
                ),
                server: sanitizeServer(server),
            });
        }
    }
    const botID = client.me.user().userID;
    const dmStats = [];
    for (const user of familiars.filter((item) => item.userID !== botID)) {
        dmStats.push({
            history: await messageHistoryStats(
                client.messages.retrieve(user.userID),
            ),
            user: sanitizeUser(user),
        });
    }
    return {
        bot: sanitizeUser(client.me.user()),
        channels: channelStats,
        currentChatKey: chatMemoryKey(source),
        dms: dmStats,
        memoryEntries: Object.entries(memory.chats ?? {}).map(([key, entry]) => ({
            key,
            kind: entry.kind,
            summaryChars: String(entry.summary ?? "").length,
            updatedAt: entry.updatedAt,
        })),
        permissions: permissions.map(sanitizePermission),
        sessionCount: sessions.length,
    };
}

async function messageHistoryStats(historyPromise) {
    const history = await historyPromise.catch(() => []);
    const visible = history.filter(
        (message) => message.decrypted && message.message.trim(),
    );
    const last = visible
        .slice()
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
        .at(0);
    return {
        decryptedMessages: visible.length,
        latest: last
            ? {
                  authorID: last.authorID,
                  mailID: last.mailID,
                  timestamp: last.timestamp,
              }
            : null,
        totalMessages: history.length,
    };
}

async function vexLocalSessions(client, args) {
    const limit = clampInt(args.limit, 20, 1, 50);
    const sessions = await client.sessions.retrieve();
    sessions.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
    const items = [];
    for (const session of sessions.slice(0, limit)) {
        items.push(await sanitizeSession(client, session));
    }
    return {
        sessions: items,
        total: sessions.length,
    };
}

async function sanitizeSession(client, session) {
    const userID = session.userID ?? session.userId;
    return {
        deviceID: session.deviceID,
        fingerprint: session.fingerprint,
        lastUsed: session.lastUsed,
        mode: session.mode,
        sessionID: session.sessionID,
        userID,
        username: userID
            ? await usernameFor(client, userID).catch(() => userID)
            : undefined,
        verified: Boolean(session.verified),
    };
}

async function vexLocalMemory(settings, source, args) {
    if (!settings.memoryEnabled) return { enabled: false };
    const store = await readMemoryStore(settings.memoryPath);
    if (String(args.scope ?? "").toLowerCase() === "all") {
        const limit = clampInt(args.limit, 10, 1, 50);
        const entries = Object.entries(store.chats ?? {})
            .sort(([, a], [, b]) =>
                String(b.updatedAt).localeCompare(String(a.updatedAt)),
            )
            .slice(0, limit)
            .map(([key, entry]) => ({
                key,
                kind: entry.kind,
                lastMailID: entry.lastMailID,
                summary: truncateText(
                    entry.summary ?? "",
                    settings.memorySummaryChars,
                ),
                updatedAt: entry.updatedAt,
            }));
        return { enabled: true, entries };
    }
    const key = chatMemoryKey(source);
    const entry = store.chats?.[key];
    return {
        enabled: true,
        key,
        memory: entry
            ? {
                  kind: entry.kind,
                  lastMailID: entry.lastMailID,
                  summary: truncateText(
                      entry.summary ?? "",
                      settings.memorySummaryChars,
                  ),
                  updatedAt: entry.updatedAt,
              }
            : null,
    };
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

function sanitizePermission(permission) {
    if (!permission) return null;
    return {
        permissionID: permission.permissionID,
        powerLevel: permission.powerLevel,
        resourceID: permission.resourceID,
        resourceType: permission.resourceType,
        userID: permission.userID,
    };
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

async function buildConversationContext(client, settings, source) {
    const summary = settings.memoryEnabled
        ? await readChatMemorySummary(settings, source).catch((err) => {
              logDebug(settings, `memory read failed: ${formatError(err)}`);
              return "";
          })
        : "";
    const recent = await buildRecentChatContext(client, settings, source);
    return { recent, summary };
}

async function buildRecentChatContext(client, settings, source) {
    if (settings.contextMessages <= 0 || settings.contextChars <= 0) return "";
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
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        const line = await formatContextMessage(client, recent[i]);
        const next = used + line.length + 1;
        if (next > settings.contextChars && lines.length > 0) break;
        if (next > settings.contextChars) {
            lines.unshift(truncateText(line, settings.contextChars));
            break;
        }
        lines.unshift(line);
        used = next;
    }
    return lines.join("\n");
}

async function readChatMemorySummary(settings, source) {
    const store = await readMemoryStore(settings.memoryPath);
    const entry = store.chats?.[chatMemoryKey(source)];
    if (!entry || typeof entry.summary !== "string") return "";
    return truncateText(entry.summary.trim(), settings.memorySummaryChars);
}

async function updateConversationMemory(client, settings, source, prompt, answer) {
    if (!settings.memoryEnabled || settings.memorySummaryChars <= 0) return;
    memoryUpdateQueue = memoryUpdateQueue
        .catch(() => {})
        .then(() =>
            updateConversationMemoryNow(
                client,
                settings,
                source,
                prompt,
                answer,
            ),
        );
    await memoryUpdateQueue;
}

async function updateConversationMemoryNow(
    client,
    settings,
    source,
    prompt,
    answer,
) {
    const key = chatMemoryKey(source);
    const store = await readMemoryStore(settings.memoryPath).catch((err) => {
        logDebug(settings, `memory store read failed: ${formatError(err)}`);
        return createMemoryStore();
    });
    const previous = store.chats[key]?.summary ?? "";
    const recent = await buildRecentChatContext(
        client,
        {
            ...settings,
            contextChars: Math.min(settings.contextChars, 900),
            contextMessages: Math.min(settings.contextMessages, 6),
        },
        source,
    ).catch(() => "");
    const summary = await summarizeMemory(
        client,
        settings,
        source,
        previous,
        recent,
        prompt,
        answer,
    );
    store.version = MEMORY_VERSION;
    store.updatedAt = new Date().toISOString();
    store.chats[key] = {
        kind: source.group ? "channel" : "dm",
        key,
        lastMailID: source.mailID,
        summary: truncateText(
            cleanupMemorySummary(summary),
            settings.memorySummaryChars,
        ),
        updatedAt: store.updatedAt,
    };
    await writeMemoryStore(settings.memoryPath, store);
    logDebug(settings, `memory updated for ${key}`);
}

async function summarizeMemory(
    client,
    settings,
    source,
    previous,
    recent,
    prompt,
    answer,
) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.llmTimeoutMs);
    try {
        const headers = { "Content-Type": "application/json" };
        if (settings.llmApiKey) {
            headers.Authorization = `Bearer ${settings.llmApiKey}`;
        }
        const author = await usernameFor(client, source.authorID).catch(
            () => source.authorID,
        );
        const content = buildMemoryPrompt(settings, {
            answer,
            author,
            previous,
            prompt,
            recent,
        });
        return await requestChatCompletion(
            settings,
            headers,
            controller.signal,
            content,
        );
    } catch (err) {
        if (err instanceof ContextExceededError) {
            logDebug(settings, "memory summary overflow; keeping previous memory");
            return previous;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function buildMemoryPrompt(
    settings,
    { answer, author, previous, prompt, recent },
) {
    return [
        "Update the rolling memory summary for a Vex chat.",
        `Keep it under ${settings.memorySummaryChars} characters.`,
        "Keep durable facts, preferences, decisions, active plans, unresolved questions, project details, and names/roles.",
        "Drop small talk, duplicates, one-off commands, and stale details. Do not invent facts.",
        "Return only the updated summary text.",
        `Previous summary:\n${truncateText(
            previous || "(none)",
            settings.memorySummaryChars,
        )}`,
        `Recent raw context:\n${truncateText(recent || "(none)", 900)}`,
        `New exchange:\n${author}: ${truncateText(prompt, 700)}\n${
            settings.username
        }: ${truncateText(answer, 900)}`,
    ].join("\n\n");
}

function cleanupMemorySummary(summary) {
    const text = String(summary ?? "").trim();
    return text
        .replace(/^updated summary:\s*/i, "")
        .replace(/^summary:\s*/i, "")
        .trim();
}

async function readMemoryStore(memoryPath) {
    try {
        const raw = await fs.readFile(memoryPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return createMemoryStore();
        return {
            ...parsed,
            chats:
                parsed.chats && typeof parsed.chats === "object"
                    ? parsed.chats
                    : {},
            version: parsed.version ?? MEMORY_VERSION,
        };
    } catch (err) {
        if (err?.code === "ENOENT") return createMemoryStore();
        throw err;
    }
}

async function writeMemoryStore(memoryPath, store) {
    const tempPath = `${memoryPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), {
        mode: 0o600,
    });
    await fs.rename(tempPath, memoryPath);
}

function createMemoryStore() {
    return {
        chats: {},
        createdAt: new Date().toISOString(),
        version: MEMORY_VERSION,
    };
}

function chatMemoryKey(source) {
    return source.group ? `channel:${source.group}` : `dm:${source.authorID}`;
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
    return truncateText(text, MAX_CONTEXT_LINE_CHARS);
}

function truncateText(text, maxChars) {
    const value = String(text ?? "");
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
    return `${value.slice(0, maxChars - 3)}...`;
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
    const commandPrompt = parseCommandPrompt(trimmed);
    if (commandPrompt !== null) return commandPrompt;

    const mention = mentionRegex(settings.username);
    if (!mention.test(trimmed)) return null;
    return stripMentions(trimmed, settings);
}

function parseDirectPrompt(text, settings) {
    const trimmed = stripInviteText(text);
    const commandPrompt = parseCommandPrompt(trimmed);
    if (commandPrompt !== null) return commandPrompt;
    return stripMentions(trimmed, settings);
}

function parseCommandPrompt(text) {
    const trimmed = String(text ?? "").trim();
    const lower = trimmed.toLowerCase();
    for (const command of LEGACY_COMMANDS) {
        if (lower === command) return "";
        if (lower.startsWith(`${command} `)) {
            return trimmed.slice(command.length).trim();
        }
    }
    return null;
}

function stripMentions(text, settings) {
    return String(text ?? "")
        .replace(mentionRegex(settings.username, "gi"), " ")
        .trim();
}

function extractInviteIDs(text) {
    const ids = new Set();
    const value = String(text ?? "");
    INVITE_LINK_REGEX.lastIndex = 0;
    for (const match of value.matchAll(INVITE_LINK_REGEX)) {
        ids.add(match[1].toLowerCase());
    }
    INVITE_LINK_REGEX.lastIndex = 0;
    const raw = value.match(RAW_INVITE_REGEX);
    if (raw?.[1]) ids.add(raw[1].toLowerCase());
    return [...ids];
}

function stripInviteText(text) {
    INVITE_LINK_REGEX.lastIndex = 0;
    const stripped = String(text ?? "")
        .replace(INVITE_LINK_REGEX, " ")
        .replace(/\s+/g, " ")
        .trim();
    INVITE_LINK_REGEX.lastIndex = 0;
    if (RAW_INVITE_REGEX.test(stripped)) return "";
    return /[A-Za-z0-9]/.test(stripped) ? stripped : "";
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
                path.join(os.homedir(), `.vex-${username}`),
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
    const contextChars = Number.parseInt(
        String(
            flags["context-chars"] ??
                process.env.VEX_QWEN_CONTEXT_CHARS ??
                DEFAULT_CONTEXT_CHARS,
        ),
        10,
    );
    const memorySummaryChars = Number.parseInt(
        String(
            flags["memory-summary-chars"] ??
                process.env.VEX_QWEN_MEMORY_SUMMARY_CHARS ??
                DEFAULT_MEMORY_SUMMARY_CHARS,
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
        contextChars: Number.isFinite(contextChars)
            ? Math.max(0, contextChars)
            : DEFAULT_CONTEXT_CHARS,
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
        memoryEnabled:
            !Boolean(flags["no-memory"]) &&
            !["0", "false", "no", "off"].includes(
                String(process.env.VEX_QWEN_MEMORY ?? "1").toLowerCase(),
            ),
        memoryPath: path.join(dataDir, `${username}-memory.json`),
        memorySummaryChars: Number.isFinite(memorySummaryChars)
            ? Math.max(0, memorySummaryChars)
            : DEFAULT_MEMORY_SUMMARY_CHARS,
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
        if (["debug", "help", "http", "local", "no-memory"].includes(key)) {
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

Creates or reuses a libvex user named ${DEFAULT_USERNAME}, redeems the configured invite,
responds to "@${DEFAULT_USERNAME} <text>" in channels, and responds to every DM message.

Options:
  --invite <url-or-id>       Invite to redeem (default: ${DEFAULT_INVITE})
  --llm-url <url>            OpenAI-compatible base or chat URL (default: ${DEFAULT_LLM_URL})
  --model <id>               Model field for chat completions (default: ${DEFAULT_MODEL})
  --username <name>          Bot username (default: ${DEFAULT_USERNAME})
  --data-dir <path>          Persistent bot state dir (default: ~/.vex-${DEFAULT_USERNAME})
  --api-url <url>            Vex API URL; sets host and protocol
  --host <host[:port]>       Vex API host (default: ${DEFAULT_HOST})
  --http                     Use http/ws for Vex API
  --local                    Use local Spire at ${LOCAL_HOST}
  --dev-key <key>            x-dev-api-key for local Spire
  --password <password>      Optional password for first registration
  --context-messages <n>     Recent DM/channel messages to send as context (default: ${DEFAULT_CONTEXT_MESSAGES})
  --context-chars <n>        Approximate recent-context character budget (default: ${DEFAULT_CONTEXT_CHARS})
  --memory-summary-chars <n> Rolling per-chat summary budget (default: ${DEFAULT_MEMORY_SUMMARY_CHARS})
  --no-memory                Disable rolling per-chat memory summaries
  --vex-tool-steps <n>       Read-only Vex tool calls allowed per prompt (default: ${DEFAULT_VEX_TOOL_STEPS})
  --llm-timeout-ms <ms>      LLM request timeout (default: 120000)
  --sync-interval-ms <ms>    Poll inbox in addition to websocket notify (default: ${DEFAULT_SYNC_INTERVAL_MS})
  --debug                    Log ignored messages, sync, and context activity
  --help                     Show this help

Environment equivalents:
  VEX_QWEN_INVITE, VEX_QWEN_LLM_URL, VEX_QWEN_MODEL, VEX_QWEN_DATA_DIR,
  VEX_QWEN_USERNAME, VEX_QWEN_PASSWORD, VEX_QWEN_LLM_API_KEY,
  VEX_QWEN_CONTEXT_MESSAGES, VEX_QWEN_CONTEXT_CHARS, VEX_QWEN_MEMORY,
  VEX_QWEN_MEMORY_SUMMARY_CHARS, VEX_QWEN_TOOL_STEPS,
  VEX_QWEN_SYNC_INTERVAL_MS, VEX_QWEN_DEBUG`);
}
