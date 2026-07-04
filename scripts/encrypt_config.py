"""Шифрует LangSmith-ключ паролем сайта → site/config.enc.json.

Запускается в GitHub Actions. Ожидает env:
  LANGSMITH_API_KEY  — ключ LangSmith (секрет)
  SITE_PASSWORD      — пароль сайта (секрет)
  LANGSMITH_API_URL  — опционально (по умолчанию https://api.smith.langchain.com)

Схема: PBKDF2-HMAC-SHA256 (600k итераций) → AES-256-GCM.
Расшифровка — в браузере через WebCrypto (site/app.js, функция unlock).
"""

import base64
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 600_000


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def main() -> None:
    api_key = os.environ.get("LANGSMITH_API_KEY", "")
    password = os.environ.get("SITE_PASSWORD", "")
    if not api_key or not password:
        sys.exit("ОШИБКА: задайте секреты LANGSMITH_API_KEY и SITE_PASSWORD "
                 "(Settings -> Secrets and variables -> Actions).")

    payload = json.dumps({
        "api_key": api_key,
        "api_url": os.environ.get("LANGSMITH_API_URL") or "https://api.smith.langchain.com",
    }).encode()

    salt, iv = os.urandom(16), os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    key = kdf.derive(password.encode())
    ciphertext = AESGCM(key).encrypt(iv, payload, None)

    out = Path(__file__).resolve().parent.parent / "site" / "config.enc.json"
    out.write_text(json.dumps({
        "salt": b64(salt), "iv": b64(iv),
        "iterations": ITERATIONS, "data": b64(ciphertext),
    }), encoding="utf-8")
    print(f"OK: {out} записан ({len(ciphertext)} байт шифротекста)")


if __name__ == "__main__":
    main()
