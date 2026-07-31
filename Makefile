.DEFAULT_GOAL := help

.PHONY: help run docker-build docker-run simulate-midnight-rollover release release-patch release-minor release-major release-docker release-docker-push

help: ## Affiche l'aide
	@printf "\nTargets disponibles:\n\n"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' Makefile | awk 'BEGIN {FS=":.*?## "} {printf "  %-12s %s\n", $$1, $$2}'
	@printf "\nExemples:\n"
	@printf "  make run\n\n"

run: ## Lance le service (nécessite config.yaml)
	node src/index.js

simulate-midnight-rollover: ## Force le rollover minuit au prochain tick (test, redémarrer le service après)
	./scripts/simulate-midnight-rollover.sh

docker-build: ## Construit l'image Docker localement
	docker build -t envoyjs:latest .

docker-run: ## Lance le container (monte ./config.yaml)
	docker run --rm \
		-v "$(PWD)/config.yaml:/app/config.yaml:ro" \
		envoyjs:latest

release: ## Incrémente version (patch) + tag git si repo
	./scripts/release.sh patch

release-patch: ## Alias de release
	./scripts/release.sh patch

release-minor: ## Incrémente version minor
	./scripts/release.sh minor

release-major: ## Incrémente version major
	./scripts/release.sh major

release-docker: ## Incrémente version (patch) + build image Docker
	./scripts/release.sh patch --docker

release-docker-push: ## Incrémente version (patch) + build+push Docker
	./scripts/release.sh patch --docker --push
