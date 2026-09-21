.PHONY: install test lint format typecheck build verify clean
UV ?= uv
install:
	$(UV) sync --locked --group dev
test:
	$(UV) run pytest --cov --cov-report=term-missing
lint:
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy
format:
	$(UV) run ruff format .
	$(UV) run ruff check --fix .
typecheck:
	$(UV) run mypy
build:
	rm -rf dist && $(UV) build
verify: lint test build
clean:
	rm -rf dist .venv .pytest_cache .ruff_cache .mypy_cache .coverage
