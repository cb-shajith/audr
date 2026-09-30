.PHONY: install lint format typecheck test build examples isolation verify clean
NPM ?= npm
# `@openaudr/audr` is a `file:` dependency on the core package until it is published, and
# the core's `exports` point at its `dist/`, so the core is installed and built first.
install:
	$(MAKE) -C ../../core/typescript install build
	$(NPM) ci
lint:
	$(NPM) run lint
	$(NPM) run typecheck
format:
	$(NPM) run format
typecheck:
	$(NPM) run typecheck
test:
	$(NPM) test
build:
	$(NPM) run build
examples: build
	node examples/generate-text.ts
	node examples/agent-call-options.ts
	node examples/sub-agent.ts
isolation: build
	$(NPM) run check:package
verify: lint test examples isolation
clean:
	rm -rf dist coverage node_modules *.tgz
