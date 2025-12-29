#!/bin/bash

# Script de build (et optionnellement publication) Docker pour envoyjs/envoy2mqtt

set -euo pipefail

# Vérifications des prérequis
command -v docker >/dev/null 2>&1 || { echo "❌ Docker est requis mais non installé."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "❌ Git est requis mais non installé."; exit 1; }

usage() {
    echo "Usage: $0 [--push] [--repo <docker_user>] [--image <name>]"
    echo "  --push            pousse les images sur Docker Hub (nécessite docker login)"
    echo "  --repo <user>      Docker Hub user/org (défaut: env DOCKER_USER ou mathmath350)"
    echo "  --image <name>     nom de l'image (défaut: env APP_NAME ou envoyjs)"
}

PUSH=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --push) PUSH=1; shift ;;
        --repo) DOCKER_USER="$2"; shift 2 ;;
        --image) APP_NAME="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Option inconnue: $1"; usage; exit 1 ;;
    esac
done

# Configuration
DOCKER_USER=${DOCKER_USER:-"mathmath350"}
APP_NAME=${APP_NAME:-"envoyjs"}

if [[ "$PUSH" -eq 1 ]]; then
    docker info | grep -q Username || {
            echo "❌ Non connecté à Docker Hub. Lancez 'docker login' d'abord.";
            exit 1;
    }
fi

echo "Build Docker pour $APP_NAME"
echo "Docker Hub repo: $DOCKER_USER"

# Version depuis package.json (sans jq, sans import JSON expérimental)
VERSION=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version)")
echo "Version: $VERSION"

# Récupère le hash court du commit git
GIT_REF=$(git rev-parse --short HEAD)
echo "Git ref: $GIT_REF"

# Vérifie que le working directory est propre
if [ -n "$(git status --porcelain)" ]; then
    echo "Warning: working directory pas propre."
    git status --short
    echo "(le build va inclure l'état actuel de ton workspace)"
fi

# Build de l'image Docker avec la ref git
echo "Construction de l'image Docker..."
docker build \
    --build-arg GIT_REF=$GIT_REF \
    --build-arg BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ') \
    -t $APP_NAME:latest \
    -t $APP_NAME:$VERSION \
    -t $APP_NAME:$GIT_REF \
    .

if [[ "$PUSH" -eq 1 ]]; then
    echo "Tagging pour Docker Hub..."
    docker tag $APP_NAME:latest $DOCKER_USER/$APP_NAME:latest
    docker tag $APP_NAME:$VERSION $DOCKER_USER/$APP_NAME:$VERSION
    docker tag $APP_NAME:$GIT_REF $DOCKER_USER/$APP_NAME:$GIT_REF

    echo "Push Docker Hub..."
    docker push $DOCKER_USER/$APP_NAME:latest
    docker push $DOCKER_USER/$APP_NAME:$VERSION
    docker push $DOCKER_USER/$APP_NAME:$GIT_REF
fi

echo "OK. Images locales:" 
echo "  - $APP_NAME:latest"
echo "  - $APP_NAME:$VERSION"
echo "  - $APP_NAME:$GIT_REF"