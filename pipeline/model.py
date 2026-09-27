"""Load Whisper large-v3 from models/ onto the GPU, fully offline."""
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = REPO_ROOT / "models" / "faster-whisper-large-v3"


def add_cuda_dll_dirs():
    """Make the pip-installed CUDA/cuDNN DLLs (site-packages/nvidia/*/bin) findable on Windows.

    Must run before ctranslate2 is imported.
    """
    if sys.platform != "win32":
        return
    for site in map(Path, sys.path):
        nvidia = site / "nvidia"
        if not nvidia.is_dir():
            continue
        for bin_dir in nvidia.glob("*/bin"):
            os.add_dll_directory(str(bin_dir))
            # ctranslate2 loads some libraries lazily via PATH lookup
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]


def load_model(device="cuda", compute_type="float16"):
    os.environ["HF_HUB_OFFLINE"] = "1"
    add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    if not (MODEL_DIR / "model.bin").exists():
        raise FileNotFoundError(f"Whisper model not found in {MODEL_DIR}")
    return WhisperModel(str(MODEL_DIR), device=device, compute_type=compute_type)
