.PHONY: install lint format typecheck test build isolation verify clean
NPM ?= npm
CORE := ../../../adapters/core/typescript
# The core is linked from this repository until it is published, and resolves through its
# built `dist/`, so it is installed and built first.
install:
	$(MAKE) -C $(CORE) install build
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
isolation: build
	$(NPM) run check:package
	node scripts/verify-package.ts
verify: lint test isolation
clean:
	rm -rf dist coverage node_modules *.tgz
