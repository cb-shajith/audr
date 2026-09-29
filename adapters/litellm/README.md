# LiteLLM

The LiteLLM adapter turns provider-reported model usage from the LiteLLM Python
SDK and `Router` into AUDR records. Calls without explicit usage or cost are not
emitted.

| Language | Package | Documentation |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr-adapter-litellm?include_prereleases&label=audr-adapter-litellm)](https://pypi.org/project/audr-adapter-litellm/) | [`python/README.md`](python/README.md) — install, what gets recorded, attribution, shutdown order |

Status: experimental.
