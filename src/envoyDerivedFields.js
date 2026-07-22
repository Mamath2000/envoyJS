/**
 * Calcule les champs derives (grid/eco/courant/lifetime) a partir des champs
 * bruts normalises d'Envoy, en appliquant une correction optionnelle (ex:
 * tableau electrique deporte). Fonction pure, un seul passage de calcul.
 *
 * Aucun champ kWh n'est calcule ici: le kWh est toujours simplement le Wh /
 * 1000, donc affiche cote Home Assistant via un value_template sur le topic
 * Wh existant plutot que publie comme un champ MQTT separe (voir
 * sensors-def.json / source_field, et src/ha/discovery.js).
 */

export function deriveEnvoyFields(rawFields, correction = {}) {
  if (!rawFields || typeof rawFields !== "object") return rawFields;

  const signedPowerW = Number(correction.signedPowerW ?? 0);
  const energyOffsetWh = Number(correction.energyOffsetWh ?? 0);

  const adjusted = { ...rawFields };

  // Champ temps réél :
  const baseNetPowerW = Number(adjusted["conso_net/wNow"] ?? 0);
  if (Number.isFinite(baseNetPowerW)) {
    const correctedNetPowerW = Math.round(baseNetPowerW + signedPowerW);
    adjusted["conso_net/wNow"] = correctedNetPowerW;

    adjusted["grid/wNow"] = correctedNetPowerW < 0 ? Math.abs(correctedNetPowerW) : 0;
    adjusted["grid/wNow_binary"] = correctedNetPowerW > 0 ? 1 : 0;

    const prodW = Number(adjusted["prod/wNow"]);
    if (Number.isFinite(prodW)) {
      adjusted["eco/wNow"] = correctedNetPowerW < 0 ? prodW + correctedNetPowerW : prodW;
    }

    // Coherence electrique demandee: I = P / U
    const netVoltageV = Number(adjusted["conso_net/voltage"]);
    if (Number.isFinite(netVoltageV) && Math.abs(netVoltageV) > 0.1) {
      adjusted["conso_net/current"] = Number((correctedNetPowerW / netVoltageV).toFixed(3));
    }
  }

  const baseAllPowerW = Number(adjusted["conso_all/wNow"]);
  if (Number.isFinite(baseAllPowerW)) {
    adjusted["conso_all/wNow"] = Math.round(baseAllPowerW + signedPowerW);
  }

  // Index energie
  const baseNetWhLifetime = Number(adjusted["conso_net/whLifetime"]);
  if (Number.isFinite(baseNetWhLifetime)) {
    adjusted["conso_net/whLifetime"] = Math.max(0, Math.round(baseNetWhLifetime + energyOffsetWh));
  }

  const baseAllWhLifetime = Number(adjusted["conso_all/whLifetime"]);
  if (Number.isFinite(baseAllWhLifetime)) {
    adjusted["conso_all/whLifetime"] = Math.max(0, Math.round(baseAllWhLifetime + energyOffsetWh));
  }

  // import (tire du reseau) augmente quand la conso externe augmente: ce qu'elle
  // consomme sans venir du solaire a bien fallu le tirer du reseau.
  const baseImportWhLifetime = Number(adjusted.import_eim_whLifetime);
  if (Number.isFinite(baseImportWhLifetime)) {
    adjusted.import_eim_whLifetime = Math.max(0, Math.round(baseImportWhLifetime + energyOffsetWh));
  }

  const prodWhLifetime = Number(adjusted["prod/whLifetime"]);

  // Compteur EDF (Linky, index EAST): situe avant la scission maison/tableau
  // ext, il voit deja le vrai import combine des deux reseaux — aucune
  // correction a lui appliquer. On en deduit grid (export)/eco (autoconso) par
  // conservation d'energie ("ce qui est consomme = ce qui est importe + ce qui
  // est autoconsomme"), une identite lineaire toujours vraie — contrairement a
  // l'ancienne approche basee sur le TOR (actEnergyRcvd), qui dependait de quel
  // reseau exportait/importait a quel instant et necessitait un clamp monotone
  // pour rester coherente en presence du tableau ext (retiree, voir historique
  // 6.3/6.4 dans la doc).
  //
  // Pas de clamp a 0 ici, volontairement: conso_all/whLifetime et
  // edf_import_whLifetime ne partent pas du meme "zero" (le compteur Linky
  // compte depuis sa propre installation, generalement bien avant le suivi
  // logiciel de conso_all) — la difference absolue peut donc etre negative,
  // sans aucune signification physique en tant que "total depuis toujours".
  // Ce qui compte, et qui reste correct malgre ce decalage arbitraire, c'est
  // le delta entre deux instants (_today/_yesterday, via _00h): ce decalage
  // s'annule dans la soustraction, et le delta est physiquement toujours >= 0
  // (Δeco(t) = Δconso_all(t) - Δedf_import(t) = autoconsommation reelle de
  // l'instant >= 0, et par symetrie Δgrid(t) = Δprod(t) - Δeco(t) >= 0). Un
  // clamp a 0 ici ecraserait ce delta a chaque cycle des que le decalage
  // d'origine est negatif, rendant _today/_yesterday definitivement bloques a
  // 0 (incident reel observe le 2026-07-23).
  const edfImportWhLifetime = Number(correction.edfImportWhLifetime);
  if (Number.isFinite(edfImportWhLifetime)) {
    adjusted.edf_import_whLifetime = Math.round(edfImportWhLifetime);

    const consoAllWhLifetime = Number(adjusted["conso_all/whLifetime"]);
    if (Number.isFinite(consoAllWhLifetime)) {
      adjusted["eco/whLifetime"] = Math.round(consoAllWhLifetime - edfImportWhLifetime);

      if (Number.isFinite(prodWhLifetime)) {
        adjusted["grid/whLifetime"] = Math.round(prodWhLifetime - adjusted["eco/whLifetime"]);
      }
    }
  }

  return adjusted;
}
