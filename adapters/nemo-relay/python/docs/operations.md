# Operational warnings and bounds

What the plugin reports at runtime, and the limits it enforces. Activating the plugin is
documented in [`README.md`](../README.md).

Runtime counters live in the client, not the plugin. Skipped, malformed, dropped, evicted, and
internal-failure events produce privacy-safe warnings containing only stable event IDs,
field paths, counts, and queue outcomes. Unexpected failures are logged with a traceback;
values from the event are never logged. Use the host application's logs for plugin
failures and `client.stats` for end-to-end delivery totals.

`max_pending_handoffs` bounds records waiting to reach the client's event loop
(1–100000, default 1000). `max_tracked_scopes` bounds incomplete structural scope state
(1–1000000, default 10000). Overflow is non-blocking: handoffs are dropped and old
incomplete scopes are evicted, with corresponding warnings.

One instance accepts one component activation: two would install two subscribers over
the same process-wide event stream and double-count every operation.
