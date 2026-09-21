.PHONY: help spec check schema examples conformance lint fresh install clean all
.PHONY: python core-python adapter-nemo-relay-python sink-chargebee-python

PYTHON ?= python3

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install the tooling dependencies
	$(PYTHON) -m pip install -r requirements.txt

spec: ## Regenerate the specification from the schema, outline and prose
	@$(PYTHON) tools/render.py

check: schema examples conformance lint fresh ## Everything CI runs
	@echo "All checks passed."

schema: ## Meta-validate the schema against JSON Schema Draft 2020-12
	@$(PYTHON) -c "import json,sys; from jsonschema import Draft202012Validator as V; \
	s=json.load(open('spec/audr.schema.json')); V.check_schema(s); \
	print('  schema is a valid Draft 2020-12 schema')"

examples: ## Validate every specification example against the schema
	@$(PYTHON) tools/validate_examples.py

conformance: ## Run the shared conformance fixtures
	@$(PYTHON) conformance/runner/python/run.py

lint: ## Check $$id cross-references resolve
	@$(PYTHON) tools/lint.py

fresh: ## Fail if any generated file is stale
	@$(PYTHON) tools/render.py --check

core-python: ## Verify the core Python SDK (adapters/core/python)
	@$(MAKE) -C adapters/core/python verify

adapter-nemo-relay-python: ## Lint and test the NeMo Relay Python adapter
	@$(MAKE) -C adapters/nemo-relay/python lint test

sink-chargebee-python: ## Lint and test the Chargebee Python sink
	@$(MAKE) -C sinks/chargebee/python lint test

python: core-python adapter-nemo-relay-python sink-chargebee-python ## Verify every Python package

all: check python ## Everything CI runs, across the repository

clean: ## Remove generated specification outputs
	@rm -f spec/SPEC.md
	@echo "  removed generated outputs (run 'make spec' to restore)"
