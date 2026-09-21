"""A terminal chat app metered automatically through NVIDIA NeMo Relay.

From ``adapters/nemo-relay/python``::

    pip install -e ".[example]"
    export OPENAI_API_KEY="..."
    python examples/nemo_relay_chat.py

This makes billable network requests. Records are appended to
``AUDR_OUTPUT_PATH`` (default ``nemo-relay-usage.jsonl``). Optional:
``AUDR_ACCOUNT_ID`` (the example uses the ``test`` environment),
``OPENAI_MODEL`` (default ``gpt-4o-mini``), and ``OPENAI_BASE_URL``.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, cast

import httpx
import nemo_relay
from audr import Client, FileSink
from nemo_relay import plugin as relay_plugin

from audr_adapter_nemo_relay import (
    PLUGIN_KIND,
    NeMoRelayConfig,
    NeMoRelayPlugin,
)

Messages = list[dict[str, nemo_relay.JsonValue]]


def required_env(name: str) -> str:
    """Return one required environment variable with an actionable error."""
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Set {name} before running this example.")
    return value


def parse_reply(payload: object) -> str:
    """Extract assistant text from a Chat Completions response."""
    if not isinstance(payload, dict):
        raise ValueError("model response was not a JSON object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("model response omitted choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise ValueError("model response contained an invalid choice")
    message = first.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        raise ValueError("model response contained no assistant text")
    return cast(str, message["content"])


async def main() -> None:
    """Run a Relay-instrumented chat session with correct plugin shutdown ordering."""
    openai_api_key = required_env("OPENAI_API_KEY")
    account_id = os.environ.get("AUDR_ACCOUNT_ID")
    output_path = os.environ.get("AUDR_OUTPUT_PATH", "nemo-relay-usage.jsonl")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    messages: Messages = [{"role": "system", "content": "You are a concise and helpful assistant."}]

    # A file sink shows records directly; substitute any Sink (for example the
    # Chargebee `audr-sink-chargebee` sink) for production use.
    async with (
        httpx.AsyncClient(timeout=60.0) as http,
        Client(FileSink(output_path)) as usage,
    ):

        async def call_openai(
            relay_request: nemo_relay.LLMRequest,
        ) -> nemo_relay.JsonValue:
            response = await http.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {openai_api_key}"},
                json=relay_request.content,
            )
            response.raise_for_status()
            return cast(nemo_relay.JsonValue, response.json())

        codec = nemo_relay.codecs.OpenAIChatCodec()
        usage_plugin = NeMoRelayPlugin(client=usage)
        component = NeMoRelayConfig()
        relay_config = relay_plugin.PluginConfig(
            components=[
                relay_plugin.ComponentSpec(
                    kind=PLUGIN_KIND,
                    config=component.to_dict(),
                )
            ]
        )
        relay_plugin.register(PLUGIN_KIND, usage_plugin)
        try:
            async with relay_plugin.plugin(relay_config):
                with nemo_relay.scope.scope(
                    "sample-chat-app",
                    nemo_relay.ScopeType.Agent,
                    metadata={
                        "audr": {
                            "environment": "test",
                            "account_id": account_id,
                            "user_id": "example_user",
                            "labels": {"application": "nemo_relay_chat"},
                        }
                    },
                ):
                    print("Relay chat is ready. Enter /quit to exit.")
                    while True:
                        try:
                            prompt = (await asyncio.to_thread(input, "You: ")).strip()
                        except EOFError:
                            print()
                            break
                        if prompt == "/quit":
                            break
                        if not prompt:
                            continue
                        messages.append({"role": "user", "content": prompt})
                        request = nemo_relay.LLMRequest(
                            {},
                            cast("dict[str, Any]", {"model": model, "messages": messages}),
                        )

                        try:
                            result = await nemo_relay.llm.execute(
                                "openai",
                                request,
                                call_openai,
                                model_name=model,
                                codec=codec,
                                response_codec=codec,
                            )
                            reply = parse_reply(result)
                        except (httpx.HTTPError, ValueError) as error:
                            messages.pop()
                            print(f"Model request failed: {type(error).__name__}: {error}")
                            continue

                        messages.append({"role": "assistant", "content": reply})
                        print(f"Assistant: {reply}")
            await usage_plugin.drain(timeout=5)
        finally:
            relay_plugin.deregister(PLUGIN_KIND)

    print(f"Usage records appended to {output_path}")
    print("Delivery statistics:", usage.stats)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print()
