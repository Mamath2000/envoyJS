# envoyJS (Envoy → MQTT)

## 🧩 Fonctionnalités principales

> **À savoir :** l’authentification initiale se fait en ligne auprès du service Enlighten d’Enphase (nécessaire pour obtenir le token JWT). Ensuite, les lectures de données se font en **local**, directement via l’API de la passerelle **Envoy**, et les valeurs sont publiées sur **MQTT**.

```mermaid
flowchart TD
    A[Passerelle Enphase Envoy S Metered]
    subgraph MQTT
        B1[Publication données complètes (retained)]
        B2[Publication capteurs dédiés PV / Conso nette]
        B3[Publication haute fréquence (raw)]
    end
    subgraph Home Assistant
        C1[Autodiscovery (device-based)]
        C2[Automatisations]
    end

    A --> B1
    A --> B2
    A --> B3
    B1 --> C1
    B2 --> C1
    B3 --> C2
```

Ce service Node.js :

- Récupère des mesures de la passerelle Envoy (production, conso nette, conso totale, injection réseau, etc.).
- Publie sur MQTT :
  - **données complètes** à intervalle configurable (par défaut 60s), en **retained**.
  - **données raw** haute fréquence (par défaut 1s), sans retain.
- Optionnellement :
  - publie la configuration Home Assistant via **autodiscovery** (payload « device-based »).
  - publie 2 capteurs dédiés JSON (PV et conso nette) sur des topics « simples ».
- Calcule des valeurs journalières (`*_today` / `*_yesterday`) à partir de compteurs *lifetime*.

---

## ⚡ Commandes principales

Le projet fournit un `Makefile` (optionnel) + les scripts npm.

- `npm start` : lance le service
- `make run` : lance le service (équivalent)
- `make docker-build` / `make docker-run` : build + run Docker

---

## 🚀 Installation rapide

### Prérequis

- Node.js >= 18
- Un broker MQTT
- Une passerelle Enphase Envoy accessible sur le LAN
- Des identifiants Enphase (Enlighten) du **propriétaire** de l’Envoy

### Installer

```bash
npm ci
```

### Configurer

Crée un fichier de configuration (il est ignoré par git) :

```bash
cp config.example.yaml config.yaml
```

Puis édite `config.yaml`.

### Lancer

```bash
npm start
# ou
make run
```

---

## 📝 Configuration (config.yaml)

Le service cherche un fichier de config à l’un de ces emplacements :

- `./config.yaml` (recommandé)
- `./config.yml`

### Champs requis

- `envoy.serial` : numéro de série de l’Envoy
- `envoy.base_url` : URL locale de l’Envoy (ex: `https://192.168.1.50`)
- `auth.owner_email` / `auth.owner_password` : identifiants Enlighten

### Exemple

Voir [config.example.yaml](config.example.yaml).

### Options utiles

- `envoy.insecure_tls` (défaut `true`) : utile si l’Envoy est en HTTPS avec certificat auto-signé.
- `http.timeout_ms` (défaut 1500) : timeout des appels LAN.
- `polling.interval_ms` (défaut 60000) : boucle « full ».
- `high_frequency.enabled` + `high_frequency.interval_ms` : boucle « raw ».
- `mqtt.*` : broker MQTT + `mqtt.base_topic`.
- `discovery.enabled` : active l’autodiscovery Home Assistant.
  - `discovery.topic` (optionnel) : override du topic de config.
  - `discovery.qos_config` (défaut 1) : QoS du message discovery.
- `sensors.pv_production.*` / `sensors.conso_net.*` : capteurs dédiés JSON.
- `sensors.tableau_elec.*` : capteur MQTT externe injecté dans le calcul de `conso_net`.
  - `topic` : topic MQTT contenant la puissance du tableau (nombre brut ou JSON).
  - `power_field` (optionnel) : chemin du champ puissance à lire dans le JSON (ex: `payload.power`).
  - `index_field` (optionnel) : chemin du champ index énergie cumulé (ex: `payload.energy`).
  - `index_unit` (optionnel, défaut `auto`) : `kwh`, `wh` ou `auto`.
  - `state_file` (optionnel) : fichier JSON de persistance de l'index/baseline entre redémarrages (ex: `data/tableau-elec-state.json`).
    - L'énergie externe est corrigée uniquement depuis le différentiel d'index (aucune intégration puissance×temps dans le code).
    - Le calcul est strictement différentiel: la première valeur reçue sert de baseline et n'est pas ajoutée aux compteurs.
    - Au redémarrage, l'état est restauré depuis `state_file` pour continuer le calcul sans perdre l'historique.
  - `sign` : `1` pour ajouter au net, `-1` pour soustraire.
  - Persistance: fichier (`state_file`) + mémoire process.
- `timezone.name` : fuseau utilisé pour minuit (snapshots / yesterday).
- `logging.level` : `silent|error|warn|info|debug`.

> **Note Docker / mDNS** : `http://envoy.local` ne fonctionne pas toujours dans Docker. Le plus simple est de mettre l’IP dans `envoy.base_url`.

---

## 📡 Topics MQTT

Base : `mqtt.base_topic` + `envoy.serial`.

- **Statut** (retained)
  - `${base}/${serial}/lwt` : `online` / `offline`

- **Données complètes** (retained)
  - `${base}/${serial}/data/{field}`

- **Données raw** (non-retained)
  - `${base}/${serial}/raw/{field}`

Exemple :

- `envoy/123456789/lwt`
- `envoy/123456789/raw/prod_wNow`
- `envoy/123456789/raw/conso_net_wNow`

### Valeurs journalières

Pour certains compteurs, le service publie aussi :

- `${base}/${serial}/data/{sensor}_00h` (référence minuit, retained)
- `${base}/${serial}/data/{sensor}_today` (valeur du jour, retained)
- `${base}/${serial}/data/{sensor}_yesterday` (valeur de la veille, retained)

---

## 🏠 Home Assistant

### Autodiscovery

Si `discovery.enabled: true`, le service publie un payload « device-based » :

- par défaut : `homeassistant/device/envoy_{serial}/config`
- ou `discovery.topic` si fourni

Les entités publiées dépendent de la définition dans [src/device-def/sensors-def.json](src/device-def/sensors-def.json).

### Capteurs dédiés (JSON)

Si activé :

- `sensors.pv_production.topic` publie un JSON contenant notamment : `energy`, `power`, `voltage`, `current`…
- `sensors.conso_net.topic` publie un JSON contenant notamment : `energy`, `power`, `power_cons`, `energy_flow`…

---

## 🐳 Lancer avec Docker

### docker compose

```bash
cp docker-compose.example.yml docker-compose.yml
cp config.example.yaml config.yaml

docker compose up -d
```

### build + run

```bash
make docker-build
make docker-run
```

---

## 🔍 Dépannage

- **Auth Enphase** : vérifie `auth.owner_email` / `auth.owner_password`.
- **TLS/HTTPS Envoy** : si certificat auto-signé, laisse `envoy.insecure_tls: true`.
- **Docker + envoy.local** : préfère une IP dans `envoy.base_url`.
- **MQTT** : vérifie `mqtt.host` / `mqtt.port` et les logs `MQTT error`.

---

## 🔐 Notes sécurité

- Ne commite pas `config.yaml` : il contient des secrets (déjà ignoré par `.gitignore`).
- Idéalement, utilise un compte Enphase dédié et un mot de passe spécifique.
