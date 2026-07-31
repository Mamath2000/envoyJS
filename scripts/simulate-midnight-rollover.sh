#!/bin/bash

# Force le declenchement du rollover minuit au prochain tick du service, sans
# attendre minuit reel: recule lastMidnightCheck d'un jour dans le fichier
# d'etat (voir loadMidnightReferencesFromDisk()/checkAndUpdateMidnightReferences()
# dans src/mqttService.js, et docs/envoy-data-pipeline.md §5.2).
#
# Le fichier n'est relu qu'au demarrage du service (start()): redemarrer le
# service (ou le conteneur) apres ce script pour que le changement soit pris
# en compte. Note: previousFullData (utilise pour eviter de melanger de la
# conso du nouveau jour dans yesterday) est en RAM, jamais persiste — un
# redemarrage repart donc sans lui, ce qui exerce le chemin de repli
# (currentData) plutot que le chemin precis. Voir docs/envoy-data-pipeline.md.
#
# Usage: scripts/simulate-midnight-rollover.sh [chemin_fichier_etat]

set -euo pipefail
cd "$(dirname "$0")/.."

STATE_FILE="${1:-data/midnight-references-state.json}"

command -v jq >/dev/null || { echo "jq introuvable"; exit 1; }

if [ ! -f "$STATE_FILE" ]; then
  echo "Fichier d'etat introuvable: $STATE_FILE (demarre le service au moins une fois pour qu'il soit cree)" >&2
  exit 1
fi

TZ_NAME="$(node -e '
import("./src/config.js").then(({ loadConfig }) => {
  process.stdout.write(loadConfig().timeZoneName);
});
')"

YESTERDAY="$(TZ="$TZ_NAME" date -d "yesterday" +%F)"

TMP_FILE="$(mktemp "${STATE_FILE}.XXXXXX")"
jq --arg lc "$YESTERDAY" '.lastMidnightCheck = $lc' "$STATE_FILE" > "$TMP_FILE"
mv "$TMP_FILE" "$STATE_FILE"

echo "lastMidnightCheck mis a ${YESTERDAY} dans ${STATE_FILE}."
echo "Redemarre le service: le rollover se declenchera au prochain tick (polling.interval_ms)."
