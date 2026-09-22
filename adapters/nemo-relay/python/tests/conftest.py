"""Pytest configuration shared across the NeMo Relay adapter test suite.

Nothing here is package-specific today; it exists as the place future shared
fixtures (for example, a network-blocking autouse fixture, if a sink test ever
needs one) would go, and so `tests` has a stable root for pytest's rootdir
discovery.
"""
