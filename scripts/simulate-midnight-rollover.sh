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
# DANGER: si le vrai rollover du jour a deja eu lieu (lastMidnightCheck deja a
# aujourd'hui), relancer ce script puis redemarrer declenche un DEUXIEME
# rollover quelques instants apres le premier. previousFullData n'etant pas
# persisté, ce deuxieme rollover retombe sur currentData — quasi identique au
# _00h que le premier rollover vient tout juste de poser — et ECRASE la vraie
# valeur "yesterday" par un delta de quelques minutes au lieu d'une journee
# complete. D'ou le garde-fou ci-dessous: refuse par defaut si le rollover du
# jour a deja eu lieu (utiliser --force pour passer outre, en connaissance de
# cause — jamais sur le fichier d'etat de prod juste apres un vrai rollover).
#
# Usage: scripts/simulate-midnight-rollover.sh [--force] [chemin_fichier_etat]

set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=1
  else
    ARGS+=("$arg")
  fi
done

STATE_FILE="${ARGS[0]:-data/midnight-references-state.json}"

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

TODAY="$(TZ="$TZ_NAME" date +%F)"
CURRENT_LMC="$(jq -r '.lastMidnightCheck // empty' "$STATE_FILE")"

if [ "$CURRENT_LMC" = "$TODAY" ] && [ "$FORCE" -ne 1 ]; then
  echo "lastMidnightCheck (${CURRENT_LMC}) est deja la date du jour: le vrai rollover a deja eu lieu aujourd'hui." >&2
  echo "Relancer ce script maintenant declencherait un DEUXIEME rollover quelques instants apres le premier," >&2
  echo "et ecraserait la vraie valeur 'yesterday' qui vient d'etre calculee par un delta de quelques minutes." >&2
  echo "Utilise --force si c'est vraiment voulu (en connaissance de cause), sinon attends demain," >&2
  echo "ou utilise un fichier d'etat separe (2e argument) pointant vers un environnement de test." >&2
  exit 1
fi

YESTERDAY="$(TZ="$TZ_NAME" date -d "yesterday" +%F)"

TMP_FILE="$(mktemp "${STATE_FILE}.XXXXXX")"
jq --arg lc "$YESTERDAY" '.lastMidnightCheck = $lc' "$STATE_FILE" > "$TMP_FILE"
mv "$TMP_FILE" "$STATE_FILE"

echo "lastMidnightCheck mis a ${YESTERDAY} dans ${STATE_FILE}."
echo "Redemarre le service: le rollover se declenchera au prochain tick (polling.interval_ms)."
