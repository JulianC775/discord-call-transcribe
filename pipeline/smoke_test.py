"""GPU smoke test: transcribe one clip. Usage: python -m pipeline.smoke_test [audio file]"""
import sys
import time
from pathlib import Path

from .model import REPO_ROOT, load_model


def main():
    if len(sys.argv) > 1:
        clip = Path(sys.argv[1])
    else:
        clip = next((REPO_ROOT / "recordings").glob("*/*/*.ogg"), None)
        if clip is None:
            sys.exit("No .ogg clips found under recordings/")

    t0 = time.perf_counter()
    model = load_model()
    print(f"Model loaded in {time.perf_counter() - t0:.1f}s")

    t0 = time.perf_counter()
    segments, info = model.transcribe(str(clip), language="en", beam_size=5)
    for seg in segments:
        print(f"[{seg.start:6.2f} -> {seg.end:6.2f}] {seg.text.strip()}")
    print(f"{clip.name}: {info.duration:.1f}s audio in {time.perf_counter() - t0:.1f}s")


if __name__ == "__main__":
    main()
