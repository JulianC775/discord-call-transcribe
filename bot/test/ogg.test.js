// Round-trips real Opus packets through OggOpusWriter and checks ffmpeg can read the result.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import prism from 'prism-media';
import { OggOpusWriter } from '../src/ogg.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ogg-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

async function samplePackets(seconds) {
  const source = path.join(tmp, `sine-${seconds}.ogg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-frame_duration', '20', source]);
  const packets = [];
  for await (const packet of fs.createReadStream(source).pipe(new prism.opus.OggDemuxer())) packets.push(packet);
  return packets;
}

function probe(file) {
  const errors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: 'pipe' });
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim());
  return { errors, duration };
}

test('writes a valid Ogg Opus file with the right duration', async () => {
  const packets = await samplePackets(3);
  const out = path.join(tmp, 'plain.ogg');
  const writer = new OggOpusWriter(out);
  packets.forEach((packet, i) => writer.write(packet, 1_000 + i * 20));
  const result = await writer.close();

  assert.equal(result.error, null);
  assert.equal(result.packets, packets.length);
  const { errors, duration } = probe(out);
  assert.equal(errors, '');
  assert.ok(Math.abs(duration - 3) < 0.05, `duration ${duration}`);
});

test('pads long gaps with silence so timing matches wall-clock', async () => {
  const packets = await samplePackets(2);
  const out = path.join(tmp, 'gap.ogg');
  const writer = new OggOpusWriter(out);
  const half = packets.length / 2;
  packets.forEach((packet, i) => writer.write(packet, 1_000 + i * 20 + (i >= half ? 1_000 : 0)));
  await writer.close();

  const { errors, duration } = probe(out);
  assert.equal(errors, '');
  assert.ok(Math.abs(duration - 3) < 0.05, `duration ${duration}`);
});

test('ignores small network jitter', async () => {
  const packets = await samplePackets(2);
  const out = path.join(tmp, 'jitter.ogg');
  const writer = new OggOpusWriter(out);
  packets.forEach((packet, i) => writer.write(packet, 1_000 + i * 20 + (i % 5 === 0 ? 150 : 0)));
  await writer.close();

  assert.ok(Math.abs(probe(out).duration - 2) < 0.05);
});
