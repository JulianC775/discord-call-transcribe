"""Put each speaker's utterance clips back on one continuous 16 kHz mono WAV track.

Whisper gets the whole track (with context between utterances) instead of many
2-second clips, which it tends to hallucinate on.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np
from faster_whisper.audio import decode_audio

SAMPLE_RATE = 16000


def load_session(folder):
    """Read session.json and segments.jsonl.

    Clips on disk that segments.jsonl doesn't list (the bot crashed mid-utterance)
    are added back, using the startMs in their file name.
    """
    folder = Path(folder)
    session = json.loads((folder / "session.json").read_text(encoding="utf-8"))

    segments = []
    seg_file = folder / session.get("segments", "segments.jsonl")
    if seg_file.exists():
        for line in seg_file.read_text(encoding="utf-8").splitlines():
            try:
                segments.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # half-written last line after a crash

    listed = {Path(s["file"]).as_posix() for s in segments}
    for clip in folder.glob("*/*.ogg"):
        rel = clip.relative_to(folder).as_posix()
        if rel not in listed and clip.stem.isdigit():
            segments.append({"user": clip.parent.name, "file": rel, "startMs": int(clip.stem), "durationMs": None})

    segments.sort(key=lambda s: s["startMs"])
    return session, segments


def speaker_names(session, user_ids):
    """Display name per user id, with the username added when two people share a name."""
    speakers = session.get("speakers", {})
    names = {uid: speakers.get(uid, {}).get("name") or uid for uid in user_ids}
    counts = {}
    for name in names.values():
        counts[name] = counts.get(name, 0) + 1
    for uid, name in names.items():
        if counts[name] > 1:
            names[uid] = f"{name} ({speakers.get(uid, {}).get('username') or uid})"
    return names


def stitch(folder, out_dir=None):
    """Write one WAV per speaker. Returns [(user_id, name, wav_path)]."""
    folder = Path(folder)
    out_dir = Path(out_dir or folder / "tracks")
    out_dir.mkdir(parents=True, exist_ok=True)
    session, segments = load_session(folder)

    by_user = {}
    for seg in segments:
        by_user.setdefault(seg["user"], []).append(seg)
    names = speaker_names(session, by_user)

    tracks = []
    for uid, segs in by_user.items():
        end_ms = max(s["startMs"] + (s["durationMs"] or 0) for s in segs)
        track = np.zeros(int(end_ms * SAMPLE_RATE / 1000) + SAMPLE_RATE, dtype=np.int16)
        for seg in segs:
            try:
                audio = decode_audio(str(folder / seg["file"]), sampling_rate=SAMPLE_RATE)
            except Exception as err:  # truncated or corrupt clip
                print(f"  skipping {seg['file']}: {err}", file=sys.stderr)
                continue
            start = int(seg["startMs"] * SAMPLE_RATE / 1000)
            if start + len(audio) > len(track):
                track = np.concatenate([track, np.zeros(start + len(audio) - len(track), dtype=np.int16)])
            track[start:start + len(audio)] = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)

        wav_path = out_dir / f"{uid}.wav"
        write_wav(wav_path, track)
        tracks.append((uid, names[uid], wav_path))
    return tracks


def write_wav(path, samples):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(samples.tobytes())
