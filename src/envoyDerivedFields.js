/**
 * Calcule les champs derives (grid/eco/courant/lifetime) a partir des champs
 * bruts normalises d'Envoy et des lectures du capteur general. Fonction pure,
 * un seul passage de calcul.
 *
 * `inputs` n'est plus une "correction" au sens strict: conso_net (wNow,
 * current) et grid/eco/conso_all (whLifetime) sont directement sources
 * depuis le capteur general — il n'y a plus rien a corriger sur ces champs,
 * contrairement a l'ancienne approche TOR + offset (tableau elec, retiré).
 *
 * Aucun champ kWh n'est calcule ici: le kWh est toujours simplement le Wh /
 * 1000, donc affiche cote Home Assistant via un value_template sur le topic
 * Wh existant plutot que publie comme un champ MQTT separe (voir
 * sensors-def.json / source_field, et src/ha/discovery.js).
 */

export function deriveEnvoyFields(rawFields, inputs = {}) {
  if (!rawFields || typeof rawFields !== "object") return rawFields;

  const adjusted = { ...rawFields };

  // Champ temps réél :

  // Bruit de veille des micro-onduleurs: hors production, les panneaux
  // consomment 2-3W (auto-alimentation), ce que l'Envoy remonte tel quel sur
  // prod/wNow. Sans ce clamp, le TOR (prod/wNow_binary) et eco/wNow
  // interpretent ce bruit comme une production reelle.
  const rawProdW = Number(adjusted["prod/wNow"]);
  if (Number.isFinite(rawProdW) && rawProdW <= 3) {
    adjusted["prod/wNow"] = 0;
  }

  // Capteur général (zigbee bidirectionnel, place sur le general — meme point
  // que le compteur EDF): il voit l'integralite du flux reseau de
  // l'installation (maison + ex-tableau ext), en instantane comme en cumule.
  // conso_net/wNow et current en viennent desormais directement — plus besoin
  // du TOR net-consumption Envoy (aveugle au tableau ext) ni du calcul I =
  // P/U (le capteur remonte son propre courant mesure).
  const generalMeterPowerW = Number(inputs.generalMeterPowerW);
  if (Number.isFinite(generalMeterPowerW)) {
    const netPowerW = Math.round(generalMeterPowerW);
    adjusted["conso_net/wNow"] = netPowerW;

    adjusted["grid/wNow"] = netPowerW < 0 ? Math.abs(netPowerW) : 0;
    adjusted["grid/wNow_binary"] = netPowerW > 0 ? 1 : 0;

    const prodW = Number(adjusted["prod/wNow"]);
    if (Number.isFinite(prodW)) {
      adjusted["eco/wNow"] = netPowerW < 0 ? prodW + netPowerW : prodW;
    }
  }

  // Un seul champ voltage suffit cote HA (prod/voltage, Envoy — toujours
  // fiable, jamais besoin de correction, voir sensors-def.json): pas de
  // conso_net/voltage distinct a maintenir.
  const generalMeterCurrentA = Number(inputs.generalMeterCurrentA);
  if (Number.isFinite(generalMeterCurrentA)) {
    adjusted["conso_net/current"] = Number(generalMeterCurrentA.toFixed(3));
  }

  // Sens du flux tel que remonté par le capteur general lui-meme
  // ("producing"/"consuming"), déjà utilisé en interne pour signer
  // generalMeterPowerW (voir mqttService.parseGeneralMeterPayload) —
  // republié tel quel pour que HA affiche aussi ce champ source.
  if (inputs.generalMeterEnergyFlow != null) {
    adjusted["conso_net/energy_flow"] = inputs.generalMeterEnergyFlow;
  }

  // Index energie
  const prodWhLifetime = Number(adjusted["prod/whLifetime"]);

  // prod/whLifetime (publié tel quel ci-dessus, jamais modifié: c'est la vraie
  // valeur absolue depuis l'installation des panneaux) vit depuis bien plus
  // longtemps que les nouveaux index du capteur general (baselinés a la pose,
  // donc proches de 0). Pour que eco/conso_all restent coherents avec des
  // index tout juste rebaselinés plutot que domines par ce gros nombre, on
  // utilise ici une version elle aussi rebaselinée de prod (memes principes
  // que le capteur general — constante de config, jamais recapturée), sans
  // jamais toucher au champ publié prod/whLifetime lui-meme.
  const prodBaselineWh = Number(inputs.prodBaselineWh);
  const prodWhLifetimeSinceReset =
    Number.isFinite(prodBaselineWh) && Number.isFinite(prodWhLifetime)
      ? prodWhLifetime - prodBaselineWh
      : prodWhLifetime;

  // Capteur général — index cumules (import/export): deux registres materiels
  // independants, chacun avec une baseline fixe configurée a la pose du
  // capteur sur le general (sensors.general_meter.*_baseline_wh, voir
  // mqttService.applyGeneralMeterReading — simple soustraction brut -
  // baseline, jamais recapturée automatiquement).
  //
  // generalMeterImportWhLifetime n'est plus publié comme champ a part
  // (data/import/*, HA "sensor" retiré — inutile a l'usage): il ne sert plus
  // qu'en interne, pour conso_all/conso_net ci-dessous. grid/whLifetime
  // (export/"to_grid") reste lu directement et publié. eco/whLifetime
  // (autoconsommation) se deduit par conservation d'energie a partir de deux
  // grandeurs desormais fiables et non affectees par le tableau ext (prod,
  // jamais aveugle a rien, et grid/export, mesure directement au meme point
  // que l'ancien compteur EDF): ce qui est produit = ce qui est autoconsomme
  // + ce qui est exporte.
  //
  // Pas de clamp a 0 ici, volontairement: meme avec prodBaselineWh configurée,
  // rien ne garantit que la baseline prod et celles du capteur general aient
  // ete relevées exactement au meme instant (et prodBaselineWh peut tout
  // simplement etre absente) — la difference absolue peut donc etre negative,
  // sans aucune signification physique en tant que "total depuis toujours".
  // Ce qui compte, et qui reste correct malgre ce decalage arbitraire, c'est
  // le delta entre deux instants (_today/_yesterday, via _00h): ce decalage
  // s'annule dans la soustraction, et le delta est physiquement toujours >= 0
  // (Δeco(t) = Δprod(t) - Δgrid(t) = autoconsommation reelle de l'instant >=
  // 0). Un clamp a 0 ici ecraserait ce delta a chaque cycle des que le
  // decalage d'origine est negatif, rendant _today/_yesterday definitivement
  // bloques a 0 (meme classe d'incident que celui observe le 2026-07-23 avec
  // l'ancienne approche EDF).
  const generalMeterImportWhLifetime = Number(inputs.generalMeterImportWhLifetime);

  const generalMeterExportWhLifetime = Number(inputs.generalMeterExportWhLifetime);
  if (Number.isFinite(generalMeterExportWhLifetime)) {
    adjusted["grid/whLifetime"] = Math.round(generalMeterExportWhLifetime);

    if (Number.isFinite(prodWhLifetimeSinceReset)) {
      adjusted["eco/whLifetime"] = Math.round(prodWhLifetimeSinceReset - generalMeterExportWhLifetime);

      // conso_all/whLifetime ("consommation totale du foyer, tous circuits"):
      // meme conservation, un terme de plus. Ce qui est consomme = ce qui est
      // importe + ce qui est autoconsomme (eco). Remplace l'ancien calcul base
      // sur le report total-consumption du TOR (+ energyOffsetWh du tableau
      // elec) — celui-ci restait aveugle au tableau ext des que la correction
      // n'etait plus appliquee (voir capteur general ci-dessus).
      if (Number.isFinite(generalMeterImportWhLifetime)) {
        adjusted["conso_all/whLifetime"] = Math.round(
          generalMeterImportWhLifetime + adjusted["eco/whLifetime"],
        );
      }
    }
  }

  // conso_net/whLifetime ("solde net"): desormais deduit d'import - export,
  // les deux venant du meme capteur general (meme origine, donc grandeur
  // veritablement absolue, contrairement a eco/grid ci-dessus).
  if (Number.isFinite(generalMeterImportWhLifetime) && Number.isFinite(generalMeterExportWhLifetime)) {
    adjusted["conso_net/whLifetime"] = Math.round(generalMeterImportWhLifetime - generalMeterExportWhLifetime);
  }

  return adjusted;
}
