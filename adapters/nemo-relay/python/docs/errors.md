# Errors

The exceptions `audr-adapter-nemo-relay` raises, and the conditions that produce them.
Using the adapter is documented in [`README.md`](../README.md).

| Error | Raised when |
| --- | --- |
| `NeMoRelayCompatibilityError` (a `ConfigurationError`) | The `nemo-relay` distribution is missing or outside `>=0.8,<0.9`. |
| `ConfigurationError` | Relay activated the component with configuration this plugin rejects. |
| `NeMoRelayActivationError` (a `LifecycleError`) | The host misused the lifecycle: no running loop, a second activation, or `drain()` after `close()`. |

A `register()` that raises for any reason leaves the instance unregistered, because
Relay rolls back every registration from that initialization.

`drain(timeout=...)` raises `TimeoutError` if its handoffs cannot complete in time.

Relay component validation returns the `ConfigDiagnostic` values Relay's Plugin protocol
requires, each carrying a stable `NeMoRelayDiagnosticCode`.
