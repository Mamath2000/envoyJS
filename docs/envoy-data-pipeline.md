---
title: Pipeline de donnees Envoy
description: Recuperation des donnees Envoy, calculs internes, integration tableau electrique deporte, mode haute frequence.
sidebar_position: 10
---

# Pipeline de donnees Envoy

Ce document decrit le flux complet de donnees dans ce projet:

- authentification Enphase
- appels HTTP a la passerelle Envoy
- normalisation et calculs
- integration du tableau electrique deporte via MQTT
- publication MQTT en mode normal et mode haute frequence

## 1. Vue d ensemble

Le service principal lance deux boucles:

- boucle full: lecture complete + calculs + publication retained
- boucle raw (optionnelle): lecture puissance instantanee + publication rapide non retained

```mermaid
flowchart TD
	A[Config YAML] --> B[EnvoyApi]
	B --> C[Endpoints Envoy]
	C --> D[Normalisation interne brute]
	D --> E[deriveEnvoyFields: calcul champs derives + correction tableau]
	E --> F[Calcul valeurs journalieres]
	F --> G[Publish MQTT data]
	D --> H[Publish MQTT raw]
	I[Topic tableau externe] --> E
	J[Fichier state tableau] <--> E
```

Depuis la refonte, `EnvoyApi.getAllEnvoyData()` ne fait plus que la normalisation brute (renommage de champs, aucun calcul croise). Tous les champs derives (grid, eco, courant, lifetimes corriges) sont calcules en un seul passage par `deriveEnvoyFields()` (src/envoyDerivedFields.js), que le tableau elec soit actif ou non (avec une correction nulle par defaut).

## 2. Authentification et securite

Le projet utilise un token bearer Enphase pour les endpoints Envoy.

Sequence:

1. POST https://enlighten.enphaseenergy.com/login/login.json
2. POST https://entrez.enphaseenergy.com/tokens
3. GET /auth/check_jwt sur l Envoy local
4. Reauth automatique si 401

Points importants:

- token considere valide pendant 12h
- timeout cloud: max(8000ms, timeout local)
- timeout local Envoy: config http.timeout_ms
- option insecure TLS possible (certificat auto-signe)
- les requetes Envoy independantes (meters/readings, consumption, production v1) sont lancees en parallele (`Promise.all`) plutot que sequentiellement — voir 3.x. `ensureAuthenticated()` (src/envoyApi.js:50) garantit qu'une seule authentification est en vol a la fois meme si plusieurs requetes paralleles detectent un token invalide simultanement (single-flight): les appels concurrents attendent la meme promesse au lieu de relancer chacun un login.
- l'Envoy est un device embarqué qui pourrait ne pas gerer 3 requetes concurrentes aussi bien qu'un serveur classique (traitement interne serialisé, timeouts). `getMetersReadings()`, `getRawData()` et `getAllEnvoyData()` logguent chacun leur duree totale en `debug` (`"... terminé (parallèle)"`, avec `durationMs`) — a surveiller en conditions reelles (`LOG_LEVEL=debug`) pour confirmer que le parallelisme aide reellement et ne provoque pas de timeouts/erreurs qui n'existaient pas avant.

Reference code:

- src/envoyApi.js:1

## 3. Endpoints utilises et formats de retour

### 3.1 GET /ivp/meters

But: recuperer la liste des compteurs et associer eid -> type de mesure.

Le code filtre sur:

- production
- net-consumption

Exemple de retour (simplifie):

```json
[
	{ "eid": 704643328, "measurementType": "production" },
	{ "eid": 704643584, "measurementType": "net-consumption" }
]
```

Resultat interne:

```json
{
	"704643328": "production",
	"704643584": "net-consumption"
}
```

Reference code:

- src/envoyApi.js:250 (getMetersInfo)

### 3.2 GET /ivp/meters/readings

But: recuperer les mesures instantanees et cumulees de chaque compteur.

Exemple de retour Envoy (simplifie):

```json
[
	{
		"eid": 704643328,
		"instantaneousDemand": 1260,
		"voltage": 236.2,
		"current": 5.4,
		"pwrFactor": 0.98,
		"actEnergyDlvd": 5581234
	},
	{
		"eid": 704643584,
		"instantaneousDemand": -420,
		"voltage": 235.8,
		"current": -1.8,
		"pwrFactor": -0.94,
		"actEnergyRcvd": 2334455,
		"actEnergyDlvd": 1234567
	}
]
```

Resultat interne apres mapping par role:

```json
{
	"production": { "...": "..." },
	"net-consumption": { "...": "..." }
}
```

Reference code:

- src/envoyApi.js:271 (getMetersReadings)

### 3.3 GET /ivp/meters/reports/consumption

But: recuperer les cumuls de consommation (total/net).

Exemple de retour Envoy (simplifie):

```json
[
	{
		"reportType": "total-consumption",
		"cumulative": {
			"currW": 1860,
			"rmsCurrent": 8.2,
			"rmsVoltage": 236.0,
			"whDlvdCum": 9123456
		}
	},
	{
		"reportType": "net-consumption",
		"cumulative": {
			"whDlvdCum": 6789012
		}
	}
]
```

Resultat interne:

```json
{
	"total-consumption": { "currW": 1860, "rmsCurrent": 8.2, "rmsVoltage": 236.0, "whDlvdCum": 9123456 },
	"net-consumption": { "whDlvdCum": 6789012 }
}
```

Reference code:

- src/envoyApi.js:295 (getConsumptionReports)

### 3.4 GET /api/v1/production

But: recuperer notamment wattHoursToday.

Exemple de retour utile:

```json
{
	"wattHoursToday": 12450
}
```

Reference code:

- src/envoyApi.js:310 (getProductionV1)

## 4. Objets de sortie internes

### 4.1 Sortie getRawData

Objet compact pour la boucle haute frequence:

```json
{
	"conso_all_eim_wNow": 1860,
	"conso_net_eim_wNow": -420,
	"prod_eim_wNow": 1260,
	"timestamp": 1720000000
}
```

Reference code:

- src/envoyApi.js:317 (getRawData)

### 4.2 Sortie getAllEnvoyData

Objet brut normalise pour la boucle principale (renommage de champs uniquement, aucun calcul croise):

- puissances instantanees telles que renvoyees par l'Envoy
- tensions/courants/facteur de puissance
- compteurs lifetime Wh et kWh
- timestamp et timestamp_text

Exemples de champs produits:

- prod_eim_wNow
- conso_net_eim_wNow
- conso_all_eim_wNow
- prod_eim_whLifetime / prod_eim_kwhLifetime
- conso_net_eim_whLifetime / conso_net_eim_kwhLifetime
- conso_all_eim_whLifetime / conso_all_eim_kwhLifetime

Note: `grid_eim_wNow`, `grid_eim_wNow_binary`, `eco_eim_wNow`, `eco_eim_whLifetime`, `eco_eim_kwhLifetime` et `conso_net_eim_current` ne font plus partie de cette sortie brute — ils sont calcules par `deriveEnvoyFields()` (voir 4.3), en un seul passage, a partir de cet objet.

Reference code:

- src/envoyApi.js:337

### 4.3 Sortie deriveEnvoyFields

Fonction pure (src/envoyDerivedFields.js) qui prend l'objet brut de `getAllEnvoyData()` plus une correction optionnelle `{ signedPowerW, energyOffsetWh }` (nulle par defaut) et renvoie l'objet final publie, en un seul passage de calcul:

- champs bruts recopies tels quels
- conso_net_eim_wNow / conso_all_eim_wNow decales de `signedPowerW`
- grid_eim_wNow, grid_eim_wNow_binary, eco_eim_wNow calcules a partir du net corrige
- conso_net_eim_current recalcule via I = P / U
- conso_net/all_eim_whLifetime/kwhLifetime decales de `energyOffsetWh`, grid_eim_whLifetime/kwhLifetime decale en sens inverse, eco_eim_whLifetime/kwhLifetime recalcule (tous clampes a 0)

Reference code:

- src/envoyDerivedFields.js:6

## 5. Logique de calcul metier

### 5.1 Calculs derives de base

A partir de la puissance nette corrigee (`correctedNetPowerW`, apres application de la correction tableau elec):

- grid_eim_wNow = abs(correctedNetPowerW) si correctedNetPowerW < 0 sinon 0
- grid_eim_wNow_binary = 1 si correctedNetPowerW > 0 sinon 0
- eco_eim_wNow = prodDemand + correctedNetPowerW si correctedNetPowerW < 0 sinon prodDemand

Economie lifetime:

- eco_eim_whLifetime = max(0, prod_eim_whLifetime - grid_eim_whLifetime_corrige)

Ce calcul tourne desormais systematiquement dans `deriveEnvoyFields()`, tableau elec actif ou non (correction nulle dans ce dernier cas — voir 6.3).

Reference code:

- src/envoyDerivedFields.js:6

### 5.2 Valeurs journalieres

Le service maintient une reference minuit pour:

- conso_all_eim_whLifetime
- conso_net_eim_whLifetime
- prod_eim_whLifetime
- grid_eim_whLifetime
- eco_eim_whLifetime

Et publie:

- sensor_today = current_lifetime - reference_00h
- sensor_yesterday lors du passage a minuit

#### Detection du changement de jour

`checkAndUpdateMidnightReferences()` ne s'appuie plus sur une fenetre d'horloge fixe (ex: "entre 00h00 et 00h05"). Elle compare simplement la date courante (`getNowPartsInTz().date`) a la derniere date traitee (`this.lastMidnightCheck`) — des que la date differe, le rollover se declenche, quelle que soit l'heure exacte. Cette approche est independante de `polling.interval_ms` : avec l'ancienne fenetre fixe, un intervalle de polling superieur a quelques minutes pouvait faire rater completement le passage a minuit un jour donne (le rollover n'aurait alors plus jamais lieu ce jour-la). Avec la detection par changement de date, le rollover se declenche systematiquement des la premiere iteration de boucle qui observe un nouveau jour — seule sa **precision** depend de la frequence de polling (avec un intervalle tres long, la reference _00h/_yesterday est capturee plus tard dans la journee que minuit exact, mais elle finit toujours par etre capturee).

Le tout premier appel apres le demarrage du service memorise simplement le jour courant sans declencher de rollover (sinon un demarrage en milieu de journee serait pris a tort pour un changement de jour).

#### Persistance de `lastMidnightCheck`

`this.lastMidnightCheck` (dernier jour pour lequel le rollover a ete effectue) est publié en `retain: true` sur `topicData/last_midnight_check`, exactement comme les topics `_00h` — au meme endroit dans le code, juste apres leur republication. `installMqttListeners()` s'y reabonne au demarrage et restaure `lastMidnightCheck` depuis le message retenu (uniquement si aucune valeur n'est deja connue en memoire, et si le payload a bien un format de date `YYYY-MM-DD`).

Sans ca, un redemarrage du service tombant pile sur un changement de jour (arret avant minuit, redemarrage apres) ferait perdre le rollover `_yesterday` de ce jour precis: au redemarrage `lastMidnightCheck` serait `undefined`, et le premier appel se contenterait de memoriser le nouveau jour sans jamais calculer `_yesterday` pour le jour manque. Avec la restauration MQTT, `lastMidnightCheck` retrouve sa vraie valeur (le dernier jour effectivement traite) avant le premier appel de boucle, et le rollover manque se declenche normalement.

Reference code:

- src/mqttService.js:362 (installMqttListeners — souscription + restauration)
- src/mqttService.js:549 (initializeMissingReferences)
- src/mqttService.js:562 (checkAndUpdateMidnightReferences — publication retained)
- src/mqttService.js:845 (calculateDailyValues)

## 6. Integration du tableau electrique deporte

Configuration:

- sensors.tableau_elec.topic
- sensors.tableau_elec.power_field
- sensors.tableau_elec.index_field
- sensors.tableau_elec.index_unit: kwh | wh | auto
- sensors.tableau_elec.sign: 1 ou -1
- sensors.tableau_elec.state_file

### 6.1 Format de payload accepte

Exemple type Zigbee2MQTT:

```json
{
	"power": 7200,
	"energy": 1345.231
}
```

Regles:

- power_field alimente la correction instantanee (W)
- index_field alimente la correction energie (differentiel d index)
- la premiere valeur d index est baseline, jamais ajoutee telle quelle

### 6.2 Persistance entre redemarrages

Le fichier state_file (par defaut data/tableau-elec-state.json) stocke:

```json
{
	"version": 2,
	"updatedAt": "2026-07-19T12:34:56.000Z",
	"lastIndexWh": 1345231,
	"energyFromIndexWh": 5420,
	"pendingResetIndexWh": null,
	"pendingResetLastSeenWh": null,
	"pendingResetCount": 0
}
```

`lastIndexWh`/`energyFromIndexWh` sont la derniere valeur confirmee et l'offset cumule. Les trois champs `pendingReset*` portent l'etat de la fenetre de confirmation d'un eventuel reset/remplacement de capteur (voir 6.3) — ils sont non-nuls uniquement pendant qu'une baisse d'index est en cours de confirmation, et permettent de ne pas perdre cette confirmation partielle en cas de redemarrage du service au mauvais moment.

Mise a jour du fichier:

- a la premiere baseline (immediat)
- a chaque delta "normal" valide, mais throttlé a `EnvoyMqttService.TABLEAU_ELEC_SAVE_THROTTLE_MS` (1h par defaut) — voir note ci-dessous
- a chaque lecture candidate/confirmee d'un reset, sans throttle (voir 6.3)
- a l arret du service (`stop()`), sans throttle

#### Throttle des ecritures disque

`saveTableauElecStateToDisk(force = false)` ignore les appels non forcés survenant moins de `TABLEAU_ELEC_SAVE_THROTTLE_MS` apres la derniere ecriture reussie — utile si le capteur externe publie tres frequemment (plusieurs fois par seconde), pour eviter d'ecrire sur disque a chaque message. Ce throttle ne s'applique qu'a la progression "normale" de l'index (le cas le plus frequent); les baselines, transitions de detection de reset et l'arret du service forcent toujours l'ecriture (`force = true`).

Ce throttle est sans risque pour l'exactitude: `lastIndexWh` et `energyFromIndexWh` sont toujours ecrits ensemble comme une paire coherente. Si le service redemarre entre deux ecritures (crash, coupure), le prochain message recalcule un delta plus grand depuis le dernier point sauvegardé, ce qui redonne le meme total accumulé (propriete telescopique de la somme de deltas) — au pire, une confirmation de reset en cours (voir 6.3) redemarre a zero, ce qui est le comportement "safe by default" recherché.

Reference code:

- src/mqttService.js:154 (resolveTableauElecStateFilePath)
- src/mqttService.js:212 (saveTableauElecStateToDisk)
- src/mqttService.js:702 (updateTableauElecIndexOffset)

### 6.3 Corrections appliquees dans le code (detail)

Le principe est bien celui que tu decris: le tableau deporte sert a corriger un ecart sur les donnees Envoy.

Depuis la refonte, la correction n'est plus appliquee "apres coup" sur un objet deja calcule: `EnvoyMqttService.getTableauElecCorrection()` (src/mqttService.js:794) resout `{ signedPowerW, energyOffsetWh }` a partir de l'etat courant du tableau elec (0 si desactive), puis `deriveFullData()` (src/mqttService.js:805) transmet cette correction a `deriveEnvoyFields()` en un seul appel — c'est cette meme fonction qui calcule aussi bien les champs de base (5.1) que la correction, il n'y a plus de double calcul.

Le code applique les corrections suivantes (dans src/envoyDerivedFields.js).

Correction puissance instantanee (avec signe):

- signedPowerW = tableau_elec_power * sign
- conso_net_eim_wNow = conso_net_eim_wNow_envoy + signedPowerW
- conso_all_eim_wNow = conso_all_eim_wNow_envoy + signedPowerW

Puis recalcul de derivees instantanees:

- grid_eim_wNow
- grid_eim_wNow_binary
- eco_eim_wNow
- conso_net_eim_current (via I = P / U)

Correction energie cumulative (Wh) via index differentiel uniquement:

- energyOffsetWh = somme des deltas d index externe confirmes (jamais la valeur absolue)
- conso_net_eim_whLifetime = conso_net_eim_whLifetime_envoy + energyOffsetWh
- conso_net_eim_kwhLifetime = conso_net_eim_kwhLifetime_envoy + energyOffsetWh / 1000
- conso_all_eim_whLifetime = conso_all_eim_whLifetime_envoy + energyOffsetWh
- conso_all_eim_kwhLifetime = conso_all_eim_kwhLifetime_envoy + energyOffsetWh / 1000
- grid_eim_whLifetime = grid_eim_whLifetime_envoy - energyOffsetWh
- grid_eim_kwhLifetime = grid_eim_kwhLifetime_envoy - energyOffsetWh / 1000
- eco_eim_whLifetime = prod_eim_whLifetime - grid_eim_whLifetime_corrige
- eco_eim_kwhLifetime = prod_eim_kwhLifetime - grid_eim_kwhLifetime_corrige

Impact sur les calculs journaliers:

- conso_all_eim_today, conso_net_eim_today, grid_eim_today et eco_eim_today sont corriges,
  car calcules depuis les lifetimes corriges.

#### Autodiscovery Home Assistant

`publishHaAutodiscoveryDynamic()` ignore silencieusement tout champ absent de `src/device-def/sensors-def.json` (voir 8). `eco_eim_kwhLifetime` et `tableau_elec_whOffset` y ont ete ajoutes — ils sont calcules/publies depuis un moment mais n'avaient jamais de definition HA, donc jamais decouverts automatiquement. `tableau_elec_whOffset` est declare en `state_class: measurement` (pas `total_increasing`): sa valeur peut decroitre indefiniment selon le `sign` configure (ex: sign=-1), ce que `total_increasing` interpreterait a tort comme des resets de compteur repetes.

#### Detection de reset/remplacement du capteur externe (protection anti-glitch)

Un payload MQTT glitché (`null` ou `0` ponctuel, ex: device Zigbee qui se reveille) est indiscernable, sur une seule lecture, d'un vrai remplacement de capteur (compteur qui repart de 0). `updateTableauElecIndexOffset()` n'applique donc jamais un reset sur une seule baisse d'index detectee (delta < -1 Wh par rapport a la derniere valeur confirmee):

- 1ere lecture basse → candidat de reset, mis en attente (rien n'est committe, `energyFromIndexWh`/`lastIndexWh` inchanges).
- Si la lecture suivante revient sur la trajectoire d'origine (delta normal par rapport a l'ancienne valeur confirmee) → le candidat est abandonne, c'etait un glitch isole.
- Si au contraire les lectures suivantes continuent sur la nouvelle trajectoire basse (coherentes entre elles), le candidat est confirme apres `EnvoyMqttService.RESET_CONFIRMATIONS_REQUIRED` (3) lectures consecutives.
- Une fois confirme, seul le delta depuis la toute premiere lecture candidate est ajoute a `energyFromIndexWh` — l'offset deja accumule par le capteur precedent est preserve integralement (aucune perte d'historique au remplacement physique du capteur).
- Si les lectures candidates sont elles-memes incoherentes entre elles (rebaisse encore), la fenetre de confirmation redemarre a partir de la derniere valeur.

References code:

- src/envoyDerivedFields.js:6 (deriveEnvoyFields — toutes les formules ci-dessus)
- src/mqttService.js:702 (updateTableauElecIndexOffset — detection/confirmation de reset)
- src/mqttService.js:794 (getTableauElecCorrection — resolution de signedPowerW/energyOffsetWh)
- src/mqttService.js:805 (deriveFullData — appel unique + ajout de tableau_elec_wNow/whOffset)

## 7. Mode haute frequence

Activation:

- high_frequency.enabled: true
- high_frequency.interval_ms: ex 1000

Comportement:

- boucle raw qui appelle getRawData
- publication sur base/serial/raw/field
- messages non retained
- correction puissance tableau appliquee en temps reel
- pas de recalcul journalier dans cette boucle

Reference code:

- src/mqttService.js:410 (publishRawLoop)
- src/mqttService.js:439 (applyTableauElecOnRawData)

## 8. Topics MQTT publies

### 8.1 Etat service

- base/serial/lwt: online|offline (retained)

### 8.2 Donnees full

- base/serial/data/field (retained)
- base/serial/data/*_00h (retained)
- base/serial/data/*_today (retained)
- base/serial/data/*_yesterday (retained)
- base/serial/data/last_midnight_check (retained, technique — dernier jour de rollover, voir 5.2)

### 8.3 Donnees raw

- base/serial/raw/field (non retained)

### 8.4 Capteurs JSON dedies

- topic pv_production: energy, power, facteur_de_puiss, voltage, current
- topic conso_net: energy, energy_flow, power_cons, power, facteur_de_puiss, voltage, current

Reference code:

- src/ha/energySensors.js:42

## 9. Cas limites et garanties

- Si index_field absent: correction energie externe desactivee (offset = 0)
- Si index recule fortement (delta < -1 Wh): reset non committe immediatement, mis en attente de confirmation sur 3 lectures consecutives coherentes (voir 6.3) — protege contre un payload glitché (null/0) isole
- Si erreur endpoint: la boucle continue, warning logge
- Si token expire/401: reauth + retry automatique

## 10. Checklist d integration Docusaurus

1. Conserver le frontmatter du fichier.
2. Ajouter ce document dans la sidebar Docusaurus.
3. Lier cette page depuis la doc de configuration.
4. Optionnel: ajouter une page annexe avec exemples reels de payload Envoy.

