#!/bin/bash

# Genere data/midnight-references-state.json (ou le chemin donne en argument) a
# partir des topics MQTT retained actuels (_00h, _yesterday, last_midnight_check).
# Usage unique: migre l'etat existant vers le fichier local utilise par
# loadMidnightReferencesFromDisk() (voir docs/envoy-data-pipeline.md §5.2).
#
# Usage: scripts/generate-midnight-references-state.sh [chemin_sortie] [timeout_s]

set -euo pipefail
cd "$(dirname "$0")/.."

OUT_FILE="${1:-data/midnight-references-state.json}"
TIMEOUT_S="${2:-5}"

command -v mosquitto_sub >/dev/null || { echo "mosquitto_sub introuvable (paquet mosquitto-clients)"; exit 1; }
command -v jq >/dev/null || { echo "jq introuvable"; exit 1; }

eval "$(node -e '
import("./src/config.js").then(({ loadConfig }) => {
  const c = loadConfig();
  console.log(`MQTT_HOST=${JSON.stringify(c.mqttHost)}`);
  console.log(`MQTT_PORT=${JSON.stringify(String(c.mqttPort))}`);
  console.log(`MQTT_USER=${JSON.stringify(c.mqttUsername ?? "")}`);
  console.log(`MQTT_PASS=${JSON.stringify(c.mqttPassword ?? "")}`);
  console.log(`TOPIC_DATA=${JSON.stringify(`${c.mqttBaseTopic}/${c.serialNumber}/data`)}`);
  console.log(`TZ_NAME=${JSON.stringify(c.timeZoneName)}`);
});
')"

MOSQ_ARGS=(-h "$MQTT_HOST" -p "$MQTT_PORT")
[ -n "$MQTT_USER" ] && MOSQ_ARGS+=(-u "$MQTT_USER")
[ -n "$MQTT_PASS" ] && MOSQ_ARGS+=(-P "$MQTT_PASS")

fetch_topic() {
  timeout "$TIMEOUT_S" mosquitto_sub "${MOSQ_ARGS[@]}" -t "$1" -C 1 2>/dev/null || true
}

# La cle JSON stockee doit correspondre exactement a ce que
# loadMidnightReferencesFromDisk()/midnightReferences attendent en memoire:
# - reference _00h  -> cle = nom brut du capteur (ex: conso_all_eim_whLifetime),
#                       topic = <cle>_00h
# - valeur _yesterday -> cle = nom du capteur avec _whLifetime remplace par
#                       _yesterday (ex: conso_all_eim_yesterday), topic = <cle>
add_ref() {
  local key="$1" topic="$2"
  local value
  value="$(fetch_topic "$topic")"
  if [[ "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    refs_json="$(jq --arg k "$key" --argjson v "$value" '.[$k] = $v' <<<"$refs_json")"
  else
    echo "ignore ${key}: pas de valeur retained numerique (${topic})" >&2
  fi
}

SENSORS=(conso_all_eim_whLifetime conso_net_eim_whLifetime prod_eim_whLifetime grid_eim_whLifetime eco_eim_whLifetime)

refs_json="{}"
for sensor in "${SENSORS[@]}"; do
  add_ref "$sensor" "${TOPIC_DATA}/${sensor}_00h"

  yesterday_key="${sensor/_whLifetime/_yesterday}"
  add_ref "$yesterday_key" "${TOPIC_DATA}/${yesterday_key}"
done

last_check="$(fetch_topic "${TOPIC_DATA}/last_midnight_check")"
if [[ ! "$last_check" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  # Pas de valeur retained valide: les references _00h recuperees ci-dessus sont
  # par definition celles du jour en cours (le service les republie a chaque
  # cycle), donc lastMidnightCheck doit flaguer aujourd'hui, pas rester null
  # (sinon on force le service a le redeviner via son propre fallback demarrage).
  last_check="$(TZ="$TZ_NAME" date +%F)"
  echo "last_midnight_check absent/invalide sur MQTT: jour courant utilisé (${last_check})" >&2
fi

mkdir -p "$(dirname "$OUT_FILE")"
jq -n --argjson refs "$refs_json" --arg lc "$last_check" \
  '{midnightReferences: $refs, lastMidnightCheck: (if ($lc | length) > 0 then $lc else null end)}' \
  > "$OUT_FILE"

echo "Ecrit: $OUT_FILE"
cat "$OUT_FILE"
