# Attribution resolution

How the plugin decides which attribution a completed scope carries. Where to put
attribution, and which fields are supported, is documented in [`README.md`](../README.md).

- Scope **start** metadata wins over `attribution_defaults`, field by field. Metadata on a
  completing scope is ignored, so a child cannot re-bill work its root already claimed.
- Child scopes inherit the snapshot taken at their parent's start.
- Relay never emits the outermost scope's own parent. A scope whose parent the plugin has
  **never observed** is therefore treated as a new billing root, and
  `attribution_defaults` apply.
- A scope whose parent the plugin observed and then **lost** — an evicted or already
  completed ancestor — is skipped instead of falling back to defaults, unless its own
  start declares the `audr` namespace. The ancestor that carried attribution is gone,
  and static defaults could bill the wrong subscription.

To require per-scope attribution and never bill to a fallback, omit `environment` from
`attribution_defaults`. Scopes that do not carry their own `environment` then resolve to
an incomplete attribution and are skipped.
