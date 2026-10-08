"""FixFlow AI service: text triage plus photo sanity checks.

classify() is a keyword baseline. Swap in a trained model (for example a fine-tuned
text classifier) without changing the /triage contract the API relies on.
"""
import re
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile

app = FastAPI(title="FixFlow AI")

RULES = {
    "HVAC": r"\b(ac|a/c|air ?con\w*|hvac|furnace|heater|heating|cooling|thermostat|compressor|duct\w*|refrigerant)\b",
    "ELECTRICAL": r"\b(wiring|socket|outlet|breaker|fuse|spark\w*|short ?circuit|power (?:cut|outage)|switch)\b",
    "APPLIANCE": r"\b(washing machine|washer|dryer|fridge|refrigerator|dishwasher|oven|microwave|stove|freezer)\b",
}
URGENT = r"\b(smoke|smoking|burning|fire|spark\w*|gas leak|flood\w*|shock\w*)\b"


def classify(text: str) -> tuple[str, float]:
    t = text.lower()
    hits = {category: len(re.findall(pattern, t)) for category, pattern in RULES.items()}
    total = sum(hits.values())
    if total == 0:
        return "GENERAL", 0.3
    best = max(hits, key=hits.get)
    return best, round(min(0.95, 0.5 + 0.15 * hits[best]) * hits[best] / total, 2)


def inspect_photo(data: bytes) -> Optional[dict]:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    rust = cv2.inRange(hsv, np.array([5, 120, 50]), np.array([20, 255, 200]))
    return {
        "blurry": sharpness < 100,
        "dark": float(gray.mean()) < 50,
        "sharpness": round(sharpness, 1),
        "rust_ratio": round(float((rust > 0).mean()), 3),
    }


@app.post("/triage")
async def triage(text: str = Form(...), image: Optional[UploadFile] = File(None)):
    category, confidence = classify(text)
    return {
        "category": category,
        "confidence": confidence,
        "priority": 4 if re.search(URGENT, text.lower()) else 2,
        "image": inspect_photo(await image.read()) if image else None,
    }


@app.get("/health")
def health():
    return {"ok": True}
