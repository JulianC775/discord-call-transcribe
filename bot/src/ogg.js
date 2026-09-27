// Minimal Ogg Opus muxer (RFC 7845). Discord hands us raw Opus packets; this wraps
// them in an Ogg container so ffmpeg can read them without decoding in Node.
import crypto from 'node:crypto';
import fs from 'node:fs';

const SAMPLES_PER_MS = 48; // Opus granule positions are always in 48 kHz samples
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]); // 20 ms of Opus silence
const SILENCE_FRAME_SAMPLES = 960;
const MAX_PACKETS_PER_PAGE = 50; // ~1 s of audio per page
// Discord stops sending packets during short pauses. When the next packet arrives
// this late, pad with silence so time inside the file matches wall-clock time.
const GAP_FILL_THRESHOLD_MS = 200;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC_TABLE[i] = r >>> 0;
}

function crc32(buf) {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

// Number of 48 kHz samples in an Opus packet, from its TOC byte (RFC 6716 §3.1).
export function packetSamples(packet) {
  const config = packet[0] >> 3;
  let frameSize;
  if (config < 12) frameSize = [480, 960, 1920, 2880][config & 3]; // SILK
  else if (config < 16) frameSize = [480, 960][config & 1]; // Hybrid
  else frameSize = [120, 240, 480, 960][config & 3]; // CELT
  const code = packet[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? packet[1] & 0x3f : 2;
  return frameSize * frames;
}

function opusHead() {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1; // version
  head[9] = 2; // channels: Discord sends stereo
  head.writeUInt16LE(0, 10); // pre-skip
  head.writeUInt32LE(48000, 12); // original input sample rate
  head.writeInt16LE(0, 16); // output gain
  head[18] = 0; // channel mapping family
  return head;
}

function opusTags() {
  const vendor = Buffer.from('discord-call-transcribe', 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // no user comments
  return tags;
}

export class OggOpusWriter {
  constructor(filePath) {
    this.file = fs.createWriteStream(filePath);
    this.error = null;
    this.file.on('error', (err) => { this.error = err; }); // e.g. disk full; reported by close()
    this.serial = crypto.randomInt(0, 0xffffffff);
    this.pageSequence = 0;
    this.pending = [];
    this.pendingLacing = 0;
    this.samples = 0;
    this.packets = 0;
    this.firstArrival = null;
    this.writePage([opusHead()], 0x02, 0);
    this.writePage([opusTags()], 0, 0);
  }

  write(packet, now = Date.now()) {
    if (packet.length === 0) return;
    if (this.firstArrival === null) {
      this.firstArrival = now;
    } else {
      const behind = (now - this.firstArrival) * SAMPLES_PER_MS - this.samples;
      if (behind > GAP_FILL_THRESHOLD_MS * SAMPLES_PER_MS) {
        for (let n = Math.floor(behind / SILENCE_FRAME_SAMPLES); n > 0; n--) this.addPacket(SILENCE_FRAME);
      }
    }
    this.addPacket(packet);
  }

  addPacket(packet) {
    const lacing = Math.floor(packet.length / 255) + 1;
    if (this.pending.length >= MAX_PACKETS_PER_PAGE || this.pendingLacing + lacing > 255) this.flush(0);
    this.pending.push(packet);
    this.pendingLacing += lacing;
    this.samples += packetSamples(packet);
    this.packets++;
  }

  flush(flags) {
    this.writePage(this.pending, flags, this.samples);
    this.pending = [];
    this.pendingLacing = 0;
  }

  writePage(packets, flags, granule) {
    const segments = [];
    for (const packet of packets) {
      let length = packet.length;
      for (; length >= 255; length -= 255) segments.push(255);
      segments.push(length);
    }
    const header = Buffer.alloc(27 + segments.length);
    header.write('OggS', 0, 'ascii');
    header[4] = 0; // version
    header[5] = flags; // 0x02 = first page, 0x04 = last page
    header.writeBigInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.pageSequence++, 18);
    header[26] = segments.length;
    header.set(segments, 27);
    const page = Buffer.concat([header, ...packets]);
    page.writeUInt32LE(crc32(page), 22);
    this.file.write(page);
  }

  // Resolves once the file is fully written (or failed); never rejects.
  close() {
    this.flush(0x04);
    return new Promise((resolve) => {
      this.file.once('close', () => resolve({ packets: this.packets, samples: this.samples, error: this.error }));
      this.file.end();
    });
  }
}
