#!/usr/bin/env python3
import asyncio
import os
import sys
import time
from typing import Any


ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(ROOT_DIR, ".env")
LOCAL_DEPS = os.path.join(ROOT_DIR, ".pydeps_local_llm")
if os.path.isfile(ENV_PATH):
    with open(ENV_PATH, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("\"'")
            if key and key not in os.environ:
                os.environ[key] = value
if os.path.isdir(LOCAL_DEPS):
    sys.path.insert(0, LOCAL_DEPS)

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import torch
import uvicorn
from transformers import AutoModelForImageTextToText, AutoProcessor


MODEL_ID = os.environ.get("HF_LOCAL_LLM_MODEL") or os.environ.get("LOCAL_LLM_MODEL") or "Qwen/Qwen3.5-4B"
HOST = os.environ.get("LOCAL_LLM_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_LLM_SERVER_PORT", "8000"))
DEVICE = os.environ.get("LOCAL_LLM_DEVICE", "cpu").lower()
MAX_NEW_TOKENS = int(os.environ.get("LOCAL_LLM_MAX_NEW_TOKENS", "1200"))
TEMPERATURE = float(os.environ.get("LOCAL_LLM_TEMPERATURE", "0.2"))

app = FastAPI(title="teacher-local-llm")
generation_lock = asyncio.Lock()
processor = None
model = None
model_device = None


def resolve_dtype() -> torch.dtype:
    dtype_name = os.environ.get("LOCAL_LLM_TORCH_DTYPE", "").lower()
    if dtype_name == "float16":
        return torch.float16
    if dtype_name == "bfloat16":
        return torch.bfloat16
    if dtype_name == "float32":
        return torch.float32
    if DEVICE == "cuda":
        return torch.float16
    return torch.float32


def select_device() -> str:
    if DEVICE == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("LOCAL_LLM_DEVICE=cuda，但当前未检测到可用 CUDA。")
        return "cuda"
    return "cpu"


def normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for message in messages:
        role = str(message.get("role") or "user")
        content = message.get("content") or ""
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    parts.append({"type": "text", "text": str(part.get("text") or "")})
                elif isinstance(part, dict) and part.get("type") == "image_url":
                    parts.append(part)
            if not parts:
                parts = [{"type": "text", "text": ""}]
        else:
            parts = [{"type": "text", "text": str(content)}]
        normalized.append({"role": role, "content": parts})
    return normalized


def load_model() -> None:
    global processor, model, model_device
    if model is not None and processor is not None:
        return

    dtype = resolve_dtype()
    model_device = select_device()
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
    )
    model.eval()
    model.to(model_device)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "model": MODEL_ID}


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    body = await request.json()
    requested_model = str(body.get("model") or MODEL_ID)
    if requested_model != MODEL_ID:
        raise HTTPException(status_code=400, detail=f"当前只加载了模型 {MODEL_ID}")

    messages = body.get("messages") or []
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")

    do_sample = float(body.get("temperature", TEMPERATURE) or 0) > 0
    max_new_tokens = int(body.get("max_tokens") or MAX_NEW_TOKENS)
    normalized_messages = normalize_messages(messages)

    async with generation_lock:
        reply_text = await asyncio.to_thread(generate_text, normalized_messages, do_sample, max_new_tokens)

    created = int(time.time())
    return JSONResponse({
        "id": f"chatcmpl-local-{created}",
        "object": "chat.completion",
        "created": created,
        "model": MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": reply_text,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    })


def generate_text(messages: list[dict[str, Any]], do_sample: bool, max_new_tokens: int) -> str:
    load_model()
    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    inputs = {key: value.to(model_device) for key, value in inputs.items()}
    generate_kwargs = {
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
    }
    if do_sample:
        generate_kwargs["temperature"] = TEMPERATURE

    with torch.no_grad():
        outputs = model.generate(**inputs, **generate_kwargs)
    generated = outputs[0][inputs["input_ids"].shape[-1]:]
    return processor.decode(generated, skip_special_tokens=True).strip()


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
