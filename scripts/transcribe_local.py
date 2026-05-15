#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PYDEPS = ROOT / ".pydeps"
if str(PYDEPS) not in sys.path:
    sys.path.insert(0, str(PYDEPS))

from faster_whisper import WhisperModel  # type: ignore


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf8").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
            continue
        key, value = trimmed.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        value = int(os.environ.get(name, default))
    except ValueError:
        value = default
    return max(minimum, value)


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def build_model(model_size: str) -> WhisperModel:
    kwargs = {
        "device": os.environ.get("LOCAL_WHISPER_DEVICE", "cpu"),
        "compute_type": os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8"),
        "num_workers": env_int("LOCAL_WHISPER_NUM_WORKERS", 1, 1),
    }
    cpu_threads = env_int("LOCAL_WHISPER_CPU_THREADS", 0, 0)
    if cpu_threads > 0:
        kwargs["cpu_threads"] = cpu_threads
    return WhisperModel(model_size, **kwargs)


def transcribe_audio(model: WhisperModel, audio_path: str, language: str) -> dict:
    beam_size = env_int("LOCAL_WHISPER_BEAM_SIZE", 5, 1)
    best_of = env_int("LOCAL_WHISPER_BEST_OF", 5, 1)
    segments, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=env_bool("LOCAL_WHISPER_VAD_FILTER", True),
        beam_size=beam_size,
        best_of=best_of,
        temperature=0.0,
    )

    items = []
    text_parts = []
    for segment in segments:
        segment_text = segment.text.strip()
        if not segment_text:
            continue
        items.append(
            {
                "start": round(float(segment.start), 2),
                "end": round(float(segment.end), 2),
                "text": segment_text,
            }
        )
        text_parts.append(segment_text)

    return {
        "language": getattr(info, "language", language),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 4),
        "duration": round(float(getattr(info, "duration", 0.0)), 2),
        "text": "\n".join(text_parts).strip(),
        "segments": items,
    }


def main() -> int:
    load_dotenv()
    if len(sys.argv) < 2:
        raise SystemExit("usage: transcribe_local.py <audio_path> [model_size] [language]")

    if sys.argv[1] == "--batch":
        if len(sys.argv) < 5:
            raise SystemExit("usage: transcribe_local.py --batch <model_size> <language> <audio_path>...")
        model_size = sys.argv[2] or os.environ.get("LOCAL_WHISPER_MODEL", "medium")
        language = sys.argv[3] or os.environ.get("LOCAL_WHISPER_LANGUAGE", "zh")
        model = build_model(model_size)
        results = []
        for audio_path in sys.argv[4:]:
            try:
                payload = transcribe_audio(model, audio_path, language)
                payload["path"] = audio_path
                results.append(payload)
            except Exception as exc:
                results.append({"path": audio_path, "error": str(exc)})
        print(json.dumps({"results": results}, ensure_ascii=False))
        return 0

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("LOCAL_WHISPER_MODEL", "medium")
    language = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("LOCAL_WHISPER_LANGUAGE", "zh")

    model = build_model(model_size)
    payload = transcribe_audio(model, audio_path, language)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
