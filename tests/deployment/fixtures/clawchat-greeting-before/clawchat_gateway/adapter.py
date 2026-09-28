# Minimal source fixture from ClawChat 8651f7078916e60ed1da9f78ec4d1278fef49dd9.
from __future__ import annotations

class ClawChatAdapter:
    def _schedule_liveware_sample(self) -> None:
        """Fire-and-forget bootstrap of the Liveware Sample demo app on READY.

        Never blocks or fails the platform connection:
        ``LivewareSampleSupervisor.start()`` catches its own errors and never
        raises. Idempotent per adapter instance — a supervisor already held is
        reused across reconnects (its own ``start()`` re-checks stored state)
        rather than replaced; a later ``READY`` only asks it to
        ``start_if_idle()``.
        """
        # Liveware owns host-global singletons (a fixed TCP port and the shared
        # ``$HOME/.clawling`` CLI login) that co-located profiles cannot share,
        # so only the primary/"main" agent — the Hermes default profile — boots
        # it. Named profiles skip liveware entirely to avoid port/login clashes.
        if not is_default_profile():
            return
        if self._store is None:
            return
        if self._liveware_sample_supervisor is not None:
            # Keep the ONE supervisor per adapter instance — constructing a
            # second would race the bootstrap "owner has zero apps" gate and
            # register a duplicate liveware app that no (single-row) sqlite row
            # tracks. But do NOT just return: the supervisor's
            # _START_RETRY_DELAYS_S ladder is bounded, so a plain return made
            # every later READY a permanent no-op and, once the ladder was
            # exhausted, nothing ever re-entered the flow again. start_if_idle()
            # kicks a fresh attempt only when nothing is in flight. Unlike
            # openclaw (adoptDeps) there are no deps to re-point: every dep is
            # read lazily off `self`, so a reconnect needs no new closure.
            self._spawn_liveware_sample_task(
                self._liveware_sample_supervisor.start_if_idle(),
                name="clawchat-liveware-sample-start-if-idle",
            )
            return
        cfg = self._clawchat_config
        hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        sample_root = hermes_home / "clawchat" / "liveware-sample"

        async def _list_apps() -> dict[str, Any]:
            return await self._rest_with_auth_retry(lambda client: client.list_apps())

        async def _register_app(*, name: str, app_id: str, url: str) -> dict[str, Any]:
            return await self._rest_with_auth_retry(
                lambda client: client.register_app(name=name, app_id=app_id, url=url)
            )

        async def _notify_owner(text: str) -> bool:
            chat_id = self._owner_direct_chat_id()
            if not chat_id:
                return False
            return await self._send_owner_text(chat_id, text)

        def _resolve_token() -> str:
            try:
                token = load_profile_config().token
            except Exception:  # noqa: BLE001 — fall back to the live in-memory token
                token = ""
            return token or self._clawchat_config.token or ""

        deps = LivewareSampleDeps(
            platform=CLAWCHAT_PLUGIN_PLATFORM,
            account_id="default",
            enabled=bool(cfg.liveware_sample),
            store=self._store,
            sample_root=sample_root,
            resolve_token=_resolve_token,
            resolve_liveware_path=resolve_liveware_path,
            resolve_agent_user_id=lambda: (self._clawchat_config.user_id or None),
            wait_cli_ready=wait_liveware_cli_ready,
            list_apps=_list_apps,
            register_app=_register_app,
            notify_owner=_notify_owner,
            log=logger,
        )
        self._liveware_sample_supervisor = LivewareSampleSupervisor(deps)
        self._spawn_liveware_sample_task(
            self._liveware_sample_supervisor.start(),
            name="clawchat-liveware-sample-start",
        )

    async def _dispatch_activation_bootstrap(self) -> None:
        if self._store is None:
            return
        # Greeting must see the freshest owner metadata (incl. locale) —
        # wait before claiming so a cancellation here cannot leak the claim.
        await self._await_owner_metadata_refreshed()
        claim = self._store.claim_pending_activation_bootstrap(
            platform="hermes",
            account_id="default",
        )
        if claim is None:
            return
        conversation_id = str(getattr(claim, "conversation_id", "") or "")
        if not conversation_id:
            return
        owner_user_id = str(getattr(claim, "owner_user_id", "") or "")
        claimed_at = getattr(claim, "claimed_at", None)
        inbound = InboundMessage(
            chat_id=conversation_id,
            chat_type="direct",
            sender_id=owner_user_id,
            sender_name="",
            text=load_activation_bootstrap_prompt(),
            raw_message={
                "synthetic": True,
                "bootstrap": True,
                "conversation_id": conversation_id,
                "owner_user_id": owner_user_id,
            },
        )
        # The greeting is emitted *inside* the turn below, so a failure after
        # that point must not roll the claim back — releasing it lets the next
        # READY (typically the process the activation restart just spawned)
        # claim again and greet the owner a second time. Only a turn that put
        # nothing on the wire is safe to retry.
        delivered_before = self._visible_send_count(conversation_id)
        try:
            await self._handle_inbound(inbound)
        except (asyncio.CancelledError, Exception):  # CancelledError is a BaseException
            if self._visible_send_count(conversation_id) > delivered_before:
                self._mark_activation_bootstrap_sent(
                    conversation_id=conversation_id,
                    claimed_at=claimed_at,
                    reason="turn failed after delivery",
                )
            else:
                self._release_activation_bootstrap_claim(
                    conversation_id=conversation_id,
                    claimed_at=claimed_at,
                )
            raise
        self._mark_activation_bootstrap_sent(
            conversation_id=conversation_id,
            claimed_at=claimed_at,
        )

    def _mark_activation_bootstrap_sent(
        self,
        *,
        conversation_id: str,
        claimed_at: Any,
        reason: str = "",
    ) -> None:
        if self._store is None:
            return
        marked = self._store.mark_activation_bootstrap_sent(
            platform="hermes",
            account_id="default",
            conversation_id=conversation_id,
            claimed_at=claimed_at,
        )
        if marked is False or marked is None:
            # A silent no-op here leaves bootstrap_sent = 0 forever, so every
            # later reconnect re-greets. Never swallow it.
            logger.warning(
                "clawchat activation bootstrap not marked sent conversation_id=%s "
                "claimed_at=%s reason=%s — the greeting may repeat on reconnect",
                conversation_id,
                claimed_at,
                reason or "post-turn",
            )
        elif reason:
            logger.info(
                "clawchat activation bootstrap marked sent conversation_id=%s reason=%s",
                conversation_id,
                reason,
            )

    def _release_activation_bootstrap_claim(
        self,
        *,
        conversation_id: str,
        claimed_at: Any,
    ) -> None:
        if self._store is None or claimed_at is None:
            return
        try:
            self._store.release_activation_bootstrap_claim(
                platform="hermes",
                account_id="default",
                conversation_id=conversation_id,
                claimed_at=int(claimed_at),
            )
        except Exception:  # noqa: BLE001
            logger.warning("clawchat activation bootstrap claim release failed", exc_info=True)
