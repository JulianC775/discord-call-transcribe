// Discord bot: ?record joins your voice channel and records each speaker locally,
// ?stop ends it. Audio never leaves this machine; see ../../CLAUDE.md.
// Reading "?record" from chat needs the Message Content intent enabled in the
// Developer Portal (Bot > Privileged Gateway Intents). Other messages are ignored.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ActivityType, Client, Events, GatewayIntentBits } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { Recording } from './recorder.js';
import { log } from './log.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const RECORDINGS_DIR = path.resolve(REPO_ROOT, process.env.RECORDINGS_DIR ?? 'recordings');
const PREFIX = process.env.COMMAND_PREFIX ?? '?';
// Stop automatically when the bot has been alone in the channel this long.
const ALONE_TIMEOUT_MS = 2 * 60_000;

if (!process.env.DISCORD_TOKEN) {
  console.error(`DISCORD_TOKEN is missing. Put it in ${path.join(REPO_ROOT, '.env')}`);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const sessions = new Map(); // guildId -> { recording, connection, voiceChannel, aloneTimer }

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function sessionFolderName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
    + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function updatePresence() {
  client.user.setPresence(sessions.size
    ? { activities: [{ type: ActivityType.Custom, name: 'recording', state: '🔴 Recording' }] }
    : { activities: [] });
}

async function announce(channel, content) {
  try {
    await channel.send(content);
  } catch (err) {
    log(`couldn't post in #${channel.name}: ${err.message}`);
  }
}

async function endSession(guildId, reason) {
  const session = sessions.get(guildId);
  if (!session) return null;
  sessions.delete(guildId);
  clearTimeout(session.aloneTimer);
  const summary = await session.recording.stop();
  if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  updatePresence();
  log(`recording stopped (${reason}): ${summary.dir}`);
  return `⏹️ **Recording stopped** (${reason}). `
    + `${formatDuration(summary.durationMs)}, ${summary.speakers.length} speaker(s), ${summary.segments} clips. `
    + `Saved locally to \`recordings/${path.basename(summary.dir)}\`.`;
}

function watchConnection(guildId, connection) {
  connection.on('error', (err) => log(`voice connection error: ${err.message}`));
  if (process.env.DEBUG_VOICE) connection.on('debug', (message) => log(`voice: ${message}`));
  // Standard @discordjs/voice recovery: a moved/reconnecting bot passes through
  // Signalling/Connecting quickly; if it doesn't, the disconnect is real.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      log('voice connection dropped, reconnecting');
    } catch {
      connection.destroy();
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, async () => {
    const session = sessions.get(guildId);
    if (session?.connection !== connection) return; // already ended via /stop
    const message = await endSession(guildId, 'the bot was disconnected');
    await announce(session.voiceChannel, message);
  });
}

async function handleRecord(message) {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    await message.channel.send(`Join a voice channel first, then send \`${PREFIX}record\`.`);
    return;
  }
  if (sessions.has(message.guildId)) {
    await message.channel.send(`Already recording in this server. Send \`${PREFIX}stop\` first.`);
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guildId,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false, // must hear the channel to record it
    selfMute: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    connection.destroy();
    log(`couldn't join ${voiceChannel.name}: ${err.message}`);
    await message.channel.send(`Couldn't join ${voiceChannel}. Check the bot has Connect permission there.`);
    return;
  }

  const recording = new Recording({
    connection,
    guild: message.guild,
    channel: voiceChannel,
    dir: path.join(RECORDINGS_DIR, sessionFolderName(new Date())),
  });
  recording.start();
  sessions.set(message.guildId, { recording, connection, voiceChannel, aloneTimer: null });
  watchConnection(message.guildId, connection);
  updatePresence();
  log(`recording started in ${message.guild.name} / ${voiceChannel.name}: ${recording.dir}`);

  const announcement = `🔴 **Recording started** in ${voiceChannel} by ${message.member}. `
    + 'Everyone speaking in this channel is being recorded to a local file for a transcript. '
    + `Send \`${PREFIX}stop\` to end it.`;
  await message.channel.send(announcement);
  if (message.channelId !== voiceChannel.id) await announce(voiceChannel, announcement);
}

async function handleStop(message) {
  if (!sessions.has(message.guildId)) {
    await message.channel.send('Not recording right now.');
    return;
  }
  const { voiceChannel } = sessions.get(message.guildId);
  const announcement = await endSession(message.guildId, `stopped by ${message.member.displayName}`);
  await message.channel.send(announcement);
  if (message.channelId !== voiceChannel.id) await announce(voiceChannel, announcement);
}

const handlers = { record: handleRecord, stop: handleStop };

client.once(Events.ClientReady, async (ready) => {
  log(`logged in as ${ready.user.tag}; commands: ${PREFIX}record, ${PREFIX}stop`);
  // Remove the slash commands an earlier version registered.
  for (const guild of ready.guilds.cache.values()) {
    await guild.commands.set([]).catch((err) => log(`couldn't clear slash commands in ${guild.name}: ${err.message}`));
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild() || !message.content.startsWith(PREFIX)) return;
  const name = message.content.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
  const handler = handlers[name];
  if (!handler) return;
  try {
    await handler(message);
  } catch (err) {
    log(`${PREFIX}${name} failed: ${err.stack}`);
    await message.channel.send(`Something went wrong: ${err.message}`).catch(() => {});
  }
});

// Auto-stop if everyone else leaves, so a forgotten /stop doesn't record an empty room for hours.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const session = sessions.get(oldState.guild.id);
  if (!session) return;
  const humans = session.voiceChannel.members.filter((member) => !member.user.bot).size;
  if (humans > 0) {
    clearTimeout(session.aloneTimer);
    session.aloneTimer = null;
  } else if (!session.aloneTimer) {
    session.aloneTimer = setTimeout(async () => {
      const message = await endSession(oldState.guild.id, 'everyone left');
      if (message) await announce(session.voiceChannel, message);
    }, ALONE_TIMEOUT_MS);
  }
});

// Ctrl+C: finish writing and announce before exiting.
let shuttingDown = false;
process.on('SIGINT', async () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('shutting down');
  for (const [guildId, { voiceChannel }] of [...sessions]) {
    await announce(voiceChannel, await endSession(guildId, 'the bot was shut down'));
  }
  await client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack ?? err}`));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error(`Login failed: ${err.message}`);
  if (/disallowed intents/i.test(err.message)) {
    console.error('Enable "Message Content Intent" under Bot > Privileged Gateway Intents in the Developer Portal.');
  }
  process.exit(1);
});
