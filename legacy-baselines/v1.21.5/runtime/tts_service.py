"""Thread-safe text-to-speech service for the Tavern runtime.

The service owns every TTS concern: persisted settings, cloned reference audio,
voice discovery, request validation and the in-memory audio cache.  Keeping the
state transitions behind one lock prevents concurrent HTTP handlers from losing
each other's config updates.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

from memory_cache import ByteLRUCache


FALLBACK_VOICES = (
    {"id": "vivian", "name": "Vivian", "model": "clawling/qwen-tts", "description": "明亮、略带锐气的年轻女声。", "language": "chinese"},
    {"id": "serena", "name": "Serena", "model": "clawling/qwen-tts", "description": "温暖柔和的年轻女声。", "language": "chinese"},
    {"id": "uncle_fu", "name": "Uncle_Fu", "model": "clawling/qwen-tts", "description": "音色低沉醇厚的成熟男声。", "language": "chinese"},
    {"id": "dylan", "name": "Dylan", "model": "clawling/qwen-tts", "description": "清晰自然的北京青年男声。", "language": "chinese"},
    {"id": "eric", "name": "Eric", "model": "clawling/qwen-tts", "description": "活泼、略带沙哑明亮感的成都男声。", "language": "chinese"},
    {"id": "ryan", "name": "Ryan", "model": "clawling/qwen-tts", "description": "富有节奏感的动态男声。", "language": "english"},
    {"id": "aiden", "name": "Aiden", "model": "clawling/qwen-tts", "description": "清晰中频的阳光美式男声。", "language": "english"},
    {"id": "ono_anna", "name": "Ono_Anna", "model": "clawling/qwen-tts", "description": "轻快灵活的俏皮日语女声。", "language": "japanese"},
    {"id": "sohee", "name": "Sohee", "model": "clawling/qwen-tts", "description": "富含情感的温暖韩语女声。", "language": "korean"},
)


class TTSService:
    MODEL = "clawling/qwen-tts"
    MODEL_NAME = "Qwen TTS"
    PREVIEW_TEXT = "欢迎来到故事的世界里"
    REFERENCE_MAX_BYTES = 10 * 1024 * 1024
    MAX_CLONES = 20
    DEFAULT_SPEED = 0.9

    def __init__(self, state_dir, *, base, key_provider):
        self.base = str(base or "").strip().rstrip("/")
        self._key_provider = key_provider
        self.default_voice = os.environ.get("TAVERN_TTS_VOICE", "vivian").strip().lower()
        self.timeout = max(30, int(os.environ.get("TAVERN_TTS_TIMEOUT", "240")))
        self.max_chars = min(4096, max(1, int(os.environ.get("TAVERN_TTS_MAX_CHARS", "4096"))))
        self.max_audio_bytes = max(
            1024 * 1024,
            int(os.environ.get("TAVERN_TTS_MAX_AUDIO_BYTES", str(16 * 1024 * 1024))),
        )
        cache_items = max(1, int(os.environ.get("TAVERN_TTS_CACHE_LIMIT", "32")))
        cache_bytes = max(
            1024 * 1024,
            int(os.environ.get("TAVERN_TTS_CACHE_MAX_BYTES", str(32 * 1024 * 1024))),
        )
        self.config_path = os.path.join(state_dir, "tts_config.json")
        self.reference_dir = os.path.join(state_dir, "tts-references")
        self.cache_dir = os.path.join(state_dir, "tts-cache")
        self.cache_retention_days = max(
            1, int(os.environ.get("TAVERN_TTS_CACHE_RETENTION_DAYS", "15"))
        )
        for directory in (self.reference_dir, self.cache_dir):
            os.makedirs(directory, mode=0o700, exist_ok=True)
            try:
                os.chmod(directory, 0o700)
            except OSError:
                pass
        self.cache = ByteLRUCache(cache_items, cache_bytes)
        self._config_lock = threading.RLock()
        self._voice_lock = threading.Lock()
        self._voice_cache = {"at": 0.0, "voices": list(FALLBACK_VOICES)}
        self._request_locks = tuple(threading.Lock() for _ in range(32))
        self._cleanup_lock = threading.Lock()
        self._last_cleanup = 0.0

    @property
    def preview_text(self):
        return self.PREVIEW_TEXT

    def cache_stats(self):
        return self.cache.stats()

    def _cache_path(self, cache_key):
        if not re.fullmatch(r"[0-9a-f]{64}", str(cache_key or "")):
            raise ValueError("invalid speech cache key")
        return os.path.join(self.cache_dir, cache_key + ".mp3")

    def _store_disk_cache(self, cache_key, audio):
        path = self._cache_path(cache_key)
        temporary = path + ".tmp." + secrets.token_hex(4)
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as file:
                file.write(audio)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass

    def _load_disk_cache(self, cache_key):
        path = self._cache_path(cache_key)
        try:
            with open(path, "rb") as file:
                audio = file.read(self.max_audio_bytes + 1)
            if not audio or len(audio) > self.max_audio_bytes:
                os.remove(path)
                return None
            os.utime(path, None)
            return audio
        except FileNotFoundError:
            return None
        except OSError:
            return None

    def _cached_audio(self, cache_key):
        audio = self.cache.get(cache_key)
        if audio is not None:
            try:
                os.utime(self._cache_path(cache_key), None)
            except FileNotFoundError:
                self._store_disk_cache(cache_key, audio)
            except OSError:
                pass
            return audio
        audio = self._load_disk_cache(cache_key)
        if audio is not None:
            self.cache.put(cache_key, audio)
        return audio

    def cleanup(self, force=False, now=None):
        now = float(now if now is not None else time.time())
        with self._cleanup_lock:
            if not force and now - self._last_cleanup < 24 * 60 * 60:
                return 0
            self._last_cleanup = now
            cutoff = now - self.cache_retention_days * 24 * 60 * 60
            removed = 0
            try:
                entries = list(os.scandir(self.cache_dir))
            except OSError:
                return 0
            for entry in entries:
                match = re.fullmatch(r"([0-9a-f]{64})\.mp3", entry.name)
                if not match or not entry.is_file(follow_symlinks=False):
                    continue
                try:
                    if entry.stat(follow_symlinks=False).st_mtime >= cutoff:
                        continue
                    os.remove(entry.path)
                    self.cache.delete(match.group(1))
                    removed += 1
                except FileNotFoundError:
                    pass
                except OSError:
                    continue
            return removed

    def _read_config_unlocked(self):
        try:
            with open(self.config_path, encoding="utf-8") as file:
                saved = json.load(file)
        except FileNotFoundError:
            return {}
        return saved if isinstance(saved, dict) else {}

    def _read_config(self):
        with self._config_lock:
            return self._read_config_unlocked()

    def _write_config_unlocked(self, value):
        temporary = self.config_path + ".tmp." + secrets.token_hex(4)
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                json.dump(value, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.config_path)
            os.chmod(self.config_path, 0o600)
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass

    @staticmethod
    def normalize_speed(value):
        try:
            speed = float(value)
        except (TypeError, ValueError):
            speed = TTSService.DEFAULT_SPEED
        if not 0.25 <= speed <= 4:
            raise ValueError("speech speed must be between 0.25 and 4")
        return round(speed, 2)

    @staticmethod
    def normalize_instructions(value):
        instructions = str(value or "").strip()
        if len(instructions) > 1000:
            raise ValueError("speech tone instructions are too long")
        return instructions

    def _clones(self, saved):
        raw = saved.get("clones")
        if isinstance(raw, list):
            return [dict(item) for item in raw if isinstance(item, dict)]
        legacy = saved.get("clone")
        if isinstance(legacy, dict) and legacy:
            clone = dict(legacy)
            clone["id"] = str(clone.get("id") or clone.get("token") or "")
            clone["speed"] = self.normalize_speed(clone.get("speed"))
            clone.pop("tone", None)
            return [clone]
        return []

    def _clone_file(self, clone):
        token = str((clone or {}).get("token") or "")
        extension = str((clone or {}).get("ext") or "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", token):
            return ""
        if extension not in (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"):
            return ""
        return os.path.join(self.reference_dir, token + extension)

    def _clone_ready(self, clone):
        path = self._clone_file(clone)
        return bool(path and os.path.isfile(path) and str((clone or {}).get("ref_text") or "").strip())

    def _active_clone(self, saved):
        active_id = str(saved.get("active_clone_id") or "")
        for clone in self._clones(saved):
            clone_id = str(clone.get("id") or clone.get("token") or "")
            if clone_id == active_id and self._clone_ready(clone):
                return clone
        return None

    def _preset_setting(self, saved, voice):
        settings = saved.get("preset_settings")
        setting = settings.get(voice) if isinstance(settings, dict) else None
        setting = setting if isinstance(setting, dict) else {}
        return {
            "speed": self.normalize_speed(setting.get("speed")),
            "instructions": self.normalize_instructions(setting.get("instructions")),
        }

    def voices(self, force=False):
        now = time.monotonic()
        with self._voice_lock:
            cached = list(self._voice_cache["voices"])
            fresh = now - self._voice_cache["at"] < 300
            if fresh and not force:
                return cached
            key = str(self._key_provider() or "").strip()
            if not key or not self.base:
                return cached
            request = urllib.request.Request(
                f"{self.base}/audio/voices",
                headers={"Authorization": f"Bearer {key}"},
                method="GET",
            )
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    data = json.loads(response.read().decode("utf-8"))
                voices = [
                    item for item in (data.get("data") or [])
                    if isinstance(item, dict) and item.get("model") == self.MODEL
                    and str(item.get("id") or "").strip()
                ]
                if voices:
                    self._voice_cache = {"at": now, "voices": voices}
                    return list(voices)
            except Exception:
                pass
            self._voice_cache["at"] = now
            return cached

    def settings(self):
        saved = self._read_config()
        voices = self.voices()
        voice_ids = {item["id"] for item in voices}
        default_voice = self.default_voice if self.default_voice in voice_ids else voices[0]["id"]
        voice = str(saved.get("voice") or default_voice).strip().lower()
        if voice not in voice_ids:
            voice = default_voice
        clones = [clone for clone in self._clones(saved) if self._clone_ready(clone)]
        active_clone = self._active_clone(saved)
        mode = "clone" if saved.get("mode") == "clone" and active_clone else "preset"

        def public_clone(clone):
            return {
                "id": str(clone.get("id") or clone.get("token") or ""),
                "configured": True,
                "name": str(clone.get("name") or "").strip(),
                "ref_text": str(clone.get("ref_text") or "").strip(),
                "speed": self.normalize_speed(clone.get("speed")),
            }

        public_clones = [public_clone(clone) for clone in clones]
        public_active = public_clone(active_clone) if active_clone else {}
        return {
            "model": self.MODEL,
            "model_name": self.MODEL_NAME,
            "active_voice": voice,
            "active_clone_id": public_active.get("id", ""),
            "mode": mode,
            "voices": voices,
            "preset_settings": {
                item["id"]: self._preset_setting(saved, item["id"]) for item in voices
            },
            "clones": public_clones,
            "clone": public_active,
        }

    def save_voice(self, voice):
        voices = self.voices()
        voice = str(voice or "").strip().lower()
        if voice not in {item["id"] for item in voices}:
            raise ValueError("unsupported voice")
        with self._config_lock:
            saved = self._read_config_unlocked()
            saved.update({"voice": voice, "mode": "preset"})
            saved.pop("model", None)
            self._write_config_unlocked(saved)
        return voice

    def save_preset_settings(self, voice, speed=None, instructions=None):
        voice = str(voice or "").strip().lower()
        if voice not in {item["id"] for item in self.voices()}:
            raise ValueError("unsupported voice")
        with self._config_lock:
            saved = self._read_config_unlocked()
            settings = saved.get("preset_settings")
            settings = dict(settings) if isinstance(settings, dict) else {}
            settings[voice] = {
                "speed": self.normalize_speed(speed),
                "instructions": self.normalize_instructions(instructions),
            }
            saved["preset_settings"] = settings
            self._write_config_unlocked(saved)
        return self.settings()

    @staticmethod
    def _decode_reference_audio(audio_data):
        match = re.fullmatch(
            r"data:(audio/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)",
            str(audio_data or ""),
            re.DOTALL,
        )
        if not match:
            raise ValueError("reference audio must be an uploaded audio file")
        mime = match.group(1).lower()
        extensions = {
            "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav",
            "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
            "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/flac": ".flac",
        }
        extension = extensions.get(mime)
        if not extension:
            raise ValueError("unsupported reference audio format")
        try:
            audio = base64.b64decode(match.group(2), validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("reference audio is invalid") from error
        if not audio or len(audio) > TTSService.REFERENCE_MAX_BYTES:
            raise ValueError("reference audio must be between 1 byte and 10 MB")
        return mime, extension, audio

    def save_clone(self, audio_data, ref_text, name, speed=None):
        ref_text = str(ref_text or "").strip()
        name = str(name or "").strip()[:40] or "My Voice"
        if not ref_text:
            raise ValueError("reference transcript is required")
        if len(ref_text) > 4096:
            raise ValueError("reference transcript is too long")
        speed = self.normalize_speed(speed)
        mime, extension, audio = self._decode_reference_audio(audio_data)
        with self._config_lock:
            saved = self._read_config_unlocked()
            clones = self._clones(saved)
            if len(clones) >= self.MAX_CLONES:
                raise ValueError(f"no more than {self.MAX_CLONES} cloned voices are allowed")
            token = secrets.token_urlsafe(32)
            clone = {
                "id": token, "token": token, "ext": extension, "mime": mime,
                "name": name, "ref_text": ref_text, "speed": speed,
            }
            path = self._clone_file(clone)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as file:
                    file.write(audio)
                    file.flush()
                    os.fsync(file.fileno())
                clones.append(clone)
                saved.update({"mode": "clone", "clones": clones, "active_clone_id": token})
                saved.pop("clone", None)
                saved.pop("model", None)
                self._write_config_unlocked(saved)
            except Exception:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
                raise
        return self.settings()

    def use_clone(self, clone_id):
        clone_id = str(clone_id or "")
        with self._config_lock:
            saved = self._read_config_unlocked()
            clone = next(
                (item for item in self._clones(saved)
                 if str(item.get("id") or item.get("token") or "") == clone_id),
                None,
            )
            if not clone or not self._clone_ready(clone):
                raise ValueError("cloned voice is not configured")
            saved.update({"mode": "clone", "active_clone_id": clone_id})
            self._write_config_unlocked(saved)
        return self.settings()

    def delete_clone(self, clone_id):
        clone_id = str(clone_id or "")
        with self._config_lock:
            saved = self._read_config_unlocked()
            clones = self._clones(saved)
            clone = next(
                (item for item in clones
                 if str(item.get("id") or item.get("token") or "") == clone_id),
                None,
            )
            if not clone:
                raise ValueError("cloned voice is not configured")
            saved["clones"] = [
                item for item in clones
                if str(item.get("id") or item.get("token") or "") != clone_id
            ]
            saved.pop("clone", None)
            if str(saved.get("active_clone_id") or "") == clone_id:
                saved.pop("active_clone_id", None)
                saved["mode"] = "preset"
            self._write_config_unlocked(saved)
            path = self._clone_file(clone)
            if path:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
        return self.settings()

    def migrate(self):
        with self._config_lock:
            saved = self._read_config_unlocked()
            changed = saved.pop("model", None) is not None
            legacy = saved.pop("clone", None)
            clones = self._clones({"clones": saved.get("clones")})
            if isinstance(legacy, dict) and legacy:
                migrated = dict(legacy)
                migrated["id"] = str(migrated.get("id") or migrated.get("token") or "")
                migrated["speed"] = self.normalize_speed(migrated.get("speed"))
                migrated.pop("tone", None)
                clones.append(migrated)
                saved["active_clone_id"] = migrated["id"]
                changed = True
            normalized = []
            for clone in clones:
                clone["id"] = str(clone.get("id") or clone.get("token") or "")
                clone["speed"] = self.normalize_speed(clone.get("speed"))
                if clone.pop("tone", None) is not None:
                    changed = True
                normalized.append(clone)
            if normalized != saved.get("clones"):
                saved["clones"] = normalized
                changed = True
            voice_ids = {item["id"] for item in FALLBACK_VOICES}
            if saved.get("voice") not in voice_ids:
                saved["voice"] = self.default_voice if self.default_voice in voice_ids else "vivian"
                changed = True
            if saved.get("mode") not in ("preset", "clone"):
                saved["mode"] = "preset"
                changed = True
            if changed:
                self._write_config_unlocked(saved)

    @staticmethod
    def _speech_text(text):
        text = str(text or "").strip()
        text = re.sub(r"\*([^*]+)\*", r"\1", text)
        return text.replace("*", "").strip()

    def _clone_data_url(self, clone):
        path = self._clone_file(clone)
        if not path or not os.path.isfile(path):
            raise ValueError("cloned voice reference audio is unavailable")
        mime = str((clone or {}).get("mime") or "audio/mpeg").strip().lower()
        with open(path, "rb") as file:
            encoded = base64.b64encode(file.read()).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    def reference(self, token):
        saved = self._read_config()
        clone = next(
            (item for item in self._clones(saved)
             if secrets.compare_digest(str(item.get("token") or ""), str(token or ""))),
            None,
        )
        if not clone:
            return None, ""
        path = self._clone_file(clone)
        if not path or not os.path.isfile(path):
            return None, ""
        return clone, path

    def generate(self, text, voice=None, speed=None, instructions=None, force_preset=False):
        self.cleanup()
        text = self._speech_text(text)
        if not text:
            raise ValueError("speech text is empty")
        if len(text) > self.max_chars:
            raise ValueError(f"speech text is too long (max {self.max_chars} characters)")
        settings = self.settings()
        voice = str(voice or settings["active_voice"]).strip().lower()
        if voice not in {item["id"] for item in settings["voices"]}:
            raise ValueError("unsupported voice")
        saved = self._read_config()
        clone = self._active_clone(saved) if settings["mode"] == "clone" and not force_preset else None
        clone_token = str((clone or {}).get("token") or "")
        if clone:
            speed = self.normalize_speed(clone.get("speed"))
            instructions = ""
        else:
            preset = self._preset_setting(saved, voice)
            speed = self.normalize_speed(speed if speed is not None else preset["speed"])
            instructions = self.normalize_instructions(
                instructions if instructions is not None else preset["instructions"]
            )
        request_voice = "custom" if clone else voice
        cache_key = hashlib.sha256(
            f"{self.MODEL}\0{request_voice}\0{clone_token}\0{speed}\0{instructions}\0{text}".encode("utf-8")
        ).hexdigest()
        cached = self._cached_audio(cache_key)
        if cached is not None:
            return cached

        with self._request_locks[int(cache_key[:8], 16) % len(self._request_locks)]:
            cached = self._cached_audio(cache_key)
            if cached is not None:
                return cached
            key = str(self._key_provider() or "").strip()
            if not key:
                raise ValueError("Clawling TTS key is missing")
            if not self.base:
                raise ValueError("TTS service endpoint is missing")
            request_data = {
                "model": self.MODEL, "voice": request_voice, "input": text,
                "response_format": "mp3", "speed": speed,
            }
            if clone:
                request_data["ref_audio"] = self._clone_data_url(clone)
                request_data["ref_text"] = clone["ref_text"]
            elif instructions:
                request_data["instructions"] = instructions
            request = urllib.request.Request(
                f"{self.base}/audio/speech",
                data=json.dumps(request_data, ensure_ascii=False).encode("utf-8"),
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    audio = response.read(self.max_audio_bytes + 1)
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", "replace")[:300]
                raise ValueError(f"TTS request failed (HTTP {error.code}): {detail}") from error
            except urllib.error.URLError as error:
                raise ValueError(f"TTS connection failed: {error.reason}") from error
            if not audio:
                raise ValueError("TTS returned empty audio")
            if len(audio) > self.max_audio_bytes:
                raise ValueError("TTS returned audio larger than the configured limit")
            self._store_disk_cache(cache_key, audio)
            self.cache.put(cache_key, audio)
            return audio
