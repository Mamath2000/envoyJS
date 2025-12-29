#!/bin/bash

# Release helper:
# - Bump version (package.json + package-lock.json)
# - Optionally commit/tag if this is a git repo
# - Optionally build/push Docker image

set -euo pipefail

usage() {
  echo "Usage: $0 [patch|minor|major] [--docker] [--push] [--repo <docker_user>] [--image <name>]"
  echo "  patch|minor|major  type d'incrément (défaut: patch)"
  echo "  --docker           build l'image Docker après bump"
  echo "  --push             pousse l'image Docker (implique --docker)"
  echo "  --repo <user/org>  repo Docker Hub (défaut: env DOCKER_USER ou mathmath350)"
  echo "  --image <name>     nom image (défaut: env APP_NAME ou envoyjs)"
}

BUMP="patch"
DO_DOCKER=0
DO_PUSH=0
DOCKER_USER=${DOCKER_USER:-"mathmath350"}
APP_NAME=${APP_NAME:-"envoyjs"}

if [[ $# -gt 0 ]]; then
  case "$1" in
    patch|minor|major) BUMP="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker) DO_DOCKER=1; shift ;;
    --push) DO_PUSH=1; DO_DOCKER=1; shift ;;
    --repo) DOCKER_USER="$2"; shift 2 ;;
    --image) APP_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Option inconnue: $1"; usage; exit 1 ;;
  esac
done

NEW_VERSION=$(node scripts/bump-version.js "$BUMP")
echo "Version bump -> $NEW_VERSION"

# Git commit/tag si on est dans un repo
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    git add package.json package-lock.json 2>/dev/null || true
    git commit -m "chore(release): v$NEW_VERSION" || true
  fi
  # tag si pas déjà présent
  if ! git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
    git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"
  fi
fi

if [[ "$DO_DOCKER" -eq 1 ]]; then
  echo "Build Docker (tag: $APP_NAME:$NEW_VERSION)"
  ./scripts/build-docker-image.sh --image "$APP_NAME" --repo "$DOCKER_USER" $( [[ "$DO_PUSH" -eq 1 ]] && echo "--push" )
fi

echo "OK release v$NEW_VERSION"
