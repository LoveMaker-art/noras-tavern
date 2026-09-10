# Minimal source fixture from ClawChat 8651f7078916e60ed1da9f78ec4d1278fef49dd9.
from __future__ import annotations

class ClawChatStore:
    def get_activation_credentials(
        self,
        *,
        platform: str,
        account_id: str,
    ) -> ActivationCredentials | None:
        self.initialize()
        if self._disabled:
            return None
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute(
                """
                SELECT user_id, owner_user_id, access_token, refresh_token,
                       device_id, activated_at
                FROM activations
                WHERE platform = ? AND account_id = ?
                """,
                (platform, account_id),
            ).fetchone()
            if row is None:
                return None
            user_id = str(row[0] or "").strip()
            owner_user_id = str(row[1] or "").strip()
            access_token = str(row[2] or "").strip()
            refresh_token = str(row[3] or "").strip() or None
            device_id = str(row[4] or "").strip() or None
            try:
                activated_at = int(row[5]) if row[5] is not None else None
            except (TypeError, ValueError):
                activated_at = None
            if not user_id or not owner_user_id or not access_token:
                return None
            return ActivationCredentials(
                user_id=user_id,
                owner_user_id=owner_user_id,
                access_token=access_token,
                refresh_token=refresh_token,
                device_id=device_id,
                activated_at=activated_at,
            )
        finally:
            conn.close()

    def get_activation_conversation(
        self,
        *,
        platform: str,
        account_id: str,
    ) -> str | None:
        self.initialize()
        if self._disabled:
            return None
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute(
                """
                SELECT conversation_id
                FROM activations
                WHERE platform = ? AND account_id = ?
                """,
                (platform, account_id),
            ).fetchone()
            if row is None or row[0] is None:
                return None
            return str(row[0])
        finally:
            conn.close()
