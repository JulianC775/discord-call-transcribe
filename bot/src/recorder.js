// Records every speaker in a voice connection as a series of utterance files:
//   <dir>/session.json               who/where/when, speaker names
//   <dir>/segments.jsonl             one line per utterance: user, file, startMs, durationMs
//   <dir>/<userId>/<startMs>.ogg     the audio
// startMs is milliseconds since the recording started, so the pipeline can put
// every speaker's utterances back on one timeline. Each utterance is on disk as
// soon as it ends, so a crash mid-call only loses what was being said right then.
import fs from 'node:fs';
import path from 'node:path';
import { EndBehaviorType } from '@discordjs/voice';
import { OggOpusWriter } from './ogg.js';
import { log } from './log.js';

// An utterance ends after this much silence. Long enough not to split sentences,
// short enough that files stay small and timestamps stay accurate.
const UTTERANCE_SILENCE_MS = 1500;

export class Recording {
  constructor({ connection, guild, channel, dir }) {
    this.connection = connection;
    this.guild = guild;
    this.channel = channel;
    this.dir = dir;
    this.startedAt = new Date();
    this.endedAt = null;
    this.speakers = new Map(); // userId -> { name, username }
    this.active = new Map(); // userId -> AudioReceiveStream
    this.pending = new Set(); // promises for utterances still being written
    this.segments = 0;
    this.stopped = false;
    this.onSpeakingStart = this.onSpeakingStart.bind(this);
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.segmentLog = fs.createWriteStream(path.join(this.dir, 'segments.jsonl'), { flags: 'a' });
    this.segmentLog.on('error', (err) => log(`segments.jsonl write failed: ${err.message}`));
    this.writeSession();
    this.connection.receiver.speaking.on('start', this.onSpeakingStart);
  }

  onSpeakingStart(userId) {
    if (this.stopped || this.active.has(userId)) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return;
    if (!this.speakers.has(userId)) this.addSpeaker(userId, member);

    const startMs = Date.now() - this.startedAt.getTime();
    const file = `${userId}/${String(startMs).padStart(9, '0')}.ogg`;
    fs.mkdirSync(path.join(this.dir, userId), { recursive: true });
    const writer = new OggOpusWriter(path.join(this.dir, file));
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: UTTERANCE_SILENCE_MS },
    });
    this.active.set(userId, stream);

    stream.on('data', (packet) => writer.write(packet));
    // A DAVE decrypt failure destroys the stream; keep what we have and move on.
    stream.on('error', (err) => log(`audio stream for ${this.speakerName(userId)} failed: ${err.message}`));
    // 'close' fires after both a normal end and an error, and only then does the
    // receiver drop the subscription, so it's the safe point to accept a new one.
    const done = new Promise((resolve) => stream.once('close', resolve))
      .then(() => {
        this.active.delete(userId);
        return writer.close();
      })
      .then(({ packets, samples, error }) => {
        if (error) log(`writing ${file} failed: ${error.message}`);
        if (packets === 0) {
          fs.rmSync(path.join(this.dir, file), { force: true });
          return;
        }
        const durationMs = Math.round(samples / 48);
        this.segmentLog.write(`${JSON.stringify({ user: userId, file, startMs, durationMs })}\n`);
        this.segments++;
      });
    this.pending.add(done);
    done.finally(() => this.pending.delete(done));
  }

  addSpeaker(userId, member) {
    this.speakers.set(userId, { name: member?.displayName ?? userId, username: member?.user.username ?? null });
    this.writeSession();
    if (member) return;
    this.guild.members.fetch(userId)
      .then((fetched) => {
        this.speakers.set(userId, { name: fetched.displayName, username: fetched.user.username });
        this.writeSession();
      })
      .catch((err) => log(`couldn't look up speaker ${userId}: ${err.message}`));
  }

  speakerName(userId) {
    return this.speakers.get(userId)?.name ?? userId;
  }

  writeSession() {
    const session = {
      version: 1,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt?.toISOString() ?? null,
      guild: { id: this.guild.id, name: this.guild.name },
      channel: { id: this.channel.id, name: this.channel.name },
      speakers: Object.fromEntries(this.speakers),
      segments: 'segments.jsonl',
    };
    const target = path.join(this.dir, 'session.json');
    try {
      fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(session, null, 2)}\n`);
      fs.renameSync(`${target}.tmp`, target);
    } catch (err) {
      log(`session.json write failed: ${err.message}`);
    }
  }

  async stop() {
    if (this.stopped) return this.summary();
    this.stopped = true;
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);
    for (const stream of this.active.values()) stream.destroy();
    await Promise.all(this.pending);
    this.endedAt = new Date();
    this.writeSession();
    await new Promise((resolve) => this.segmentLog.end(resolve));
    return this.summary();
  }

  summary() {
    return {
      dir: this.dir,
      durationMs: (this.endedAt ?? new Date()) - this.startedAt,
      speakers: [...this.speakers.values()].map((s) => s.name),
      segments: this.segments,
    };
  }
}
