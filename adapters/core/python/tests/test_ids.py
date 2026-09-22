import uuid

from audr.ids import uuid7


def test_uuid7_is_version_7_string() -> None:
    value = uuid7()
    assert isinstance(value, str) and len(value) == 36
    assert uuid.UUID(value).version == 7


def test_uuid7_monotonic_within_process() -> None:
    values = [uuid7() for _ in range(1000)]
    assert values == sorted(values)
    assert len(set(values)) == 1000
